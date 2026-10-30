// 用**发布产物** lib/index.js（npm 用户真正拿到的那份）跑一遍鉴权与桥接行为，
// 而不是只测 src。流程：假 cordis 上下文 -> apply() -> 假扩展连 WS -> 打 HTTP 面。
import net from "node:net";
import { readFile } from "node:fs/promises";
import { Config, apply } from "../lib/index.js";

const PORT = 9777;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const logs = [];
const tools = [];
const disposers = [];
const ctx = {
  logger: { info: (l) => logs.push(String(l)), warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => {
    if (!deps.includes("settings")) return;
    let value = null;
    const watchers = [];
    const scope = { get: () => value, watch: (cb2) => void watchers.push(cb2) };
    cb({
      logger: ctx.logger,
      settings: {
        register(ns, schema, options) {
          value = schema(options?.base ?? {});
          return scope;
        },
      },
    });
  },
  tools: { register: (def) => tools.push(def?.name) },
  systemPrompt: { section: () => {} },
};

const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
apply(ctx, Config({ enabled: /enabled:\s*true/.test(patch), port: PORT, token: "dsh-local" }));
await new Promise((r) => setTimeout(r, 250));

check("发布产物注册 22 个工具", tools.length === 22, String(tools.length));
check("默认 token 触发启动告警", logs.some((l) => l.includes("insecure token")), logs.filter((l) => l.includes("insecure")).join("|").slice(0, 90));

const open = await new Promise((res) => {
  const s = net.connect(PORT, "127.0.0.1", () => { s.end(); res(true); });
  s.on("error", () => res(false));
});
check("9777 已监听", open);

// 假扩展连上，才能证明命令面真的在干活
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=dsh-local`);
let executed = null;
await new Promise((res) => {
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", client: "fake-ext", version: "0", browser: { name: "fake", version: "1", ua: "" } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "command") {
      executed = m.command;
      ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: { executed: m.command } }));
    }
  };
  setTimeout(res, 250);
});

let res = await fetch(`${BASE}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "nav", params: {} }) });
check("发布产物：无 token 的 /api/command -> 401", res.status === 401, `实际 ${res.status}`);
check("发布产物：被拒的命令没有到达扩展", executed === null, String(executed));

res = await fetch(`${BASE}/api/command?token=dsh-local`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "nav", params: {} }) });
const j = await res.json().catch(() => ({}));
check("发布产物：?token= 的 /api/command -> 200 且驱动扩展", res.status === 200 && executed === "nav", JSON.stringify(j).slice(0, 90));

res = await fetch(`${BASE}/api/cleanup`, { method: "POST" });
check("发布产物：无 token 的 /api/cleanup -> 401", res.status === 401, `实际 ${res.status}`);

res = await fetch(`${BASE}/api/status`);
const st = await res.json().catch(() => ({}));
check("发布产物：/api/status 免鉴权且报告 insecureToken", res.status === 200 && st.insecureToken === true, JSON.stringify(st).slice(0, 100));

res = await fetch(`${BASE}/api/status`);
check("发布产物：响应无 ACAO", !res.headers.get("access-control-allow-origin"));

ws.close();
for (const [fn] of disposers) { try { await fn(); } catch {} }
await new Promise((r) => setTimeout(r, 300));
console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项未通过"}`);
process.exit(failures === 0 ? 0 : 1);
