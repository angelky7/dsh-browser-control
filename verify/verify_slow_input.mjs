// 慢输入诊断台子（1.7.14 新增）。
//
// 要拦的是什么：一条 **静默** 的 5 秒。没有报错、没有丢失、体积也没变——只是慢。
// 宿主侧只看得到「这次工具调用花了 5 秒」，没有任何字段能说明为什么，于是模型会：
//   · 以为页面卡了，去 reload（把真正的状态丢掉）；
//   · 或者干脆再点一次（在已经生效的页面上多点一下）。
// 两条都是坏结局，而真因只有一句话：**这个标签从来没被激活过，没有合成表面**，
// Chromium 会让每个 Input.dispatchMouseEvent 等一个（约 5s/事件，一次点击 3 个）。
// 激活一次之后就再也测不出延迟（实测 9ms）。
//
// 本台子钉死四件事：
//   1) 慢的输入命令，结果里带 durationMs 与指向 browser_tabs activate 的 warning；
//   2) 快的输入命令**不**带 warning（不许变成噪音，那会让真告警失效）；
//   3) input 的 fill 模式不派发按键，所以再慢也不该报这个警（口径要准）；
//   4) 非输入命令（且输出 schema 是 strict 的）结果形状一个字不加 ——
//      否则 validateJsonSchemaValue 会红，且会破坏所有下游对结果形状的假设。

import { Config, apply } from "../lib/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9807; // 9777 装机默认 / 9785 批量关闭台 / 9801 审计台
const TOKEN = "slow-input-test";
const SHOTS = await mkdtemp(path.join(tmpdir(), "dsh-slow-"));
const tools = [];
const disposers = [];
const config = Config({ stateDir: (process.env.TEMP || "/tmp") + "/dsh-verify-state", enabled: true, port: PORT, token: TOKEN, shotsDir: SHOTS });
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

// 假扩展：每条命令都可控地慢。delayFor 决定这条命令该睡多久。
let delayFor = () => 0;
const seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello", client: "fake-extension", version: "1.7.2", protocol: 1,
      browser: { name: "fake", version: "1", ua: "" },
      capabilities: ["click", "input", "press", "eval", "content"],
    }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seen.push(msg.command);
    const wait = delayFor(msg.command, msg.params);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 7, clicked: true, filled: true, value: "x", text: "body", url: "https://a.test/" } }));
    }, wait);
  };
  setTimeout(r, 400);
});
await new Promise((r) => setTimeout(r, 100));

const byName = (n) => tools.find((t) => t.name === n);
const signal = () => new AbortController().signal;
const call = (name, args) => byName(name).execute(args, { signal: signal() }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

const checkShape = (label, tool, args, value) => {
  const violations = validateJsonSchemaValue(tool.output.schema, value, "value");
  check(`${label}: 结果过输出 schema`, violations.length === 0, violations.join(" | "));
  const blocks = tool.output.render(args, value);
  const text = Array.isArray(blocks) ? blocks.map((p) => p.text ?? "").join("\n") : "";
  check(`${label}: render 仍有内容`, text.length > 0, `${text.length} chars`);
};

/* 1 —— 慢点击：结果里必须自己说得清 */
{
  delayFor = (cmd) => (cmd === "click" ? 1200 : 0);
  const click = byName("browser_click");
  const res = await call("browser_click", { tabId: 7, selector: ".a" });
  check("慢点击：调用本身仍然成功（慢不是失败）", res.ok === true, res.error?.slice(0, 120));
  check("慢点击：结果带 durationMs 且 ≥ 1000", res.ok && typeof res.r.durationMs === "number" && res.r.durationMs >= 1000, JSON.stringify(res.r?.durationMs));
  check("慢点击：结果带 slow_input 告警", res.ok && typeof res.r.warning === "string" && /slow_input/.test(res.r.warning), String(res.r?.warning).slice(0, 80));
  check("慢点击：告警说得出「多少毫秒」", res.ok && /\d+ms/.test(String(res.r?.warning)), String(res.r?.warning).slice(0, 120));
  check("慢点击：告警指向 browser_tabs action:\"activate\"（不是叫模型重试）",
    res.ok && /browser_tabs action:"activate"/.test(String(res.r?.warning)), String(res.r?.warning).slice(0, 160));
  check("慢点击：告警解释了「为什么只有输入类慢」（同标签上非输入命令仍是毫秒级）",
    res.ok && /compositing surface/.test(String(res.r?.warning)), String(res.r?.warning).slice(0, 160));
  if (res.ok) checkShape("慢点击", click, { tabId: 7, selector: ".a" }, res.r);
}

/* 2 —— 快点击：不许刷告警 */
{
  delayFor = () => 0;
  const res = await call("browser_click", { tabId: 7, selector: ".a" });
  check("快点击：成功", res.ok === true, res.error?.slice(0, 120));
  check("快点击：不带 warning（真告警不许被噪音稀释）", res.ok && res.r.warning === undefined, JSON.stringify(res.r?.warning));
}

/* 3 —— type 模式慢：同样要报（它派发的是真按键） */
{
  delayFor = (cmd) => (cmd === "input" ? 1200 : 0);
  const res = await call("browser_type", { tabId: 7, selector: "#q", value: "abc", mode: "type" });
  check("type 模式慢输入：带 slow_input 告警", res.ok && /slow_input/.test(String(res.r?.warning)), String(res.r?.warning).slice(0, 80));
  check("type 模式慢输入：告警里说的是 key event（不是三个鼠标事件）",
    res.ok && /key event/.test(String(res.r?.warning)), String(res.r?.warning).slice(0, 160));
}

/* 4 —— fill 模式再慢也不报：它走 JS 设值，不派发任何按键 */
{
  delayFor = (cmd) => (cmd === "input" ? 1200 : 0);
  const res = await call("browser_type", { tabId: 7, selector: "#q", value: "abc" });
  check("fill 模式慢：成功", res.ok === true, res.error?.slice(0, 120));
  check("fill 模式慢：不报 slow_input（它不派发按键，报这个警是误导）",
    res.ok && res.r.warning === undefined, JSON.stringify(res.r?.warning));
}

/* 5 —— 非输入命令：形状一个字不加（strict schema 的工具会被打回） */
{
  delayFor = (cmd) => (cmd === "eval" ? 1200 : 0);
  const evalTool = byName("browser_evaluate");
  const res = await call("browser_evaluate", { tabId: 7, expression: "1+1" });
  check("慢 evaluate：成功", res.ok === true, res.error?.slice(0, 120));
  check("慢 evaluate：不带 durationMs（它不派发输入，且 schema 是 strict）",
    res.ok && res.r.durationMs === undefined, JSON.stringify(res.r?.durationMs));
  check("慢 evaluate：不带 warning", res.ok && res.r.warning === undefined, JSON.stringify(res.r?.warning));
  if (res.ok) checkShape("慢 evaluate", evalTool, { tabId: 7, expression: "1+1" }, res.r);
}

/* 6 —— 快 evaluate：同样没有额外字段（这是 regression 守门） */
{
  delayFor = () => 0;
  const res = await call("browser_evaluate", { tabId: 7, expression: "1+1" });
  check("快 evaluate：结果里没有 durationMs/warning 这类附加字段",
    res.ok && res.r.durationMs === undefined && res.r.warning === undefined, JSON.stringify(Object.keys(res.r ?? {})));
}

/* 7 —— 阈值口径：刚好低于 SLOW_INPUT_MS 不许报 */
{
  delayFor = (cmd) => (cmd === "click" ? 400 : 0);
  const res = await call("browser_click", { tabId: 7, selector: ".a" });
  check("400ms 的点击：不报（阈值是 1000ms，别把正常慢当故障）",
    res.ok && res.r.warning === undefined, JSON.stringify(res.r?.warning));
}

/* 8 —— 告警不许把审计里的耗时搞丢（两个数字必须同源同值） */
{
  delayFor = (cmd) => (cmd === "click" ? 1200 : 0);
  const slow = await call("browser_click", { tabId: 7, selector: ".a" });
  const shown = slow.ok ? slow.r.durationMs : undefined;
  delayFor = () => 0;
  const list = await call("browser_audit", {});
  const clickEntries = list.ok ? list.r.entries.filter((e) => e.command === "click") : [];
  // 比的是**相等**而不是「都很大」：结果里那个数字和审计里那条必须是同一次测量，
  // 否则就是两处各算一遍，慢的根因会被算到两套口径里去。
  check("审计里留着同一次 click 的耗时（与结果里的数字逐毫秒相同）",
    typeof shown === "number" && clickEntries.some((e) => e.durationMs === shown),
    `结果 ${shown}ms / 审计 ${JSON.stringify(clickEntries.map((e) => e.durationMs))}`);
}

try { ws.close(); } catch { /* already closed */ }
await new Promise((r) => setTimeout(r, 100));
for (const d of disposers) { try { await d[0](); } catch { /* teardown 不参与断言 */ } }
await new Promise((r) => setTimeout(r, 100));

console.log(fails === 0 ? "\n慢输入诊断全部通过：慢的会自证、快的会闭嘴、不该报的一条不报" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
