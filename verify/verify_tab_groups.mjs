// 标签分组的真实行为：在 node:vm 里加载扩展的 service worker，用一套**有状态**的
// chrome.tabs / chrome.tabGroups 假浏览器来跑，断言「建组 / 复用 / 退避重试 /
// 缓存失效 / 按窗口拆组 / 无权限降级」。
//
// 这套断言存在的原因：分组是给用户看的可见副作用。建出两个组、往已死的 groupId
// 上塞标签、或者漏了 manifest 权限却当成能用了，都不会让工具报错，只会悄悄变难看。
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const BG_URL = new URL("../extension/background.js", import.meta.url);
const BG_CODE = await readFile(BG_URL, "utf8");

/** 一台内存里的假浏览器：标签页和分组是真的对象，操作会改状态。 */
function makeModel({ failGroupTimes = 0 } = {}) {
  return {
    tabs: new Map(),
    groups: new Map(),
    nextTabId: 100,
    nextGroupId: 500,
    calls: { group: 0, ungroup: 0, create: 0 },
    failGroupTimes,
    addTab(windowId, url) {
      const id = this.nextTabId++;
      this.tabs.set(id, { id, windowId, groupId: -1, url, title: url, active: false });
      return id;
    },
  };
}

/** 未建模的 chrome 命名空间一律打桩，保证 background.js 加载不炸。 */
function stub(path, state) {
  return new Proxy(function () {}, {
    get: (_t, k) => {
      if (typeof k !== "string") return undefined;
      if (k === "lastError") return state.lastError;
      if (k === "then" || k === "catch" || k === "finally") return undefined;
      if (k === "addListener") return () => {};
      return stub(`${path}.${k}`, state);
    },
    apply: () => Promise.resolve({ result: { value: null } }),
  });
}

function makeChrome(model, { withTabGroups }) {
  const state = { lastError: undefined };
  const resolve = (v) => Promise.resolve(v);
  const reject = (m) => Promise.reject(new Error(m));

  const dropEmptyGroups = () => {
    for (const [gid, group] of model.groups) {
      if (![...model.tabs.values()].some((t) => t.groupId === gid)) model.groups.delete(gid);
    }
  };

  const listener = () => ({ addListener: () => {}, removeListener: () => {} });

  const tabs = {
    onRemoved: listener(),
    onUpdated: listener(),
    onActivated: listener(),
    onCreated: listener(),
    onMoved: listener(),
    create: ({ url, active = true, windowId }) => {
      model.calls.create++;
      const id = model.addTab(windowId ?? 1, url ?? "");
      model.tabs.get(id).active = active;
      return resolve({ ...model.tabs.get(id) });
    },
    get: (id) => (model.tabs.has(id) ? resolve({ ...model.tabs.get(id) }) : reject(`No tab with id: ${id}`)),
    query: (info = {}) => {
      let list = [...model.tabs.values()];
      if (info.windowId !== undefined) list = list.filter((t) => t.windowId === info.windowId);
      if (info.groupId !== undefined) list = list.filter((t) => t.groupId === info.groupId);
      return resolve(list.map((t) => ({ ...t })));
    },
    group: ({ tabIds, groupId, createProperties }) => {
      model.calls.group++;
      if (model.failGroupTimes > 0) {
        model.failGroupTimes--;
        return reject("Cannot group the tab because it is being moved");
      }
      const ids = tabIds.map(Number);
      for (const id of ids) if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
      let gid = groupId;
      if (gid === undefined) {
        const windowId = createProperties?.windowId ?? model.tabs.get(ids[0]).windowId;
        gid = model.nextGroupId++;
        model.groups.set(gid, { id: gid, windowId, title: "", color: "grey" });
      } else if (!model.groups.has(gid)) {
        // 往一个不存在的 groupId 上塞标签：真 Chrome 就是这么报错的
        return reject(`No group with id: ${gid}`);
      }
      for (const id of ids) model.tabs.get(id).groupId = gid;
      return resolve(gid);
    },
    ungroup: (tabIds) => {
      model.calls.ungroup++;
      const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
      for (const id of ids) {
        if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
        model.tabs.get(id).groupId = -1;
      }
      dropEmptyGroups();
      return resolve();
    },
  };

  const tabGroups = {
    get: (id) => (model.groups.has(id) ? resolve({ ...model.groups.get(id) }) : reject(`No group with id: ${id}`)),
    query: (info = {}) => {
      let list = [...model.groups.values()];
      if (info.title !== undefined) list = list.filter((g) => g.title === info.title);
      if (info.windowId !== undefined) list = list.filter((g) => g.windowId === info.windowId);
      return resolve(list.map((g) => ({ ...g })));
    },
    update: (id, props) => {
      model.calls.update = (model.calls.update ?? 0) + 1;
      if (!model.groups.has(id)) return reject(`No group with id: ${id}`);
      Object.assign(model.groups.get(id), props);
      return resolve({ ...model.groups.get(id) });
    },
  };

  const runtime = {
    getManifest: () => ({ version: "1.0.9-test" }),
    id: "test-extension-id",
    lastError: undefined,
  };

  // 建模过的命名空间仍然允许 background.js 调用我们没写到的方法，那些退回打桩，
  // 免得测试因为某个无关 API 缺席而炸掉。
  const withFallback = (obj, path) => new Proxy(obj, {
    get: (target, k) => (typeof k === "string" && !(k in target) ? stub(`${path}.${k}`, state) : target[k]),
  });

  const modeled = { tabs: withFallback(tabs, "chrome.tabs"), runtime: withFallback(runtime, "chrome.runtime") };
  if (withTabGroups) modeled.tabGroups = withFallback(tabGroups, "chrome.tabGroups");

  return new Proxy({}, {
    get: (_t, k) => {
      if (typeof k !== "string") return undefined;
      if (!withTabGroups && k === "tabGroups") return undefined;
      if (k in modeled) return modeled[k];
      return stub(`chrome.${k}`, state);
    },
  });
}

async function boot({ withTabGroups = true, failGroupTimes = 0, model } = {}) {
  const browser = model ?? makeModel({ failGroupTimes });
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder, crypto,
    AbortController, Blob, fetch: () => Promise.resolve({}),
    WebSocket: class { close() {} send() {} },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    chrome: makeChrome(browser, { withTabGroups }),
  };
  sandbox.globalThis = sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(BG_CODE, ctx, { filename: "background.js" });
  await new Promise((r) => setTimeout(r, 5));
  return { model: browser, ctx };
}

const openTab = (ctx, url) => ctx.cmdTabsOpen({ url, wait: false });

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
  const noGroup = await ctx.cmdTabsOpen({ url: "https://nomark.test", wait: false, group: false });
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
