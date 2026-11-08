// browser_metrics + 弱网/CPU 节流的台子（迭代 12，v1.7.1）。
//   扩展侧：metrics 只透传已知指标名（封闭 schema 的前提，假件故意混进未知名字）、
//   回空如实报错；emulate 的 network/cpuThrottlingRate 走的 CDP 参数逐字对上
//   （dbg.log），reset 是「全部还原」不只设备形状，未知预设报错并列出合法值。
//   插件侧：browser_metrics 字面量分发、emulate 透传节流参数、render 带数字、
//   分类（metrics 纯读进白名单；emulate 仍是写命令）。
import { Config, apply, policyRefusal, READ_ONLY_ALLOWED } from "../lib/index.js";
import { bootBackground } from "./ext_harness.mjs";
import { isWriteCommand } from "../src/errors.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const lastCall = (model, method) => [...model.dbg.log].reverse().find((e) => e.method === method);

/* ============ 扩展侧：metrics ============ */
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://perf.test/");
  const out = await ctx.cmdMetrics({ tabId });
  check("metrics：已知指标名进回执", out.tabId === tabId && out.metrics.Nodes === 123 && out.metrics.JSHeapUsedSize === 4_404_019, JSON.stringify(out.metrics));
  check("metrics：未知名字被过滤掉（不打穿封闭 schema）", out.metrics.MysteryFutureMetric === undefined, JSON.stringify(Object.keys(out.metrics)));
}
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://perf.test/");
  model.dbg.results["Performance.getMetrics"] = () => ({});
  const out = await ctx.cmdMetrics({ tabId }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("metrics：回空如实报错（不拿空对象装成功）", /returned no metrics/.test(String(out.error)), String(out.error));
}

/* ============ 扩展侧：network / CPU 节流 ============ */
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://slow.test/");
  const out = await ctx.cmdEmulate({ tabId, network: "slow3g" });
  const call = lastCall(model, "Network.emulateNetworkConditions");
  check("slow3g：CDP 参数逐字对上（400ms / 51200 / 51200）", call && call.params.latency === 400 && call.params.downloadThroughput === 51_200 && call.params.uploadThroughput === 51_200 && call.params.offline === false, JSON.stringify(call?.params));
  check("slow3g：回执带生效的数字（模型只看这句话）", out.network === "slow3g" && out.latency === 400 && out.downloadThroughput === 51_200, JSON.stringify(out));
  check("slow3g：Network.enable 先落位", model.dbg.log.some((e) => e.method === "Network.enable"), JSON.stringify(model.dbg.log.map((e) => e.method)));
}
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://cpu.test/");
  const out = await ctx.cmdEmulate({ tabId, cpuThrottlingRate: 4 });
  const call = lastCall(model, "Emulation.setCPUThrottlingRate");
  check("cpu×4：setCPUThrottlingRate 拿到 rate=4", call && call.params.rate === 4, JSON.stringify(call?.params));
  check("cpu×4：回执 cpuThrottlingRate=4", out.cpuThrottlingRate === 4, JSON.stringify(out));
  const bad = await ctx.cmdEmulate({ tabId, cpuThrottlingRate: 99 }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("cpu 限速超界报错并说明合法范围", /between 1 \(no throttle\) and 20/.test(String(bad.error)), String(bad.error));
}
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://net.test/");
  const bad = await ctx.cmdEmulate({ tabId, network: "dialup" }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("未知网络预设报错并列出合法值", /slow3g, fast3g, offline, reset/.test(String(bad.error)), String(bad.error));
  const out = await ctx.cmdEmulate({ tabId, network: "offline" });
  const call = lastCall(model, "Network.emulateNetworkConditions");
  check("offline：offline=true、吞吐 0", call && call.params.offline === true && call.params.downloadThroughput === 0, JSON.stringify(call?.params));
  check("offline：回执如实", out.network === "offline" && out.latency === 0, JSON.stringify(out));
  const rst = await ctx.cmdEmulate({ tabId, network: "reset" });
  const un = lastCall(model, "Network.emulateNetworkConditions");
  check("network reset：吞吐 -1（CDP 的「不节流」），offline=false", un && un.params.offline === false && un.params.downloadThroughput === -1, JSON.stringify(un?.params));
  check("network reset：回执带 reset 与清后数值", rst.network === "reset" && rst.downloadThroughput === -1, JSON.stringify(rst));
}
{
  // device reset 是「全部还原」：网络与 CPU 节流一起清，否则模型以为恢复了真实环境
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://reset.test/");
  await ctx.cmdEmulate({ tabId, device: "mobile-iphone-13", network: "slow3g", cpuThrottlingRate: 4 });
  const out = await ctx.cmdEmulate({ tabId, device: "reset" });
  const net = [...model.dbg.log].reverse().find((e) => e.method === "Network.emulateNetworkConditions");
  const cpu = [...model.dbg.log].reverse().find((e) => e.method === "Emulation.setCPUThrottlingRate");
  check("device reset 连网络节流一起清", net && net.params.downloadThroughput === -1 && net.params.offline === false, JSON.stringify(net?.params));
  check("device reset 连 CPU 节流一起清（rate 回 1）", cpu && cpu.params.rate === 1, JSON.stringify(cpu?.params));
  check("reset 回执说清了清了什么", out.reset === true && out.network === "reset" && out.cpuThrottlingRate === 1, JSON.stringify(out));
}
{
  // 节流挂会话上：只传节流不动设备形状（width 不在回执里顶出 0×0）
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://only.test/");
  const out = await ctx.cmdEmulate({ tabId, network: "fast3g" });
  const metrics = model.dbg.log.filter((e) => e.method === "Emulation.setDeviceMetricsOverride");
  check("只过节流不动设备形状", metrics.length === 0 && out.width === 0, JSON.stringify(out));
  const fast = lastCall(model, "Network.emulateNetworkConditions");
  check("fast3g：150ms / 204800 / 96000", fast && fast.params.latency === 150 && fast.params.downloadThroughput === 204_800 && fast.params.uploadThroughput === 96_000, JSON.stringify(fast?.params));
}

/* ============ 插件侧 ============ */
const PORT = 9790;
const TOKEN = "metrics-test";
const tools = [];
const disposers = [];
const config = Config({ enabled: true, port: PORT, token: TOKEN });
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

const metricsTool = tools.find((t) => t.name === "browser_metrics");
const emulateTool = tools.find((t) => t.name === "browser_emulate");
check("browser_metrics 已注册（工具面 27 条）", Boolean(metricsTool) && tools.length === 27, String(tools.length));

const seenCommands = [];
const seenParams = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.7.1", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seenCommands.push(msg.command);
    seenParams.push(msg.params);
    if (msg.command === "metrics") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 3, metrics: { Nodes: 456, JSHeapUsedSize: 10_485_760, JSHeapTotalSize: 20_971_520, LayoutCount: 7, ScriptDuration: 2.5, TaskDuration: 4 } } }));
    } else {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 3, width: 0, height: 0, network: msg.params.network ?? "reset", latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200, cpuThrottlingRate: msg.params.cpuThrottlingRate ?? 1 } }));
    }
  };
  setTimeout(r, 400);
});
const signal = () => new AbortController().signal;

const m = await metricsTool.execute({ tabId: 3 }, { signal: signal() });
check("metrics 字面量分发到 metrics 命令", seenCommands.at(-1) === "metrics", JSON.stringify(seenCommands));
const rendered = metricsTool.output.render({}, m)[0].text;
check("render 带数字本身（nodes/heap/layouts/script）", /nodes=456/.test(rendered) && /heap=10\.0\/20\.0MB/.test(rendered) && /layouts=7/.test(rendered) && /script=2\.50s/.test(rendered), rendered);

seenCommands.length = 0;
seenParams.length = 0;
await emulateTool.execute({ tabId: 3, network: "slow3g", cpuThrottlingRate: 4 }, { signal: signal() });
check("emulate 透传节流参数（还是那条 emulate 命令）", seenCommands.at(-1) === "emulate" && seenParams[0].network === "slow3g" && seenParams[0].cpuThrottlingRate === 4, JSON.stringify(seenParams));
const out2 = await emulateTool.execute({ tabId: 3, network: "slow3g", cpuThrottlingRate: 4 }, { signal: signal() });
const r2 = emulateTool.output.render({}, out2)[0].text;
check("emulate render 写出哪档节流在生效", /slow3g\(400ms/.test(r2) && /cpu×4/.test(r2), r2);

/* ============ 分类与只读档 ============ */
check("metrics 是读命令（重试只是再读一遍）", isWriteCommand("metrics") === false);
check("readOnly 放行 metrics（进白名单）", policyRefusal("metrics", { readOnly: true }) === undefined && READ_ONLY_ALLOWED.has("metrics"));
check("emulate 仍是写命令且只读档拒（节流改页面行为）", isWriteCommand("emulate") === true && policyRefusal("emulate", { readOnly: true }) !== undefined);

disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
