// CDP 会话丢失时的行为护栏（跑真实的扩展代码，chrome.debugger 是有状态的假实现）。
//
// 由来：PR #7（BeiWay1145）修的是「Chrome 单方面收回会话后，扩展的 attachedTabs
// 缓存还说附着着，之后每条命令都失败」。核心修复没问题，但他第一版把整个 withCDP
// 闭包重放了一次——实测一次 click 的 Input.dispatchMouseEvent 从 2 次变 3 次，
// `mode:'type'` 的逐字符 insertText 会重复输入。他后来按「只在闭包第一次 send 就失败时
// 才重放」改了。这里的断言就是为了让**这两件事都不能再悄悄回来**：
//   1) 会话被抢走后能不能恢复（PR #7 的核心）
//   2) 恢复过程中不许把已有副作用重做一遍（PR #7 曾经的缺陷）
//
// 场景 S1 在合并 PR #7 之前是「钉住已知缺陷」的方向。合并时把环境变量
// `CDP_RETRY_FIXED=1` 一起改进 CI/本命令，断言就会翻成「必须重新 attach 并成功」——
// 逼着改 PR 的人当面确认这条真被修好了，而不是留一个永远绿的空断言。
//
// 用法：node verify/verify_cdp_retry.mjs [background.js 的相对路径]
import { bootBackground } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
/**
 * 会话恢复在 main 上修好了没有？合并带这个修复的 PR 时把这里改成 true。
 * S1 的断言方向跟着它走：改回 true 之后，「抢完会话还不重连」就会红。
 * （用常量而不是环境变量，是因为 npm 脚本在 Windows 上默认走 cmd，`X=1 node …` 那种写法不成立。）
 */
const FIXED_ON_MAIN = true;
const EXPECT_FIXED = process.env.CDP_RETRY_FIXED ? process.env.CDP_RETRY_FIXED === "1" : FIXED_ON_MAIN;

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const DETACHED_MIDWAY = "Detached while handling command.";

/** 起一份扩展代码 + 一个标签页，先把 CDP 会话焐热（真实 attach），**之后**才装失败剧本。 */
async function warm({ failPlan = null, attachPlan = null } = {}) {
  const { model, ctx } = await bootBackground(CANDIDATE ? { backgroundPath: CANDIDATE } : {});
  const tabId = model.addTab(1, "https://retry.test");
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", {}));
  model.dbg.failPlan = failPlan;
  model.dbg.attachPlan = attachPlan;
  return { model, ctx, tabId, sends: model.dbg.sends, base: { ...model.dbg.sends }, attaches: model.dbg.attachCount };
}

const delta = (sends, base, method) => (sends[method] || 0) - (base[method] || 0);
const settle = () => new Promise((r) => setTimeout(r, 10));

/* S1 —— 会话被 Chrome 抢走之后，下一条命令还能不能干活 */
{
  const w = await warm();
  w.model.fireDetach(w.tabId);
  await settle();
  const outcome = await w.ctx.withCDP(w.tabId, (send) => send("Runtime.evaluate", {}))
    .then(() => "成功", (e) => `失败：${String(e.message).slice(0, 46)}`);
  const recovered = outcome === "成功";
  check(`S1 ${EXPECT_FIXED ? "（已合并 PR #7）会话被抢走后必须重新 attach 并成功" : "（合并前）会话被抢走后仍卡在过期缓存里，命令失败"}`,
    EXPECT_FIXED ? recovered : !recovered,
    `${outcome}｜attach 次数 ${w.model.dbg.attachCount}（焐热时 ${w.attaches}）`);
  if (!EXPECT_FIXED && recovered) {
    console.log("      ↳ 已经能恢复了：说明 PR #7 的核心修复进来了，请把这条断言连 CDP_RETRY_FIXED=1 一起翻正");
  }
}

/* S2 —— 一次 click 走到第 3 条 CDP 才丢会话：前面已落的副作用绝对不许重做 */
{
  const w = await warm({ failPlan: (method, nth) => (method === "Input.dispatchMouseEvent" && nth >= 2 ? DETACHED_MIDWAY : null) });
  const outcome = await w.ctx.withCDP(w.tabId, async (send) => {
    await send("Runtime.evaluate", {});                                 // 有副作用：scrollIntoView
    await send("Input.dispatchMouseEvent", { type: "mousePressed" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased" });
  }).then(() => "成功", () => "报错（本来就该报错）");
  const evaluate = delta(w.sends, w.base, "Runtime.evaluate");
  const mouse = delta(w.sends, w.base, "Input.dispatchMouseEvent");
  check("S2 中途丢会话时，一次 click 仍然只派发 2 个鼠标事件（不许重放成 3 个）",
    mouse === 2 && evaluate === 1, `evaluate=${evaluate} mouse=${mouse}｜${outcome}`);
  check("S2 失败要如实抛出，不能假装成功", outcome === "报错（本来就该报错）", outcome);
}

/* S3 —— 每次都失败的会话：重试必须有界，不能变成死循环 */
{
  const w = await warm({ failPlan: () => "The tab is not attached to the debugger." });
  const outcome = await w.ctx.withCDP(w.tabId, (send) => send("Runtime.evaluate", {})).then(() => "成功", () => "报错");
  const evaluate = delta(w.sends, w.base, "Runtime.evaluate");
  check("S3 永久失败时最多两次尝试就放弃（有界重试）", evaluate >= 1 && evaluate <= 2 && outcome === "报错",
    `Runtime.evaluate=${evaluate} 次，attach ${w.model.dbg.attachCount - w.attaches} 次新增，结果=${outcome}`);
}

/* S4 —— 普通业务错误不是「会话丢了」，一次都不许多打 */
{
  const w = await warm({ failPlan: (method) => (method === "Runtime.evaluate" ? "No element found for selector" : null) });
  const outcome = await w.ctx.withCDP(w.tabId, (send) => send("Runtime.evaluate", {})).then(() => "成功", () => "报错");
  const evaluate = delta(w.sends, w.base, "Runtime.evaluate");
  const extraAttach = w.model.dbg.attachCount - w.attaches;
  check("S4 非会话类错误不触发重连重放", evaluate === 1 && extraAttach === 0 && outcome === "报错",
    `evaluate=${evaluate} attach 新增=${extraAttach} 结果=${outcome}`);
}

/* S5 —— 只有一条 send 的读命令：允许被救回，但尝试次数仍然有界 */
{
  const w = await warm({ failPlan: (method, nth) => (method === "Runtime.evaluate" && nth === 1 ? DETACHED_MIDWAY : null) });
  const outcome = await w.ctx.withCDP(w.tabId, (send) => send("Runtime.evaluate", {})).then(() => "成功", () => "报错");
  const evaluate = delta(w.sends, w.base, "Runtime.evaluate");
  check("S5 单条 send 的读命令最多打 2 次", evaluate <= 2, `实际 ${evaluate} 次，结果=${outcome}`);
}

/* S6 —— 假 debugger 本身要够真：没附着时 sendCommand 必须报「not attached」，且带上正确的 tabId */
{
  const { model, ctx } = await bootBackground(CANDIDATE ? { backgroundPath: CANDIDATE } : {});
  const tabId = model.addTab(1, "https://fresh.test");
  const err = await ctx.dbgSend(tabId, "Runtime.evaluate", {}).then(() => null, (e) => String(e.message));
  check("S6 未附着就发命令，假 Chrome 按真 Chrome 的文案回错（并带上 tabId）",
    err !== null && err.includes(`with id: ${tabId}`) && /not attached/.test(err), err);
}

console.log(`\n被测代码：${CANDIDATE ?? "extension/background.js（仓库当前版）"}  S1 期望：${EXPECT_FIXED ? "已修" : "未修（钉住缺陷）"}`);
console.log(`结论：${fails === 0 ? "会话恢复与重放护栏全部通过" : fails + " 项不通过"}`);
process.exit(fails ? 1 : 0);
