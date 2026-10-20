// 端到端（缺一个真浏览器）：真的 BridgeServer + 真的扩展 service worker + 真的
// WebSocket，跑在 127.0.0.1 上，只有 `chrome.*` 是假的。
//
// 之前 verify_http.mjs 用的是手写假 WS 客户端，只能证明「桥懂帧格式」；这条证明的是
// **扩展里那段真代码**连上桥之后，HTTP 命令面下发的命令会不会走到 `COMMANDS` 表、
// 结果能不能原样回来。归组这种新命令最容易死在「扩展实现了、桥不认识、插件调不到」
// 的中间地带，这里一次对齐。
import { readFile } from "node:fs/promises";
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

// 扩展上报的版本号就是从 manifest.json 读的，不是测试台里写死的字符串
const manifestVersion = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")).version;
check("扩展上报的版本与 manifest.json 一致", server.status.hello?.version === manifestVersion,
  `hello=${server.status.hello?.version} manifest=${manifestVersion}`);

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

/* 本地锁 → 桥分类 → HTTP 结构化：整条链路一次对齐（PR #15 的锁 + 本次补的错误契约） */
{
  const dbgBefore = model.dbg.log.length;
  const lockedOn = await model.sendRuntimeMessage({ type: "lockSet", locked: true });
  check("锁从弹窗这一侧上上了（真扩展、真 WS）", lockedOn?.locked === true, JSON.stringify(lockedOn));

  const lockedRead = await call("content", { selector: "body" });
  check("锁着时只读命令 → HTTP 502 + code=locked_by_user",
    lockedRead.status === 502 && lockedRead.json.code === "locked_by_user",
    JSON.stringify(lockedRead.json).slice(0, 200));

  // 关键是这条：click 在写清单里，若不认锁前缀就会被报成 unknown「动作可能已经落到页面上」。
  // 锁的拦截发生在 handler 之前，所以真相是 not_started。
  const lockedWrite = await call("click", { selector: "#q" });
  check("锁着时写命令也报 not_started（一条事件都没派发，不许报 unknown）",
    lockedWrite.json.code === "locked_by_user" && lockedWrite.json.effectState === "not_started",
    `${lockedWrite.json.code}/${lockedWrite.json.effectState}`);
  check("error 字段是剥掉线协议标记的整句话",
    typeof lockedWrite.json.error === "string"
    && !lockedWrite.json.error.includes("browser-locked-by-user:")
    && /已被用户锁定/.test(lockedWrite.json.error), String(lockedWrite.json.error).slice(0, 80));
  check("hint 指向「让用户解锁」，不是「选择器没命中」",
    /扩展弹窗/.test(String(lockedWrite.json.hint)) && !/选择器/.test(String(lockedWrite.json.hint)),
    String(lockedWrite.json.hint).slice(0, 70));
  check("锁着期间一次 CDP 都没派发（拦在 handler 之前，不是拦在页面里）",
    model.dbg.log.length === dbgBefore, `新增 ${model.dbg.log.length - dbgBefore} 次`);

  await model.sendRuntimeMessage({ type: "lockSet", locked: false });
  const afterUnlock = await call("tabs.list", {});
  check("解锁后同一条链路立刻恢复（不需要重启桥或扩展）",
    afterUnlock.status === 200 && afterUnlock.json.ok !== false, JSON.stringify(afterUnlock.json).slice(0, 120));
}

ctx.disconnectNow?.();
await new Promise((r) => setTimeout(r, 120));
await server.stop();

console.log(`\n结论：${fails === 0 ? "真桥 + 真扩展代码端到端通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
