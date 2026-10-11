// 端到端（缺一个真浏览器）：真的 BridgeServer + 真的扩展 service worker + 真的
// WebSocket，跑在 127.0.0.1 上，只有 `chrome.*` 是假的。
//
// 之前 verify_http.mjs 用的是手写假 WS 客户端，只能证明「桥懂帧格式」；这条证明的是
// **扩展里那段真代码**连上桥之后，HTTP 命令面下发的命令会不会走到 `COMMANDS` 表、
// 结果能不能原样回来。归组这种新命令最容易死在「扩展实现了、桥不认识、插件调不到」
// 的中间地带，这里一次对齐。
import { BridgeServer } from "../src/server.ts";
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const PORT = 9779;
const TOKEN = "e2e-token-1234567890";
const model = makeModel();

const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

const { ctx } = await bootBackground({
  model,
  realWebSocket: true,
  storage: { port: PORT, token: TOKEN, autoConnect: true },
});

// 扩展顶层就跑 init()→loadConfig()→connect()，等它把 hello 发过来
const waitConnected = async () => {
  for (let i = 0; i < 100; i++) {
    if (server.status.extensionConnected) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
check("扩展真的连上了桥（WS 握手 + Token + hello）", await waitConnected(),
  JSON.stringify(server.status).slice(0, 160));

check("hello 帧带过来的协议版本被桥认下",
  server.status.extensionProtocol === 1 && server.status.protocolCompatible === true,
  `extension=${server.status.extensionProtocol} compatible=${server.status.protocolCompatible}`);

const call = async (command, params = {}, timeoutMs = 4000) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command, params, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 2000),
  });
  return { status: res.status, json: await res.json() };
};

/* 归组命令走完整条链路 */
const opened = await call("tabs.open", { url: "https://e2e.test", wait: false });
const group = opened.json?.result ?? {};
check("HTTP 下发 tabs.open → 扩展真的建了标签并归组",
  opened.status === 200 && typeof group.tabId === "number" && group.grouped === true && group.created === true,
  JSON.stringify(opened.json).slice(0, 200));
check("桥没有改写结果载荷（tabId/group 原样回来）",
  model.tabs.get(group.tabId)?.url === "https://e2e.test" && model.groups.get(group.groupId)?.title === "DSH",
  `tab=${JSON.stringify(model.tabs.get(group.tabId))} group=${JSON.stringify(model.groups.get(group.groupId))}`);

const looseId = model.addTab(1, "https://loose.test");
const grouped = await call("tabs.group", { tabId: looseId });
check("HTTP 下发 tabs.group → 散标签进了同一个组",
  grouped.json.result?.grouped === true && grouped.json.result?.created === false && model.tabs.get(looseId).groupId === group.groupId,
  JSON.stringify(grouped.json).slice(0, 160));

const listed = await call("tabs.list", {});
check("HTTP 下发 tabs.list → 数量与假浏览器一致",
  listed.json.result?.count === model.tabs.size, `桥报 ${listed.json.result?.count}，假浏览器有 ${model.tabs.size}`);

const dissolved = await call("tabs.ungroup", {});
check("HTTP 下发 tabs.ungroup → 组确实被拆了",
  dissolved.json.result?.ungrouped >= 2 && model.groups.size === 0,
  JSON.stringify(dissolved.json.result));

/* 错误也要走完整条链路：扩展抛错 → 桥分类 → HTTP 结构化 */
const bad = await call("no.such-command", {});
check("扩展侧未知命令 → HTTP 502 + command_failed",
  bad.status === 502 && bad.json.code === "command_failed" && /unknown command/.test(String(bad.json.error)),
  JSON.stringify(bad.json).slice(0, 180));
check("未知命令（只读类）标成 not_started，可以安全重试",
  bad.json.effectState === "not_started", bad.json.effectState);

const missingTab = await call("tabs.group", { tabId: 999999 });
check("归组不存在的标签 → 扩展的错误文本原样回到调用方",
  missingTab.status === 502 && /不存在|No tab/.test(String(missingTab.json.error)), JSON.stringify(missingTab.json).slice(0, 180));

ctx.disconnectNow?.();
await new Promise((r) => setTimeout(r, 120));
await server.stop();

console.log(`\n结论：${fails === 0 ? "真桥 + 真扩展代码端到端通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
