// #19 ② 的台子：`waitUntil` 四档 + 「到达」改成事件判定（Page.frameNavigated 等）。
// 三组断言（评审口径里点名的）：
//   1) 同站重定向回同一地址——「地址变了」当判据永远为假（www.bing.com → cn.bing.com
//      → 回原地址），只有事件才是权威来源。假件用事件桩手动驱动 frameNavigated。
//   2) 预算分档——none 0 秒通过、commit/domcontentloaded 4s 上限、显式 timeoutMs 永远优先。
//   3) 回执如实——waitUntil / waitedMs / readyState 都进 output schema（封闭 schema
//      少声明一个字段就是整条工具报错）并出现在结果里。
// 另加两条回归闸：轮询兜底还在（压根不提交的导航 ~1.2s 报 loadPending，不是 4s），
// 以及 tabs.open 的两步创建（先 about:blank 再 update——否则快页的 commit 事件在
// attach 完成前就没了）。
import { readFile } from "node:fs/promises";
import { bootBackground } from "./ext_harness.mjs";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const OLD = "https://old.test/page";
const TARGET = "https://new.test/dest";

/* ============ 扩展侧：真 background.js + 事件桩 ============ */

// 1) 同站重定向回同一地址：tabs API 一动不动（stale），只有 frameNavigated 事件
//    说「提交回了原地址」。判 URL 变化的实现在这里永远等不到，判事件的立刻通过。
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "stale";
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  setTimeout(() => model.fireCDP(tabId, "Page.frameNavigated", { frame: { url: OLD, parentId: undefined } }), 80);
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: OLD, waitUntil: "commit", timeoutMs: 3000 });
  const ms = Date.now() - started;
  check("同站重定向回同一地址：事件到达即返回，不干等预算", out.loadPending === undefined && ms < 2000, JSON.stringify({ ...out, ms }));
  check("重定向回执：waitUntil=commit + waitedMs 数值", out.waitUntil === "commit" && typeof out.waitedMs === "number", `waitedMs=${out.waitedMs}`);
}

// 1b) 旧文档迟到的 dcl/load 不冒领（PR #12 那个竞态在 CDP 层的样子）：慢启动窗口里
//     手动塞进一个 loadEventFired——它属于旧文档，必须被忽略，真到达仍由事件链结算。
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "slowstart";
  model.slowStartMs = 500;
  model.loadDelayMs = 240;
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  setTimeout(() => model.fireCDP(tabId, "Page.loadEventFired", {}), 100);
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "load", timeoutMs: 3000 });
  const ms = Date.now() - started;
  check("旧文档的迟到 load 不算新文档完成（认领 commit 之前的事件被忽略）", out.loadPending === undefined && ms >= 400, `用时 ${ms}ms`);
}

// 1c) about:blank 出生提交迟到也不冒领：两步创建的落位提交若在发起之后才到
//     （真实 Chrome 的边缘情况），不许被当成目的地已提交。
{
  const { model, ctx } = await bootBackground();
  setTimeout(() => model.fireCDP(100, "Page.frameNavigated", { frame: { url: "about:blank", parentId: undefined } }), 30);
  const out = await ctx.cmdTabsOpen({ url: TARGET, waitUntil: "commit", group: false });
  check("about:blank 的迟到提交冒领不了（等到真目的地）", out.url === TARGET && out.loadPending === undefined, JSON.stringify(out));
}

// 2) 预算分档
{
  // a. commit 档默认预算 4s（不是 15s）：一直 loading、不发事件
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "hang";
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "commit" });
  const ms = Date.now() - started;
  check("commit 档默认预算 4s 上限（原 15s）", out.loadPending === true && ms >= 3900 && ms < 6000, `用时 ${ms}ms`);
  check("hang 回执如实：loadPending + waitedMs ≈ 4000", out.waitedMs >= 3900, `waitedMs=${out.waitedMs}`);
}
{
  // b. 显式 timeoutMs 永远优先
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "hang";
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "commit", timeoutMs: 800 });
  const ms = Date.now() - started;
  check("显式 timeoutMs=800 压过 commit 档的 4s", out.loadPending === true && ms >= 700 && ms < 2000, `用时 ${ms}ms`);
}
{
  // c. none：0 秒通过、不做到达判定、也不 attach（连「正受控制」横幅都不该出现）
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "stale";
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "none" });
  const ms = Date.now() - started;
  check("none 档立即返回且不报 loadPending", ms < 300 && out.loadPending === undefined, `用时 ${ms}ms ${JSON.stringify(out)}`);
  check("none 档回执：waitUntil=none", out.waitUntil === "none", JSON.stringify(out));
  check("none 档零 debugger 附着", model.dbg.attached.size === 0, `attached=${model.dbg.attached.size}`);
}
{
  // d. domcontentloaded 档不等 load：load 事件故意拖到 3s 后，dcl 在提交后 50ms 就该返回
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.loadDelayMs = 200;
  model.loadEventDelayMs = 3000;
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "domcontentloaded" });
  const ms = Date.now() - started;
  check("domcontentloaded 档不等 load 事件（200+50ms 返回，不等 3s 的 load）", out.loadPending === undefined && ms < 1500, `用时 ${ms}ms`);
  check("dcl 回执：readyState 如实带出", out.readyState === "complete", `readyState=${out.readyState}`);
}

// 3) 回归闸：轮询兜底还在——压根不提交的导航 ~1.2s 报 loadPending，不是 4s
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  model.nav = "stale";
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "commit", timeoutMs: 3000 });
  const ms = Date.now() - started;
  check("永不提交的导航仍走 1.2s 宽限期如实报 loadPending（不是 0ms 也不是 4s）", out.loadPending === true && ms >= 1000 && ms < 2500, `用时 ${ms}ms`);
}

// 4) tabs.open 两步创建 + 共用等待器
{
  const { model, ctx } = await bootBackground();
  model.loadDelayMs = 150;
  const out = await ctx.cmdTabsOpen({ url: TARGET, waitUntil: "commit", group: false });
  check("tabs.open（commit 档）：报出提交后的 URL", out.url === TARGET && out.loadPending === undefined, JSON.stringify(out));
  check("tabs.open 两步创建：先 about:blank 落位再发真导航", model.calls.create === 1, `creates=${model.calls.create}`);
  check("tabs.open 回执：waitUntil/waitedMs 齐全", out.waitUntil === "commit" && typeof out.waitedMs === "number", JSON.stringify(out));
}
{
  const { model, ctx } = await bootBackground();
  const out = await ctx.cmdTabsOpen({ url: TARGET, waitUntil: "none", group: false });
  check("tabs.open none 档：不等待、不 attach", out.waitUntil === "none" && model.dbg.attached.size === 0, JSON.stringify(out));
}
{
  // 旧开关 wait:false 并进 none，语义不悄悄变
  const { model, ctx } = await bootBackground();
  const out = await ctx.cmdTabsOpen({ url: TARGET, wait: false, group: false });
  check("wait:false 等价 waitUntil=none", out.waitUntil === "none" && out.loadPending === undefined, JSON.stringify(out));
}
{
  // 非法档位：报出合法清单，而不是静默当 load
  const { model, ctx } = await bootBackground();
  model.addTab(1, OLD);
  const out = await ctx.cmdNav({ url: TARGET, waitUntil: "DOMContentLoaded" }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("大小写敏感：非法 waitUntil 报错并列出合法值", /none, commit, domcontentloaded, load/.test(String(out.error)), String(out.error));
}

/* ============ 插件侧：真 BridgeServer + 假扩展 ============ */

const PORT = 9786;
const TOKEN = "nav-waituntil-test";
const tools = [];
const disposers = [];

const config = Config({ enabled: true, port: PORT, token: TOKEN });
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

const ctx2 = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: ctx2.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};

apply(ctx2, config);
await new Promise((r) => setTimeout(r, 400));

const nav = tools.find((t) => t.name === "browser_navigate");
const tabsTool = tools.find((t) => t.name === "browser_tabs");
check("browser_navigate / browser_tabs 已注册", Boolean(nav) && Boolean(tabsTool));

const props = nav?.parameters?.properties ?? {};
check("参数表暴露了 waitUntil", props.waitUntil !== undefined, Object.keys(props).join(","));
check("waitUntil 描述列出全部四档", ["none", "commit", "domcontentloaded", "load"].every((t) => String(props.waitUntil?.description ?? "").includes(`"${t}"`)), String(props.waitUntil?.description ?? "").slice(0, 100));
const schemaProps = nav?.output?.schema?.properties ?? {};
check("output schema 声明了回执三字段（封闭 schema 少一个就整条报错）", schemaProps.waitUntil !== undefined && schemaProps.waitedMs !== undefined && schemaProps.readyState !== undefined, Object.keys(schemaProps).join(","));

let reply = true;
let lastNavParams = null;
let lastTabsOpenParams = null;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.4.0", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    if (msg.command === "nav") lastNavParams = msg.params ?? null;
    if (msg.command === "tabs.open") lastTabsOpenParams = msg.params ?? null;
    if (!reply) return;
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 7, url: msg.params?.url ?? "", title: "T", waitUntil: msg.params?.waitUntil, waitedMs: 12, readyState: "complete" } }));
  };
  setTimeout(r, 400);
});

const signal = () => new AbortController().signal;

// 默认（不传 waitUntil）：load 档 + 15000 预算下传
await nav.execute({ url: "https://a.example/" }, { signal: signal() });
check("默认 waitUntil=load 且 timeoutMs=15000 下传", lastNavParams?.waitUntil === "load" && lastNavParams?.timeoutMs === 15_000, JSON.stringify(lastNavParams));

// commit 档：预算取档位默认 4000
await nav.execute({ url: "https://b.example/", waitUntil: "commit" }, { signal: signal() });
check("commit 档预算 4000 下传", lastNavParams?.waitUntil === "commit" && lastNavParams?.timeoutMs === 4_000, JSON.stringify(lastNavParams));

// 显式 timeoutMs 优先
await nav.execute({ url: "https://c.example/", waitUntil: "commit", timeoutMs: 800 }, { signal: signal() });
check("显式 timeoutMs=800 压过档位默认", lastNavParams?.timeoutMs === 800, JSON.stringify(lastNavParams));

// none：不带预算
await nav.execute({ url: "https://d.example/", waitUntil: "none" }, { signal: signal() });
check("none 档不带 timeoutMs 键", lastNavParams?.waitUntil === "none" && !("timeoutMs" in (lastNavParams ?? {})), JSON.stringify(lastNavParams));

// 非法值在插件侧就被拒
let rejected = null;
try {
  await nav.execute({ url: "https://e.example/", waitUntil: "whenever" }, { signal: signal() });
} catch (e) {
  rejected = e instanceof Error ? e.message : String(e);
}
check("非法 waitUntil 在插件侧报出合法清单", /none, commit, domcontentloaded, load/.test(String(rejected)), String(rejected));

// 回执字段透传
const passed = await nav.execute({ url: "https://f.example/" }, { signal: signal() });
check("回执 waitUntil/waitedMs/readyState 透传进输出", passed.waitUntil === "load" && passed.waitedMs === 12 && passed.readyState === "complete", JSON.stringify(passed));

// tabs.open 的 open action 同样接上
await tabsTool.execute({ action: "open", url: "https://g.example/", waitUntil: "domcontentloaded" }, { signal: signal() });
check("tabs.open 下传 waitUntil + 档位预算", lastTabsOpenParams?.waitUntil === "domcontentloaded" && lastTabsOpenParams?.timeoutMs === 4_000, JSON.stringify(lastTabsOpenParams));

// 桥余量：commit 档预算 4000 → 桥必须在 ~6s 处自己超时（预算 + 2s），而不是撑到默认 60s
reply = false;
const started = Date.now();
let error = null;
try {
  await nav.execute({ url: "https://slow.example/", waitUntil: "commit" }, { signal: signal() });
} catch (e) {
  error = e;
}
const elapsed = Date.now() - started;
const message = error instanceof Error ? error.message : String(error);
check("commit 档桥超时 = 预算 + 2s（约 6s，不是 60s）", elapsed >= 5_000 && elapsed < 9_000, `${elapsed}ms`);
check("桥超时文案带的是 6000ms", /6000/.test(message), message.slice(0, 120));

/* ============ 跨侧字面量对账：两侧 NAV_TIERS 必须一致 ============ */
{
  const bg = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const m = bg.match(/const NAV_TIERS = \{([^}]+)\}/);
  const extTiers = {};
  if (m) for (const [, k, v] of m[1].matchAll(/(\w+):\s*([\d_]+)/g)) extTiers[k] = Number(v.replaceAll("_", ""));
  check("扩展侧 NAV_TIERS 存在且与插件侧逐字一致", m !== undefined
    && extTiers.none === 0 && extTiers.commit === 4_000
    && extTiers.domcontentloaded === 4_000 && extTiers.load === 15_000,
  JSON.stringify(extTiers));
}

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
