// 模型到底看到了什么：宿主 dt2/package/lib/index.js:3548-3551 实测，成功结果里
//   content = snapshotProjection(tool.output.render(args, value))
// 而 canonical `value` 是「Execution-local … deliberately omitted from durable events」
// （types/index.d.ts:415），presentationMeta 只给 UI。也就是说 render() 少写一个字，
// 模型就少看一个字 —— 这一层以前没人测过，于是出过两类事故：
//   1) value 过不了自己声明的 schema（PR #12 的 siteUnreachable 就是这条）
//   2) render 只写了一句摘要，把这次调用真正要的数据丢在 value 里（读页面 / 快照 / 日志）
// 这个台子把每条工具的真实返回值同时喂给宿主自己的校验器和它的 render，逐条问：
// schema 过不过、模型可见文本里有没有那份数据、被截断时信号是不是机器可读的。
// 用法: node verify/verify_render_contract.mjs
import { Config, apply } from "../lib/index.js";

const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS"  : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9783; // 9777 装机默认口 / 9779 扩展端到端台 / 9781 导航诚实性台
const TOKEN = "render-contract-test";
const tools = [];
const disposers = [];

const config = Config({ enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
    const watchers = [];
    return {
      get: () => value,
      watch: (cb) => void watchers.push(cb),
      set: (next) => { value = next; watchers.forEach((w) => w()); },
    };
  },
};

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: ctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};

apply(ctx, config);
await new Promise((r) => setTimeout(r, 400));

// ---- 假扩展：按命令名回话，命令名 → 载荷 ----
let answers = {};
const seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello", client: "fake-extension", version: "1.0.11", protocol: 1,
      browser: { name: "fake", version: "1", ua: "" },
    }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seen.push(msg.command);
    const pick = answers[msg.command];
    const result = typeof pick === "function" ? pick(msg.params ?? {}) : (pick ?? {});
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
  };
  setTimeout(r, 400);
});

const byName = (name) => tools.find((t) => t.name === name);
/** 跑一条工具：拿真实 value、宿主校验结果、以及模型实际看到的文本。 */
const runTool = async (name, args, payload, command = null) => {
  const def = byName(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  answers = command === null ? {} : { [command]: payload };
  const value = await def.execute(args, { signal: new AbortController().signal });
  const violations = validateJsonSchemaValue(def.output.schema, value, "value");
  const blocks = def.output.render(args, value);
  const text = blocks.map((part) => part.text ?? "").join("\n");
  return { def, value, violations, text };
};

const TRUNCATION_TAG = /\[renderedTruncated omittedChars=(\d+) limitChars=(\d+)\]/;
const BIG = "x".repeat(12_000);

// 1) 三条 v1.0.9 补的工具以前各自硬切片（200 / 600 / 1200），现在必须走同一个夹子
for (const [name, command, args] of [
  ["browser_wait", "wait", { text: "已加载", timeoutMs: 15_000 }],
  ["browser_dialog", "dialog", { policy: "accept" }],
  ["browser_find", "find", { selector: "a", limit: 10 }],
]) {
  const out = await runTool(name, args, { tabId: 3, matched: true, blob: BIG }, command);
  const tag = out.text.match(TRUNCATION_TAG);
  check(`${name}：超限内容带机器可读截断标记`, Boolean(tag), out.text.slice(-90));
  check(`${name}：omittedChars 与实际被截掉的字符数一致`,
    tag ? Number(tag[1]) === JSON.stringify({ tabId: 3, matched: true, blob: BIG }).length - 4000 : false,
    tag ? `omitted=${tag[1]} limit=${tag[2]}` : "no tag");
  check(`${name}：模型可见文本不超过声明上限 + 标记本身`,
    out.text.length <= 4000 + 120, `len=${out.text.length}`);
  check(`${name}：JSON 片段不再从 token 中间断掉（尾部是完整标记）`,
    /\n… \[renderedTruncated[^\]]*\] narrow the query/.test(out.text), JSON.stringify(out.text.slice(4000, 4060)));
}

// 2) 没超限就别啰嗦：小载荷必须是原样 JSON，一个标记都不许出现
{
  const small = { tabId: 3, policy: "accept", recent: [] };
  const out = await runTool("browser_dialog", {}, small, "dialog");
  check("browser_dialog：没超限不带截断标记", !out.text.includes("renderedTruncated"), out.text);
  check("browser_dialog：没超限时原文完整", out.text === JSON.stringify(small), out.text);
}

// 3) 漂移护栏：src 里再出现「JSON.stringify(value).slice(0, N)」这种定长硬切片就红
{
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const hard = [...src.matchAll(/JSON\.stringify\([^)]*\)\s*\.slice\(/g)];
  check("src/index.ts 里没有残留的定长硬切片", hard.length === 0, hard.map((m) => m[0]).join(" | "));
}

// 4) 每条工具都得过自己声明的 schema —— 载荷用扩展真实回传的形状
//    （browser_console_log / browser_network_log 两条现在必红，见 fix 它们的提交：
//      它们的 items 是 additionalProperties:false + properties:{}，宿主逐键判违规）
const EXTENSION_SHAPES = [
  ["browser_info", "browser.info", {}, { name: "Chrome", version: "140.0.7339.133", tabs: 4, connected: true, protocol: 1 }],
  ["browser_tabs", "tabs.list", { action: "list" }, { tabId: 1, tabs: [{ id: 12, url: "https://a.example/", title: "A", active: true }] }],
];
for (const [name, command, args, payload] of EXTENSION_SHAPES) {
  const out = await runTool(name, args, payload, command);
  check(`${name}：真实扩展载荷过自己声明的输出 schema`,
    out.violations.length === 0, out.violations.join(" | "));
}

// 5) browser_read：正文本身要进模型可见文本。
//    修之前 render 只交出一句「Title (url) — 4321 chars」，正文留在 value 里，
//    而 value 不进模型 —— 也就是「读页面」这个工具从来没把页面交给过模型。
{
  const marker = "HEAD-MARKER";
  const tailMarker = "TAIL-MARKER";
  const page = `${marker} ${"a".repeat(25_000)} ${tailMarker}`;
  const payload = { tabId: 3, title: "Example Page", url: "https://p.example/", content: page };

  const first = await runTool("browser_read", {}, payload, "content");
  check("browser_read：真实载荷过输出 schema", first.violations.length === 0, first.violations.join(" | "));
  check("browser_read：模型看到的文本里有页面正文", first.text.includes(marker), first.text.slice(0, 120));
  check("browser_read：窗口默认 20000 字符", first.value.content.length === 20_000, `len=${first.value.content.length}`);
  check("browser_read：totalChars 报的是整页长度", first.value.totalChars === page.length, `${first.value.totalChars} vs ${page.length}`);
  check("browser_read：还有下文时明确给出下一个 offset",
    first.text.includes(`call again with offset=${20_000}`) && first.value.truncated === true,
    first.text.slice(0, 160));
  check("browser_read：单次可见文本有上界（不会把整站灌进上下文）",
    first.text.length <= 20_000 + 200, `len=${first.text.length}`);

  const second = await runTool("browser_read", { offset: 20_000 }, payload, "content");
  check("browser_read：offset 翻页能拿到尾段", second.text.includes(tailMarker) && second.value.truncated === false,
    second.text.slice(0, 120));
  check("browser_read：读完最后一窗不再喊 continue", !second.text.includes("call again"), second.text.slice(0, 120));

  const small = await runTool("browser_read", {}, { tabId: 3, title: "S", url: "https://s.example/", content: "short body" }, "content");
  check("browser_read：短页面原样给全文", small.text.includes("short body") && small.value.truncated === false, small.text);
  check("browser_read：空正文也不谎报长度",
    (await runTool("browser_read", {}, { tabId: 3, title: "", url: "", content: "" }, "content")).value.totalChars === 0);
}

// 6) browser_snapshot：ref 列表要进模型可见文本。
//    修之前只有一句「N interactive elements …; click or fill them by ref.」，
//    ref 一个都没给出去 —— 而系统提示词让模型「先快照、再按 ref 点击」。
{
  const items = Array.from({ length: 200 }, (_unused, i) => ({
    ref: `e${i}`,
    tag: i % 3 === 0 ? "a" : "button",
    role: i % 3 === 0 ? "link" : "button",
    name: `Option ${i}  with\nwhitespace`,
    ...(i % 3 === 0 ? { href: `https://p.example/page/${i}` } : {}),
  }));
  const payload = { tabId: 3, title: "Example Page", url: "https://p.example/", mode: "ax", items };
  const out = await runTool("browser_snapshot", {}, payload, "snapshot");
  check("browser_snapshot：真实载荷过输出 schema", out.violations.length === 0, out.violations.join(" | "));
  check("browser_snapshot：模型看到的文本里有 ref", out.text.includes("[e0]") && out.text.includes("[e7]"), out.text.slice(0, 200));
  check("browser_snapshot：每条带 role 与可读名字", /e13\] button "Option 13 with whitespace"/.test(out.text), out.text.split("\n")[14]);
  check("browser_snapshot：条目里的换行被压成一行", !out.text.includes("Option 1  with\nwhitespace"));
  check("browser_snapshot：链接把 href 也带出来", out.text.includes("-> https://p.example/page/0"), out.text.split("\n")[1]);
  const tag = out.text.match(TRUNCATION_TAG);
  check("browser_snapshot：200 条超预算时带机器可读截断标记", Boolean(tag), out.text.slice(-90));
  check("browser_snapshot：正文恰好在 8000 字符预算处切断",
    tag ? out.text.indexOf("\n… [renderedTruncated") === 8000 && Number(tag[2]) === 8000 : false,
    tag ? `cutAt=${out.text.indexOf("\n… [renderedTruncated")} limit=${tag[2]}` : "no tag");
  check("browser_snapshot：被截掉的确实是尾部而不是头部",
    out.text.includes("[e0]") && !out.text.includes("[e199]") && Number(tag?.[1] ?? 0) > 0,
    `omitted=${tag?.[1]}`);

  const few = await runTool("browser_snapshot", {}, { tabId: 3, title: "T", url: "u", items: [{ ref: "e1", tag: "button", name: "OK" }] }, "snapshot");
  check("browser_snapshot：小快照不带截断标记", !few.text.includes("renderedTruncated"), few.text);
  check("browser_snapshot：dom 模式仍按 tag 列", few.text.includes("[e1] button \"OK\""), few.text);

  const fell = await runTool("browser_snapshot", { mode: "ax" },
    { tabId: 3, title: "T", url: "u", mode: "dom", axFallback: "no a11y tree", items: [{ ref: "e1", tag: "a", href: "/x" }] }, "snapshot");
  check("browser_snapshot：ax 回退时把原因说给模型", fell.text.includes("no a11y tree") && fell.text.includes("[e1] a -> /x"), fell.text);
}

for (const disposer of disposers) {
  try { await disposer[0](); } catch { /*  teardown 不参与断言 */ }
}
try { ws.close(); } catch { /* already closed */ }

console.log(fails === 0 ? "\n模型可见内容契约全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
