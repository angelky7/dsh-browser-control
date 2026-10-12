// 错误契约实测：分类是否正确、写操作是否被标成「结果未知」、HTTP 面是否把
// code / effectState / hint 一起回给调用方。
import net from "node:net";
import { classify, BridgeError, isWriteCommand } from "../src/errors.ts";
import { BridgeServer } from "../src/server.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

// ---- 纯函数层：分类表 ----
const cases = [
  ["click", "browser command timed out after 60000ms: click", "command_timeout", "unknown"],
  ["screenshot", "browser command timed out after 60000ms: screenshot", "command_timeout", "not_started"],
  ["input", "the browser extension disconnected mid-command", "link_lost", "unknown"],
  ["read-cmd", "the browser extension disconnected mid-command", "link_lost", "not_started"],
  ["nav", "no browser extension connected — open the browser", "extension_offline", "not_started"],
  ["eval", "Runtime.evaluate failed: cannot access context", "command_failed", "unknown"],
  ["content", "content failed: no such element", "command_failed", "not_started"],
  ["click", "browser command cancelled: click", "cancelled", "not_started"],
  ["tabs.open", "browser-bridge stopped", "link_lost", "unknown"],
  ["click", "浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里配 enabled: true", "bridge_disabled", "not_started"],
  ["cleanup", "browser-bridge is not configured yet —— 尚未加载配置", "not_configured", "not_started"],
];
for (const [cmd, msg, code, effect] of cases) {
  const e = classify(cmd, new Error(msg));
  check(`classify(${cmd}) → ${code}/${effect}`, e.code === code && e.effectState === effect, `${e.code}/${e.effectState}｜${e.message.slice(0, 46)}`);
}

// hint 必须每条都有，且 message 带 [code] 前缀
const codes = new Set(cases.map((c) => c[2]));
for (const code of codes) {
  const sample = classify("click", new Error(cases.find((c) => c[2] === code)[1]));
  check(`code=${code} 有 hint 且 message 带前缀`, typeof sample.hint === "string" && sample.hint.length > 12 && sample.message.startsWith(`[${code}]`), sample.hint.slice(0, 40));
}

// 幂等：已经分类过的不再重复包裹
const once = classify("click", new Error("browser command timed out after 1ms: click"));
const twice = classify("click", once);
check("classify 幂等（不洗掉 code）", twice === once, twice === once ? "同一实例" : "被重新分类了");

// 读/写判定
check("click/input/nav 是写操作", isWriteCommand("click") && isWriteCommand("input") && isWriteCommand("nav"));
check("screenshot/find/content 是只读", !isWriteCommand("screenshot") && !isWriteCommand("find") && !isWriteCommand("content"));
check("BridgeError.toJSON 带三个字段", (() => {
  const j = once.toJSON();
  return j.ok === false && j.code === "command_timeout" && j.effectState === "unknown" && typeof j.hint === "string";
})(), JSON.stringify(once.toJSON()).slice(0, 120));

// ---- 失败文案必须把「该不该重试」交给模型 ----
// 宿主的失败内容是 `Error: ${message}`（@deepseek-ai/dsh-tools lib/index.js:3616-3623），
// code / effectState / hint 这些字段只进 error.info 与 HTTP 面，模型读不到。
// 所以这句 message 才是错误契约真正生效的地方。
const writeTimeout = classify("click", new Error("browser command timed out after 800ms: click"));
const readTimeout = classify("screenshot", new Error("browser command timed out after 800ms: screenshot"));
const hostView = (e) => `Error: ${e.message}`; // 宿主就是这么渲染失败内容的

check("写操作超时：模型可见文本里有 effectState=unknown", hostView(writeTimeout).includes("effectState=unknown"), hostView(writeTimeout));
check("写操作超时：模型可见文本明确禁止直接重试", /不要直接重试|先用只读工具/.test(hostView(writeTimeout)), hostView(writeTimeout).slice(-90));
check("写操作超时：模型可见文本带 hint 正文", hostView(writeTimeout).includes(writeTimeout.hint), hostView(writeTimeout).slice(-60));
check("只读超时：模型可见文本说 retry 安全", hostView(readTimeout).includes("effectState=not_started") && hostView(readTimeout).includes("重试安全"), hostView(readTimeout));
check("失败文本仍带 [code] 前缀", hostView(writeTimeout).startsWith("Error: [command_timeout]"), hostView(writeTimeout).slice(0, 40));
for (const [cmd, msg, code] of [["click", "the browser extension disconnected mid-command", "link_lost"], ["click", "no browser extension connected", "extension_offline"], ["click", "browser-bridge is not configured yet", "not_configured"]]) {
  const e = classify(cmd, new Error(msg));
  check(`code=${code}：hint 与 effectState 都在模型可见文本里`, modelSeesContract(e), e.message.slice(-70));
}
/** 模型可见文本必须同时拿到分类、副作用状态与下一步动作。 */
function modelSeesContract(e) {
  const j = e.toJSON();
  return e.message.includes(j.hint) && e.message.includes(`effectState=${j.effectState}`) && e.message.startsWith(`[${j.code}]`);
}

// HTTP 面形状不许因为文案变长而变脏
check("toJSON().error 是原始失败描述（不含追加文案与前缀）",
  writeTimeout.toJSON().error === "browser command timed out after 800ms: click",
  writeTimeout.toJSON().error);
check("toJSON() 的 hint 不重复出现在 error 字段里",
  !writeTimeout.toJSON().error.includes("下一步"), writeTimeout.toJSON().error.slice(0, 80));

// ---- 集成层：真 BridgeServer + 不回话的假扩展 ----
const PORT = 9778;
const TOKEN = "err-test-token";
const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
let saw = [];
await new Promise((r) => {
  ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", client: "fake", version: "1", browser: { name: "f", version: "1", ua: "" } })); r(); };
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === "command") saw.push(m.command); /* 故意不回 result */ };
  setTimeout(r, 250);
});

const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

const write = await post({ command: "click", params: { selector: "button.submit" }, timeoutMs: 800 });
check("写操作超时 → HTTP 504", write.status === 504, `实际 ${write.status}`);
check("写操作超时 → effectState=unknown（不许盲目重试）", write.json.effectState === "unknown", JSON.stringify(write.json).slice(0, 100));
check("写操作超时 → code=command_timeout + hint", write.json.code === "command_timeout" && (write.json.hint || "").length > 10);

const read = await post({ command: "screenshot", params: {}, timeoutMs: 800 });
check("只读超时 → effectState=not_started（重试安全）", read.json.effectState === "not_started", JSON.stringify(read.json).slice(0, 100));

ws.close();
await new Promise((r) => setTimeout(r, 150));
const offline = await post({ command: "nav", params: { url: "https://example.com" }, timeoutMs: 800 });
check("扩展掉线后 → HTTP 503 + extension_offline", offline.status === 503 && offline.json.code === "extension_offline", JSON.stringify(offline.json).slice(0, 110));
check("前两条确实发到链路上；断线后不再下发（不是空转也不是乱发）",
  saw.includes("click") && saw.includes("screenshot") && !saw.includes("nav"), saw.join(","));

await server.stop();
console.log(`\n结论：${fails === 0 ? "错误契约全部通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
