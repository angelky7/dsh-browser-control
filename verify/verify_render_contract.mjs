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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

// 截图 / PDF / cleanup 三条会真写文件，所以把 shotsDir 指到临时目录，别脏了仓库
const SHOTS = await mkdtemp(path.join(tmpdir(), "dsh-render-contract-"));
const config = Config({ enabled: true, port: PORT, token: TOKEN, shotsDir: SHOTS });
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
      type: "hello", client: "fake-extension", version: "1.0.17", protocol: 1,
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

// 7) 两条日志工具：以前只要有条目就整条调用失败。
//    items 声明成 {type:'object', additionalProperties:false, properties:{}}，
//    宿主 checkValue（dt2 lib/index.js:468-470）对 additionalProperties:false 逐键判违规，
//    properties 为空 = 任何键都违规；实测 valueSchemaSpecToJsonSchema 编译后原样保留。
{
  const payload = {
    tabId: 3, count: 2, total: 140,
    entries: [
      { tabId: 3, level: "error", text: "boom: cannot read xyz", t: 1_760_000_000_000, location: "app.js:42" },
      { tabId: 3, level: "warn", text: "deprecated API\nused here", t: 1_760_000_003_000 },
    ],
  };
  const out = await runTool("browser_console_log", {}, payload, "console.log");
  check("browser_console_log：真实扩展载荷过输出 schema", out.violations.length === 0, out.violations.join(" | "));
  check("browser_console_log：模型看到条目正文", out.text.includes("boom: cannot read xyz"), out.text.slice(0, 200));
  check("browser_console_log：条目带级别、位置与 UTC 时间",
    /1\. \[08:53:20\] error @app\.js:42 — boom: cannot read xyz/.test(out.text), out.text.split("\n")[1]);
  check("browser_console_log：条目里的换行被压成一行", out.text.includes("deprecated API used here"), out.text.split("\n")[2]);
  check("browser_console_log：只给了一部分时说清给了多少",
    out.text.includes("2 of 140") && out.text.includes("showing the newest 2"), out.text.split("\n")[0]);
  check("browser_console_log：value 里的条目归一化成声明的字段",
    JSON.stringify(Object.keys(out.value.entries[0]).sort()) === JSON.stringify(["level", "location", "text", "time"]),
    JSON.stringify(out.value.entries[0]));

  const flood = {
    tabId: 3, count: 300, total: 300,
    entries: Array.from({ length: 300 }, (_u, i) => ({ tabId: 3, level: "log", text: `row ${i} ${"z".repeat(60)}`, t: 1_760_000_000_000 + i * 1000 })),
  };
  const big = await runTool("browser_console_log", {}, flood, "console.log");
  const tag = big.text.match(TRUNCATION_TAG);
  check("browser_console_log：整屏日志按 6000 预算截断并带机器可读标记",
    Boolean(tag) && Number(tag[2]) === 6000 && big.text.indexOf("\n… [renderedTruncated") === 6000,
    tag ? `cutAt=${big.text.indexOf("\n… [renderedTruncated")} limit=${tag[2]} omitted=${tag[1]}` : "no tag");

  const empty = await runTool("browser_console_log", {}, { tabId: 3, count: 0, total: 0, entries: [] }, "console.log");
  check("browser_console_log：没有条目时不谎报", empty.violations.length === 0 && empty.value.entries.length === 0, empty.text);
}

{
  const payload = {
    tabId: 3, count: 3, total: 3,
    requests: [
      {
        method: "GET", url: "https://api.example/x", resourceType: "XHR", status: 200, statusText: "OK",
        mimeType: "application/json", encodedDataLength: 1234, wallTime: 1_760_000_000.5, finished: true,
        headers: { "content-type": "application/json", cookie: "session=secret" },
        responseHeaders: { "set-cookie": "a=b" }, postData: "k=v", initiator: { url: "https://p.example/" },
      },
      { method: "POST", url: "https://api.example/y", resourceType: "Fetch", status: 500, statusText: "Server Error", wallTime: 1_760_000_002 },
      { method: "GET", url: "https://api.example/z", resourceType: "Fetch", failed: true, errorText: "net::ERR_CONNECTION_REFUSED", wallTime: 1_760_000_004 },
    ],
  };
  const out = await runTool("browser_network_log", {}, payload, "network.log");
  check("browser_network_log：真实扩展载荷过输出 schema", out.violations.length === 0, out.violations.join(" | "));
  check("browser_network_log：模型看到每条请求的方法/状态/URL",
    out.text.includes("GET 200 OK XHR 1.2 KB https://api.example/x") && out.text.includes("POST 500 Server Error"),
    out.text.split("\n").slice(1, 3).join(" ⏎ "));
  check("browser_network_log：失败的请求带上错误文本",
    out.text.includes("FAILED net::ERR_CONNECTION_REFUSED"), out.text.split("\n")[3]);
  check("browser_network_log：wallTime 按 UTC 秒显示", out.text.includes("[08:53:20]"), out.text.split("\n")[1]);
  check("browser_network_log：headers / POST 正文不进 value（那是最灌爆上下文的东西）",
    !JSON.stringify(out.value).includes("session=secret") && !JSON.stringify(out.value).includes("k=v"),
    JSON.stringify(out.value.requests[0]));
}

// 8) 全 20 条工具的地面真相审计：扩展真实载荷 → 宿主校验器 → 模型可见文本。
//    上面几段是逐条深挖，这一段是**广度**：一条都不许漏，因为漏掉的那条就是下一个
//    「活了 12 个版本没人发现」。每行都断言两件事：value 过得了自己的 schema，
//    而且这次调用真正要的数据出现在模型看到的文本里（`expect` 是必须命中的片段）。
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_B64 = "JVBERi0xLjQKJcOkw7zDtsOfCg==";

const GROUND_TRUTH = [
  // [工具, 扩展命令, 参数, 扩展真实回传, 模型必须看到的片段]
  ["browser_navigate", "nav", { url: "https://p.example/" },
    { tabId: 7, url: "https://p.example/", title: "Example" }, ["Tab 7 now shows", "Example", "https://p.example/"]],
  ["browser_read", "content", {},
    { tabId: 3, title: "T", url: "https://p.example/", content: "READ-GT-BODY" }, ["READ-GT-BODY"]],
  ["browser_snapshot", "snapshot", {},
    { tabId: 3, title: "T", url: "https://p.example/", items: [{ ref: "e41", tag: "button", name: "SUBMIT-GT" }] }, ["[e41]", "SUBMIT-GT"]],
  ["browser_click", "click", { selector: "#pay" },
    { tabId: 3, clicked: true, x: 128, y: 640 }, ["clicked", "128"]],
  ["browser_type", "input", { selector: "#q", value: "abc" },
    { tabId: 3, filled: true, value: "abc" }, ["filled", "abc"]],
  ["browser_press", "press", { key: "Enter" },
    { tabId: 3, key: "Enter", pressed: true }, ["Enter", "pressed"]],
  ["browser_scroll", "scroll", { y: 300 },
    { tabId: 3, x: 0, y: 300, scrollY: 300 }, ["scrollY"]],
  ["browser_wait", "wait", { text: "已加载" },
    { tabId: 3, matched: true, waitedMs: 120 }, ["matched", "120"]],
  ["browser_find", "find", { selector: "a" },
    { tabId: 3, count: 2, items: [{ tag: "a", text: "FIND-GT", rect: { x: 1, y: 2, w: 3, h: 4 } }] }, ["FIND-GT", "count"]],
  ["browser_dialog", "dialog", {},
    { policy: "accept", recent: [{ type: "alert", message: "DIALOG-GT", answeredAs: "accept" }] }, ["DIALOG-GT", "accept"]],
  ["browser_info", "browser.info", {},
    { connected: true, browser: { name: "Chrome", version: "140.0.7339.133" }, tabs: 4, protocol: 1, version: "1.0.12" }, ["Chrome", "connected"]],
  ["browser_tabs", "tabs.list", { action: "list" },
    { tabs: [{ id: 12, url: "https://tabs.example/page", title: "TAB-GT", active: true }] }, ["TAB-GT", "https://tabs.example/page"]],
  ["browser_evaluate", "eval", { expression: "document.title" },
    { tabId: 3, value: "EVAL-GT" }, ["EVAL-GT"]],
  ["browser_screenshot", "screenshot", {},
    { tabId: 3, format: "png", base64: PNG_B64, tabTitle: "SHOT-GT", tabUrl: "https://p.example/" }, ["Saved", ".png", "bytes"]],
  ["browser_console_log", "console.log", {},
    { tabId: 3, count: 1, total: 1, entries: [{ tabId: 3, level: "error", text: "LOG-GT", t: 1_760_000_000_000 }] }, ["LOG-GT"]],
  ["browser_network_log", "network.log", {},
    { tabId: 3, count: 1, total: 1, requests: [{ method: "GET", url: "https://net.example/gt", status: 201, wallTime: 1_760_000_000 }] }, ["https://net.example/gt", "201"]],
  ["browser_network_clear", "network.clear", {},
    { tabId: 3, cleared: true }, ["cleared"]],
  ["browser_pdf", "pdf", {},
    { tabId: 3, base64: PDF_B64 }, ["PDF written to", ".pdf"]],
  ["browser_emulate", "emulate", { device: "mobile-pixel-7" },
    { tabId: 3, width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7)" }, ["412", "915", "mobile=true", "UA="]],
];

// 封闭 schema 的工具里，任何 null 都会打穿调用：宿主 checkValue 只对 undefined 放行
// （`!Object.hasOwn(value,key) || value[key] === void 0` 才 continue），null 会下钻判类型。
// 所以这 11 条的 value 里出现 null 就是必然失败，而不是「字段没填」。
const CLOSED_SCHEMA = new Set([
  "browser_navigate", "browser_read", "browser_snapshot", "browser_evaluate", "browser_screenshot",
  "browser_cleanup", "browser_console_log", "browser_network_log", "browser_network_clear",
  "browser_pdf", "browser_emulate",
]);
const hasNull = (v) => v === null
  || (typeof v === "object" && v !== null && Object.values(v).some(hasNull));

for (const [name, command, args, payload, expect] of GROUND_TRUTH) {
  const out = await runTool(name, args, payload, command);
  check(`${name}：扩展真实载荷过自己的输出 schema`, out.violations.length === 0, out.violations.join(" | "));
  check(`${name}：模型可见文本里有这次调用要的数据`,
    expect.every(part => out.text.includes(part)),
    expect.filter(part => !out.text.includes(part)).join(",") || `len=${out.text.length}`);
  check(`${name}：render 至少交出一段非空文本`,
    out.text.trim().length > 0 && out.def.output.render(args, out.value).length > 0, JSON.stringify(out.text.slice(0, 40)));
  if (CLOSED_SCHEMA.has(name)) {
    check(`${name}：封闭 schema 的 value 里没有 null（null 会被宿主判成类型违规）`,
      !hasNull(out.value), JSON.stringify(out.value).slice(0, 120));
  }
}

// 9) browser_emulate 的 null 分支：扩展在无覆盖时回的是显式 `userAgent: null`
//    （extension/background.js:719 `userAgent: userAgent || null`），而 desktop 预设的
//    userAgent 就是空串 —— 于是 `device:"desktop"` 与任何自定义宽高的调用都会抛
//    ToolOutputError。审计表以前用 mobile-pixel-7（预设里带 UA 字符串）所以没碰到这条分支。
{
  const bare = { tabId: 3, width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: null };
  const desktop = await runTool("browser_emulate", { device: "desktop" }, bare, "emulate");
  check("browser_emulate：desktop 预设（扩展回 userAgent:null）过 schema",
    desktop.violations.length === 0, desktop.violations.join(" | "));
  check("browser_emulate：null 覆盖被归一化掉，不进 value",
    !("userAgent" in desktop.value) && !hasNull(desktop.value), JSON.stringify(desktop.value));
  check("browser_emulate：模型看到生效的视口尺寸", desktop.text.includes("1280×800"), desktop.text);

  const custom = await runTool("browser_emulate", { width: 900, height: 600 },
    { tabId: 3, width: 900, height: 600, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: null }, "emulate");
  check("browser_emulate：自定义宽高（同样回 userAgent:null）过 schema",
    custom.violations.length === 0, custom.violations.join(" | "));

  const withUa = await runTool("browser_emulate", { device: "mobile-iphone-13" },
    { tabId: 3, width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)" }, "emulate");
  check("browser_emulate：真的覆盖了 UA 时把 UA 说给模型",
    withUa.violations.length === 0 && withUa.text.includes('UA="Mozilla/5.0 (iPhone'), withUa.text);

  const reset = await runTool("browser_emulate", { device: "reset" }, { tabId: 3, reset: true }, "emulate");
  check("browser_emulate：reset 形状过 schema 且文案说明清掉了覆盖",
    reset.violations.length === 0 && reset.text.includes("reset to default"), reset.text);
}

// 10) 版本错位的诚实性（本机真实 Chrome 实测逼出来的用例）：
//     扩展 1.0.10 收到 mode:"ax" 时不报错、也不带 mode/axFallback，直接回一份 DOM 结果。
//     插件必须自己发现「请求的模式 ≠ 回报的模式」并写进 axFallback，否则模型会把
//     标签名当成可访问名。
{
  const legacyShape = { tabId: 3, title: "T", url: "https://p.example/", total: 2, limitedTo: 2, items: [{ ref: "e1", tag: "a", name: "首页", href: "/x" }] };
  const skewed = await runTool("browser_snapshot", { mode: "ax" }, legacyShape, "snapshot");
  check("旧扩展静默降级：axFallback 被插件自己补上",
    typeof skewed.value.axFallback === "string" && /v1\.0\.11/.test(skewed.value.axFallback),
    String(skewed.value.axFallback));
  check("旧扩展静默降级：这句话进得了模型",
    skewed.text.includes("mode ax fell back to dom") && skewed.text.includes("tag names, not accessible names"),
    skewed.text.split("\n")[1]);

  const modern = await runTool("browser_snapshot", { mode: "ax" },
    { ...legacyShape, mode: "ax", ax: { nodes: 40, candidates: 2, unresolved: 0, invisible: 1 }, items: [{ ref: "e1", tag: "a", role: "link", name: "首页" }] }, "snapshot");
  check("新扩展真的走了 AX：不许凭空报降级",
    modern.value.axFallback === undefined && modern.text.includes("(mode ax)"), modern.text.split("\n")[0]);

  const genuine = await runTool("browser_snapshot", { mode: "ax" },
    { ...legacyShape, mode: "dom", axFallback: "no a11y tree" }, "snapshot");
  check("扩展自己报了降级原因时以它为准",
    genuine.value.axFallback === "no a11y tree", String(genuine.value.axFallback));
}

// browser_cleanup 是唯一不经过扩展的工具：它读本地 shotsDir，所以单独跑（也用临时目录）。
{
  const out = await runTool("browser_cleanup", {}, {}, null);
  check("browser_cleanup：返回值过自己的输出 schema", out.violations.length === 0, out.violations.join(" | "));
  check("browser_cleanup：模型看到清掉了几个文件", /Cleaned \d+ screenshot/.test(out.text) && /scratch file/.test(out.text), out.text);
}

// Windows 上刚写进 shotsDir 的文件句柄可能还没释放，清理失败不该让整台子变红
try { await rm(SHOTS, { recursive: true, force: true }); } catch { /* 系统临时目录，留着无害 */ }

for (const disposer of disposers) {
  try { await disposer[0](); } catch { /*  teardown 不参与断言 */ }
}
try { ws.close(); } catch { /* already closed */ }

console.log(fails === 0 ? "\n模型可见内容契约全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
