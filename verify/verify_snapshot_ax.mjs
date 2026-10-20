// AX 语义快照实测：跑真实的扩展代码，CDP 结果由一台会演页面的假 debugger 提供，
// 扩展传进页面里的那段 stamping 函数是**真的被执行**（在另一个 vm 里，`this` 绑到假元素）。
// 所以能断言的不只是返回的 JSON，还有「元素上到底有没有写进 data-dsh-ref」。
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const axNode = ({ backendDOMNodeId, role, name, ignored = false }) => ({
  nodeId: `n${backendDOMNodeId ?? role}`,
  ignored,
  role: { value: role },
  name: name === undefined ? undefined : { value: name },
  ...(backendDOMNodeId === undefined ? {} : { backendDOMNodeId }),
});

/**
 * 造一台假页面：`nodes` 是 AX 树（CDP 原样形状），`pageNodes` 是**真的存在**的 DOM 元素。
 * 两者故意分开——AX 里报了 backendDOMNodeId 但 DOM 里没这个节点，是 Chrome 会发生的
 * 真实情况（节点刚被移除），要靠不写进 pageNodes 来构造。
 */
async function axPage({ nodes, pageNodes = [], rect = { x: 8, y: 40, width: 120, height: 28 } } = {}) {
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://ax.test");
  const elements = new Map();
  for (const spec of pageNodes) {
    const el = model.addPageNode({
      backendNodeId: spec.backendNodeId,
      tagName: spec.tagName ?? "BUTTON",
      rect: spec.rect ?? rect,
    });
    elements.set(spec.backendNodeId, el);
  }
  model.axNodes = nodes;
  // 先焐热会话（真实 attach），否则第一条命令会以「not attached」失败
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  return { model, ctx, tabId, elements };
}

const REF_ATTR = "data-dsh-ref";
const visibleNodes = (ids) => ids.map((id) => ({ backendNodeId: id }));

/* 1 —— 可操作节点来自 AX 树，噪音角色被滤掉，ref 连续且真的打到元素上 */
{
  const { ctx, model, elements } = await axPage({
    nodes: [
      axNode({ backendDOMNodeId: 11, role: "button", name: "提交订单" }),
      axNode({ backendDOMNodeId: 12, role: "GenericContainer", name: "" }),
      axNode({ backendDOMNodeId: 13, role: "link", name: "帮助中心" }),
      axNode({ backendDOMNodeId: 14, role: "StaticText", name: "很多文字" }),
      axNode({ backendDOMNodeId: 15, role: "textbox", name: "搜索\n输入框" }),
      axNode({ backendDOMNodeId: 16, role: "button", name: "被忽略的按钮", ignored: true }),
      axNode({ role: "InlineTextBox", name: "x" }),
    ],
    pageNodes: visibleNodes([11, 12, 13, 14, 15, 16]),
  });
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId: model.tabs.keys().next().value, limit: 100 });
  check("AX 模式返回 mode:'ax'", res.mode === "ax", JSON.stringify(res).slice(0, 120));
  check("只收可操作角色：3 个而不是 7 个", res.items.length === 3 && res.ax.candidates === 3,
    `items=${res.items.length} candidates=${res.ax.candidates} nodes=${res.ax.nodes}`);
  check("ref 连续（e1..e3）", JSON.stringify(res.items.map((i) => i.ref)) === '["e1","e2","e3"]',
    res.items.map((i) => i.ref).join(","));
  check("role 与 name 来自 Chrome 算好的可访问名，不是文本截取",
    res.items[0].role === "button" && res.items[0].name === "提交订单" && res.items[1].role === "link",
    JSON.stringify(res.items[0]));
  check("name 里的换行被压平", res.items[2].name === "搜索 输入框", JSON.stringify(res.items[2].name));
  const stamped = [...elements.values()].map((el) => el.attributes[REF_ATTR]).filter(Boolean).sort();
  check("ref 是真的写到 DOM 元素上的（click/type 靠这个选择器）",
    stamped.length === 3 && stamped.join(",") === "e1,e2,e3", stamped.join(","));
  check("被 ignored 的按钮没拿到 ref",
    elements.get(16) === undefined || elements.get(16).attributes[REF_ATTR] === undefined);
  check("title / url 也带回来了", res.title === "Fake page" && res.url === "https://fake.test/",
    `${res.title} / ${res.url}`);
}

/* 2 —— 顺序：取 AX 树之前必须先清掉上一次的 ref */
{
  const { ctx, model, tabId } = await axPage({
    nodes: [axNode({ backendDOMNodeId: 21, role: "button", name: "B" })],
    pageNodes: visibleNodes([21]),
  });
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId, limit: 10 });
  const log = model.dbg.log.map((e) => e.method);
  const clearAt = model.dbg.log.findIndex((e) => e.method === "Runtime.evaluate"
    && /removeAttribute/.test(String(e.params?.expression ?? "")));
  const treeAt = log.indexOf("Accessibility.getFullAXTree");
  check("AX 树之前先发了一次清 ref 的 evaluate", clearAt !== -1 && clearAt < treeAt,
    `clearAt=${clearAt} treeAt=${treeAt}｜顺序=${log.slice(0, 6).join(">")}`);
  check("DOM.enable / Accessibility.enable 都开了",
    log.includes("DOM.enable") && log.includes("Accessibility.enable"), log.join(">"));
  check("单节点页面也正常出 1 条", res.items.length === 1 && res.items[0].ref === "e1", JSON.stringify(res.items));
}

/* 3 —— 隐形元素：不消耗 ref、也不许留 attribute；解析不到的元素算 unresolved */
{
  const { ctx, tabId, elements } = await axPage({
    nodes: [
      axNode({ backendDOMNodeId: 31, role: "button", name: "看得见的" }),
      axNode({ backendDOMNodeId: 32, role: "button", name: "隐形的", rect: { x: 0, y: 0, width: 0, height: 0 } }),
      axNode({ backendDOMNodeId: 99, role: "button", name: "AX 说有但 DOM 没有" }),
      axNode({ backendDOMNodeId: 33, role: "checkbox", name: "第二个看得见的" }),
    ],
    pageNodes: [
      { backendNodeId: 31 },
      { backendNodeId: 32, rect: { x: 0, y: 0, width: 0, height: 0 } },
      // 99 故意不给元素：AX 报了节点但 DOM 里已经没有了
      { backendNodeId: 33 },
    ],
  });
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId, limit: 10 });
  check("隐形与解析失败的节点不进 items", res.items.length === 2,
    JSON.stringify(res.items.map((i) => i.name)));
  check("ref 仍然连续（隐形节点没占号）",
    res.items[0].ref === "e1" && res.items[1].ref === "e2", res.items.map((i) => i.ref).join(","));
  check("隐形元素上没写 attribute", elements.get(32).attributes[REF_ATTR] === undefined,
    JSON.stringify(elements.get(32).attributes));
  check("skipped 计数分得清 invisible / unresolved",
    res.ax.invisible === 1 && res.ax.unresolved === 1, JSON.stringify(res.ax));
}

/* 4 —— limit 尊重传入值，候选总数照样报出来 */
{
  const many = Array.from({ length: 5 }, (_, i) => axNode({ backendDOMNodeId: 40 + i, role: "button", name: `B${i}` }));
  const { ctx, tabId } = await axPage({ nodes: many, pageNodes: visibleNodes([40, 41, 42, 43, 44]) });
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId, limit: 2 });
  check("limit=2 只出 2 条，但候选数照报", res.items.length === 2 && res.ax.candidates === 5 && res.limitedTo === 2,
    `items=${res.items.length} candidates=${res.ax.candidates}`);
}

/* 5 —— AX 域出问题时降级回 DOM 模式，并且说清原因 */
{
  const { ctx, model, tabId } = await axPage({
    nodes: [axNode({ backendDOMNodeId: 51, role: "button", name: "B" })],
    pageNodes: visibleNodes([51]),
  });
  const domPayload = { tabId: 1, title: "Fake page", url: "https://ax.test", total: 2, items: [{ ref: "e1", tag: "button" }] };
  model.dbg.failPlan = (method) => (method === "Accessibility.getFullAXTree" ? "Accessibility domain unavailable" : null);
  model.dbg.results["Runtime.evaluate"] = (params) => (/items\.push/.test(String(params?.expression ?? ""))
    ? { result: { value: JSON.parse(JSON.stringify(domPayload)) } }
    : { result: { value: null } });
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId, limit: 10 });
  check("AX 炸了不炸整条命令：回落到 DOM 模式", res.mode === "dom" && Array.isArray(res.items),
    JSON.stringify(res).slice(0, 150));
  check("降级原因如实回报（agent 能知道名字来自 DOM 而不是 AX）",
    typeof res.axFallback === "string" && /Accessibility/.test(res.axFallback), res.axFallback);
}

/* 接管浮层自己的节点不进快照：它是扩展挂的，不是页面内容 */
// 浮层卡片上有个「中止模型操作」按钮，AX 树里它是标准的 button——不排除的话模型
// 会在快照里读到自己的提示语，甚至按 ref 去点那个按钮。
{
  const { ctx, model, elements } = await axPage({
    nodes: [
      axNode({ backendDOMNodeId: 61, role: "button", name: "提交订单" }),
      axNode({ backendDOMNodeId: 62, role: "button", name: "中止模型操作" }),
    ],
    pageNodes: visibleNodes([61, 62]),
  });
  const overlayBtn = elements.get(62);
  overlayBtn.closest = (sel) => (sel === "[data-dsh-hold]" ? { id: "host" } : null);
  const res = await ctx.cmdSnapshot({ mode: "ax", tabId: [...model.tabs.keys()][0], limit: 100 });
  check("AX：浮层里的按钮不进快照", res.items.length === 1 && res.items[0].name === "提交订单",
    JSON.stringify(res.items.map((i) => i.name)));
  check("AX：浮层节点不占 ref 编号", res.items.every((i) => i.ref !== "e2") && res.items[0].ref === "e1");
  check("AX：浮层节点没被写 data-dsh-ref（不会被 click-by-ref 点到）",
    overlayBtn.attributes[REF_ATTR] === undefined);
  check("AX：total 只数页面元素，candidates 里多出来的自己人单独记",
    res.total === 1 && res.ax.candidates === 2 && res.ax.ownOverlay === 1, JSON.stringify(res.ax));
}

console.log(`\n结论：${fails === 0 ? "AX 快照行为符合预期" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
