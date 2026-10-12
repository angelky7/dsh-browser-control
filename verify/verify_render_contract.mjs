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

for (const disposer of disposers) {
  try { await disposer[0](); } catch { /*  teardown 不参与断言 */ }
}
try { ws.close(); } catch { /* already closed */ }

console.log(fails === 0 ? "\n模型可见内容契约全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
