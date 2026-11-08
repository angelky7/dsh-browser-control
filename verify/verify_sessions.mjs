// 多 session 隔离的台子（v1.7.6，纯插件特性）。三面：
//   1) 隔离核心：两个 agent 各自用自己的工作标签页——省略 tabId 的调用落到
//      **本会话**记下的那个（先向扩展核验它还开着），而不是浏览器活动页；
//   2) 回退与收养：工作标签页被关掉 → 退回活动页并改记新的；tabs.open 一类
//      带结果的命令把新标签页收养成会话的工作页；
//   3) 兼容与契约：没有 agent 身份的调用完全维持旧行为（不注入）；browser_sessions
//      list/release 可用、只读档可查、render 标出「你」。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const STATE = await mkdtemp(path.join(tmpdir(), "dsh-sessions-"));
const PORT = 9807;
const TOKEN = "sessions-test";
const tools = [];
const disposers = [];
const config = Config({ stateDir: STATE, enabled: true, port: PORT, token: TOKEN, shotsDir: path.join(STATE, "shots") });
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

/* 假扩展：记录每个命令的原始参数；tabs.list 报当前活着的标签页 */
let liveTabs = new Set([100, 200]);
let activeTab = 200;
const received = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.7.2", protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: ["tabs.list", "tabs.open", "nav", "click", "input"] }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    received.push({ command: msg.command, params: msg.params ?? {} });
    if (msg.command === "tabs.list") {
      const tabs = [...liveTabs].map((id) => ({ id, active: id === activeTab }));
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabs, activeTabId: activeTab, count: tabs.length } }));
      return;
    }
    if (msg.command === "tabs.open") {
      liveTabs.add(300);
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 300, grouped: true } }));
      return;
    }
    const tabId = typeof msg.params?.tabId === "number" ? msg.params.tabId : activeTab;
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId, clicked: true, filled: true, value: "x", url: "https://a.test/", title: "A" } }));
  };
  setTimeout(r, 400);
});
await new Promise((r) => setTimeout(r, 150));

const tool = (n) => tools.find((t) => t.name === n);
const signal = () => new AbortController().signal;
const run = (name, args, agentId) => tool(name).execute(args, {
  signal: signal(),
  ...(agentId === undefined ? {} : { agent: { id: agentId } }),
}).then((r) => ({ ok: true, value: r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
const last = () => received[received.length - 1];

check("browser_sessions 已注册（工具面 29 条）", Boolean(tool("browser_sessions")) && tools.length === 29, String(tools.length));

/* ============ 1. 隔离核心 ============ */
await run("browser_navigate", { url: "https://a.test/", tabId: 100 }, "agent-a");
check("A 显式指定 tabId 100 → 命令原样带上", last().command === "nav" && last().params.tabId === 100, JSON.stringify(last()));
await run("browser_navigate", { url: "https://b.test/", tabId: 200 }, "agent-b");
check("B 显式指定 tabId 200", last().params.tabId === 200, JSON.stringify(last()));

await run("browser_click", { selector: "#a" }, "agent-a");
check("A 省略 tabId ⇒ 落到 A 自己的工作标签 100（不是活动页 200）", last().command === "click" && last().params.tabId === 100, JSON.stringify(last()));
await run("browser_click", { selector: "#b" }, "agent-b");
check("B 省略 tabId ⇒ 落到 B 自己的 200", last().params.tabId === 200, JSON.stringify(last()));

await run("browser_click", { selector: "#nobody" });
check("没有 agent 身份的调用：不注入（旧行为原样）", last().command === "click" && last().params.tabId === undefined, JSON.stringify(last()));

/* ============ 2. 收养与回退 ============ */
await run("browser_tabs", { action: "open", url: "https://new.test/" }, "agent-a");
check("tabs.open 走 tabs.open 命令（不注入、不误当工作页）", last().command === "tabs.open" && last().params.tabId === undefined, JSON.stringify(last()));
await run("browser_click", { selector: "#after-open" }, "agent-a");
check("tabs.open 结果里的新标签被收养成 A 的工作页（300）", last().params.tabId === 300, JSON.stringify(last()));

liveTabs.delete(300);
await run("browser_click", { selector: "#after-close" }, "agent-a");
check("工作标签 300 被关掉 ⇒ 退回活动页（不注入，命令里没有 tabId）", last().params.tabId === undefined, JSON.stringify(last()));
await run("browser_click", { selector: "#after-close-2" }, "agent-a");
check("回退后拿到活动页结果 ⇒ 改记 200 为 A 的新工作页", last().params.tabId === 200, JSON.stringify(last()));

/* tabs.list 不参与注入 */
await run("browser_tabs", { action: "list" }, "agent-a");
check("tabs.list 不在默认标签集合里（不注入 tabId）", last().command === "tabs.list" && last().params.tabId === undefined, JSON.stringify(last()));

/* ============ 3. 会话清单与释放 ============ */
const listing = await run("browser_sessions", {}, "agent-a");
check("list：当前会话是 agent-a", listing.value.current === "agent-a", JSON.stringify(listing.value));
check("list：两个会话都在，工作标签页各自对得上",
  listing.value.sessions.length === 2
  && listing.value.sessions.some((s) => s.sessionId === "agent-a" && s.workingTabId === 200)
  && listing.value.sessions.some((s) => s.sessionId === "agent-b" && s.workingTabId === 200),
  JSON.stringify(listing.value.sessions));
check("list：调用计数与时间戳是数字", listing.value.sessions.every((s) => typeof s.calls === "number" && s.calls > 0 && typeof s.lastActiveAt === "number"));

const rendered = tool("browser_sessions").output.render({}, listing.value)[0].text;
check("render：标出「你」与工作标签", /you: agent-a/.test(rendered) && /\* agent-a — tab 200/.test(rendered), rendered);

const released = await run("browser_sessions", { action: "release" }, "agent-b");
check("release：B 拿回自己释放的 200", released.value.releasedTabId === 200, JSON.stringify(released.value));
await run("browser_click", { selector: "#b-after-release" }, "agent-b");
check("释放后 B 省略 tabId ⇒ 不再注入（回到活动页行为）", last().params.tabId === undefined, JSON.stringify(last()));

const badAction = await run("browser_sessions", { action: "steal" }, "agent-a");
check("非法 action 报出合法清单", badAction.ok === false && /list.*release|release.*list/.test(badAction.error), badAction.error);

/* ============ 4. 只读档 ============ */
{
  const roTools = [];
  const roDisposers = [];
  const roCfg = Config({ stateDir: STATE, enabled: true, port: 9808, token: "sessions-ro", shotsDir: path.join(STATE, "shots"), readOnly: true });
  const roSettings = { register(_ns, schema, options) { const v = schema(options?.base ?? roCfg); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => roDisposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: roSettings, logger: c.logger }); },
    tools: { register: (def) => roTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, roCfg);
  await new Promise((r) => setTimeout(r, 350));
  const roList = await roTools.find((t) => t.name === "browser_sessions").execute({}, { signal: signal(), agent: { id: "ro-agent" } });
  check("只读档：browser_sessions 照常可查（插件本地）", Array.isArray(roList.sessions) && roList.current === "ro-agent");
  roDisposers.reverse().forEach((fn) => { try { fn(); } catch {} });
}

try { ws.close(); } catch {}
disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
