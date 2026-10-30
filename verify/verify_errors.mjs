// 错误契约实测：分类是否正确、写操作是否被标成「结果未知」、HTTP 面是否把
// code / effectState / hint 一起回给调用方。
import net from "node:net";
import { classify, BridgeError, isWriteCommand, LOCKED_BY_USER_MARKER, LOCK_UNREADABLE_MARKER, HOLD_ABORTED_MARKER } from "../src/errors.ts";
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
  // 删除是逐条 rm 的：半路失败（Windows 上被占用的截图 EPERM）时前面的文件已经没了，
  // 这时报 not_started「没动过，重试安全」就是假的，必须 unknown 并先去看还剩什么。
  ["cleanup", "EPERM: operation not permitted, unlink 'dsh-browser-shots/shot.png'", "command_failed", "unknown"],
  // 扩展弹窗的锁：连写操作也确定一条命令都没发出，所以是 not_started，
  // 不能因为 click 在写清单里就报 unknown（那等于说「动作可能已经落到页面上」）。
  ["click", "browser-locked-by-user: 本机扩展已被用户锁定：命令 click 被拦下", "locked_by_user", "not_started"],
  ["tabs.close", "browser-lock-unreadable: 扩展读不出本地锁的状态，已按冻结处理", "lock_unreadable", "not_started"],
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

// ---- 分类表与扩展命令表必须一一对上（PR #11 合并后暴露的缺口）----
// tabs.closeMany 是批量关闭，在链路上是**一条**命令，所以它是新的命令名；
// 而 effectState 是按命令名判写/读的。漏登记的名字会静默落到 not_started，
// 于是超时报文写着「重试安全」，实际可能已经关掉了一半标签。
{
  const src = await (await import('node:fs/promises')).readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const table = src.slice(src.indexOf('const COMMANDS = {'));
  const commands = [...table.slice(0, table.indexOf('};')).matchAll(/'?([a-zA-Z.]+)'?\s*:\s*cmd[A-Za-z]/g)]
    .map((m) => m[1]);
  // 读操作与「重复执行无害」的幂等命令，逐条写理由：新增命令必须在这里做一次判断，
  // 不能默默落在 neither 里。
  const classifiedRead = new Set([
    'ping', 'browser.info', 'tabs.list', 'tabs.group', 'tabs.ungroup', // 分组是幂等的：重复归组是空操作
    'content', 'find', 'snapshot', 'screenshot', 'wait', 'console.log', 'network.log', 'network.clear', 'pdf',
    // cookie 三条：set/remove 都是幂等的——重设同一颗、重复删同一颗，结果不变，
    // 所以按本文件顶部的判据（「重试会不会造成额外损害」）算只读；改浏览器状态的那道
    // 闸门在 policy.ts 的只读档里（set/remove 默认拒），两张表各管各的语义。
    'cookies.get', 'cookies.set', 'cookies.remove',
  ]);
  const unclassified = commands.filter((c) => !isWriteCommand(c) && !classifiedRead.has(c));
  const wronglyMarked = commands.filter((c) => isWriteCommand(c) && classifiedRead.has(c));
  check('COMMANDS 表被解析出来了（解析不出来时后面三条全是空集合上的真命题）',
    commands.length >= 24, `解析到 ${commands.length} 条：${commands.join(',')}`);
  check('每条扩展命令都登记过写/读（新增命令不许静默算作重试安全）',
    unclassified.length === 0, unclassified.join(','));
  check('写/读分类表本身没有自相矛盾', wronglyMarked.length === 0, wronglyMarked.join(','));
  check('tabs.closeMany 被当成写操作（部分关闭后超时不许说重试安全）', isWriteCommand('tabs.closeMany'));
}

// ---- 插件本地命令同样要登记（PR #16 合并后复审抓到的）----
// 上面那条只覆盖扩展的 COMMANDS 表。但 classify() 是按**调用方传进来的名字**查表的，
// `browser_cleanup` 走 `controller.cleanup()`、根本不经 `execute()`，所以它的名字不在
// 扩展表里：删到一半失败时（Windows 上被占用的截图会 EPERM）模型拿到的是一句没有 code
// 的裸 fs 错误，而「没登记」在这里的默认含义是 not_started——正好是假的。
{
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const classified = [...new Set([...src.matchAll(/classify\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  check('src/index.ts 里解析到 classify() 用到的命令名（解析不到时后面两条是空集合上的真命题）',
    classified.length >= 1 && classified.includes('cleanup'), `解析到 ${classified.length} 个：${classified.join(',')}`);
  // 插件本地命令里确实算只读的：目前没有，新增时必须在这里写理由。
  const localRead = new Set();
  const unregistered = classified.filter((c) => !isWriteCommand(c) && !localRead.has(c));
  check('每个传给 classify() 的名字都登记过写/读（不许静默按「重试安全」处理）',
    unregistered.length === 0, unregistered.join(','));
  check('cleanup 被当成写操作（半路删除失败不许说重试安全）', isWriteCommand('cleanup'));
}

// ---- 锁的前缀是跨两侧的线协议，两边必须逐字一致 ----
// 结果帧只有一个 error 字符串能带信息，所以「命令根本没发出」这件事只能写在文本前缀上。
// 前缀一旦对不上，插件侧不会报错——它会安静地把锁当成 command_failed，于是写操作的
// 锁拒绝被报成 effectState=unknown「动作可能已经落到页面上」，而那恰好是假的。
{
  const fs = await import('node:fs/promises');
  const bg = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  // 接管浮层的「中止」也一样：前缀是线协议，两边必须逐字一致，否则插件那侧只是安静地
  // 退回 command_failed/unknown（写操作会被说成「可能已经落到页面上」，而那恰好是假的）。
  check('对账：扩展里写着与插件侧逐字相同的浮层中止前缀',
    bg.includes(`'${HOLD_ABORTED_MARKER}'`), HOLD_ABORTED_MARKER);
  const held = classify('click', new Error(`${HOLD_ABORTED_MARKER} 用户已在页面的接管浮层上按下「中止操作」：命令 click 被拦下`));
  check('浮层中止：认成 held_by_user 且 effectState=not_started（一条都没发出去）',
    held.code === 'held_by_user' && held.effectState === 'not_started', `${held.code}/${held.effectState}`);
  check('浮层中止：前缀不出现在给模型的那句话里',
    !held.message.includes(HOLD_ABORTED_MARKER), held.message.slice(0, 70));
  check('浮层中止：hint 指路 browser_hold action=off，而不是「换个选择器重试」',
    /browser_hold action=off/.test(held.hint) && !/选择器/.test(held.hint), held.hint.slice(0, 60));
  check('hold 本身按写操作分类（超时/掉线之后重试可能多留一层）', isWriteCommand('hold') === true);

  check('对账：扩展里写着与插件侧逐字相同的两个锁前缀',
    bg.includes(`'${LOCKED_BY_USER_MARKER}'`) && bg.includes(`'${LOCK_UNREADABLE_MARKER}'`),
    `${LOCKED_BY_USER_MARKER} / ${LOCK_UNREADABLE_MARKER}`);
  const stripped = classify('click', new Error(`${LOCKED_BY_USER_MARKER} 本机扩展已被用户锁定：命令 click 被拦下`));
  check('锁标记不留在给模型的那句话里（但 [code] 与文案都在）',
    !stripped.message.includes(LOCKED_BY_USER_MARKER)
    && stripped.message.startsWith('[locked_by_user]')
    && /已被用户锁定/.test(stripped.message), stripped.message.slice(0, 90));
  check('锁拒绝的 detail 也不带标记（HTTP 面的 error 字段是原始描述）',
    !stripped.detail.includes(LOCKED_BY_USER_MARKER), stripped.detail.slice(0, 60));
}

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
