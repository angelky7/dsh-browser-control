// browser_drag 的台子（v1.7.3，第一个纯插件版本——扩展代码零改动）。
// 三面：
//   1) 鼠标模式（真 background.js + 真桥 + 假 chrome）：cdp 通道把
//      Input.dispatchMouseEvent 序列逐条送到，断言**事件顺序/坐标插值/按钮标志**
//      全对——拖拽的语义就在这些字段里，少一个 buttons:1 页面根本不认为在拖。
//   2) html5 模式：扩展传进页面的那段 dragstart→dragover→drop 合成函数在另一个
//      vm 里**真的被执行**（假 DOM + 假 DragEvent/DataTransfer），按浏览器规则断言
//      dragover 不 preventDefault 就不许有 drop、dragstart 被取消就整场不拖。
//   3) 契约面：坐标端点零 DOM 查询、错误文案（选择器没命中/双地址/缺地址/
//      非法 mode/box model 失败）、只读档与 allowScript 的**工具级**拒绝、
//      旧扩展（hello 1.7.1）拿到 extension-outdated 而不是裸 unknown command。
import vm from "node:vm";
import { Config, apply } from "../lib/index.js";
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9797;
const TOKEN = "drag-test";
const tools = [];
const disposers = [];
const config = Config({ enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  register(_ns, schema, options) {
    const value = schema(options?.base ?? config);
    return { get: () => value, watch: () => {}, set: () => {} };
  },
};
const pctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: pctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};
apply(pctx, config);
await new Promise((r) => setTimeout(r, 400));

/* 真扩展代码 + 真 WebSocket 连上当前插件 */
const { model } = await bootBackground({
  realWebSocket: true,
  storage: { port: PORT, token: TOKEN, autoConnect: true },
});
const TAB = model.addTab(1, "https://drag.test/");
let hello = null;
for (let i = 0; i < 100 && hello === null; i++) {
  await new Promise((r) => setTimeout(r, 50));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const j = await res.json();
    if (j.hello?.version !== undefined) hello = j.hello;
  } catch { /* 桥还没起来 */ }
}
check("真扩展连上，hello 带 cdp 能力（闸门走精确握手路径）",
  hello?.capabilities?.includes("cdp") === true, JSON.stringify(hello?.capabilities?.length));

const dragTool = tools.find((t) => t.name === "browser_drag");
check("browser_drag 已注册", Boolean(dragTool));
const props = dragTool?.parameters?.properties ?? {};
check("参数表齐全（from/to/坐标/tabId/mode/steps）",
  ["from", "to", "fromX", "fromY", "toX", "toY", "tabId", "mode", "steps"].every((k) => props[k] !== undefined),
  Object.keys(props).join(","));

const signal = () => new AbortController().signal;
const call = (args) => dragTool.execute(args, { signal: signal() }).then((r) => ({ ok: true, value: r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

const mouseEvents = (from) => model.dbg.log.slice(from).filter((l) => l.method === "Input.dispatchMouseEvent").map((l) => l.params);

/** 装一套 DOM/Input 的假 CDP 语义（每次覆盖全部键，防止上一个用例的剧本残留）。 */
function installDom({ selectors = {}, attributes = {}, boxes = {}, extra = {} } = {}) {
  Object.assign(model.dbg.results, {
    "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
    "DOM.querySelector": (p) => ({ nodeId: selectors[p.selector] ?? 0 }),
    "DOM.scrollIntoViewIfNeeded": () => ({}),
    "DOM.getAttributes": (p) => ({ attributes: attributes[p.nodeId] ?? [] }),
    "DOM.getBoxModel": (p) => ({ model: boxes[p.nodeId] }),
    "Input.dispatchMouseEvent": () => ({}),
    ...extra,
  });
}

const QUAD_SRC = { content: [100, 50, 200, 50, 200, 90, 100, 90], width: 100, height: 40 }; // 中心 (150,70)
const QUAD_DST = { content: [300, 150, 400, 150, 400, 250, 300, 250], width: 100, height: 100 }; // 中心 (350,200)
const BASE_SELECTORS = { ".src": 11, ".dst": 22 };
const BASE_BOXES = { 11: QUAD_SRC, 22: QUAD_DST };

/* ============ 1. 鼠标模式：事件序列逐条对 ============ */
{
  installDom({ selectors: BASE_SELECTORS, boxes: BASE_BOXES });
  const at = model.dbg.log.length;
  const res = await call({ tabId: TAB, from: ".src", to: ".dst", steps: 4 });
  check("鼠标模式：调用成功", res.ok === true, res.error);
  const ev = mouseEvents(at);
  check("鼠标模式：总派发数 = steps + 4（悬停/按下/移动×N/抬起/落定）", ev.length === 8, `实际 ${ev.length}`);
  check("鼠标模式：先悬停到源中心（无按键）",
    ev[0]?.type === "mouseMoved" && Math.abs(ev[0].x - 150) < 0.01 && Math.abs(ev[0].y - 70) < 0.01 && ev[0].buttons === 0,
    JSON.stringify(ev[0]));
  check("鼠标模式：按下在源中心，左键 buttons=1",
    ev[1]?.type === "mousePressed" && Math.abs(ev[1].x - 150) < 0.01 && ev[1].button === "left" && ev[1].buttons === 1 && ev[1].clickCount === 1,
    JSON.stringify(ev[1]));
  const moves = ev.slice(2, 6);
  check("鼠标模式：移动全程按住左键（buttons=1）", moves.every((m) => m.type === "mouseMoved" && m.buttons === 1 && m.button === "left"), JSON.stringify(moves));
  check("鼠标模式：插值精确走到目标中心（150,70 → 350,200 线性）",
    Math.abs(moves[0].x - 200) < 0.01 && Math.abs(moves[0].y - 102.5) < 0.01
    && Math.abs(moves[3].x - 350) < 0.01 && Math.abs(moves[3].y - 200) < 0.01,
    JSON.stringify(moves.map((m) => [m.x, m.y])));
  check("鼠标模式：抬起在目标中心，buttons=0",
    ev[6]?.type === "mouseReleased" && Math.abs(ev[6].x - 350) < 0.01 && Math.abs(ev[6].y - 200) < 0.01 && ev[6].buttons === 0,
    JSON.stringify(ev[6]));
  check("鼠标模式：落定再一发无按键移动", ev[7]?.type === "mouseMoved" && ev[7].buttons === 0, JSON.stringify(ev[7]));
  check("鼠标模式：选择器端点先 scrollIntoView 再量矩形（两次，源与靶）",
    model.dbg.sends["DOM.scrollIntoViewIfNeeded"] === 2, String(model.dbg.sends["DOM.scrollIntoViewIfNeeded"]));
  check("鼠标模式回执：rects/steps/dispatched 如实",
    res.value?.mode === "mouse" && res.value?.steps === 4 && res.value?.dispatched === 8
    && Math.abs(res.value?.from?.x - 150) < 0.01 && Math.abs(res.value?.to?.y - 200) < 0.01,
    JSON.stringify(res.value));
  const rendered = dragTool.output.render({}, res.value)[0].text;
  check("鼠标模式 render：模式/步数/派发数进模型可见文本",
    /mouse input/.test(rendered) && /4 steps/.test(rendered) && /8 dispatches/.test(rendered), rendered);
}

/* ============ 2. 坐标端点：零 DOM 查询 ============ */
{
  installDom({});
  const at = model.dbg.log.length;
  const res = await call({ tabId: TAB, fromX: 5, fromY: 6, toX: 105, toY: 106, steps: 2 });
  check("坐标端点：成功且不查 DOM", res.ok === true
    && model.dbg.log.slice(at).every((l) => !l.method.startsWith("DOM.")), res.error);
  const ev = mouseEvents(at);
  check("坐标端点：起点/终点就是给的坐标", Math.abs(ev[1]?.x - 5) < 0.01 && Math.abs(ev[4]?.x - 105) < 0.01 && ev.length === 6,
    JSON.stringify(ev.map((e) => [e.type, e.x, e.y])));
  check("坐标端点回执：selector 字段不出现（不伪造端点形式）", res.value?.from?.selector === undefined && res.value?.from?.x === 5, JSON.stringify(res.value?.from));
}

/* ============ 3. html5 合成：那段函数真的在假页面里执行 ============ */

/** 假页面：元素按类型派发，dragover 不 preventDefault 就没有 drop（浏览器规则）。 */
function makeFakePage({ acceptDrop = true, cancelStart = false } = {}) {
  const log = [];
  let dropped = false;
  const mk = (name, rect) => {
    const listeners = {};
    return {
      addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
      dispatchEvent(ev) {
        log.push(`${ev.type}@${name}`);
        for (const fn of listeners[ev.type] ?? []) fn(ev);
        return !ev.defaultPrevented;
      },
      getBoundingClientRect: () => rect,
    };
  };
  const src = mk("src", { left: 0, top: 0, width: 50, height: 50 });
  const dst = mk("dst", { left: 100, top: 100, width: 50, height: 50 });
  if (cancelStart) src.addEventListener("dragstart", (ev) => ev.preventDefault());
  if (acceptDrop) dst.addEventListener("dragover", (ev) => ev.preventDefault());
  dst.addEventListener("drop", (ev) => { dropped = true; ev.preventDefault(); });
  const context = vm.createContext({
    document: {
      querySelector: (s) => (s === ".src" ? src : s === ".dst" ? dst : null),
      elementFromPoint: () => dst,
    },
    DataTransfer: class { setData() {} getData() { return ""; } },
    DragEvent: class {
      constructor(type, init) { this.type = type; Object.assign(this, init); this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
    },
    Math, JSON, Object, Array, String, Number, Boolean,
  });
  return { context, log, get dropped() { return dropped; } };
}

function installHtml5(page) {
  installDom({ selectors: BASE_SELECTORS, attributes: { 11: ["draggable", "true"] }, boxes: BASE_BOXES, extra: {
    "Runtime.evaluate": (p) => ({ result: { type: "object", value: vm.runInContext(p.expression, page.context) } }),
  } });
}

{
  const page = makeFakePage();
  installHtml5(page);
  const res = await call({ tabId: TAB, from: ".src", to: ".dst" });
  check("auto：源带 draggable=true ⇒ 自动走 html5", res.value?.mode === "html5", JSON.stringify(res.value?.mode ?? res.error));
  check("html5：事件按浏览器顺序派发（dragstart→dragenter→dragover→drop→dragend）",
    JSON.stringify(page.log) === JSON.stringify(["dragstart@src", "dragenter@dst", "dragover@dst", "drop@dst", "dragend@src"]), JSON.stringify(page.log));
  check("html5：dragover 被接受 ⇒ drop 真的派发且被处理",
    res.value?.overPrevented === true && res.value?.dropFired === true && res.value?.dropPrevented === true && page.dropped === true,
    JSON.stringify({ over: res.value?.overPrevented, fired: res.value?.dropFired, handled: res.value?.dropPrevented }));
  check("html5：回执事件数如实（5）", res.value?.events === 5, String(res.value?.events));
  const rendered = dragTool.output.render({}, res.value)[0].text;
  check("html5 render：说清楚 drop 被处理", /drop fired and was handled/.test(rendered), rendered);
}

{
  const page = makeFakePage({ acceptDrop: false });
  installHtml5(page);
  const res = await call({ tabId: TAB, from: ".src", to: ".dst", mode: "html5" });
  check("html5：dragover 未被接受 ⇒ 不派发 drop（不装成功）",
    res.value?.overPrevented === false && res.value?.dropFired === false && page.dropped === false,
    JSON.stringify({ over: res.value?.overPrevented, fired: res.value?.dropFired }));
  check("html5：回执事件数 4（无 drop）", res.value?.events === 4, String(res.value?.events));
  const rendered = dragTool.output.render({}, res.value)[0].text;
  check("html5 render：如实说目标没有接受", /did not accept/.test(rendered), rendered);
}

{
  const page = makeFakePage({ cancelStart: true });
  installHtml5(page);
  const res = await call({ tabId: TAB, from: ".src", to: ".dst", mode: "html5" });
  check("html5：dragstart 被页面取消 ⇒ 整场不拖（只有 start/end 两个事件）",
    res.value?.startCancelled === true && JSON.stringify(page.log) === JSON.stringify(["dragstart@src", "dragend@src"]), JSON.stringify(page.log));
  const rendered = dragTool.output.render({}, res.value)[0].text;
  check("html5 render：如实说 dragstart 被取消", /cancelled by the page/.test(rendered), rendered);
}

{
  const page = makeFakePage();
  installHtml5(page);
  const res = await call({ tabId: TAB, from: ".src", toX: 120, toY: 130, mode: "html5" });
  check("html5：坐标终点用 elementFromPoint 找靶", res.value?.mode === "html5" && page.log.includes("dragover@dst"), JSON.stringify(page.log));
}

/* 负方向：draggable=false 的源在 auto 下仍走鼠标 */
{
  installDom({ selectors: BASE_SELECTORS, attributes: { 11: ["draggable", "false"] }, boxes: BASE_BOXES });
  const res = await call({ tabId: TAB, from: ".src", to: ".dst", steps: 2 });
  check("auto：draggable=false ⇒ 鼠标模式", res.value?.mode === "mouse", JSON.stringify(res.value?.mode ?? res.error));
}

/* ============ 4. 错误与契约面 ============ */
{
  installDom({ selectors: {}, boxes: {} });
  const miss = await call({ tabId: TAB, from: ".nope", to: ".dst" });
  check("选择器没命中：点名选择器", /no element matches selector ".nope"/.test(miss.error), miss.error);
  const both = await call({ tabId: TAB, from: ".src", fromX: 1, fromY: 2, to: ".dst" });
  check("同一端既给选择器又给坐标：明确拒绝", /not both/.test(both.error), both.error);
  const neither = await call({ tabId: TAB, to: ".dst" });
  check("缺端点地址：说明要给什么", /needs a CSS selector/.test(neither.error), neither.error);
  const badMode = await call({ tabId: TAB, from: ".src", to: ".dst", mode: "teleport" });
  check("非法 mode：列出合法值", /"auto", "mouse" or "html5"/.test(badMode.error), badMode.error);
  const pointHtml5 = await call({ tabId: TAB, fromX: 1, fromY: 2, to: ".dst", mode: "html5" });
  check("html5 但起点是坐标：说明元素是必需的", /needs a CSS selector for "from"/.test(pointHtml5.error), pointHtml5.error);
  installDom({ selectors: BASE_SELECTORS, boxes: BASE_BOXES });
  model.dbg.failPlan = (method) => (method === "DOM.getBoxModel" ? "Could not compute box model." : undefined);
  const blockedBox = await call({ tabId: TAB, from: ".src", to: ".dst" });
  model.dbg.failPlan = null;
  check("量不到矩形：点名选择器并带上原错误", /cannot measure ".src"/.test(blockedBox.error) && /Could not compute box model/.test(blockedBox.error), blockedBox.error);
}

/* ============ 5. 策略与旧扩展（各起一个独立实例） ============ */

function makeInstance({ port, token, configOverrides = {} }) {
  const instTools = [];
  const instDisposers = [];
  const cfg = Config({ enabled: true, port, token, ...configOverrides });
  const settings = { register(_ns, schema, options) { const v = schema(options?.base ?? cfg); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => instDisposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: c.logger }); },
    tools: { register: (def) => instTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, cfg);
  return { tools: instTools, dispose: () => instDisposers.reverse().forEach((fn) => { try { fn(); } catch {} }) };
}

{
  const inst = makeInstance({ port: 9798, token: "drag-ro", configOverrides: { readOnly: true } });
  await new Promise((r) => setTimeout(r, 300));
  const tool = inst.tools.find((t) => t.name === "browser_drag");
  const res = await tool.execute({ tabId: 1, from: ".a", to: ".b" }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("只读档：工具级拒绝并点名开关（不是含糊的 cdp 被拒）", res.ok === false && /read-only mode is on/.test(res.error) && /browser-bridge/.test(res.error), res.error);
  inst.dispose();
}

{
  const inst = makeInstance({ port: 9799, token: "drag-script", configOverrides: { allowScript: false } });
  await new Promise((r) => setTimeout(r, 300));
  const ws = new WebSocket("ws://127.0.0.1:9799/ws?token=drag-script");
  await new Promise((r) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", client: "fake", version: "1.7.2", protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: ["cdp", "eval"] })); r(); };
    setTimeout(r, 400);
  });
  const tool = inst.tools.find((t) => t.name === "browser_drag");
  const res = await tool.execute({ tabId: 1, from: ".a", to: ".b", mode: "html5" }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("allowScript:false：html5 模式工具级拒绝并指向 mouse 模式", res.ok === false && /allowScript is off/.test(res.error) && /mode:"mouse"/.test(res.error), res.error);
  try { ws.close(); } catch {}
  inst.dispose();
}

{
  const inst = makeInstance({ port: 9800, token: "drag-old" });
  await new Promise((r) => setTimeout(r, 300));
  const ws = new WebSocket("ws://127.0.0.1:9800/ws?token=drag-old");
  await new Promise((r) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", client: "fake", version: "1.7.1", protocol: 1, browser: { name: "fake", version: "1", ua: "" } })); r(); };
    setTimeout(r, 400);
  });
  // hello 是异步解析的：不等到位就调用，插件会按「无 hello 乐观放行」（设计如此），
  // 这条用例就变成测 60s 超时而不是测闸门。
  let oldHello = null;
  for (let i = 0; i < 100 && oldHello === null; i++) {
    await new Promise((r) => setTimeout(r, 30));
    try {
      const res = await fetch("http://127.0.0.1:9800/api/status", { headers: { authorization: "Bearer drag-old" } });
      const j = await res.json();
      if (j.hello?.version !== undefined) oldHello = j.hello;
    } catch { /* 桥还没起来 */ }
  }
  check("旧扩展 hello 到位（版本 1.7.1、无 capabilities）", oldHello?.version === "1.7.1" && oldHello?.capabilities === undefined, JSON.stringify(oldHello));
  const tool = inst.tools.find((t) => t.name === "browser_drag");
  const res = await tool.execute({ tabId: 1, from: ".a", to: ".b" }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("旧扩展（1.7.1、无 cdp）：extension-outdated + 重装指引，不是裸 unknown command",
    res.ok === false && /extension-outdated/.test(res.error) && /releases\/latest/.test(res.error) && !/unknown command/.test(res.error), res.error.slice(0, 120));
  try { ws.close(); } catch {}
  inst.dispose();
}

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
