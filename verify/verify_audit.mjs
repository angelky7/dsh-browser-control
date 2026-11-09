// 操作审计的台子（v1.7.4，纯插件特性）。四面：
//   1) 记账器单元：脱敏（输入值/cookie 值/令牌键）、表达式截断、摘要限长、
//      环形缓冲（200 上限、seq 不回收）、过滤器（tabId/命令子串/sinceSeq/limit）。
//   2) 真实链路：真 BridgeServer + 假扩展 WS，走工具 → 命令 → 账本，
//      成功/失败/本地 cleanup 都上账，错误条目带 code 与 effectState。
//   3) 策略与闸门：只读档拒绝的写命令也上账（blocked_by_policy）；审计工具自己
//      是纯本地读，只读档下照常可查；旧扩展预检拒绝记 extension_outdated。
//   4) 模型可见面：render 带 seq/命令/结果/时长与脱敏参数，审计工具不给自己上账。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";
import { AuditLog, summarizeAuditParams, AUDIT_MAX_ENTRIES } from "../src/audit.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/* ============ 1. 记账器单元 ============ */
{
  const typed = summarizeAuditParams("input", { selector: "#q", value: "hunter2-secret" });
  check("input 的 value 打码（含长度），明文不出现",
    /\[redacted:14 chars\]/.test(typed) && !typed.includes("hunter2"), typed);
  const cookie = summarizeAuditParams("cookies.set", { name: "sid", value: "s3cr3t", url: "https://x.test/" });
  check("cookies.set 的 value 打码，name/url 保留", cookie.includes('"name":"sid"') && cookie.includes("[redacted:") && !cookie.includes("s3cr3t"), cookie);
  const token = summarizeAuditParams("ping", { token: "abc123", authorization: "Bearer x", keep: "ok" });
  check("令牌类键（token/authorization）一律打码", token.includes('"token":"[redacted]"') && token.includes('"authorization":"[redacted]"') && token.includes('"keep":"ok"'), token);
  const longExpr = summarizeAuditParams("eval", { expression: "x".repeat(200) });
  check("eval 表达式截断并标记剩余长度", longExpr.includes("…[+80 chars]"), longExpr.slice(-30));
  const longParams = summarizeAuditParams("nav", { url: `https://x.test/?q=${"a".repeat(400)}` });
  check("参数摘要整体限长（300）", longParams.length <= 330 && /…\[\+\d+ chars\]/.test(longParams), `len=${longParams.length}`);
  const other = summarizeAuditParams("navigate", { value: "not-sensitive-here" });
  check("别的命令的 value 不打码（只打输入与 cookie 两条）", other.includes("not-sensitive-here"), other);
}
{
  let now = 1_000;
  const log = new AuditLog(() => now++);
  for (let i = 0; i < AUDIT_MAX_ENTRIES + 5; i++) log.record({ command: "ping", params: "{}", ok: true, durationMs: 1 });
  check(`环形缓冲封顶 ${AUDIT_MAX_ENTRIES}`, log.size() === AUDIT_MAX_ENTRIES, String(log.size()));
  const all = log.list({ limit: 10_000 });
  check("挤掉的是最旧的一端（seq 从 6 开始，不回收编号）", all[0]?.seq === 6 && all[all.length - 1]?.seq === 205, `${all[0]?.seq}..${all[all.length - 1]?.seq}`);
  check("默认取最新 50 条、按 seq 升序", log.list().length === 50 && log.list()[49].seq === 205, String(log.list().length));
  check("sinceSeq 分页", log.list({ sinceSeq: 200 }).map((e) => e.seq).join(",") === "201,202,203,204,205", log.list({ sinceSeq: 200 }).map((e) => e.seq).join(","));
  log.record({ command: "tabs.open", tabId: 7, params: '{"url":"u"}', ok: true, durationMs: 4 });
  log.record({ command: "nav", tabId: 9, params: '{"url":"u"}', ok: true, durationMs: 2 });
  check("tabId 过滤只要那一条", log.list({ tabId: 7 }).length === 1 && log.list({ tabId: 7 })[0].command === "tabs.open");
  check("命令子串过滤（nav 命中 nav 与 tabs.open? 不——只命中 nav）", log.list({ command: "nav" }).every((e) => e.command.includes("nav")) && log.list({ command: "tabs" }).length === 1);
}

/* ============ 2. 真实链路 ============ */
const PORT = 9801;
const TOKEN = "audit-test";
const SHOTS = await mkdtemp(path.join(tmpdir(), "dsh-audit-"));
const tools = [];
const disposers = [];
const config = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: PORT, token: TOKEN, shotsDir: SHOTS });
const settingsService = {
  register(_ns, schema, options) {
    const value = schema(options?.base ?? config);
    return { get: () => value, watch: () => {}, set: () => {} };
  },
};
const pctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: pctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};
apply(pctx, config);
await new Promise((r) => setTimeout(r, 400));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.7.2", protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: ["nav", "input", "click", "metrics"] }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    if (msg.command === "click") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "element not found: .none" }));
      return;
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 7, url: "https://a.test/", title: "A", filled: true, value: "x", metrics: {} } }));
  };
  setTimeout(r, 400);
});
await new Promise((r) => setTimeout(r, 100));

const byName = (n) => tools.find((t) => t.name === n);
const signal = () => new AbortController().signal;
const call = (name, args) => byName(name).execute(args, { signal: signal() }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

check("browser_audit 已注册（工具面 29 条）", Boolean(byName("browser_audit")) && tools.length === 29, String(tools.length));

await call("browser_navigate", { url: "https://a.test/", tabId: 7 });
await call("browser_type", { selector: "#q", value: "hunter2-secret", tabId: 7 });
const clickFail = await call("browser_click", { selector: ".none", tabId: 7 });
check("失败调用也返回错误（链路本身没被审计改变）", clickFail.ok === false && /element not found/.test(clickFail.error));
await writeFile(path.join(SHOTS, "a.png"), "x");
const cleaned = await call("browser_cleanup", {});
check("cleanup 走本地路径", cleaned.ok === true && cleaned.r.shotsRemoved === 1, JSON.stringify(cleaned.r));

const list = await call("browser_audit", {});
const entries = list.r.entries;
check("四条命令按顺序上账（nav/input/click/cleanup）",
  entries.map((e) => e.command).join(",") === "nav,input,click,cleanup", entries.map((e) => e.command).join(","));
const navEntry = entries[0];
check("成功条目字段齐全（seq/t/tabId/ok/durationMs/params）",
  navEntry.seq === 1 && typeof navEntry.t === "number" && navEntry.tabId === 7 && navEntry.ok === true && typeof navEntry.durationMs === "number" && /a\.test/.test(navEntry.params),
  JSON.stringify(navEntry));
const inputEntry = entries[1];
check("输入值在账本里是打码的", /\[redacted:14 chars\]/.test(inputEntry.params) && !JSON.stringify(entries).includes("hunter2"), inputEntry.params);
const clickEntry = entries[2];
check("失败条目带 code/effectState 与错误文本",
  clickEntry.ok === false && clickEntry.code === "command_failed" && clickEntry.effectState === "unknown" && /element not found/.test(clickEntry.error ?? ""),
  JSON.stringify(clickEntry));
const cleanupEntry = entries[3];
check("cleanup 本地命令也上账", cleanupEntry.command === "cleanup" && cleanupEntry.ok === true, JSON.stringify(cleanupEntry));

const filtered = await call("browser_audit", { command: "nav" });
check("命令过滤只回 nav", filtered.r.entries.length === 1 && filtered.r.entries[0].command === "nav", JSON.stringify(filtered.r.entries.map((e) => e.command)));
const limited = await call("browser_audit", { limit: 1 });
check("limit 取最新一条", limited.r.shown === 1 && limited.r.entries[0].command === "cleanup", JSON.stringify(limited.r.entries.map((e) => e.command)));
const paged = await call("browser_audit", { sinceSeq: 3 });
check("sinceSeq 分页只回新条目", paged.r.entries.map((e) => e.seq).join(",") === "4", paged.r.entries.map((e) => e.seq).join(","));

const auditRendered = byName("browser_audit").output.render({}, list.r)[0].text;
check("render 带序号/命令/结果/时长与脱敏参数",
  /#1 /.test(auditRendered) && /nav/.test(auditRendered) && /ok/.test(auditRendered) && /ms/.test(auditRendered) && /\[redacted:14 chars\]/.test(auditRendered) && !auditRendered.includes("hunter2"),
  auditRendered.slice(0, 120));
const after = await call("browser_audit", {});
check("审计工具不给自己上账（查了两次，账本还是 4 条）", after.r.total === 4, String(after.r.total));
try { ws.close(); } catch {}
disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });

/* ============ 3. 策略与闸门 ============ */

function makeInstance({ port, token, configOverrides = {}, helloVersion = "1.7.2", capabilities = null }) {
  const instTools = [];
  const instDisposers = [];
  const cfg = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port, token, shotsDir: SHOTS, ...configOverrides });
  const settings = { register(_ns, schema, options) { const v = schema(options?.base ?? cfg); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => instDisposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: c.logger }); },
    tools: { register: (def) => instTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, cfg);
  return { tools: instTools, dispose: () => instDisposers.reverse().forEach((fn) => { try { fn(); } catch {} }), port, token, helloVersion, capabilities };
}
async function connectFake(inst) {
  const sock = new WebSocket(`ws://127.0.0.1:${inst.port}/ws?token=${inst.token}`);
  await new Promise((r) => {
    sock.onopen = () => {
      const hello = { type: "hello", client: "fake", version: inst.helloVersion, protocol: 1, browser: { name: "fake", version: "1", ua: "" } };
      if (inst.capabilities !== null) hello.capabilities = inst.capabilities;
      sock.send(JSON.stringify(hello));
      r();
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 1 } }));
    };
    setTimeout(r, 400);
  });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    try {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/status`, { headers: { authorization: `Bearer ${inst.token}` } });
      if ((await res.json()).hello?.version !== undefined) break;
    } catch { /* 等桥 */ }
  }
  return sock;
}

{
  const inst = makeInstance({ port: 9802, token: "audit-ro", configOverrides: { readOnly: true } });
  await new Promise((r) => setTimeout(r, 300));
  const sock = await connectFake(inst);
  const tool = (n) => inst.tools.find((t) => t.name === n);
  const refused = await tool("browser_click").execute({ selector: "#x", tabId: 1 }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("只读档：写命令被拒", refused.ok === false && /blocked_by_policy/.test(refused.error), refused.error?.slice(0, 80));
  const audit = await tool("browser_audit").execute({}, { signal: signal() });
  const entry = audit.entries[0];
  check("被策略拒绝的命令也上账（code=blocked_by_policy、not_started）",
    entry?.command === "click" && entry.ok === false && entry.code === "blocked_by_policy" && entry.effectState === "not_started", JSON.stringify(entry));
  check("只读档下审计工具照常可查（纯本地读）", Array.isArray(audit.entries) && audit.entries.length === 1);
  try { sock.close(); } catch {}
  inst.dispose();
}
{
  // 回归（专家评审 S2）：journal 打不开 = 纯内存审计。旧实现
  // `this.journal?.append(this.audit.record(input))` 会让可选链短路掉 audit.record，
  // journal 一关（默认就是关的）账本整本丢失。这里用「stateDir 指向一个文件」逼
  // Journal.open 失败，证明内存审计不依赖 journal。
  const badState = path.join(SHOTS, "not-a-dir.state");
  await writeFile(badState, "x");
  const inst = makeInstance({ port: 9804, token: "audit-nojournal", configOverrides: { stateDir: badState } });
  await new Promise((r) => setTimeout(r, 300));
  const sock = await connectFake(inst);
  const tool = (n) => inst.tools.find((t) => t.name === n);
  await tool("browser_navigate").execute({ url: "https://a.test/", tabId: 1 }, { signal: signal() });
  const audit = await tool("browser_audit").execute({}, { signal: signal() });
  check("journal 关闭时内存审计照常记账（可选链不许短路 audit.record）",
    audit.entries.length === 1 && audit.entries[0].command === "nav", JSON.stringify(audit.entries));
  try { sock.close(); } catch {}
  inst.dispose();
}
{
  const inst = makeInstance({ port: 9803, token: "audit-old", helloVersion: "1.7.0", capabilities: undefined });
  await new Promise((r) => setTimeout(r, 300));
  const sock = await connectFake(inst);
  const tool = (n) => inst.tools.find((t) => t.name === n);
  const gate = await tool("browser_metrics").execute({ tabId: 1 }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("旧扩展：metrics 预检拒绝（extension-outdated）", gate.ok === false && /extension-outdated/.test(gate.error));
  const audit = await tool("browser_audit").execute({}, { signal: signal() });
  const entry = audit.entries[0];
  check("预检拒绝也上账（code=extension_outdated，命令与原因都在）",
    entry?.command === "metrics" && entry.ok === false && entry.code === "extension_outdated" && /added in 1\.7\.1/.test(entry.error ?? ""), JSON.stringify(entry));
  try { sock.close(); } catch {}
  inst.dispose();
}

console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
