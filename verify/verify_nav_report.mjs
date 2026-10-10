// browser_navigate 必须把「没到位」的三种情况说出来：加载没落地（loadPending）、
// 目标不可达（siteUnreachable）、还在切页（pendingUrl）。
//
// 这条断言存在的理由是一类已经实测到的缺陷：扩展把「15s 到了但新文档还没落地」
// 和「落到 chrome-error://」都如实报了出来，可宿主这边
//   1) 输出 schema 是封闭的（additionalProperties: false）却没声明这些字段，
//   2) render 只看 title/url，
// 于是模型读到的是一句「Tab N now shows <你要的 URL>」——一次没成功的导航被读成成功。
// 这里用真 BridgeServer + 假扩展把三种形状一路推到工具返回值与给模型看的文案。
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9779;
const TOKEN = "nav-report-test";
const tools = [];
const disposers = [];

const config = Config({ enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  // dsh-settings 0.1.2-rc.1 形状：register(ns, schema, { base, validate }) -> scope{ get, watch }
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

const nav = tools.find((t) => t.name === "browser_navigate");
check("browser_navigate 已注册", Boolean(nav));
const props = nav?.output?.schema?.properties ?? {};
for (const field of ["pendingUrl", "loadPending", "siteUnreachable"]) {
  check(`输出 schema 声明了 ${field}`, props[field] !== undefined, Object.keys(props).join(","));
}

// ---- 假扩展：按当前脚本回话，其他命令一律空对象 ----
let answer = () => ({});
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.0.9", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "command") ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: answer(msg) }));
  };
  setTimeout(r, 400);
});

const call = async (result, args) => { answer = () => result; return await nav.execute(args, { signal: new AbortController().signal }); };
const text = (value) => nav.output.render({ url: value.url }, value).map((part) => part.text).join("\n");

// 1) 正常落地：形状和文案都不许变
const settled = await call({ tabId: 7, url: "https://target.example/", title: "Target" }, { url: "https://target.example/" });
check("正常落地：url/title 原样带出", settled.url === "https://target.example/" && settled.title === "Target", JSON.stringify(settled));
check("正常落地：纯 tab/url/title，不冒新字段",
  settled.loadPending === undefined && settled.pendingUrl === undefined && settled.siteUnreachable === undefined,
  JSON.stringify(settled));
check("正常落地：文案与旧版一致", text(settled) === "Tab 7 now shows Target — https://target.example/", text(settled));

// 2) 15s 到点、新文档仍未落地（扩展新增的 loadPending + pendingUrl）
const pending = await call(
  { tabId: 7, url: "https://old.example/", title: "Old", pendingUrl: "https://slow.example/", loadPending: true },
  { url: "https://slow.example/" },
);
check("未落地：loadPending/pendingUrl 到得了模型",
  pending.loadPending === true && pending.pendingUrl === "https://slow.example/", JSON.stringify(pending));
check("未落地：文案说「仍在加载」而不是「已显示」",
  /is still loading https:\/\/slow\.example\//.test(text(pending)) && !/now shows/.test(text(pending)), text(pending));

// 3) 目标不可达：扩展报的是 {reason}，老代码 `=== true` 把它整条丢掉
const unreachable = await call(
  { tabId: 7, url: "https://10.255.255.1:8080/", siteUnreachable: { reason: "unreachable" } },
  { url: "https://10.255.255.1:8080/" },
);
check("不可达：{reason} 归一成 siteUnreachable: true", unreachable.siteUnreachable === true, JSON.stringify(unreachable));
check("不可达：文案说明落在浏览器错误页",
  /could not load/.test(text(unreachable)) && /error page/.test(text(unreachable)) && !/now shows/.test(text(unreachable)), text(unreachable));

// 4) 还在切页（超时前就被别的命令打断的场景）：至少要说出去哪儿了
const navigating = await call(
  { tabId: 7, url: "https://old.example/", title: "Old", pendingUrl: "https://next.example/", loadPending: true },
  { url: "https://next.example/" },
);
check("未落地：旧文档与目的地都要出现在文案里",
  text(navigating).includes("Old — https://old.example/") && text(navigating).includes("https://next.example/"), text(navigating));

ws.close();
await new Promise((r) => setTimeout(r, 150));
for (const [fn] of disposers) { try { await fn(); } catch { /* bench teardown is best effort */ } }
await new Promise((r) => setTimeout(r, 200));

console.log(`\n结论：${fails === 0 ? "导航结果不再假报成功" : fails + " 项未通过"}`);
process.exit(fails === 0 ? 0 : 1);
