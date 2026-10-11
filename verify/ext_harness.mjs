// 扩展 service worker 的测试台：在 node:vm 里加载**真实的** extension/background.js，
// 配一台有状态的假 Chrome（chrome.tabs / chrome.tabGroups / chrome.debugger …）。
//
// 为什么假 chrome 而不是真浏览器：这台机器上没法无人值守地重装扩展；但归组、
// 命令派发、WS 帧契约这些逻辑跟 Chrome 的关系只是「API 形状」，把形状做成真的
// 对象、把状态做成真的 Map，断言就有意义。verify_extension_e2e.mjs 在这之上再
// 接一条真的 WebSocket，跑真的 BridgeServer。
//
// 两个坑：
//   - 自动打桩的 Proxy 会让 `typeof chrome.tabGroups.update === 'function'` 永远成立，
//     「能力探测 + 降级」那条路就永远测不到；要显式让命名空间返回 undefined。
//   - vm context 上只取得到顶层 `function` 声明（cmdTabsOpen / addToAgentGroup …），
//     `const`/`class`（COMMANDS / agentGroupsByWindow）取不到，断言只能写在函数与假状态上。
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const BG_PATH = new URL("../extension/background.js", import.meta.url);
const MANIFEST_PATH = new URL("../extension/manifest.json", import.meta.url);
let bgCode;
let realManifest;

/** @returns 一台内存里的假浏览器。 */
export function makeModel({ failGroupTimes = 0 } = {}) {
  return {
    tabs: new Map(),
    groups: new Map(),
    nextTabId: 100,
    nextGroupId: 500,
    calls: { group: 0, ungroup: 0, create: 0 },
    failGroupTimes,
    /**
     * 假 CDP 会话。`attached` 是 **Chrome 侧**的事实，扩展里的 `attachedTabs`
     * 是它的缓存——两者故意分开，才能测出「缓存说了谎」这类缺陷。
     * `failPlan(method, nth)` 返回错误文案，模拟会话中途丢失。
     */
    dbg: {
      attached: new Set(),
      attachCount: 0,
      detachCount: 0,
      sends: {},
      failPlan: null,
      attachPlan: null,
      listeners: { onEvent: [], onDetach: [] },
    },
    addTab(windowId, url) {
      const id = this.nextTabId++;
      this.tabs.set(id, { id, windowId, groupId: -1, url, title: url, active: false });
      return id;
    },
    /** 模拟 Chrome 单方面丢掉会话（DevTools 抢占 / 导航竞态），并广播 onDetach。 */
    fireDetach(tabId, reason = "target_closed") {
      this.dbg.attached.delete(tabId);
      for (const fn of this.dbg.listeners.onDetach) fn({ tabId, targetType: "page" }, reason);
    },
  };
}

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

/**
 * @param model 假浏览器
 * @param options.withTabGroups 关掉即模拟「Chrome 太旧或权限没给」
 * @param options.storage chrome.storage.local.get 的返回值（扩展的端口/Token 就从这里来）
 * @param options.manifest 喂给 chrome.runtime.getManifest() 的内容（扩展会把它报给桥）
 */
export function makeChrome(model, { withTabGroups = true, storage = {}, manifest = { version: "0.0.0-harness" } } = {}) {
  const state = { lastError: undefined };
  const resolve = (v) => Promise.resolve(v);
  const reject = (m) => Promise.reject(new Error(m));
  const listener = () => ({ addListener: () => {}, removeListener: () => {} });

  const dropEmptyGroups = () => {
    for (const [gid, group] of model.groups) {
      if (![...model.tabs.values()].some((t) => t.groupId === gid)) model.groups.delete(gid);
    }
  };

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
        // 往不存在的 groupId 上塞标签：真 Chrome 就是这么拒绝的
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
      if (!model.groups.has(id)) return reject(`No group with id: ${id}`);
      Object.assign(model.groups.get(id), props);
      return resolve({ ...model.groups.get(id) });
    },
  };

  const dbg = model.dbg;
  /**
   * 假 debugger。语义照着真 Chrome 来：会话已经被 Chrome 收回时，
   * `sendCommand` 回 `Debugger is not attached to the tab with id: N.`——
   * 这正是「扩展缓存还说附着着」暴露出来的方式。
   */
  const debuggerApi = {
    attach: (target, version, cb) => {
      const done = typeof version === "function" ? version : cb;
      dbg.attachCount++;
      const forced = typeof dbg.attachPlan === "function" ? dbg.attachPlan(Number(target?.tabId), dbg.attachCount) : null;
      state.lastError = forced ? { message: forced } : undefined;
      if (!forced) dbg.attached.add(Number(target?.tabId));
      if (done) { done(); return undefined; }
      return forced ? Promise.reject(new Error(forced)) : Promise.resolve();
    },
    detach: (target, cb) => {
      dbg.detachCount++;
      dbg.attached.delete(Number(target?.tabId));
      state.lastError = undefined;
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    sendCommand: (target, method, params, cb) => {
      const done = typeof params === "function" ? params : cb;
      const tabId = Number(target?.tabId);
      const nth = (dbg.sends[method] || 0) + 1;
      dbg.sends[method] = nth;
      let message;
      if (!dbg.attached.has(tabId)) message = `Debugger is not attached to the tab with id: ${tabId}.`;
      else if (typeof dbg.failPlan === "function") message = dbg.failPlan(method, nth, tabId);
      state.lastError = message ? { message } : undefined;
      const result = { result: { value: null } };
      if (done) { done(message ? undefined : result); return undefined; }
      return message ? Promise.reject(new Error(message)) : Promise.resolve(result);
    },
    onEvent: { addListener: (fn) => { dbg.listeners.onEvent.push(fn); } },
    onDetach: { addListener: (fn) => { dbg.listeners.onDetach.push(fn); } },
  };

  const runtime = {
    getManifest: () => manifest,
    id: "test-extension-id",
    // 必须是 getter：Chrome 在每次回调前改这个值，扩展就是读它来判失败的
    get lastError() { return state.lastError; },
  };

  const storageArea = {
    // 只返回真给得出值的键：扩展那边 `{...DEFAULT_CONFIG, ...stored}` 会被 undefined 覆盖
    get: (keys) => resolve(Object.fromEntries(
      (Array.isArray(keys) ? keys : Object.keys(keys ?? {}))
        .filter((k) => storage[k] !== undefined)
        .map((k) => [k, storage[k]]),
    )),
    set: (items) => resolve(),
    onChanged: listener(),
  };

  const withFallback = (obj, path) => new Proxy(obj, {
    get: (target, k) => (typeof k === "string" && !(k in target) ? stub(`${path}.${k}`, state) : target[k]),
  });

  const modeled = {
    tabs: withFallback(tabs, "chrome.tabs"),
    runtime: withFallback(runtime, "chrome.runtime"),
    debugger: withFallback(debuggerApi, "chrome.debugger"),
    storage: withFallback({ local: storageArea, session: storageArea, onChanged: listener() }, "chrome.storage"),
  };
  if (withTabGroups) modeled.tabGroups = withFallback(tabGroups, "chrome.tabGroups");

  const chrome = new Proxy({}, {
    get: (_t, k) => {
      if (typeof k !== "string") return undefined;
      if (!withTabGroups && k === "tabGroups") return undefined;
      if (k in modeled) return modeled[k];
      return stub(`chrome.${k}`, state);
    },
  });
  return chrome;
}

/**
 * 加载真实的 background.js。
 * @param options.model 复用同一台假浏览器（模拟 service worker 重启：缓存没了，状态还在）
 * @param options.realWebSocket 注入 Node 的全局 WebSocket，让它真的去连本地 BridgeServer
 * @param options.backgroundPath 换一份扩展代码来跑（评审外部补丁 / 合并预览用），默认仓库的 extension/background.js
 */
export async function bootBackground({ model, withTabGroups = true, storage = {}, realWebSocket = false, backgroundPath, userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" } = {}) {
  const code = backgroundPath
    ? await readFile(new URL(backgroundPath, import.meta.url), "utf8")
    : (bgCode ??= await readFile(BG_PATH, "utf8"));
  // 扩展在加载期就读 getManifest().version 并把它报给桥，所以喂真的 manifest.json，
  // 免得一发布版本号就和一个写死在测试台里的字符串悄悄分家
  realManifest ??= JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const browser = model ?? makeModel();
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, crypto, AbortController, Blob,
    navigator: { userAgent },
    fetch: () => Promise.resolve({}),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    chrome: makeChrome(browser, { withTabGroups, storage, manifest: realManifest }),
  };
  if (realWebSocket) sandbox.WebSocket = globalThis.WebSocket;
  sandbox.globalThis = sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: backgroundPath ? "background.candidate.js" : "extension/background.js" });
  await new Promise((r) => setTimeout(r, 5));
  return { model: browser, ctx, sandbox };
}
