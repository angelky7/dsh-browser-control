// 静默操作台（PR #25 的适配版）：真 background.js + 有状态假 Chrome。
//
// 我们的取舍：
//   1) click / type(mode:type) / press 不再 focus 窗口、不再 activate 标签页
//      （CDP 输入能落到后台标签页；每次交互把 Chrome 拉到最前是用户反馈的痛点）；
//   2) tabs.open 的默认 active 保持 true —— 「开一个标签页」是显式动作，用户要看见；
//      调 `active:false` 仍可后台开；windows.open 的 focused 默认也不动；
//   3) beforeunload 会激活窗口：tabs.close / tabs.closeMany / nav / back / forward
//      在自动应答策略下先清掉 window.onbeforeunload / window.onunload（best effort）；
//      `waitUntil:'none'` 承诺零 debugger 附着，因此**不清**（不为它打破旧契约）；
//   4) 最小化窗口的真实输入仍报 window_minimized，不是静默失败。
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** 起一份扩展代码，给 windows.update / tabs.update 装焦点探针。 */
async function boot({ warm = true } = {}) {
  const { model, ctx, sandbox } = await bootBackground();
  const tabId = model.addTab(1, "https://silent.test/");
  if (warm) await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", {}));
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
  return { model, ctx, sandbox, tabId, focusCalls };
}

// click 的命中检测走 Runtime.evaluate：返回一个可点击的假元素。
const clickable = () => ({
  result: { value: { x: 10, y: 10, tag: "button", text: "ok", hitTag: "button", isTop: true, bypassedOwnOverlay: false } },
});

/* 1) press 不再抢前台 */
{
  const { ctx, tabId, focusCalls } = await boot();
  await ctx.cmdPress({ key: "Escape", tabId });
  check("press：不发 windows.update({focused:true}) / tabs.update({active:true})",
    focusCalls.length === 0, JSON.stringify(focusCalls));
}

/* 2) click 不再抢前台 */
{
  const { ctx, model, tabId, focusCalls } = await boot();
  model.dbg.results["Runtime.evaluate"] = clickable;
  await ctx.cmdClick({ selector: "#go", tabId });
  check("click：不发 windows.update({focused:true}) / tabs.update({active:true})",
    focusCalls.length === 0, JSON.stringify(focusCalls));
}

/* 3) type 模式不再抢前台（begin 在 locate 之前就会检查） */
{
  const { ctx, tabId, focusCalls } = await boot();
  await ctx.cmdInput({ selector: "#q", value: "hi", mode: "type", tabId }).then(() => {}, () => {});
  check("type：不发 windows.update({focused:true}) / tabs.update({active:true})",
    focusCalls.length === 0, JSON.stringify(focusCalls));
}

/* 4) tabs.open 默认 active 保持 true；显式 false 才后台 */
{
  const { model, ctx } = await boot({ warm: false });
  const opened = await ctx.cmdTabsOpen({ url: "https://foreground.test/" });
  const tab = model.tabs.get(opened.tabId);
  check("tabs.open 默认仍前台打开（显式动作，用户要看见）", tab?.active === true, `active=${tab?.active}`);
  const background = await ctx.cmdTabsOpen({ url: "https://background.test/", active: false });
  check("tabs.open 显式 active:false 后台打开", model.tabs.get(background.tabId)?.active === false,
    `active=${model.tabs.get(background.tabId)?.active}`);
}

/* 5) close 之前先清 beforeunload */
{
  const { model, ctx, tabId } = await boot();
  model.dbg.log.length = 0;
  await ctx.cmdTabsClose({ tabId });
  const cleared = model.dbg.log.some((e) => e.method === "Runtime.evaluate"
    && String(e.params?.expression || "").includes("onbeforeunload"));
  check("tabs.close：先清 onbeforeunload（Chrome 离开提示会激活窗口）", cleared,
    JSON.stringify(model.dbg.log.filter((e) => e.method === "Runtime.evaluate").slice(-1)));
}

/* 6) nav 非 none 档先清 beforeunload */
{
  const { model, ctx, tabId } = await boot();
  model.nav = "load";
  model.dbg.log.length = 0;
  await ctx.cmdNav({ url: "https://next.test/", tabId, waitUntil: "commit", timeoutMs: 800 });
  const cleared = model.dbg.log.some((e) => e.method === "Runtime.evaluate"
    && String(e.params?.expression || "").includes("onbeforeunload"));
  check("nav（commit 档）：先清 onbeforeunload", cleared, "");
}

/* 7) waitUntil:none 仍然零 debugger 附着（旧契约，不为清钩子打破） */
{
  const { model, ctx, tabId } = await boot({ warm: false });
  model.nav = "hang";
  const before = model.dbg.attachCount;
  await ctx.cmdNav({ url: "https://none.test/", tabId, waitUntil: "none" });
  check("nav waitUntil:none：不附着 debugger（attachCount 不变）", model.dbg.attachCount === before,
    `${before} -> ${model.dbg.attachCount}`);
  const cleared = model.dbg.log.some((e) => e.method === "Runtime.evaluate"
    && String(e.params?.expression || "").includes("onbeforeunload"));
  check("nav waitUntil:none：不清 beforeunload（没有附着就没有清）", !cleared, "");
}

/* 8) 最小化窗口的输入仍然结构化报错 */
{
  const { ctx, tabId } = await boot();
  await ctx.cmdWindowsUpdate({ windowId: 1, state: "minimized" });
  const err = await ctx.assertWindowNotMinimized(tabId).then(() => null, (e) => e);
  check("最小化窗口：仍报 window_minimized 并指向 browser_windows",
    err?.code === "window_minimized" && /browser_windows/.test(String(err?.message)), String(err?.message));
}

/* 9) 清钩子自身有上限：卡死的页面不能把 close 挂住 */
{
  const { model, ctx, tabId } = await boot();
  model.dbg.results["Runtime.evaluate"] = () => new Promise(() => {});
  const started = Date.now();
  const closed = await ctx.cmdTabsClose({ tabId }).then(() => true, () => false);
  const elapsed = Date.now() - started;
  check("清 beforeunload 卡死：close 仍在 ~1.2s 内返回并真的关掉标签",
    closed && elapsed < 1500 && model.tabs.get(tabId) === undefined, `${elapsed}ms closed=${closed}`);
}

console.log(fails === 0 ? "\n不抢前台契约全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
