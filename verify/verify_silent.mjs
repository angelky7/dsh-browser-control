// 静默实测台（2026-11-06）：真实 background.js + 有状态假 Chrome。
//
// 钉住「操作不抢前台」这条承诺：
//   1) browser_press 不再先 chrome.windows.update({focused:true}) + tabs.update({active:true})
//      （真机实测：CDP 键鼠事件在后台标签页同样生效，不需要激活）；
//   2) browser_click 同样不再激活；
//   3) tabs.open 默认后台打开（active:false），账号里那些「不抢前台」的规则才不靠调用方自觉；
//   4) windows.open 默认不聚焦。
// Chrome 原生弹窗（文件选择器 / 权限提示 / 保存面板）仍可能激活窗口，这是 Chrome 行为，
// 不在本台能力范围内——文档里单独说明。
// 用法: node verify/verify_silent.mjs
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** 起一份扩展代码，并给 chrome.windows.update / chrome.tabs.update 装上焦点探针。 */
async function boot() {
  const { model, ctx, sandbox } = await bootBackground();
  const tabId = model.addTab(1, "https://silent.test/");
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", {}));
  model.dbg.log.length = 0;
  const focusCalls = [];
  const winUpdate = sandbox.chrome.windows.update;
  const tabUpdate = sandbox.chrome.tabs.update;
  sandbox.chrome.windows.update = (id, props = {}) => {
    if (props.focused === true) focusCalls.push({ kind: "window", id, props });
    return winUpdate(id, props);
  };
  sandbox.chrome.tabs.update = (id, props = {}) => {
    if (props.active === true) focusCalls.push({ kind: "tab", id, props });
    return tabUpdate(id, props);
  };
  // click 的命中检测走 Runtime.evaluate：返回一个可点击的假元素
  model.dbg.results["Runtime.evaluate"] = () => ({
    result: { value: { x: 10, y: 10, tag: "button", text: "ok", hitTag: "button", isTop: true, bypassedOwnOverlay: false } },
  });
  return { model, ctx, tabId, focusCalls };
}

// ---- 1) press 不再抢前台 ----
{
  const { ctx, tabId, focusCalls } = await boot();
  await ctx.cmdPress({ key: "Escape", tabId });
  check("browser_press 不发 windows.update({focused:true}) / tabs.update({active:true})",
    focusCalls.length === 0, JSON.stringify(focusCalls));
}

// ---- 2) click 不再抢前台 ----
{
  const { ctx, tabId, focusCalls } = await boot();
  await ctx.cmdClick({ selector: "#go", tabId });
  check("browser_click 不发 windows.update({focused:true}) / tabs.update({active:true})",
    focusCalls.length === 0, JSON.stringify(focusCalls));
}

// ---- 3) tabs.open 默认后台 ----
{
  const { model, ctx } = await boot();
  const opened = await ctx.cmdTabsOpen({ url: "https://background.test/" });
  const tab = model.tabs.get(opened.tabId);
  check("tabs.open 不传 active 时默认后台打开", tab?.active === false, `active=${tab?.active}`);
  const explicit = await ctx.cmdTabsOpen({ url: "https://foreground.test/", active: true });
  check("显式 active:true 仍然前台打开（调用方要时能给）", model.tabs.get(explicit.tabId)?.active === true,
    `active=${model.tabs.get(explicit.tabId)?.active}`);
}

// ---- 4) windows.open 默认不聚焦 ----
{
  const { model, ctx } = await boot();
  const opened = await ctx.cmdWindowsOpen({ url: "https://w2.test/" });
  check("windows.open 不传 focused 时默认不聚焦", opened.focused === false && model.windows.get(opened.id)?.focused === false,
    `focused=${opened.focused}`);
}

// ---- 5) 最小化窗口的输入仍然有结构化报错（不是静默失败） ----
{
  const { ctx, tabId } = await boot();
  await ctx.cmdWindowsUpdate({ windowId: 1, state: "minimized" });
  const err = await ctx.assertWindowNotMinimized(tabId).then(() => null, (e) => e);
  check("最小化窗口：输入仍报 window_minimized 并指向 browser_windows",
    err?.code === "window_minimized" && /browser_windows/.test(String(err?.message)), String(err?.message));
}

console.log(fails === 0 ? "\n静默行为全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
