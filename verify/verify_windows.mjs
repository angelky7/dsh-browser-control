// browser_windows 的台子（迭代 10 窗口控制）。三面：
//   扩展侧（真 background.js + 假 chrome.windows）：清单/开窗/更新/关闭/挪标签的
//   契约，重点是回执带**实际**几何（不是请求值）、focused:true 对最小化窗口
//   「还原不压扁」、close 幂等（alreadyGone）且关了必须真的没了。
//   插件侧（真 BridgeServer + 假扩展）：五个 action 各自的字面量分发、只读档
//   对窗口命令的放行/拒绝、分类（windows.open 是唯一写命令）。
import { Config, apply, policyRefusal, READ_ONLY_ALLOWED } from "../lib/index.js";
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/* ============ 扩展侧 ============ */
{
  const { model, ctx } = await bootBackground();
  const a = model.addTab(1, "https://a.test/");
  const b = model.addTab(1, "https://b.test/");
  const out = await ctx.cmdWindowsList();
  const w1 = out.windows.find((w) => w.id === 1);
  check("list：窗口 1 带几何/状态/tabIds", w1?.state === "normal" && w1?.width === 1280 && w1.tabIds.includes(a) && w1.tabIds.includes(b), JSON.stringify(w1));
  check("list：tabCount 如实", w1?.tabCount === 2, String(w1?.tabCount));
}
{
  const { model, ctx } = await bootBackground();
  const out = await ctx.cmdWindowsOpen({ url: ["https://x.test/1", "https://x.test/2"], width: 800, height: 600, left: 10, top: 20 });
  check("open：新窗口按几何开出，URL 各占一个标签", out.id === 2 && out.width === 800 && out.tabCount === 2 && out.tabIds.length === 2, JSON.stringify(out));
  check("open：首个标签 active", model.tabs.get(out.tabIds[0]).active === true, JSON.stringify(model.tabs.get(out.tabIds[0]).active));
}
{
  const { model, ctx } = await bootBackground();
  await ctx.cmdWindowsUpdate({ windowId: 1, state: "maximized" });
  await ctx.cmdWindowsUpdate({ windowId: 1, state: "minimized" });
  const restored = await ctx.cmdWindowsUpdate({ windowId: 1, focused: true });
  check("最小化后 focused:true 还原到最大化（不压成小窗）", restored.state === "maximized" && restored.focused === true, JSON.stringify(restored));
  const moved = await ctx.cmdWindowsUpdate({ windowId: 1, width: 800, height: 600 });
  check("update 回执是实际几何（不是请求值的复读机）", moved.width === 800 && moved.height === 600, JSON.stringify(moved));
  const bad = await ctx.cmdWindowsUpdate({ windowId: 1, state: "tiny" }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("非法 state 报错并列出合法值", /normal, minimized, maximized, fullscreen/.test(String(bad.error)), String(bad.error));
}
{
  const { model, ctx } = await bootBackground();
  const a = model.addTab(1, "https://a.test/");
  const closed = await ctx.cmdWindowsClose({ windowId: 1 });
  check("close：关掉后如实报 closed", closed.closed === true && closed.alreadyGone === false, JSON.stringify(closed));
  check("close：窗口和它的标签一起没了", !model.windows.has(1) && !model.tabs.has(a));
  const again = await ctx.cmdWindowsClose({ windowId: 1 });
  check("close：对已关窗口报 alreadyGone（幂等成功）", again.alreadyGone === true && again.closed === false, JSON.stringify(again));
}
{
  const { model, ctx } = await bootBackground();
  model.addTab(1, "https://a.test/");
  model.winRemoveGhost = 1;
  const out = await ctx.cmdWindowsClose({ windowId: 1 }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("close：remove 假成功也逃不过复查（关了必须真的没了）", /still exists/.test(String(out.error)), String(out.error));
}
{
  const { model, ctx } = await bootBackground();
  const a = model.addTab(1, "https://a.test/");
  await ctx.cmdWindowsOpen({ url: "https://w2.test/" });
  const out = await ctx.cmdWindowsMoveTab({ tabId: a, windowId: 2, index: 0 });
  check("moveTab：标签真的换了窗口", out.moved.length === 1 && model.tabs.get(a).windowId === 2, JSON.stringify(out));
  const missing = await ctx.cmdWindowsMoveTab({ tabId: 999, windowId: 2 });
  check("moveTab：缺失标签进 failed，不拖累整批", missing.failed.length === 1 && missing.moved.length === 0, JSON.stringify(missing));
  const noWin = await ctx.cmdWindowsMoveTab({ tabId: a, windowId: 99 }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("moveTab：目标窗口没了说明白", /no window with id 99/.test(String(noWin.error)), String(noWin.error));
}
{
  const { model, ctx } = await bootBackground();
  const a = model.addTab(1, "https://a.test/");
  await ctx.cmdWindowsUpdate({ windowId: 1, state: "minimized" });
  const err = await ctx.assertWindowNotMinimized(a).then(() => null, (e) => e);
  check("最小化窗口上做输入：结构化报错并指向 browser_windows 的恢复出口", err?.code === "window_minimized" && /browser_windows/.test(String(err?.message)), String(err?.message));
}

/* ============ 插件侧 ============ */
const PORT = 9788;
const TOKEN = "windows-test";
const tools = [];
const disposers = [];
const config = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
    const watchers = [];
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

const winTool = tools.find((t) => t.name === "browser_windows");
check("browser_windows 已注册", Boolean(winTool));
const winProps = winTool?.parameters?.properties ?? {};
check("参数表有 action 与五组动作参数", winProps.action !== undefined && winProps.windowId !== undefined && winProps.tabIds !== undefined && winProps.drawAttention !== undefined, Object.keys(winProps).join(","));

const seenCommands = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.6.0", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seenCommands.push(msg.command);
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { windows: [], id: 3, state: "normal", width: 1280 } }));
  };
  setTimeout(r, 400);
});
const signal = () => new AbortController().signal;

await winTool.execute({ action: "list" }, { signal: signal() });
await winTool.execute({ action: "open", url: "https://o.test/" }, { signal: signal() });
await winTool.execute({ action: "update", windowId: 3, width: 640 }, { signal: signal() });
await winTool.execute({ action: "close", windowId: 3 }, { signal: signal() });
await winTool.execute({ action: "moveTab", windowId: 3, tabIds: [1, 2] }, { signal: signal() });
check("五个 action 各自字面量分发到五条命令", JSON.stringify(seenCommands) === JSON.stringify(["windows.list", "windows.open", "windows.update", "windows.close", "windows.moveTab"]), JSON.stringify(seenCommands));

const unknown = await winTool.execute({ action: "maximize" }, { signal: signal() }).then((r) => r, (e) => ({ error: String(e.message) }));
check("未知 action 报出合法清单", /list\|open\|update\|close\|moveTab/.test(String(unknown.error)), String(unknown.error));
const noWin = await winTool.execute({ action: "close" }, { signal: signal() }).then((r) => r, (e) => ({ error: String(e.message) }));
check("缺 windowId 在插件侧就被拒", /close requires windowId/.test(String(noWin.error)), String(noWin.error));

/* ============ 分类与只读档 ============ */
const { isWriteCommand } = await import("../src/errors.ts");
check("windows.open 是写命令（重试 = 双窗，报 unknown）", isWriteCommand("windows.open") === true, String(isWriteCommand("windows.open")));
check("update/close/moveTab 幂等算读", !isWriteCommand("windows.update") && !isWriteCommand("windows.close") && !isWriteCommand("windows.moveTab"));
check("readOnly 拒 open/update/close/moveTab", ["windows.open", "windows.update", "windows.close", "windows.moveTab"].every((c) => policyRefusal(c, { readOnly: true }) !== undefined));
check("readOnly 放行 windows.list（进白名单）", policyRefusal("windows.list", { readOnly: true }) === undefined && READ_ONLY_ALLOWED.has("windows.list"));

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
