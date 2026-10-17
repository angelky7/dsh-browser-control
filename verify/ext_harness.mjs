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
let pageVm;

/** @returns 一台内存里的假浏览器。 */
export function makeModel({ failGroupTimes = 0 } = {}) {
  return {
    tabs: new Map(),
    groups: new Map(),
    nextTabId: 100,
    nextGroupId: 500,
    calls: { group: 0, ungroup: 0, create: 0, remove: 0 },
    failGroupTimes,
    /** 每次 `chrome.tabs.remove` 实际收到的参数（数组形态）——用来断言「一批 = 一次调用」。 */
    removeCalls: [],
    /** >0 时 `chrome.tabs.remove` 拒绝，用来演「调用失败但副作用可能已经发生」。 */
    failRemoveTimes: 0,
    removeError: null,
    /**
     * >0 时：先把前 N 个 id 真的关掉，再让整次 `remove` 拒绝 —— 真实竞态（用户在那
     * 一瞬间自己关掉了其中一个标签，Chrome 于是拒绝了整批）。专治「失败就当什么都没
     * 发生」的实现。
     */
    removeRejectButClose: 0,
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
      /**
       * 每个 CDP 方法返回什么。值可以是现成的对象，也可以是 `(params) => 对象`——
       * 需要按参数演的时候（`DOM.resolveNode` 按 backendNodeId 找节点）用函数。
       * 没登记的走下面 `cdpResult` 里的默认语义。
       */
      results: {},
      /** 调用顺序记录，用来断言「先清了旧 ref 再取 AX 树」这类顺序要求。 */
      log: [],
    },
    /** 页面本身的样子（title / url），以及「真实 DOM 节点」集合。 */
    page: { title: "Fake page", url: "https://fake.test/" },
    /**
     * 导航剧本：`'stale'` = 请求的文档永远不提交（标签还停在旧页面上），
     * `'load'` = 走一遍 loading→complete，`'instant'` = 直接完成。
     * `createNav` 管新建标签：`'blip'` 模拟真 Chrome 的「出生在 about:blank 且已是
     * complete，随后才开始加载」。
     */
    nav: "load",
    createNav: "load",
    loadDelayMs: 240,
    slowStartMs: 400,
    updatedListeners: [],
    axNodes: [],
    elements: new Map(),
    byBackend: new Map(),
    nextObjectId: 1,
    addTab(windowId, url) {
      const id = this.nextTabId++;
      this.tabs.set(id, { id, windowId, groupId: -1, url, title: url, active: false, status: "complete", pendingUrl: "" });
      return id;
    },
    /**
     * 造一个「页面上的真实元素」，供 AX 快照通过 backendDOMNodeId 找到它。
     * 元素带 getBoundingClientRect / setAttribute，所以扩展那段在页面里跑的
     * 函数是**真的被执行**，而不是我们替它假定结果。
     */
    addPageNode({ backendNodeId, tagName = "BUTTON", rect = { x: 10, y: 20, width: 100, height: 30 }, type, value, href } = {}) {
      const objectId = `obj-${this.nextObjectId++}`;
      // 真 getBoundingClientRect() 同时有 x/y/width/height 和 left/top/right/bottom，
      // 页面里的函数读哪种都得给全，否则测试会假装通过
      const full = {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height,
      };
      const el = {
        objectId,
        tagName,
        type,
        value,
        href,
        attributes: {},
        rect: full,
        getBoundingClientRect() { return this.rect; },
        setAttribute(name, v) { this.attributes[name] = String(v); },
        removeAttribute(name) { delete this.attributes[name]; },
      };
      this.elements.set(objectId, el);
      if (backendNodeId !== undefined) this.byBackend.set(backendNodeId, objectId);
      return el;
    },
    /** 模拟 Chrome 单方面丢掉会话（DevTools 抢占 / 导航竞态），并广播 onDetach。 */
    fireDetach(tabId, reason = "target_closed") {
      this.dbg.attached.delete(tabId);
      for (const fn of this.dbg.listeners.onDetach) fn({ tabId, targetType: "page" }, reason);
    },
  };
}

/**
 * 把一次 CDP 调用演成真的结果。默认语义按 Chrome 的样子来：
 * `Runtime.evaluate` 回 `{result:{value}}`、`DOM.resolveNode` 按 backendNodeId
 * 找 objectId、`Runtime.callFunctionOn` **实际执行**扩展传进来的那段页面函数。
 * 测试可以用 `model.dbg.results[method]` 覆盖任意一个。
 */
function cdpResult(model, method, params) {
  const custom = model.dbg.results[method];
  if (typeof custom === "function") return custom(params, model);
  if (custom !== undefined) return custom;
  switch (method) {
    case "Runtime.evaluate": {
      const expression = String(params?.expression ?? "");
      if (expression.includes("document.title")) return { result: { value: model.page.title } };
      if (expression.includes("location.href")) return { result: { value: model.page.url } };
      return { result: { value: null } };
    }
    case "DOM.resolveNode": {
      const objectId = model.byBackend.get(params?.backendNodeId);
      return objectId ? { object: { objectId } } : {};
    }
    case "Runtime.callFunctionOn":
      return runPageFunction(model, params);
    case "Accessibility.getFullAXTree":
      return { nodes: model.axNodes };
    case "Page.enable": case "Runtime.enable": case "Network.enable":
    case "DOM.enable": case "Accessibility.enable":
      return {};
    default:
      return { result: { value: null } };
  }
}

/** 在另一个 vm 里执行页面函数，`this` 绑到假元素上——所以副作用是真的发生的。 */
function runPageFunction(model, params) {
  const el = model.elements.get(params?.objectId);
  if (el === undefined) return { exceptionDetails: { text: "No node with given id found" } };
  pageVm ??= vm.createContext({ Math, String, Number, Object, Array, JSON, Boolean, isNaN, parseInt, parseFloat });
  try {
    const factory = vm.runInContext(`(${params.functionDeclaration})`, pageVm, { filename: "page-fn.js" });
    const args = (params.arguments ?? []).map((a) => (a && "value" in a ? a.value : a?.objectId));
    const value = Reflect.apply(factory, el, args);
    return { result: { value: value === undefined ? null : value } };
  } catch (error) {
    return { exceptionDetails: { text: String(error?.message ?? error) } };
  }
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

  const fireUpdated = (m, tab, info) => {
    for (const fn of m.updatedListeners) { try { fn(tab.id, info, { ...tab }); } catch { /* 监听器炸了不该影响假浏览器 */ } }
  };
  const beginLoad = (m, id, url) => {
    const tab = m.tabs.get(id);
    if (tab === undefined) return;
    tab.status = "loading";
    tab.pendingUrl = url ?? "";
    fireUpdated(m, tab, { status: "loading" });
    setTimeout(() => commitLoad(m, id, url), m.loadDelayMs);
  };
  const commitLoad = (m, id, url) => {
    const tab = m.tabs.get(id);
    if (tab === undefined) return;
    tab.url = url ?? tab.url;
    tab.pendingUrl = "";
    tab.status = "complete";
    m.page.url = tab.url;
    m.page.title = `Loaded: ${tab.url}`;
    fireUpdated(m, tab, { status: "complete" });
  };

  const dropEmptyGroups = () => {
    for (const [gid, group] of model.groups) {
      if (![...model.tabs.values()].some((t) => t.groupId === gid)) model.groups.delete(gid);
    }
  };

  const tabs = {
    onRemoved: listener(),
    onUpdated: { addListener: (fn) => { model.updatedListeners.push(fn); }, removeListener: (fn) => {
      const at = model.updatedListeners.indexOf(fn);
      if (at >= 0) model.updatedListeners.splice(at, 1);
    } },
    onActivated: listener(),
    onCreated: listener(),
    onMoved: listener(),
    create: ({ url, active = true, windowId }) => {
      model.calls.create++;
      const id = model.addTab(windowId ?? 1, url ?? "");
      const tab = model.tabs.get(id);
      tab.active = active;
      // 默认按真 Chrome：新建的标签先进 loading。'blip' 专门造那个坑——
      // 它出生在 about:blank 并且立刻就是 complete，requested URL 还没开始。
      if (model.createNav === "blip") {
        tab.url = "about:blank"; tab.status = "complete"; tab.pendingUrl = url ?? "";
        setTimeout(() => beginLoad(model, id, url), 30);
      } else if (model.createNav === "instant") {
        commitLoad(model, id, url);
      } else {
        tab.status = "loading"; tab.pendingUrl = url ?? "";
        fireUpdated(model, tab, { status: "loading" });
        setTimeout(() => commitLoad(model, id, url), model.loadDelayMs);
      }
      return resolve({ ...tab });
    },
    update: (id, props = {}) => {
      const tab = model.tabs.get(Number(id));
      if (tab === undefined) return reject(`No tab with id: ${id}`);
      if (props.url !== undefined) {
        if (model.nav === "stale") {
          // 请求的文档始终不提交：URL 不变、状态仍是 complete —— 就是「导航没到位」
        } else if (model.nav === "instant") {
          commitLoad(model, tab.id, props.url);
        } else if (model.nav === "slowstart") {
          // 真 Chrome 会有的样子：先让旧文档保持 complete 一小会儿，才开始加载
          tab.pendingUrl = props.url;
          setTimeout(() => {
            tab.status = "loading";
            fireUpdated(model, tab, { status: "loading" });
            setTimeout(() => commitLoad(model, tab.id, props.url), model.loadDelayMs);
          }, model.slowStartMs ?? 400);
        } else {
          tab.status = "loading"; tab.pendingUrl = props.url;
          fireUpdated(model, tab, { status: "loading" });
          setTimeout(() => commitLoad(model, tab.id, props.url), model.loadDelayMs);
        }
      }
      if (props.active !== undefined) tab.active = props.active;
      return resolve({ ...tab });
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
    /**
     * 真 Chrome 的语义：`remove` 接受**数组**，且任何一个 id 不存在就整次调用拒绝。
     * 后者正是 `tabs.closeMany` 必须先自查存在性的原因——不然「一个已经关掉的标签」
     * 会把同批里还能关的标签一起拖死。
     */
    remove: (ids) => {
      model.calls.remove++;
      const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
      model.removeCalls.push(list);
      if (model.removeRejectButClose > 0) {
        const taken = list.slice(0, model.removeRejectButClose);
        for (const id of taken) model.tabs.delete(id);
        model.removeRejectButClose = 0;
        return reject(model.removeError ?? `Tabs cannot be removed: ${taken.join(", ")}`);
      }
      if (model.failRemoveTimes > 0) {
        model.failRemoveTimes--;
        return reject(model.removeError ?? `Tabs cannot be removed: ${list.join(", ")}`);
      }
      for (const id of list) if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
      for (const id of list) model.tabs.delete(id);
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
      dbg.log.push({ method, nth, params });
      let message;
      if (!dbg.attached.has(tabId)) message = `Debugger is not attached to the tab with id: ${tabId}.`;
      else if (typeof dbg.failPlan === "function") message = dbg.failPlan(method, nth, tabId);
      state.lastError = message ? { message } : undefined;
      // 失败时 CDP 不回结果，扩展就是靠 lastError 判的
      const value = message ? undefined : cdpResult(model, method, params);
      if (done) { done(message ? undefined : value); return undefined; }
      return message ? Promise.reject(new Error(message)) : Promise.resolve(value);
    },
    onEvent: { addListener: (fn) => { dbg.listeners.onEvent.push(fn); } },
    onDetach: { addListener: (fn) => { dbg.listeners.onDetach.push(fn); } },
  };

  // Badge calls are recorded rather than swallowed: "connected but frozen" is
  // only honest if the icon says so, and that is now assertable.
  const action = {
    setBadgeText: ({ text } = {}) => { model.badgeText = text ?? ""; },
    setBadgeBackgroundColor: ({ color } = {}) => { model.badgeColor = color; },
    setTitle: () => {},
  };

  // chrome.runtime.onMessage: the popup -> service worker channel. Kept per
  // boot() because a service-worker restart drops the previous listeners.
  const runtimeMessages = {
    listeners: [],
    async send(msg) {
      for (const fn of runtimeMessages.listeners) {
        const response = await new Promise((resolve) => {
          const keepOpen = fn(msg, { id: "test-extension-id" }, resolve);
          // `return true` means "sendResponse comes later"; anything else must
          // not resolve twice (Chrome logs that as an error).
          if (keepOpen !== true) queueMicrotask(() => resolve(undefined));
        });
        if (response !== undefined) return response;
      }
      return undefined;
    },
  };

  const runtime = {
    getManifest: () => manifest,
    onMessage: {
      addListener: (fn) => { runtimeMessages.listeners.push(fn); },
      removeListener: (fn) => {
        const at = runtimeMessages.listeners.indexOf(fn);
        if (at >= 0) runtimeMessages.listeners.splice(at, 1);
      },
    },
    id: "test-extension-id",
    // 必须是 getter：Chrome 在每次回调前改这个值，扩展就是读它来判失败的
    get lastError() { return state.lastError; },
  };

  const storageListeners = [];
  const fireStorageChanged = (changes) => {
    for (const fn of storageListeners) {
      try { fn(changes, "local"); } catch { /* 监听器炸了不该影响假浏览器 */ }
    }
  };
  const storageArea = {
    // 只返回真给得出值的键：扩展那边 `{...DEFAULT_CONFIG, ...stored}` 会被 undefined 覆盖
    get: (keys) => resolve(Object.fromEntries(
      (Array.isArray(keys) ? keys : Object.keys(keys ?? {}))
        .filter((k) => storage[k] !== undefined)
        .map((k) => [k, storage[k]]),
    )),
    // 真写入并广播：本地锁这类「必须活过 service worker 重启」的状态，
    // 用一个 set 不落盘的假件测不出来。
    set: (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items ?? {})) {
        changes[k] = { oldValue: storage[k], newValue: v };
        storage[k] = v;
      }
      fireStorageChanged(changes);
      return resolve();
    },
    remove: (keys) => {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        changes[k] = { oldValue: storage[k], newValue: undefined };
        delete storage[k];
      }
      fireStorageChanged(changes);
      return resolve();
    },
    onChanged: {
      addListener: (fn) => storageListeners.push(fn),
      removeListener: (fn) => {
        const at = storageListeners.indexOf(fn);
        if (at >= 0) storageListeners.splice(at, 1);
      },
    },
  };

  model.sendRuntimeMessage = (msg) => runtimeMessages.send(msg);

  const withFallback = (obj, path) => new Proxy(obj, {
    get: (target, k) => (typeof k === "string" && !(k in target) ? stub(`${path}.${k}`, state) : target[k]),
  });

  const modeled = {
    tabs: withFallback(tabs, "chrome.tabs"),
    runtime: withFallback(runtime, "chrome.runtime"),
    debugger: withFallback(debuggerApi, "chrome.debugger"),
    action: withFallback(action, "chrome.action"),
    storage: withFallback({
      local: storageArea, session: storageArea, onChanged: storageArea.onChanged,
    }, "chrome.storage"),
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
