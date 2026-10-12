// 「导航到底有没有落地」实测：跑真实扩展代码，配一台会按剧本演导航的假 Chrome
// （verify/ext_harness.mjs）。这条断言要守住的契约是：**没到位的导航绝不能报成功**。
//
// 来历：PR #12 把「waiter 挂晚了 → 旧文档被当成新文档完成」这个竞态修了，但它留了
// 一个 1200ms 宽限——没看见 loading 就直接认 complete。问题是「导航根本没发生」
// （链接变成了下载、目标被 Chrome 拒载、同 URL 空转）也长这样。实测合并前那版：
// 等满 1.2 秒之后仍然把旧文档的 URL 当成功返回，loadPending 不置位。
// 现在的判据是宽限期后比一次「落到的 URL vs 要去的那个」。
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const OLD = "https://old.test/page";
const TARGET = "https://new.test/dest";

async function navCase({ nav, url = TARGET, timeoutMs = 2600 }) {
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = nav;
  model.loadDelayMs = 150;
  model.slowStartMs = 400;
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url, timeoutMs }).then((r) => r, (e) => ({ error: String(e.message) }));
  return { out, ms: Date.now() - started };
}

/* 1 —— 正常加载：新文档的 URL 原样报出，不带任何告警字段 */
{
  const { out } = await navCase({ nav: "load" });
  check("正常加载：url 就是目标地址", out.url === TARGET, JSON.stringify(out));
  check("正常加载：不该出现 loadPending / siteUnreachable", out.loadPending === undefined && out.siteUnreachable === undefined);
}

/* 2 —— 慢启动竞态：旧文档先保持 complete 400ms（这正是 PR #12 抓的那个 bug） */
{
  const { out, ms } = await navCase({ nav: "slowstart", timeoutMs: 4000 });
  check("慢启动不再骗人：等到新文档而不是 0ms 返回旧文档", out.url === TARGET && ms > 200, `用时 ${ms}ms，url=${out.url}`);
  check("慢启动：没有假 loadPending", out.loadPending === undefined, JSON.stringify(out));
}

/* 3 —— 导航永不发生：必须说出来，而不是报成功 */
{
  const { out, ms } = await navCase({ nav: "stale" });
  check("永不提交的导航被如实报成 loadPending", out.loadPending === true, JSON.stringify(out));
  check("报的是「还停在旧页面 + 还想去哪」", out.url === OLD && out.pendingUrl === undefined, `url=${out.url}`);
  check("确实等过宽限期而不是 0ms 交差", ms > 1000, `用时 ${ms}ms`);
}

/* 4 —— 同 URL 空转：不能因为「没看到 loading」就误报没到位 */
{
  const { out } = await navCase({ nav: "instant", url: OLD });
  check("导航到已经打开着的同一个地址：算成功", out.loadPending === undefined && out.url === OLD, JSON.stringify(out));
}

/* 5 —— 新建标签出生在 about:blank 且立刻 complete（真 Chrome 的样子） */
{
  const { model, ctx } = await bootBackground();
  model.addTab(1, OLD);
  model.createNav = "blip";
  model.loadDelayMs = 200;
  const out = await ctx.cmdTabsOpen({ url: TARGET, wait: true, timeoutMs: 4000, group: false });
  check("新建标签：报出真正提交后的 URL，不是 about:blank", out.url === TARGET, JSON.stringify(out));
  check("新建标签：归组可以显式跳过", out.grouped === false && out.reason === "group:false", JSON.stringify(out));
}

console.log(`\n结论：${fails === 0 ? "导航落地与否如实上报" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
