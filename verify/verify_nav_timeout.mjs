// browser_navigate 过去把 "raise timeoutMs" 写在超时文案里，但工具参数表里没有 timeoutMs ——
// 模型照着做不了。这条断言钉两件事：
//   1) timeoutMs 真的进参数表、真的传到扩展（默认 15000，显式值优先，上限 120000）；
//   2) 桥的命令超时 = 导航预算 + 2s 余量。否则预算比桥默认值(60s)长时，先到的是桥，
//      模型拿到 command_timeout（结果未知）而不是"导航等待超时"（没动过页面）——处置完全不同。
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9782;
const TOKEN = "nav-timeout-test";
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

const nav = tools.find((t) => t.name === "browser_navigate");
check("browser_navigate 已注册", Boolean(nav));
const props = nav?.parameters?.properties ?? {};
check("参数表暴露了 timeoutMs", props.timeoutMs !== undefined, Object.keys(props).join(","));
check("参数描述写明上限 120000", String(props.timeoutMs?.description ?? "").includes("120000"), String(props.timeoutMs?.description ?? "").slice(0, 80));

// ---- 假扩展：记录收到的 nav 参数；`reply:false` 时故意不回话 ----
let reply = true;
let lastNavParams = null;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.2.0", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    if (msg.command === "nav") lastNavParams = msg.params ?? null;
    if (!reply) return; // 故意不回：让桥自己超时
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 7, url: msg.params?.url ?? "", title: "T" } }));
  };
  setTimeout(r, 400);
});

const signal = () => new AbortController().signal;

// 1) 默认预算：15000 传到扩展
await nav.execute({ url: "https://a.example/" }, { signal: signal() });
check("默认把 timeoutMs=15000 传给扩展", lastNavParams?.timeoutMs === 15_000, JSON.stringify(lastNavParams));

// 2) 显式值优先
await nav.execute({ url: "https://b.example/", timeoutMs: 3_000 }, { signal: signal() });
check("显式 timeoutMs=3000 原样传下去", lastNavParams?.timeoutMs === 3_000, JSON.stringify(lastNavParams));

// 3) 上限截断
await nav.execute({ url: "https://c.example/", timeoutMs: 999_999 }, { signal: signal() });
check("超上限被截到 120000", lastNavParams?.timeoutMs === 120_000, JSON.stringify(lastNavParams));

// 4) 桥侧余量：预算 300ms 时桥必须在 ~2.3s 处自己超时，而不是撑到默认 60s
reply = false;
const started = Date.now();
let error = null;
try {
  await nav.execute({ url: "https://slow.example/", timeoutMs: 300 }, { signal: signal() });
} catch (e) {
  error = e;
}
const elapsed = Date.now() - started;
const message = error instanceof Error ? error.message : String(error);
check("预算 300ms 时桥在 2.3s 左右超时（证明是预算 + 2000 余量）", elapsed >= 1_500 && elapsed < 6_000, `${elapsed}ms`);
check("超时文案带的是 2300ms，不是 60000ms", /2300/.test(message), message.slice(0, 120));

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
