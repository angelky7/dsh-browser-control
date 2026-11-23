// 批量关闭标签页：扩展侧（node:vm 里跑**真实的** extension/background.js，配一台有状态
// 的假 `chrome.tabs`）与宿主侧（真桥 + 假扩展）各测一半。
//
// 为什么要这套断言：关标签是**有副作用的写操作**。第一版实现是
// `for (const id of ids) await controller.execute('tabs.close', …)`——第一个失败就抛出，
// 前面已经真的关掉的标签在结果里一个字都看不到。模型只拿到一句错误，会以为什么都没
// 发生，然后重放整批（而这正是 src/errors.ts 用 `effectState:'unknown'` 想拦住的事）。
//
// 所以钉死三件事：
//   1) 每个 id 的去向都必须报出来：`closed` / `alreadyGone` / `failed`；
//   2) 「关一个已经不在的标签」是**幂等成功**（`alreadyGone`），不是错误 —— 重试安全；
//   3) 一批在链路上是**一条命令、一份超时预算**（扩展侧一次 `chrome.tabs.remove([ids])`），
//      不是 N 次往返中间掉线。
import { bootBackground, makeModel } from "./ext_harness.mjs";
import { Config, apply } from "../lib/index.js";

const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const shape = (r) => JSON.stringify({ requested: r.requested, closed: r.closed, alreadyGone: r.alreadyGone, failed: r.failed });

const bootExt = async () => {
  const model = makeModel();
  const { ctx } = await bootBackground({ model });
  return { model, ctx };
};

/* 1 —— 一批全在：一次调用、数组形态、每个 id 都在结果里 */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const b = model.addTab(1, "https://b.test");
  const c = model.addTab(1, "https://c.test");
  const r = await ctx.cmdTabsCloseMany({ tabIds: [a, b, c] });
  check("一批全在：3 个 id 全进 closed",
    r.requested === 3 && r.closed.join() === [a, b, c].join() && r.alreadyGone.length === 0 && r.failed.length === 0, shape(r));
  check("一批全在：扩展只发了一次 chrome.tabs.remove（不是 N 次往返）", model.calls.remove === 1, `calls=${model.calls.remove}`);
  check("一批全在：参数是数组形态（这正是一批 = 一份超时预算的前提）",
    Array.isArray(model.removeCalls[0]) && model.removeCalls[0].join() === [a, b, c].join(), JSON.stringify(model.removeCalls));
  check("一批全在：标签真的没了", !model.tabs.has(a) && !model.tabs.has(b) && !model.tabs.has(c), `剩余 ${model.tabs.size}`);
}

/* 2 —— 其中有的早就没了：不许连坐，也不许把已消失的 id 塞进 remove */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const b = model.addTab(1, "https://b.test");
  const r = await ctx.cmdTabsCloseMany({ tabIds: [a, 999_999, b] });
  check("有 id 早已不存在：其余两个照样关掉", r.closed.join() === [a, b].join(), shape(r));
  check("有 id 早已不存在：它进 alreadyGone，不进 failed", r.alreadyGone.join() === "999999" && r.failed.length === 0, shape(r));
  check("有 id 早已不存在：交给 remove 的只有还存在的 id（真 Chrome 遇到无效 id 会整批拒绝）",
    model.removeCalls[0].join() === [a, b].join(), JSON.stringify(model.removeCalls));
}

/* 3 —— 幂等：同一条命令再发一次不能抛，也不能再动手 */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  await ctx.cmdTabsCloseMany({ tabIds: [a] });
  const again = await ctx.cmdTabsCloseMany({ tabIds: [a] });
  check("重试安全：第二次调用不抛错", again !== null && typeof again === "object", shape(again));
  check("重试安全：第二次全部落在 alreadyGone",
    again.requested === 1 && again.closed.length === 0 && again.alreadyGone.join() === String(a) && again.failed.length === 0, shape(again));
  check("重试安全：没有可关的就不再发 remove", model.calls.remove === 1, `calls=${model.calls.remove}`);
}

/* 4 —— 入参清洗：重复、字符串、负数、0、null 都不许让命令崩或重复计数 */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const r = await ctx.cmdTabsCloseMany({ tabIds: [a, a, "x", -1, 0, null] });
  check("重复与非法 id 被清洗去重", r.requested === 1 && r.closed.join() === String(a), shape(r));
  const empty = await ctx.cmdTabsCloseMany({ tabIds: [] }).then(() => null, (e) => String(e.message));
  check("空数组合法但无意义：明确报错", empty !== null && /non-empty array/.test(empty), empty);
  const none = await ctx.cmdTabsCloseMany({}).then(() => null, (e) => String(e.message));
  check("完全没有 tabIds：明确报错", none !== null && /non-empty array/.test(none), none);
}

/* 5 —— 单数命令与批量同形状（宿主单数路径复用它，模型只需要学一种结果） */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const r = await ctx.cmdTabsClose({ tabId: a });
  check("单数 tabs.close 与批量同形状",
    r.requested === 1 && r.closed.join() === String(a) && r.alreadyGone.length === 0 && r.failed.length === 0, shape(r));
  const gone = await ctx.cmdTabsClose({ tabId: a });
  check("单数重复关闭：也是幂等成功（alreadyGone）", gone.alreadyGone.join() === String(a) && gone.failed.length === 0, shape(gone));
  const missing = await ctx.cmdTabsClose({}).then(() => null, (e) => String(e.message));
  check("单数缺 tabId：明确报错", missing !== null && /tabId is required/.test(missing), missing);
}

/* 6 —— remove 整批被拒：不许只回一句错误，要点名谁没关掉 */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const b = model.addTab(1, "https://b.test");
  model.failRemoveTimes = 1;
  model.removeError = "Tabs cannot be removed";
  const r = await ctx.cmdTabsCloseMany({ tabIds: [a, b] });
  check("remove 被拒：不抛错，照样收齐结果", r.requested === 2, shape(r));
  check("remove 被拒：两个都进 failed 且带错误文本",
    r.failed.length === 2 && r.failed.every((f) => /cannot be removed/.test(f.error)) && r.closed.length === 0, shape(r));
  check("remove 被拒：failed 不是瞎报——标签确实还在", model.tabs.has(a) && model.tabs.has(b));
  check("remove 被拒：失败文案就是原因本身，不带 `Error: ` 之类的前缀（跨 realm 抛来的 Error 也要认 message）",
    r.failed.every((f) => !/^Error: /.test(f.error)), JSON.stringify(r.failed.map((f) => f.error)));
}

/* 7 —— 最阴的一种：remove 拒了，但其中一个其实已经关掉 */
{
  const { model, ctx } = await bootExt();
  const a = model.addTab(1, "https://a.test");
  const b = model.addTab(1, "https://b.test");
  model.removeRejectButClose = 1; // 先真的关掉 a，再让整次调用拒绝
  const r = await ctx.cmdTabsCloseMany({ tabIds: [a, b] });
  check("拒了但有一个其实已关：已关的报 closed（副作用没被藏起来）", r.closed.join() === String(a), shape(r));
  check("拒了但有一个其实已关：还在的才进 failed", r.failed.length === 1 && r.failed[0].tabId === b, shape(r));
  check("拒了但有一个其实已关：请求总数仍然如实回报", r.requested === 2, shape(r));
}

/* ---- 宿主侧：真桥 + 假扩展，断言「分发对了、形状到了模型眼前」 ---- */
const PORT = 9785; // 9777 装机默认 / 9779 扩展端到端台 / 9781 导航台 / 9783 渲染契约台
const TOKEN = "tabs-close-many-test";
const tools = [];
const disposers = [];
const config = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
    const watchers = [];
    return {
      get: () => value,
      watch: (cb) => void watchers.push(cb),
      set: (next) => { value = next; watchers.forEach((w) => w()); },
    };
  },
};
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: ctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};
apply(ctx, config);
await new Promise((r) => setTimeout(r, 400));

let seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({
      // 1.0.17 才引入 tabs.closeMany：假扩展必须报一个真有的版本，否则测的是闸门不是语义。
      type: "hello", client: "fake-extension", version: "1.0.17", protocol: 1,
      browser: { name: "fake", version: "1", ua: "" },
    }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seen.push({ command: msg.command, params: msg.params });
    const ids = Array.isArray(msg.params?.tabIds) ? msg.params.tabIds : [msg.params?.tabId];
    const result = { requested: ids.filter((id) => typeof id === "number").length, closed: ids, alreadyGone: [], failed: [] };
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
  };
  setTimeout(r, 400);
});

const tabsTool = tools.find((t) => t.name === "browser_tabs");
const closeTabs = async (args) => {
  seen = [];
  const value = await tabsTool.execute(args, { signal: new AbortController().signal });
  const violations = validateJsonSchemaValue(tabsTool.output.schema, value, "value");
  const text = tabsTool.output.render(args, value).map((part) => part.text ?? "").join("\n");
  return { value, violations, text, commands: seen.map((s) => s.command), params: seen.map((s) => s.params) };
};

{
  const one = await closeTabs({ action: "close", tabId: 7 });
  check("宿主：单个 id 走 tabs.close（老命令继续被人用，不被新命令架空）",
    one.commands.join() === "tabs.close" && JSON.stringify(one.params[0]) === JSON.stringify({ tabId: 7 }), JSON.stringify(one.params));
  check("宿主：单个 id 的结果过输出 schema", one.violations.length === 0, one.violations.join(" | "));

  const many = await closeTabs({ action: "close", tabIds: [7, 8, 9] });
  check("宿主：多个 id 走**一次** tabs.closeMany（不是 N 次 tabs.close）",
    many.commands.join() === "tabs.closeMany", JSON.stringify(many.commands));
  check("宿主：id 原样送到扩展，顺序不变",
    JSON.stringify(many.params[0]) === JSON.stringify({ tabIds: [7, 8, 9] }), JSON.stringify(many.params));
  check("宿主：批量的结果过输出 schema", many.violations.length === 0, many.violations.join(" | "));
  check("宿主：模型可见文本里带着每个 id 的去向（closed/alreadyGone/failed 都能读到）",
    /"requested"/.test(many.text) && /"closed"/.test(many.text) && /"alreadyGone"/.test(many.text) && /"failed"/.test(many.text),
    many.text.slice(0, 160));

  const both = await closeTabs({ action: "close", tabId: 7, tabIds: [7, 8] });
  check("宿主：tabId 与 tabIds 同时给 → 去重成一次批量，且 7 只出现一次",
    both.commands.join() === "tabs.closeMany" && JSON.stringify(both.params[0]) === JSON.stringify({ tabIds: [7, 8] }),
    JSON.stringify(both.params));

  const none = await closeTabs({ action: "close" }).then(() => null, (e) => String(e.message));
  check("宿主：什么都不给时明确报错（不许静默关掉「当前标签」这类猜测）",
    none !== null && /requires tabId or tabIds/.test(none), none);
}

/* 2 —— 版本闸门：tabs.closeMany 是 1.0.17 才有的命令，旧扩展必须在发出去之前就被拦下。
   没有这道闸门时，旧扩展收到的是它不认识的命令，回一句 "unknown command: tabs.closeMany"——
   模型只能看到一句没有出处的失败，不知道该升级什么。 */
{
  const oldTools = [];
  const oldDisposers = [];
  const oldConfig = Config({ stateDir: (process.env.TEMP || "/tmp") + "/dsh-verify-state", enabled: true, port: PORT + 1, token: TOKEN + "-old" });
  const oldSettings = { register: (_n, schema, o) => ({ get: () => schema(o?.base ?? oldConfig), watch: () => {}, set: () => {} }) };
  const oldCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn, msg) => oldDisposers.push([fn, msg]),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: oldSettings, logger: oldCtx.logger }); },
    tools: { register: (def) => oldTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(oldCtx, oldConfig);
  await new Promise((r) => setTimeout(r, 400));
  let sent = [];
  const oldWs = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws?token=${TOKEN}-old`);
  await new Promise((r) => {
    oldWs.onopen = () => {
      oldWs.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.0.15", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
      r();
    };
    oldWs.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      sent.push(msg.command);
      oldWs.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: {} }));
    };
    setTimeout(r, 400);
  });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const st = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/status`, { headers: { authorization: `Bearer ${TOKEN}-old` } })).json();
    if (st.hello?.version !== undefined) break;
  }
  const oldTabs = oldTools.find((t) => t.name === "browser_tabs");
  let gateErr = null;
  try { await oldTabs.execute({ action: "close", tabIds: [7, 8] }, { signal: new AbortController().signal }); } catch (e) { gateErr = e; }
  check("旧扩展（1.0.15）批量关闭：在发命令之前就被拦下", gateErr !== null && gateErr.code === "extension_outdated", gateErr?.message?.slice(0, 120));
  check("旧扩展（1.0.15）批量关闭：报得出是哪个命令、从哪版开始有", /tabs\.closeMany/.test(gateErr?.message ?? "") && /added in extension v1\.0\.17/.test(gateErr?.message ?? ""), gateErr?.message?.slice(0, 160));
  check("旧扩展（1.0.15）批量关闭：一个字都没往扩展发", sent.length === 0, JSON.stringify(sent));
  const singleOk = await oldTabs.execute({ action: "close", tabId: 7 }, { signal: new AbortController().signal }).then((v) => v, (e) => null);
  check("旧扩展（1.0.15）单个关闭仍然可用（tabs.close 是 1.0.0 基线命令，不该被连坐）",
    singleOk !== null && sent.join() === "tabs.close", JSON.stringify(sent));
  // 关掉 socket 与桥之间留一拍：Windows 上 libuv 的 async handle 不能在关闭中途被 dispose，
  // 否则进程退出时会撞 "!(handle->flags & UV_HANDLE_CLOSING)" 断言（退出码变成 0xC0000409）。
  try { oldWs.close(); } catch {}
  await new Promise((r) => setTimeout(r, 100));
  for (const d of oldDisposers) { try { await d[0](); } catch {} }
  await new Promise((r) => setTimeout(r, 100));
}

try { ws.close(); } catch { /* already closed */ }
for (const disposer of disposers) {
  try { await disposer[0](); } catch { /* teardown 不参与断言 */ }
}

console.log(fails === 0 ? "\n批量关闭标签页的语义全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
