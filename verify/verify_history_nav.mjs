// browser_tabs 历史导航（back/forward）+ 截图回执尺寸的台子（迭代 11）。
//   扩展侧：back/forward 落地判据复用 nav 的事件机器（frameNavigated 是提交判据），
//   目的地从 Page.getNavigationHistory **读**出来而不是猜——所以「历史边界」能当场
//   说 unchanged，读不到历史时退化成「任何提交都算」并如实标注 historyUnknown。
//   插件侧：back/forward 各自字面量分发（动态拼名字是 surface 台点名防的那类缺陷）、
//   截图回执带 PNG IHDR 解出的**真实像素尺寸**、selector 透传到扩展。
import { Config, apply, policyRefusal } from "../lib/index.js";
import { bootBackground } from "./ext_harness.mjs";
import { isWriteCommand } from "../src/errors.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const A = "https://a.test/first";
const B = "https://b.test/second";
const C = "https://c.test/third";

/** 造一个三页历史 [A,B,C]（指针在 C），返回 ctx/model/tabId。 */
async function seedHistory({ loadDelayMs = 120 } = {}) {
  const { model, ctx } = await bootBackground();
  model.loadDelayMs = loadDelayMs;
  const tabId = model.addTab(1, A);
  await ctx.cmdNav({ tabId, url: B, waitUntil: "load", timeoutMs: 4000 });
  await ctx.cmdNav({ tabId, url: C, waitUntil: "load", timeoutMs: 4000 });
  return { model, ctx, tabId };
}

/* ============ 扩展侧：back / forward ============ */
{
  const { model, ctx, tabId } = await seedHistory();
  const out = await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 });
  check("back：落到上一条历史，targetUrl 是读出来的目的地", out.url === B && out.targetUrl === B && out.action === "back", JSON.stringify(out));
  check("back：不报 loadPending（真的到位了）", out.loadPending === undefined, JSON.stringify(out));
  check("back：假件的历史指针真的动了", model.tabs.get(tabId).history.index === 1, String(model.tabs.get(tabId).history.index));
  const fwd = await ctx.cmdTabsForward({ tabId, timeoutMs: 4000 });
  check("forward：对称地回到 C", fwd.url === C && fwd.targetUrl === C && fwd.loadPending === undefined, JSON.stringify(fwd));
}

{
  const { model, ctx, tabId } = await seedHistory();
  await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 }); // C -> B
  await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 }); // B -> A
  const edge = await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 }); // A 是最老一条 => 边界
  check("历史边界：back 到最老一条后再 back 如实报 unchanged + 原因",
    edge.unchanged === true && /oldest/.test(String(edge.reason)) && edge.url === A, JSON.stringify(edge));
  check("历史边界：什么都没发射（假件指针没动、没有 load）",
    model.tabs.get(tabId).history.index === 0 && model.tabs.get(tabId).status === "complete", JSON.stringify(model.tabs.get(tabId)));
  check("历史边界：不装作等过（waitedMs 是读历史的耗时，不是超时预算）", edge.waitedMs < 1000, String(edge.waitedMs));
}

{
  // 新导航截断 forward 分叉：真 Chrome 的历史形状，插件侧不掺和，但 back 依赖它
  const { ctx, tabId } = await seedHistory();
  await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 }); // 指针到 B
  await ctx.cmdNav({ tabId, url: "https://d.test/fork", waitUntil: "load", timeoutMs: 4000 }); // 分叉
  const fwd = await ctx.cmdTabsForward({ tabId, timeoutMs: 4000 });
  check("分叉后 forward：如实报没有可去的条目", fwd.unchanged === true && /newest/.test(String(fwd.reason)), JSON.stringify(fwd));
}

{
  // 预算耗尽必须报 loadPending，不许把「还在路上」说成成功
  const { model, ctx, tabId } = await seedHistory({ loadDelayMs: 900 });
  const out = await ctx.cmdTabsBack({ tabId, timeoutMs: 150 });
  check("预算内没等到提交 ⇒ loadPending:true（url 还是旧的）", out.loadPending === true && out.url === C, JSON.stringify(out));
  check("loadPending 时 pendingUrl 指着要去的地方", out.pendingUrl === B || out.targetUrl === B, JSON.stringify(out));
}

{
  // 读不到历史（CDP 被占）：退化成「任何提交都算」，但收据里必须说出来
  const { model, ctx, tabId } = await seedHistory();
  model.dbg.results["Page.getNavigationHistory"] = () => { throw new Error("cdp busy"); };
  const out = await ctx.cmdTabsBack({ tabId, timeoutMs: 4000 });
  check("历史读不到 ⇒ historyUnknown 如实标注，导航照常执行", out.historyUnknown === true && out.url === B && out.targetUrl === undefined, JSON.stringify(out));
}

{
  // waitUntil:none：发起后立刻回报，不做到达判定（与 nav 的 none 档同义）
  const { ctx, tabId } = await seedHistory();
  const out = await ctx.cmdTabsBack({ tabId, waitUntil: "none" });
  check("waitUntil:none 立即回报（此刻多半还在旧文档上，url 照实说）", out.waitUntil === "none" && out.loadPending === undefined, JSON.stringify(out));
}

{
  // 元素截图：selector 解析出的 rect 原样进回执（扩展侧一直支持，工具面 1.7.0 才暴露）
  const { model, ctx } = await bootBackground();
  const shotTab = model.addTab(1, "https://shot.test/");
  model.dbg.results["Runtime.evaluate"] = (params) => {
    const expression = String(params?.expression ?? "");
    if (expression.includes("querySelector")) return { result: { value: { x: 10.4, y: 20.6, width: 100.2, height: 30.8 } } };
    if (expression.includes("document.title")) return { result: { value: model.page.title } };
    return { result: { value: null } };
  };
  const out = await ctx.cmdScreenshot({ tabId: shotTab, selector: "#btn" });
  check("元素截图：rect 四舍五入进回执", out.elementRect && out.elementRect.x === 10 && out.elementRect.y === 21 && out.elementRect.w === 100 && out.elementRect.h === 31, JSON.stringify(out.elementRect));
}

/* ============ 插件侧 ============ */
const PORT = 9789;
const TOKEN = "history-test";
const tools = [];
const disposers = [];
const config = Config({ enabled: true, port: PORT, token: TOKEN, shotsDir: "C:\\Users\\gzx\\AppData\\Local\\Temp\\dsh-history-bench" });
const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
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

const tabsTool = tools.find((t) => t.name === "browser_tabs");
const shotTool = tools.find((t) => t.name === "browser_screenshot");
check("browser_tabs / browser_screenshot 已注册", Boolean(tabsTool) && Boolean(shotTool));

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const seenCommands = [];
const seenParams = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.7.0", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seenCommands.push(msg.command);
    seenParams.push(msg.params);
    if (msg.command === "screenshot") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 3, format: "png", base64: PNG_1x1, tabTitle: "T", tabUrl: "https://s.test/" } }));
    } else {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 3, action: msg.command.replace("tabs.", ""), url: "https://landed.test/" } }));
    }
  };
  setTimeout(r, 400);
});
const signal = () => new AbortController().signal;

await tabsTool.execute({ action: "back", tabId: 3 }, { signal: signal() });
await tabsTool.execute({ action: "forward", tabId: 3 }, { signal: signal() });
check("back/forward 各自字面量分发到 tabs.back / tabs.forward", JSON.stringify(seenCommands) === JSON.stringify(["tabs.back", "tabs.forward"]), JSON.stringify(seenCommands));
check("默认 load 档 + 预算随行", seenParams[0].waitUntil === "load" && typeof seenParams[0].timeoutMs === "number" && seenParams[0].timeoutMs > 0, JSON.stringify(seenParams[0]));
const badTier = await tabsTool.execute({ action: "back", waitUntil: "someday" }, { signal: signal() }).then((r) => r, (e) => ({ error: String(e.message) }));
check("非法 waitUntil 在插件侧就被拒", /none, commit, domcontentloaded, load/.test(String(badTier.error)), String(badTier.error));

const shot = await shotTool.execute({ tabId: 3, fullPage: true, format: "png" }, { signal: signal() });
check("截图回执的宽高来自 PNG IHDR（真实像素，不是猜的）", shot.width === 1 && shot.height === 1, JSON.stringify({ width: shot.width, height: shot.height }));
check("render 把真实尺寸写进模型可见文本", shotTool.output.render({}, shot)[0].text.includes("1×1"), shotTool.output.render({}, shot)[0].text);

/* ============ 分类与闸门 ============ */
check("tabs.back / tabs.forward 是写命令（重试 = 多跳一条历史）", isWriteCommand("tabs.back") === true && isWriteCommand("tabs.forward") === true);
check("readOnly 拒 back/forward（导航类不进只读白名单）", policyRefusal("tabs.back", { readOnly: true }) !== undefined && policyRefusal("tabs.forward", { readOnly: true }) !== undefined);

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
