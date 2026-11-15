// 同源 iframe 支持台（issue #29）：type / click / find / snapshot 的 frame 选择。
//
// 台子自己搭了一个最小 DOM（document/iframe/contentDocument/ownerDocument.
// defaultView.frameElement/getBoundingClientRect/elementFromPoint），然后让
// 扩展的 Runtime.evaluate **真的执行**注入表达式——不是给命令编一个返回值。
// 这样 frame 路径解析、坐标换算、命中复核、ref 跨文档搜索这些行为才真正被测到；
// 只断言「命令收到了 frameSelector」会漏掉坐标加错一层、命中判到顶层 iframe 这类缺陷。
import vm from "node:vm";
import { bootBackground } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/* ------------------------------------------------------------- fake DOM */

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; }
}

class FakeElement {
  constructor(doc, tag, props = {}) {
    this.ownerDocument = doc;
    this._tag = tag;
    this.attributes = {};
    this.style = { pointerEvents: "" };
    this.rect = props.rect ?? { left: 0, top: 0, width: 0, height: 0 };
    this.clientLeft = props.clientLeft ?? 0;
    this.clientTop = props.clientTop ?? 0;
    this.parentElement = props.parentElement ?? null;
    this.children = [];
    this.events = [];
    this.focused = false;
    this.textContent = props.text ?? "";
    this.className = props.className ?? "";
    this.id = props.id ?? "";
    this.isContentEditable = props.contentEditable === true;
    if (props.id) this.attributes.id = props.id;
    if (props.src) this.attributes.src = props.src;
    if (props.href) this.attributes.href = props.href;
    if (props.name) this.attributes.name = props.name;
    if (props.role) this.attributes.role = props.role;
    if (props.placeholder) this.attributes.placeholder = props.placeholder;
    if (props.ariaLabel) this.attributes["aria-label"] = props.ariaLabel;
    if (props.contentEditable) this.attributes.contenteditable = "true";
    if (props.hold) this.attributes["data-dsh-hold"] = "";
    if (props.type) this.attributes.type = props.type;
  }
  get tagName() { return this._tag.toUpperCase(); }
  get clientWidth() { return this.rect.width; }
  get clientHeight() { return this.rect.height; }
  get href() { return this.attributes.href ?? ""; }
  getBoundingClientRect() { return { ...this.rect }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(child) { child.parentElement = this; this.children.push(child); }
  contains(el) {
    for (let node = el; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
    return null;
  }
  scrollIntoView() {}
  focus() { this.focused = true; this.ownerDocument.activeElement = this; }
  dispatchEvent(event) { this.events.push(event); return true; }
}

class FakeValueElement extends FakeElement {
  constructor(doc, tag, props) {
    super(doc, tag, props);
    this._value = props.value ?? "";
  }
  get value() { return this._value; }
  set value(next) { this._value = String(next); }
}
class FakeInput extends FakeValueElement {
  constructor(doc, props = {}) { super(doc, "input", props); this.type = props.type ?? "text"; this.attributes.type = this.type; }
}
class FakeTextArea extends FakeValueElement {
  constructor(doc, props = {}) { super(doc, "textarea", props); this.type = "textarea"; }
}
class FakeSelect extends FakeValueElement {
  constructor(doc, props = {}) { super(doc, "select", props); this.type = "select-one"; }
}
// 真 DOM 的 value 访问器挂在 HTMLInputElement.prototype 自己身上（扩展就是这么取的），
// 假件也得把访问器放到各子类原型，而不是只在共同祖先上。
for (const cls of [FakeInput, FakeTextArea, FakeSelect]) {
  Object.defineProperty(cls.prototype, "value", {
    configurable: true,
    get() { return this._value; },
    set(next) { this._value = String(next); },
  });
}

/** 只覆盖台子里用到的选择器形状：tag、#id、[attr]、[attr="v"] 及其组合。 */
function matches(el, selector) {
  return String(selector).split(",").map((part) => part.trim()).filter(Boolean).some((one) => {
    let rest = one;
    const attr = /\[([^\]=\s]+)(?:="([^"]*)")?\]/.exec(rest);
    if (attr) {
      const [, name, value] = attr;
      if (!Object.prototype.hasOwnProperty.call(el.attributes, name)) return false;
      if (value !== undefined && String(el.attributes[name]) !== value) return false;
      rest = rest.replace(attr[0], "");
    }
    const id = /#([\w-]+)/.exec(rest);
    if (id) {
      if (el.id !== id[1]) return false;
      rest = rest.replace(id[0], "");
    }
    const tag = rest.trim().toLowerCase();
    return tag === "" || el._tag === tag;
  });
}

class FakeDoc {
  constructor(title, url) {
    this.title = title;
    this.url = url;
    this.documentElement = {};
    this._elements = [];
    this.defaultView = null;
    this.activeElement = null;
  }
  register(el) { this._elements.push(el); return el; }
  querySelectorAll(selector) { return this._elements.filter((el) => matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  /** 顶层 elementFromPoint 只到 iframe 元素为止（与 Chrome 一致）。 */
  elementFromPoint(x, y) {
    let hit = null;
    for (const el of this._elements) {
      if (el.style.pointerEvents === "none") continue;
      const r = el.rect;
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
        hit = el;
      }
    }
    return hit;
  }
}

class FakeWindow {
  constructor(doc) {
    this.document = doc;
    doc.defaultView = this;
    this.frameElement = null;
    this.HTMLInputElement = FakeInput;
    this.HTMLTextAreaElement = FakeTextArea;
    this.HTMLSelectElement = FakeSelect;
    this.Event = FakeEvent;
    this.InputEvent = FakeEvent;
    this.innerHeight = 600;
    this.scrollX = 0;
    this.scrollY = 0;
  }
}

/**
 * 页面：
 *   顶层   iframe#shell  (100,50 600x300)   button#run (0,0)
 *          iframe#remote (300,400)          ← 跨源：contentDocument 为 null
 *   frame  textarea#term (10,20 200x30)     input#cmd (10,60)
 *          button#send  (10,100)
 */
function buildPage() {
  const top = new FakeDoc("Frames", "https://frames.test/");
  const topWin = new FakeWindow(top);
  const inner = new FakeDoc("Shell", "https://frames.test/shell");
  const innerWin = new FakeWindow(inner);

  const run = top.register(new FakeElement(top, "button", { id: "run", text: "Run", rect: { left: 0, top: 0, width: 80, height: 20 } }));
  const shell = top.register(new FakeElement(top, "iframe", {
    id: "shell", src: "/shell", rect: { left: 100, top: 50, width: 600, height: 300 },
  }));
  shell.contentDocument = inner;
  shell.contentWindow = innerWin;
  innerWin.frameElement = shell;
  const remote = top.register(new FakeElement(top, "iframe", {
    id: "remote", src: "https://other.example/shell", rect: { left: 300, top: 400, width: 200, height: 100 },
  }));
  remote.contentDocument = null;

  const term = inner.register(new FakeTextArea(inner, {
    id: "term", placeholder: "terminal", rect: { left: 10, top: 20, width: 200, height: 30 },
  }));
  const cmd = inner.register(new FakeInput(inner, {
    id: "cmd", type: "text", rect: { left: 10, top: 60, width: 200, height: 20 },
  }));
  const send = inner.register(new FakeElement(inner, "button", { id: "send", text: "Send", rect: { left: 10, top: 100, width: 60, height: 20 } }));

  return { top, topWin, inner, innerWin, shell, remote, run, term, cmd, send };
}

/** 让 Runtime.evaluate 在假 DOM 里执行扩展注入的表达式。 */
function wirePage(model, page) {
  const sandbox = {
    Math, String, Number, Object, Array, JSON, Boolean, isNaN, parseInt, parseFloat,
    document: page.top,
    location: { href: page.top.url },
    console,
    setTimeout,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  model.dbg.results["Runtime.evaluate"] = (params) => {
    const expression = String(params?.expression ?? "");
    try {
      const value = vm.runInContext(expression, context, { filename: "page.js" });
      return { result: { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) } };
    } catch (error) {
      return { exceptionDetails: { text: String(error?.message ?? error) } };
    }
  };
  return sandbox;
}

async function boot() {
  const { model, ctx } = await bootBackground(CANDIDATE ? { backgroundPath: CANDIDATE } : {});
  const tabId = model.addTab(1, "https://frames.test/");
  const page = buildPage();
  wirePage(model, page);
  return { model, ctx, tabId, page };
}

const mouseEvents = (model) => model.dbg.log
  .filter((e) => e.method === "Input.dispatchMouseEvent")
  .map((e) => e.params ?? {});

/* --------------------------------------------------------------- snapshot */

{
  const { ctx, tabId, page } = await boot();
  const snap = await ctx.cmdSnapshot({ tabId });
  check("snapshot 走进同源 iframe：总数含顶层 1 + 帧内 3",
    snap.total === 4 && snap.items.length === 4, `total=${snap.total} items=${snap.items.length}`);
  const refs = Object.fromEntries(snap.items.map((item) => [item.ref, item]));
  check("snapshot 给帧内元素标了 frame 路径",
    refs.e2?.tag === "textarea" && refs.e2?.frame === "iframe#shell"
    && refs.e3?.tag === "input" && refs.e3?.frame === "iframe#shell",
    JSON.stringify(snap.items.map((i) => `${i.ref}:${i.tag}@${i.frame ?? "top"}`)));
  check("snapshot 的 rect 是顶层视口坐标（iframe 偏移已加）",
    refs.e2?.rect?.x === 110 && refs.e2?.rect?.y === 70,
    JSON.stringify(refs.e2?.rect));
  check("snapshot 没把跨源 iframe 的内容假装读出来，并如实计数",
    snap.crossOriginFrames === 1 && !snap.items.some((i) => i.frame?.includes("remote")),
    `crossOriginFrames=${snap.crossOriginFrames}`);
  check("ref 真的写进了 iframe 自己的文档",
    page.inner.querySelector('[data-dsh-ref="e2"]') === page.term);
}

/* ------------------------------------------------------------------ click */

{
  const { model, ctx, tabId } = await boot();
  const snap = await ctx.cmdSnapshot({ tabId });
  const termRef = snap.items.find((i) => i.tag === "textarea").ref;
  const result = await ctx.cmdClick({ tabId, selector: `[data-dsh-ref="${termRef}"]` });
  const [moved, down, up] = mouseEvents(model);
  check("click 用 ref 命中 iframe 里的元素，坐标是顶层视口坐标",
    moved?.x === 210 && moved?.y === 85 && down?.type === "mousePressed" && up?.type === "mouseReleased",
    JSON.stringify(mouseEvents(model)));
  check("click 在帧内复核命中（顶层 elementFromPoint 只看到 iframe 也不算失败）",
    result.hitVerified === true && result.clicked.frame === "iframe#shell",
    JSON.stringify(result));
}

{
  const { model, ctx, tabId } = await boot();
  const result = await ctx.cmdClick({ tabId, selector: "textarea", frameSelector: "#shell" });
  check("click 支持 frameSelector，并在回执里写明 frame",
    result.clicked.frame === "iframe#shell" && result.hitVerified === true,
    JSON.stringify(result));
  check("click 的命中点仍然落在帧内 textarea 中心",
    mouseEvents(model)[0]?.x === 210 && mouseEvents(model)[0]?.y === 85,
    JSON.stringify(mouseEvents(model)));
}

{
  // 我们自己的接管浮层盖在 iframe 上：click 应临时让浮层对指针透明，再复核到帧内。
  const { model, ctx, tabId, page } = await boot();
  void model;
  const overlay = page.top.register(new FakeElement(page.top, "div", {
    rect: { left: 0, top: 0, width: 800, height: 600 }, hold: true,
  }));
  const result = await ctx.cmdClick({ tabId, selector: "iframe#shell >>> textarea" });
  check("自己的浮层挡住 iframe 时，click 仍能落到帧内且标记 bypassedOwnOverlay",
    result.hitVerified === true && result.bypassedOwnOverlay === true
    && overlay.style.pointerEvents === "",
    JSON.stringify(result));
}

/* ------------------------------------------------------------------- find */

{
  const { ctx, tabId } = await boot();
  const found = await ctx.cmdFind({ tabId, selector: "textarea", frameSelector: "iframe#shell" });
  check("find 支持 frameSelector，回执带帧路径与顶层坐标",
    found.count === 1 && found.frame === "iframe#shell" && found.items[0]?.tag === "textarea"
    && found.items[0]?.rect?.x === 110 && found.items[0]?.rect?.y === 70,
    JSON.stringify(found));
  const chained = await ctx.cmdFind({ tabId, selector: "iframe#shell >>> input" });
  check("find 支持 a >>> b 链式选择器",
    chained.count === 1 && chained.items[0]?.id === "cmd" && chained.frame === "iframe#shell",
    JSON.stringify(chained));
  const topOnly = await ctx.cmdFind({ tabId, selector: "textarea" });
  check("没有 frame 语法时保持旧行为：只查顶层文档",
    topOnly.count === 0 && topOnly.frame === undefined, JSON.stringify(topOnly));
}

/* ------------------------------------------------------------------ input */

{
  const { ctx, tabId, page } = await boot();
  const filled = await ctx.cmdInput({ tabId, selector: "textarea", frameSelector: "iframe#shell", value: "wc -l server.log" });
  check("fill 写进 iframe 里的输入框，回执带 frame 与真实值",
    page.term.value === "wc -l server.log" && filled.filled.value === "wc -l server.log"
    && filled.filled.frame === "iframe#shell",
    JSON.stringify(filled));
  check("fill 的 input/change 事件在元素自己的 realm 里派发（不踩顶层构造器）",
    page.term.events.some((e) => e.type === "input") && page.term.events.some((e) => e.type === "change"),
    JSON.stringify(page.term.events.map((e) => e.type)));
}

{
  const { model, ctx, tabId, page } = await boot();
  // 先把终端输入框变成有内容的，验证 type 模式会先清空再逐字符派发真实按键。
  page.term.value = "old";
  await ctx.cmdInput({ tabId, selector: "iframe#shell >>> textarea", value: "ls -l", mode: "type" });
  const keys = model.dbg.log.filter((e) => e.method === "Input.dispatchKeyEvent");
  check("type 模式在 iframe 里聚焦元素并发出 5 个字符 ×（keyDown+keyUp）",
    page.term.focused === true && keys.length === 10,
    `focused=${page.term.focused} keys=${keys.length}`);
  check("type 模式发送的是真实按键身份（'-' 是 Minus/189，不是 Insert/45）",
    keys.some((e) => e.params?.key === "-" && e.params?.code === "Minus" && e.params?.windowsVirtualKeyCode === 189),
    JSON.stringify(keys.map((e) => `${e.params?.key}/${e.params?.code}/${e.params?.windowsVirtualKeyCode}`)));
}

/* --------------------------------------------------- 跨源与错误可执行性 */

{
  const { ctx, tabId } = await boot();
  let error = null;
  try {
    await ctx.cmdClick({ tabId, selector: "button", frameSelector: "#remote" });
  } catch (err) {
    error = err;
  }
  check("跨源 iframe 报可执行的 cross-origin 错误，而不是 element not found",
    typeof error?.message === "string" && /cross-origin iframe/.test(error.message) && /same-origin/.test(error.message),
    error?.message);
}

{
  const { ctx, tabId } = await boot();
  let error = null;
  try {
    await ctx.cmdFind({ tabId, selector: "textarea", frameSelector: "#missing" });
  } catch (err) {
    error = err;
  }
  check("frameSelector 指不到 iframe 时说清是 frame 找不到",
    typeof error?.message === "string" && /frame not found: #missing/.test(error.message), error?.message);
}

/* ------------------------------------------- 插件侧：旧扩展的版本闸门 */

// frame 支持是参数级能力（没有新命令可供 capabilities 探测），插件按 hello 的
// 扩展版本拦：1.7.4 及更早会静默忽略 frameSelector，最后报成「element not found」，
// 看起来像页面问题。闸门必须在发命令前拒绝，并且普通（不带 frame）调用不受影响。
const { Config, apply } = await import("../lib/index.js");

function makePlugin(port, token) {
  const tools = [];
  const disposers = [];
  const config = Config({ stateDir: (process.env.TEMP || "/tmp") + "/dsh-verify-frames-state", enabled: true, port, token, shotsDir: (process.env.TEMP || "/tmp") + "/dsh-verify-frames-shots" });
  const settings = { register(_ns, schema, options) { const value = schema(options?.base ?? config); return { get: () => value, watch: () => {}, set: () => {} }; } };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: ctx.logger }); },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(ctx, config);
  return { tools, port, token, dispose: () => disposers.reverse().forEach((fn) => { try { fn(); } catch {} }) };
}

async function connectPlugin(inst, version) {
  const received = [];
  const sock = new WebSocket(`ws://127.0.0.1:${inst.port}/ws?token=${inst.token}`);
  await new Promise((resolve) => {
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", client: "fake", version, protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: [] }));
      resolve();
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      received.push({ command: msg.command, params: msg.params ?? {} });
      sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 1, clicked: { x: 1, y: 2, tag: "textarea" }, filled: { tag: "textarea", value: "x" } } }));
    };
    setTimeout(resolve, 300);
  });
  return { sock, received };
}

const callTool = (tool, args) => tool.execute(args, { signal: new AbortController().signal }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }));

/** 版本闸门读的是 hello 里的版本：等桥真的收下 hello 再发第一条命令。 */
async function waitHello(inst, version) {
  for (let i = 0; i < 30; i++) {
    try {
      const status = await fetch(`http://127.0.0.1:${inst.port}/api/status`).then((r) => r.json());
      if (status?.hello?.version === version) return;
    } catch { /* 还没监听 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`hello ${version} never arrived`);
}

{
  const inst = makePlugin(9815, "frames-old");
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectPlugin(inst, "1.7.4");
  await waitHello(inst, "1.7.4");
  const click = inst.tools.find((t) => t.name === "browser_click");
  const old = await callTool(click, { selector: "textarea", frameSelector: "#shell" });
  check("扩展 1.7.4 + frameSelector：拒绝并指向 1.7.5，零命令",
    old.ok === false && /extension-outdated/.test(old.error) && /frame selectors/.test(old.error)
    && /1\.7\.5/.test(old.error) && received.length === 0,
    `${old.error?.slice(0, 120)} | received=${received.length}`);
  const chained = await callTool(click, { selector: "iframe#shell >>> textarea" });
  check("扩展 1.7.4 + >>> 语法：同样在发命令前拒绝",
    chained.ok === false && /extension-outdated/.test(chained.error) && received.length === 0,
    `${chained.error?.slice(0, 120)} | received=${received.length}`);
  const plain = await callTool(click, { selector: "textarea" });
  check("扩展 1.7.4 的普通调用不被闸门误伤（零倒退）",
    plain.ok === true && received.length === 1 && received[0].params.frameSelector === undefined,
    `received=${JSON.stringify(received)}`);
  try { sock.close(); } catch {}
  inst.dispose();
}

{
  const inst = makePlugin(9816, "frames-new");
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectPlugin(inst, "1.7.5");
  await waitHello(inst, "1.7.5");
  const type = inst.tools.find((t) => t.name === "browser_type");
  await callTool(type, { selector: "textarea", frameSelector: "#shell", value: "ls", mode: "type" });
  check("扩展 1.7.5：frameSelector 与 type 模式原样送到扩展",
    received.length === 1 && received[0].command === "input"
    && received[0].params.frameSelector === "#shell" && received[0].params.mode === "type",
    JSON.stringify(received));
  try { sock.close(); } catch {}
  inst.dispose();
}

console.log(`\n${fails === 0 ? "全部 PASS" : `${fails} 项 FAIL`}`);
// Node 的 WebSocket 关闭是异步的：close() 后立刻 process.exit 在 Windows 上会撞
// libuv 的 UV_HANDLE_CLOSING 断言（exit code 非零，CI 误判台子失败）。
await new Promise((resolve) => setTimeout(resolve, 200));
process.exit(fails === 0 ? 0 : 1);
