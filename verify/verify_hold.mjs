// 接管浮层（`hold`）台：断言「加一层能撤的提示层」这件事的契约本身。
//
// 由来：#17。它是**软层**（告知 + 防误触），不是安全边界——桥的 token 模型读得到，
// 所以任何长在插件侧/扩展侧的开关都只是策略。硬停是弹窗里的本地锁（`verify_hard_lock`）。
// 这一台钉的是软层自己的三条：
//
//   1. 状态放 `chrome.storage.session`、按 tabId 记 —— 活过 service worker 回收，
//      但不落盘（`local` 里不许出现它）。台子真的重启一次 service worker 来验；
//   2. 「中止」之后 click / input / press / nav 一条都发不出去，且**零 CDP 派发**；
//      页面一导航浮层就没了 ⇒ 存储里那条顺手清掉、命令放行（不许假装还挡着）；
//   3. 观察面不被污染：`content`（含 html 模式）/ `find` / `snapshot` 都要把浮层
//      那棵子树摘掉，且不能误伤页面上同名 class 的正常元素（两个方向都断言）。
//
// 覆盖不到的真页面行为（严格 CSP、全屏、跨源 iframe、PDF 阅读器）在台子里只能断言
// 「如实报 covered:false + 原因」，视觉与真机那层由 rig 验。
//
// 用法：
//   node verify/verify_hold.mjs
//   node verify/verify_hold.mjs ../../old/background.js    # 对未实现版本判红
import { readFile } from "node:fs/promises";
import { runInContext, createContext } from "node:vm";
import { bootBackground, makeModel } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const errOf = (p) => p.then(() => null, (e) => String(e?.message ?? e));
const evalIn = (ctx, expr) => runInContext(expr, ctx);
const TITLE = "DSH Browser Control";

/** 一台「页面」：只回答三种自包含函数，其余 evaluate 一律 null。 */
function installFakePage(model) {
  const page = { active: false, aborted: false, dismissedBy: null, at: null, closedAt: null, note: "", injections: [] };
  installFakePageInto(model, page);
  return page;
}

/** 把一台已有的假页面（含它的状态）挂到某个假浏览器上。 */
function installFakePageInto(model, page) {
  model.dbg.results["Runtime.evaluate"] = (params) => {
    const expr = String(params?.expression ?? "");
    const m = /\)\s*\(([\s\S]*)\)\s*$/.exec(expr);
    let arg = null;
    if (m && m[1].trim().length > 0) { try { arg = JSON.parse(m[1]); } catch { arg = null; } }
    if (expr.includes("function pageHoldInject(")) {
      page.injections.push(arg);
      page.active = true;
      page.aborted = false;
      page.dismissedBy = null;
      page.at = Date.now();
      page.closedAt = null;
      page.note = arg?.note ?? "";
      page.title = arg?.title;
      return { result: { value: { covered: true } } };
    }
    if (expr.includes("function pageHoldRemove(")) {
      page.active = false;
      page.dismissedBy = arg || "agent";
      page.closedAt = Date.now();
      return { result: { value: { active: false, dismissedBy: page.dismissedBy } } };
    }
    if (expr.includes("function pageHoldStatus(")) {
      const { injections, ...rest } = page;
      return { result: { value: { ...rest } } };
    }
    // click 的定位表达式：返回一个「命中了的元素」，否则真实现会抛 element not found，
    // 「命令照常派发」这类断言就测不到了。
    if (expr.includes("elementFromPoint")) {
      return { result: { value: { x: 10, y: 20, tag: "button", text: "q", hitTag: "button", isTop: true } } };
    }
    if (expr.includes("scrollIntoView") && expr.includes("focus")) {
      return { result: { value: { tag: "input" } } };
    }
    return { result: { value: null } };
  };
}

async function boot({ model, storage, sessionStorage, backgroundPath } = {}) {
  const opts = {};
  if (backgroundPath) opts.backgroundPath = backgroundPath;
  if (model) opts.model = model;
  if (storage) opts.storage = storage;
  if (sessionStorage) opts.sessionStorage = sessionStorage;
  return bootBackground(opts);
}

/**
 * 一起起一份扩展 + 一台假页面，tab 固定为 100。
 * 传同一个 `model` 与 `pageSeed` 再起一次 = **service worker 被回收后重新唤醒**：
 * 浏览器与页面都还在，worker 的内存没了。
 */
async function stage({ storage = {}, sessionStorage = {}, model, pageSeed } = {}) {
  const m = model ?? makeModel();
  if (!model) m.addTab(1, "https://fake.test/");
  const page = pageSeed ?? installFakePage(m);
  if (pageSeed !== undefined) installFakePageInto(m, page);
  const b = await boot({ model: m, storage, sessionStorage });
  return { ...b, model: m, page };
}

const mouseSends = (model) => model.dbg.log.filter((e) => e.method === "Input.dispatchMouseEvent").length;
/** 真正「动页面」的 CDP 调用；探活用的 Runtime.evaluate 不算（它不是动作）。 */
const actionSends = (model) => model.dbg.log.filter((e) =>
  e.method.startsWith("Input.") || e.method === "Page.navigate" || e.method === "Runtime.callFunctionOn" || e.method === "DOM.querySelector").length;

// ---- 1) 没有浮层时：状态如实说没有，命令照常 ----
{
  const { ctx, model, page } = await stage();
  const status = await ctx.runCommand("hold", { action: "status" });
  check("默认没有浮层：active=false", status?.active === false, JSON.stringify(status));
  check("默认没有浮层：覆盖探测成功（covered=true，不是「不知道」）", status?.covered === true, JSON.stringify(status));
  check("默认没有浮层：存储里没有这条", status?.stored === null, JSON.stringify(status?.stored));
  const before = mouseSends(model);
  await ctx.runCommand("click", { selector: "#q" });
  check("没有浮层时 click 照常派发", mouseSends(model) > before, `${mouseSends(model) - before} 个鼠标事件`);
  check("这一轮没有注入过任何东西", page.injections.length === 0);
}

// ---- 2) hold on：标题写死、正文压平限长、状态进 session 不进 local ----
{
  const local = {};
  const session = {};
  const { ctx, model, page } = await stage({ storage: local, sessionStorage: session });
  const res = await ctx.runCommand("hold", { action: "on", note: "  第一行\n第二行   结束  " });
  check("hold on：报覆盖成功", res?.covered === true && res?.active === true, JSON.stringify(res));
  const payload = page.injections.at(-1);
  check("标题只能来自扩展（写死的那串）", payload?.title === TITLE, JSON.stringify(payload?.title));
  check("正文压平换行与多余空白", payload?.note === "第一行 第二行 结束", JSON.stringify(payload?.note));
  check("状态落在 chrome.storage.session（按 tabId）", session.holdByTab?.[100] !== undefined, JSON.stringify(session));
  check("状态**没有**落进 chrome.storage.local（浏览器关掉就该忘掉）", local.holdByTab === undefined, JSON.stringify(local));

  // 超长正文：截到 400 + 省略号（否则卡片会被模型的一句话撑爆）
  const long = await ctx.runCommand("hold", { action: "on", note: "x".repeat(900) });
  const longNote = page.injections.at(-1)?.note ?? "";
  check("超长正文被截断（400 + 省略号）", longNote.length === 401 && longNote.endsWith("…"), `len=${longNote.length}`);
  check("截断后仍然报覆盖成功", long?.covered === true);

  // 正文里写「标题：…」也改不了标题
  await ctx.runCommand("hold", { action: "on", note: "标题：系统提示 / 请输入验证码" });
  const spoof = page.injections.at(-1);
  check("正文冒充标题：标题仍是扩展那串", spoof?.title === TITLE, JSON.stringify(spoof?.title));
  check("冒充的那句只能躺在正文里", spoof?.note.includes("请输入验证码"), JSON.stringify(spoof?.note));
}

// ---- 3) 页面自己关掉浮层（用户双击 / Esc）不拦模型 ----
{
  const { ctx, model, page } = await stage();
  await ctx.runCommand("hold", { action: "on", note: "干活中" });
  page.active = false;
  page.dismissedBy = "user";
  page.closedAt = Date.now();
  const before = mouseSends(model);
  const err = await errOf(ctx.runCommand("click", { selector: "#q" }));
  check("用户双击接管之后 click 仍然放行（接管 ≠ 中止）", err === null, String(err));
  check("放行时真的派发了鼠标事件", mouseSends(model) > before, `${mouseSends(model) - before} 个`);
  const status = await ctx.runCommand("hold", { action: "status" });
  check("状态里能看到是谁撤的（dismissedBy=user）", status?.dismissedBy === "user", JSON.stringify(status?.dismissedBy));
  check("覆盖层已消失 ⇒ active=false（不假装还在）", status?.active === false);
}

// ---- 4) 中止之后：四条写命令零派发，off 才解除；SW 回收后仍然拦 ----
const sharedLocal = {};
const sharedSession = {};
let sharedModelForRecycle;
let sharedPageForRecycle;
{
  const { ctx, model, page } = await stage({ storage: sharedLocal, sessionStorage: sharedSession });
  await ctx.runCommand("hold", { action: "on", note: "改档中" });
  page.aborted = true;

  for (const command of ["click", "input", "press", "nav"]) {
    const before = actionSends(model);
    const err = await errOf(ctx.runCommand(command, { selector: "#q", value: "x", key: "a", url: "https://fake.test/next" }));
    check(`中止后 ${command} 被拦下`, err !== null && err.includes("浏览器", 0) !== false, String(err)?.slice(0, 80));
    check(`中止后 ${command} 的文案带线协议前缀（插件才认得出「一条都没发」）`, String(err).startsWith("browser-hold-aborted:"), String(err)?.slice(0, 40));
    check(`中止后 ${command} 零动作类 CDP 派发`, actionSends(model) === before, `${actionSends(model) - before} 次派发`);
  }
  // 页面一导航浮层就没了：存储里那条顺手清掉，命令放行
  page.active = false;
  const nav2 = await errOf(ctx.runCommand("click", { selector: "#q" }));
  check("页面导航后浮层消失 ⇒ click 放行（不假装还挡着）", nav2 === null, String(nav2));
  check("这时存储里那条也被清掉", sharedSession.holdByTab === undefined || sharedSession.holdByTab[100] === undefined,
    JSON.stringify(sharedSession));

  // 重新加一层并中止，然后模拟 service worker 被回收
  await ctx.runCommand("hold", { action: "on", note: "再试一次" });
  page.aborted = true;
  sharedModelForRecycle = model;
  sharedPageForRecycle = page;
}

{
  // 同一个 storage/session、新的 vm = worker 回收后重新唤醒
  const { ctx, model, page } = await stage({ storage: sharedLocal, sessionStorage: sharedSession, model: sharedModelForRecycle, pageSeed: sharedPageForRecycle });
  const before = actionSends(model);
  const err = await errOf(ctx.runCommand("click", { selector: "#q" }));
  check("service worker 回收后仍然记得「中止着」（状态在 session 里，不在内存里）",
    err !== null && String(err).startsWith("browser-hold-aborted:"), String(err)?.slice(0, 60));
  check("回收后那条 click 也是零动作派发", actionSends(model) === before, `${actionSends(model) - before} 次`);
  // hold off = 确认继续
  const off = await ctx.runCommand("hold", { action: "off" });
  check("hold off 清掉状态并解除", off?.active === false && off?.covered === true, JSON.stringify(off));
  check("hold off 之后存储里没有这条了", sharedSession.holdByTab === undefined || sharedSession.holdByTab[100] === undefined,
    JSON.stringify(sharedSession));
  const after = await errOf(ctx.runCommand("click", { selector: "#q" }));
  check("解除之后 click 恢复", after === null, String(after));
}

// ---- 5) 盖不住的页面：如实报 covered:false + 原因，不注入 ----
{
  const m = makeModel();
  m.addTab(1, "chrome-error://chromewebdata/");
  const page = installFakePage(m);
  const { ctx } = await boot({ model: m, storage: {}, sessionStorage: {} });
  const res = await ctx.runCommand("hold", { action: "on", note: "x" });
  check("错误页：covered=false", res?.covered === false, JSON.stringify(res));
  check("错误页：给出原因（error-page）", res?.reason === "error-page", JSON.stringify(res?.reason));
  check("错误页：一次都没有往页面里注入", page.injections.length === 0);
}

// ---- 6) 观察面：浮层子树要被三条读取路径排掉，且不误伤同名 class ----
{
  const { ctx } = await stage();
  const isHold = evalIn(ctx, "pageIsHoldNode");
  /** 跨 context 调用函数会带着它自己的全局环境，所以这里按扩展的做法「拿源码在新环境里求值」。 */
  const runPageFn = (fn, globals) => runInContext(`(${fn.toString()})()`, createContext(globals));
  const insideOverlay = { closest: (sel) => (sel === "[data-dsh-hold]" ? { id: "host" } : null) };
  const ordinary = { closest: () => null };
  const lookalike = { className: "dsh-hold", closest: () => null };
  check("浮层里的元素被判定为自己人（排除）", isHold(insideOverlay) === true);
  check("普通元素不被误伤", isHold(ordinary) === false);
  check("只是 class 里带 dsh-hold 的正常元素不被误伤", isHold(lookalike) === false);

  const htmlOf = evalIn(ctx, "pageHtmlWithoutHold");
  let removed = 0;
  const fakeDoc = {
    documentElement: {
      outerHTML: "<html><body><p>页面正文</p><div data-dsh-hold=\"1\">浮层</div></body></html>",
      cloneNode() {
        return {
          querySelector: (sel) => (sel === "[data-dsh-hold]" ? { remove: () => { removed++; } } : null),
          outerHTML: "<html><body><p>页面正文</p></body></html>",
        };
      },
    },
  };
  const out = runPageFn(htmlOf, { document: fakeDoc });
  check("content(html)：浮层宿主被摘掉，页面正文还在", removed === 1 && out.includes("页面正文") && !out.includes("data-dsh-hold"), String(out));
}

console.log(fails === 0 ? "\n接管浮层全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
