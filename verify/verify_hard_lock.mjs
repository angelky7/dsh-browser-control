// 本地硬锁台：断言「用户从扩展弹窗一键冻结后，模型一条命令都发不出去」。
//
// 由来：桥接的唯一实际边界是 127.0.0.1 + token，而 token 就明写在 profile 的
// cordis.patch.yml 里、模型能读到（也能改）。也就是说「模型自己把自己关掉」这件事
// 在当前架构里是可能的：只要它想，它能改配置重启桥接。这个锁把「冻结」放到浏览器
// 扩展里、并且**只能从扩展弹窗解除**——模型没有那条通道。
//
// 它同时钉住一个 MV3 特有的坑：service worker 空闲约 30 秒被回收，内存里的
// 布尔值会悄悄丢失，锁等于没上过。所以 flag 必须落 chrome.storage.local，
// 台子里真的重启一次 service worker 来验它。
//
// 用法：
//   node verify/verify_hard_lock.mjs                       # 跑仓库里的扩展
//   node verify/verify_hard_lock.mjs ../../old/background.js  # 对未修版本判红
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bootBackground } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
/** 换一份背景脚本跑时，弹窗也读那一份旁边的（否则结构断言测的还是本地仓库）。 */
const EXT_DIR = CANDIDATE
  ? path.dirname(path.resolve(CANDIDATE))
  : fileURLToPath(new URL("../extension/", import.meta.url));
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const errOf = (p) => p.then(() => null, (e) => String(e?.message ?? e));
/**
 * 顶层 `function` 声明会变成沙箱属性（所以能直接 `ctx.runCommand`），
 * 但 `const`/`let` 只在 context 的词法环境里 —— 要读 COMMANDS / PROTOCOL_VERSION
 * 得在同一台 context 上再跑一句。
 */
const evalIn = (ctx, expr) => runInContext(expr, ctx);

/**
 * 起一份扩展代码。`model`/`storage` 传同一个对象就等价于
 * 「service worker 被回收后重新唤醒（缓存没了，浏览器状态与本地存储还在）」。
 */
async function boot({ model, storage } = {}) {
  const opts = {};
  if (CANDIDATE) opts.backgroundPath = CANDIDATE;
  if (model) opts.model = model;
  if (storage) opts.storage = storage;
  return bootBackground(opts);
}

// ---- 1) 默认必须是开着的（锁不能自己上，也不能一装就锁死）----
{
  const { model, ctx } = await boot();
  const ping = await ctx.runCommand("ping", {});
  check("默认未锁：命令照常执行", ping?.pong === true, JSON.stringify(ping));
  check("默认未锁：bridgeStatus 报 locked:false",
    (await model.sendRuntimeMessage({ type: "bridgeStatus" }))?.locked === false);
}

// ---- 2) 弹窗一键上锁：返回状态、落盘、徽标变 LOCK ----
const store = {};
const model = undefined; // 见下：用同一个 model 模拟重启
let m1 = await boot({ storage: store });
const sharedModel = m1.model;
{
  const { ctx } = m1;
  const res = await sharedModel.sendRuntimeMessage({ type: "lockSet", locked: true });
  check("lockSet{locked:true}：弹窗拿到回执", res?.locked === true, JSON.stringify(res));
  check("上锁后立刻落盘（chrome.storage.local.hardLock）", store.hardLock === true, JSON.stringify(store));
  check("上锁后徽标变成 LOCK（绿色 ON 会骗人）", sharedModel.badgeText === "LOCK",
    JSON.stringify({ text: sharedModel.badgeText, color: sharedModel.badgeColor }));
  check("bridgeStatus 跟着报 locked:true",
    (await sharedModel.sendRuntimeMessage({ type: "bridgeStatus" }))?.locked === true);
  check("上锁不掐连接：仍允许 popup 断/连（那是 WS 控制，不是命令）",
    typeof ctx.connect === "function" && typeof ctx.disconnectNow === "function");
}

// ---- 3) 冻结必须是「全部命令」：逐条扫 COMMANDS 表，一条都不能漏 ----
{
  const { model: m, ctx } = m1;
  const commands = Object.keys(evalIn(ctx, "COMMANDS"));
  const leaked = [];
  for (const command of commands) {
    const message = await errOf(ctx.runCommand(command, { selector: "#q", key: "a" }));
    if (message === null || !/已被用户锁定/.test(message) || !message.includes(command)) {
      leaked.push(`${command}: ${message === null ? "居然执行了" : message}`);
    }
  }
  check(`COMMANDS 表里全部 ${commands.length} 条命令都被拦下（含写操作与只读）`,
    leaked.length === 0, leaked.join(" | "));
  check("拦截发生在执行之前：一次 CDP 调用都没发出", m.dbg.log.length === 0,
    `dbg.log=${m.dbg.log.length}`);
  check("拦截发生在执行之前：一个标签页都没被动过", m.tabs.size === 0, `tabs=${m.tabs.size}`);

  const clickMsg = await errOf(ctx.runCommand("click", { selector: "#q" }));
  check("拒绝文案点名被拦的命令", clickMsg?.includes("click") === true, String(clickMsg));
  check("拒绝文案说清解锁只能由用户在扩展弹窗做（模型照着做不成就别试）",
    /解锁只能由用户在浏览器工具栏的扩展弹窗里点「已锁定」完成/.test(clickMsg ?? ""), String(clickMsg));
  check("拒绝文案明确劝退重试", /不要重试/.test(clickMsg ?? ""), String(clickMsg));
}

// ---- 4) 模型侧没有解锁通道：锁不是一条命令 ----
{
  const { model: m, ctx } = m1;
  check("COMMANDS 表里没有 lockSet/lock/unlock 这类命令",
    ["lockSet", "lock", "unlock", "hardLock"].every((k) => evalIn(ctx, "COMMANDS")[k] === undefined),
    JSON.stringify(["lockSet", "lock", "unlock", "hardLock"].filter((k) => evalIn(ctx, "COMMANDS")[k] !== undefined)));
  // 桥接发来的帧走的是同一条 runCommand；即使有人塞一条 lockSet 命令帧也只会被当作
  // 普通命令拦下，状态不变。
  ctx.handleBridgeMessage({ type: "command", id: "bridge-1", command: "lockSet", params: { locked: false } });
  await new Promise((r) => setTimeout(r, 20));
  check("桥侧塞一条 lockSet 命令帧：仍然是锁着的", store.hardLock === true && (await errOf(ctx.runCommand("ping", {}))) !== null);
  check("协议版本没有变（帧契约未动）", evalIn(ctx, "PROTOCOL_VERSION") === 1, String(evalIn(ctx, "PROTOCOL_VERSION")));
}

// ---- 5) service worker 被回收后重启：锁必须还在（bi-042 的教训）----
{
  const revived = await boot({ model: sharedModel, storage: store });
  const pingErr = await errOf(revived.ctx.runCommand("ping", {}));
  check("SW 重启后仍然是锁着的（内存标志会丢，落盘的不会）",
    pingErr !== null && /已被用户锁定/.test(pingErr), String(pingErr));
  check("SW 重启后徽标仍是 LOCK", sharedModel.badgeText === "LOCK", String(sharedModel.badgeText));

  const unlocked = await sharedModel.sendRuntimeMessage({ type: "lockSet", locked: false });
  check("重启后用户仍能在弹窗解锁", unlocked?.locked === false, JSON.stringify(unlocked));
  check("解锁后才恢复执行", (await revived.ctx.runCommand("ping", {}))?.pong === true);
  check("解锁后落盘为 false", store.hardLock === false, JSON.stringify(store));
}

// ---- 6) fail-closed：畸形消息不许把锁打开 ----
{
  const s6 = {};
  const { model: m, ctx } = await boot({ storage: s6 });
  await m.sendRuntimeMessage({ type: "lockSet", locked: true });
  await m.sendRuntimeMessage({ type: "lockSet" });
  check("少了 locked 字段的消息不会解锁", s6.hardLock === true && (await errOf(ctx.runCommand("ping", {}))) !== null);
  await m.sendRuntimeMessage({ type: "lockSet", locked: "nope" });
  check("locked 不是布尔值的消息也不会解锁", s6.hardLock === true && (await errOf(ctx.runCommand("ping", {}))) !== null);
}

// ---- 7) 弹窗真的接上了这条通道（popup 在 vm 里跑不起来，只能核结构）----
{
  const html = await readFile(path.join(EXT_DIR, "popup.html"), "utf8");
  const js = await readFile(path.join(EXT_DIR, "popup.js"), "utf8");
  check("popup.html 有锁定按钮（在断开连接与状态页之间）",
    /id="reconnect"[\s\S]*id="lock"[\s\S]*id="openStatus"/.test(html));
  check("popup.js 用单击切换并走 lockSet 通道", /type: ['"]lockSet['"],\s*locked: !locked/.test(js));
  check("按钮文案在锁定后变成「已锁定」", /'已锁定' : '锁定'/.test(js));
}

console.log(fails === 0 ? "\n本地硬锁全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
