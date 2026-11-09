// 导航后置探针的桥余量护栏（issue #21）。
//
// `cmdNav` 的等待预算用完后还会跑 location.href / 错误页正文 / readyState 三个探针，
// 每个带 2s 预算。卡住的导航会让 CDP 闭嘴，于是探针吃满 2s——总耗时变成
// budget + 4s（错误页 +6s），超过插件给桥留的 +2s，调用方拿到 command_timeout /
// effectState=unknown，而不是已经准备好的 loadPending 回执。
//
// 修法（报告者的方案 B）：后置探针共享命令自己的 deadline；等待已用完预算时直接
// 跳过探针（缺 readyState 是诚实的，误导性超时不是）。这个台子用真 background.js +
// 永不 resolve 的 Runtime.evaluate 演「探针卡死」，断言命令在 budget + 余量内返回。
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/**
 * @param {object} options
 * @param {'nav'|'tabs.open'} options.mode
 * @param {'hang'|'load'} options.navMode  hang = 永不提交；load = 正常 240ms 落地
 * @param {boolean} options.hangProbes  Runtime.evaluate 永不 resolve
 * @param {number} options.budget
 */
async function run({ mode, navMode = "hang", hangProbes = false, budget = 800 }) {
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://start.test/");
  model.nav = navMode;
  // 先焐热一次 CDP（真实 attach），再装「卡死」剧本——否则 attach 本身就会失败。
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1" }));
  if (hangProbes) model.dbg.results["Runtime.evaluate"] = () => new Promise(() => {});
  const started = Date.now();
  const out = mode === "nav"
    ? await ctx.cmdNav({ tabId, url: "https://headroom.test/", waitUntil: "commit", timeoutMs: budget })
    : await ctx.cmdTabsOpen({ url: "https://headroom.test/", waitUntil: "commit", timeoutMs: budget });
  return { elapsed: Date.now() - started, out };
}

/* 1. 对照：正常落地的页面，探针照跑，readyState 在 */
{
  const { elapsed, out } = await run({ mode: "nav", navMode: "load", hangProbes: false, budget: 3000 });
  check("正常落地：总共在预算内返回", elapsed < 3000, `${elapsed}ms`);
  check("正常落地：回执带 readyState，且不许误报 loadPending",
    typeof out.readyState === "string" && out.loadPending !== true, JSON.stringify({ readyState: out.readyState, loadPending: out.loadPending }));
}

/* 2. 探针卡死：旧实现 budget + 4000ms；新实现等待用完就跳过探针 */
{
  const BUDGET = 800;
  const { elapsed, out } = await run({ mode: "nav", navMode: "hang", hangProbes: true, budget: BUDGET });
  check("nav 探针卡死：命令在 budget + 700ms 内返回（不再越过桥余量）",
    elapsed < BUDGET + 700, `${elapsed}ms（budget ${BUDGET}，旧实现约 ${BUDGET + 4000}ms）`);
  check("nav 探针卡死：仍然如实报 loadPending，不假装成功", out.loadPending === true, JSON.stringify(out.loadPending));
  check("nav 探针卡死：跳过的探针不带 readyState（宁可少说）", out.readyState === undefined, String(out.readyState));
}

/* 3. tabs.open 同一条死线（旧实现 budget + 2000ms 起步） */
{
  const BUDGET = 800;
  const { elapsed, out } = await run({ mode: "tabs.open", navMode: "hang", hangProbes: true, budget: BUDGET });
  check("tabs.open 探针卡死：命令在 budget + 700ms 内返回",
    elapsed < BUDGET + 700, `${elapsed}ms（budget ${BUDGET}，旧实现约 ${BUDGET + 2000}ms）`);
  check("tabs.open 探针卡死：仍然如实报 loadPending", out.loadPending === true, JSON.stringify(out.loadPending));
}

console.log(fails === 0 ? "\n后置探针全部贴合命令死线" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
