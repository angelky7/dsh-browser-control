// 标签分组的真实行为：在 node:vm 里跑扩展**真实的** service worker，配一台有状态的
// 假 `chrome.tabs` / `chrome.tabGroups`（verify/ext_harness.mjs），断言建组 / 复用 /
// 退避重试 / 缓存失效 / 按标题找回 / 按窗口拆组 / 无权限降级。
//
// 这套断言存在的原因：分组是给用户看的可见副作用。建出两个组、往已死的 groupId 上塞
// 标签、或者漏了 manifest 权限却当成能用了，都不会让工具报错，只会悄悄变难看。
import { readFile } from "node:fs/promises";
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

async function boot({ withTabGroups = true, failGroupTimes = 0, model } = {}) {
  const browser = model ?? makeModel({ failGroupTimes });
  const { ctx } = await bootBackground({ model: browser, withTabGroups });
  return { model: browser, ctx };
}

const openTab = (ctx, url, extra = {}) => ctx.cmdTabsOpen({ url, wait: false, ...extra });

/* 1 —— 没有 tabGroups 权限/接口时必须干净降级，且不能连累「打开标签页」 */
{
  const { model, ctx } = await boot({ withTabGroups: false });
  const res = await openTab(ctx, "https://no-api.test");
  check("缺 tabGroups 时 open 仍然成功（分组只是锦上添花）",
    typeof res.tabId === "number" && res.grouped === false, JSON.stringify(res));
  check("缺 tabGroups 时一个组都不建", model.groups.size === 0 && model.calls.group === 0);
  check("降级原因说清了是 API 不可用", /tabGroups/.test(String(res.reason)), res.reason);
}

/* 2 —— 建组、复用、把散标签拉进来 */
{
  const { model, ctx } = await boot();
  const a = await openTab(ctx, "https://a.test");
  const b = await openTab(ctx, "https://b.test");
  const groups = [...model.groups.values()];
  check("首次 open 建出 DSH 蓝色组",
    a.grouped === true && a.created === true && groups.length === 1 && groups[0].title === "DSH" && groups[0].color === "blue",
    JSON.stringify(groups));
  check("第二次 open 复用同一组（不重复建组）",
    b.grouped === true && b.created === false && b.groupId === a.groupId && model.groups.size === 1,
    `${a.groupId} vs ${b.groupId}`);
  check("两个标签页都真的在组里",
    model.tabs.get(a.tabId).groupId === a.groupId && model.tabs.get(b.tabId).groupId === a.groupId);

  const noGroup = await openTab(ctx, "https://nomark.test", { group: false });
  check("group:false 时 open 不归组",
    noGroup.grouped === false && model.tabs.get(noGroup.tabId).groupId === -1 && model.groups.size === 1,
    JSON.stringify(noGroup));

  const loose = model.addTab(1, "https://manual.test");
  const r = await ctx.cmdTabGroup({ tabId: loose });
  check("tabs.group 把已有散标签拉进组",
    r.grouped === true && r.groupId === a.groupId && r.created === false && model.tabs.get(loose).groupId === a.groupId,
    JSON.stringify(r));
  const missing = await ctx.cmdTabGroup({ tabId: 424242 }).then(() => null, (e) => String(e.message));
  check("tabs.group 对不存在的标签页明确报错", missing !== null && /不存在|No tab/.test(missing), missing);
}

/* 3 —— 刚 create 就 group 会跟 Chrome 打架：退避重试要生效，且次数有上限 */
{
  const { model, ctx } = await boot({ failGroupTimes: 1 });
  const started = Date.now();
  const a = await openTab(ctx, "https://retry.test");
  check("建组首枪失败后靠重试成功", a.grouped === true && model.groups.size === 1, JSON.stringify(a));
  check("重试前真的退避过（≥50ms）", Date.now() - started >= 45, `${Date.now() - started}ms`);
  check("只多打了一次 tabs.group", model.calls.group === 2, `实际 ${model.calls.group} 次`);
}
{
  const { model, ctx } = await boot({ failGroupTimes: 99 });
  const a = await openTab(ctx, "https://never.test");
  check("永久失败时放弃归组，但 open 不失败", a.grouped === false && typeof a.tabId === "number", JSON.stringify(a));
  check("退避有上限（1 次 + 3 次重试 = 4 枪）", model.calls.group === 4, `实际 ${model.calls.group} 次`);
  check("把最后一枪的错误带回来了", /being moved/.test(String(a.reason)), a.reason);
}

/* 4 —— 用户手动拆组后缓存变脏：不能往死 groupId 上塞标签 */
{
  const { model, ctx } = await boot();
  const a = await openTab(ctx, "https://x.test");
  model.groups.delete(a.groupId);
  for (const t of model.tabs.values()) t.groupId = -1;
  const b = await openTab(ctx, "https://y.test");
  check("缓存的组没了就重建，不塞死 id",
    b.grouped === true && b.created === true && b.groupId !== a.groupId && model.tabs.get(b.tabId).groupId === b.groupId,
    JSON.stringify(b));
}

/* 5 —— 按标题反查：service worker 重启后内存缓存是空的，仍要找回原来的组 */
{
  const { model, ctx } = await boot();
  const a = await openTab(ctx, "https://q.test");
  const revived = await boot({ model });
  const joined = await revived.ctx.cmdTabGroup({ tabId: model.addTab(1, "https://r.test") });
  check("无缓存时按标题找回原组（不新建第二个）",
    joined.grouped === true && joined.created === false && joined.groupId === a.groupId && model.groups.size === 1,
    JSON.stringify(joined));
}

/* 6 —— 拆组：按窗口和全局两种范围，拆完缓存要清掉 */
{
  const { model, ctx } = await boot();
  const w1 = await openTab(ctx, "https://w1.test");
  const t2 = model.addTab(2, "https://w2.test");
  const g2 = await ctx.addToAgentGroup(t2);
  check("第二个窗口各自有自己的组", g2.grouped === true && g2.created === true && model.groups.size === 2, JSON.stringify(g2));

  const scoped = await ctx.cmdTabUngroup({ windowId: 1 });
  check("按 windowId 拆组只拆本窗口",
    scoped.ungrouped === 1 && model.tabs.get(w1.tabId).groupId === -1 && model.tabs.get(t2).groupId === g2.groupId,
    JSON.stringify(scoped));

  const all = await ctx.cmdTabUngroup({});
  check("不带 windowId 拆掉所有 DSH 组",
    all.ungrouped >= 1 && model.groups.size === 0 && [...model.tabs.values()].every((t) => t.groupId === -1),
    JSON.stringify(all));

  const after = await openTab(ctx, "https://after.test");
  check("拆完之后再 open 会重新建组（缓存确实清了）",
    after.created === true && model.groups.size === 1, JSON.stringify(after));
}

/* 7 —— 权限声明：漏了 manifest 权限，上面所有代码都会静默变成降级 */
{
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  check("manifest 声明了 tabGroups 权限", (manifest.permissions ?? []).includes("tabGroups"), JSON.stringify(manifest.permissions));
  check("manifest 没有顺手多要 host_permissions", (manifest.host_permissions ?? []).length === 0, JSON.stringify(manifest.host_permissions ?? []));
}

console.log(`\n结论：${fails === 0 ? "分组行为全部符合预期" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
