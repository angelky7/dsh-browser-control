// 多实例实测台（v1.8.0）：
//  1) 两个带实例 id 的扩展能**同时**在位（旧实现的「新连接踢掉旧连接」只留给 legacy 槽）
//  2) 多实例但没指定 instance：命令一条都不发，报 instance_required（不猜）
//  3) instance 支持 id / 名称 / 唯一前缀（大小写不敏感）；重名或指错报 instance_not_found
//  4) 同一实例重连只替换它自己；另一个实例的连接与在途命令不受影响
//  5) 老扩展（hello 无 instance）进 legacy 单槽，仍可与新实例并存并被点名
//  6) 单连接时 /api/status 的旧字段（hello/connectedAt）照旧；多连接时让位给 instances
//  7) 断开一个实例只失败它自己的在途命令，另一个实例的照常返回
//  8) 静态对账：每条驱动浏览器的工具都带 instance 参数，并在 execute 里真的用它
// 用法: node verify/verify_multi_instance.mjs
import { readFile } from "node:fs/promises";
import { BridgeServer } from "../src/server.ts";

const PORT = 9787; // 9777 装机默认 / 9778 错误契约 / 9779 扩展端到端 / 9781 导航 / 9783 渲染 / 9785 批量关页
const TOKEN = "multi-instance-test-token-long-enough";
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const check = (name, pass, detail = "") => {
  if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms = 1500) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

/**
 * 假扩展：连上 WS、报一个 hello、对每条命令回 `{answeredBy}`。
 * `answers: false` 时只记命令不回结果——用来演「在途命令」。
 */
function connectFake({ name, instanceId, label, answers = true }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const state = { name, ws, commands: [], closed: false, hello: null };
    ws.onerror = () => reject(new Error(`fake extension ${name} failed to connect`));
    ws.onopen = () => {
      const hello = {
        type: "hello",
        client: "fake-ext",
        version: "1.8.0",
        protocol: 1,
        browser: { name: "fake", version: "1", ua: "" },
        capabilities: ["ping", "browser.info", "tabs.list", "nav", "click"],
      };
      if (instanceId !== undefined) hello.instance = label === undefined ? { id: instanceId } : { id: instanceId, label };
      state.hello = hello;
      ws.send(JSON.stringify(hello));
      resolve(state);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      state.commands.push(msg.command);
      if (!answers) return;
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { answeredBy: name, command: msg.command, params: msg.params } }));
    };
    ws.onclose = () => { state.closed = true; };
  });
}

const post = async (body) => {
  const res = await fetch(`${BASE}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const status = async () => (await fetch(`${BASE}/api/status`)).json();
const idOf = (instance) => (instance.label === undefined ? instance.id : `${instance.id}/${instance.label}`);

// ---------- 1) 两个实例可以同时在位 ----------
const alpha = await connectFake({ name: "alpha", instanceId: "11111111-aaaa-bbbb-cccc-000000000001", label: "Alpha" });
check("第一个实例连上后 /api/status 里有 1 条", await waitFor(async () => (await status()).instances.length === 1),
  JSON.stringify((await status()).instances?.map(idOf)));
const single = await status();
check("单实例时旧字段 hello/connectedAt 仍然有值（向后兼容）", single.hello !== undefined && single.connectedAt !== undefined,
  `hello=${single.hello?.version ?? "null"}`);
check("单实例时旧的 extensionProtocol 照旧上报", single.extensionProtocol === 1, `ext=v${single.extensionProtocol}`);

const beta = await connectFake({ name: "beta", instanceId: "22222222-aaaa-bbbb-cccc-000000000002", label: "Alpha-2" });
check("第二个实例连上后共有 2 条", await waitFor(async () => (await status()).instances.length === 2),
  JSON.stringify((await status()).instances?.map(idOf)));
check("两个实例的连接都还活着（旧实现会踢掉前一个）", !alpha.closed && !beta.closed,
  `alpha.closed=${alpha.closed} beta.closed=${beta.closed}`);
const multi = await status();
check("多实例时单实例视图让位（hello 为 undefined，实例清单为准）", multi.hello === undefined && multi.instances.length === 2,
  `hello=${multi.hello === undefined ? "undefined" : "SET"} instances=${multi.instances.length}`);
check("/api/status 的实例清单带名称与连接时间",
  multi.instances.every((it) => typeof it.id === "string" && typeof it.connectedAt === "string") && multi.instances.some((it) => it.label === "Alpha"),
  JSON.stringify(multi.instances.map(idOf)));

// ---------- 2) 多实例不指定 → 拒绝且零派发 ----------
const before = [alpha.commands.length, beta.commands.length];
let r = await post({ command: "click", instance: undefined, params: { selector: "#go" } });
check("多实例 + 没指定 instance → 409 + instance_required", r.status === 409 && r.json.code === "instance_required", `${r.status} ${r.json.code}`);
check("拒绝时命令一条都没有发出去", alpha.commands.length === before[0] && beta.commands.length === before[1],
  `alpha=${alpha.commands.length} beta=${beta.commands.length}`);
check("拒绝文案列出了两个实例，并说明命令没发", /Alpha/.test(r.json.error) && /Alpha-2/.test(r.json.error) && /没有发出去/.test(r.json.hint || ""),
  r.json.error);

// ---------- 3) 按名称 / id / 唯一前缀路由 ----------
r = await post({ command: "click", instance: "Alpha", params: { selector: "#a" } });
check("按名称 Alpha 路由到第一个实例", r.status === 200 && r.json.result.answeredBy === "alpha", JSON.stringify(r.json).slice(0, 90));
r = await post({ command: "click", instance: "alpha-2", params: { selector: "#b" } });
check("名称大小写不敏感（alpha-2）", r.status === 200 && r.json.result.answeredBy === "beta", JSON.stringify(r.json).slice(0, 90));
r = await post({ command: "click", instance: "22222222", params: { selector: "#c" } });
check("按 id 前缀路由到第二个实例", r.status === 200 && r.json.result.answeredBy === "beta", JSON.stringify(r.json).slice(0, 90));
check("路由只把命令发给目标实例", alpha.commands.length === 1 && beta.commands.length === 2,
  `alpha=${alpha.commands.length} beta=${beta.commands.length}`);

// ---------- 4) 指错 / 重名 ----------
r = await post({ command: "click", instance: "alph", params: {} });
check("前缀同时命中两个名称（alph → Alpha / Alpha-2）→ 404 + instance_not_found（不猜）", r.status === 404 && r.json.code === "instance_not_found", `${r.status} ${r.json.code}`);
check("歧义文案点出命中了几个", /2 个/.test(r.json.error), r.json.error);
r = await post({ command: "click", instance: "Nope", params: {} });
check("不存在的实例 → 404 + instance_not_found 并列出当前连接", r.status === 404 && /Alpha/.test(r.json.error), r.json.error);
check("两种拒绝都零派发", alpha.commands.length === 1 && beta.commands.length === 2, `alpha=${alpha.commands.length} beta=${beta.commands.length}`);

// ---------- 5) 同一实例重连只替换它自己 ----------
const alphaAgain = await connectFake({ name: "alpha-2", instanceId: "11111111-aaaa-bbbb-cccc-000000000001", label: "Alpha" });
check("同一 id 重连后仍只有 2 条实例", await waitFor(async () => (await status()).instances.length === 2),
  JSON.stringify((await status()).instances?.map(idOf)));
check("被替换的是旧 socket，不是 Alpha-2", await waitFor(() => alpha.closed === true) && beta.closed === false,
  `alpha.closed=${alpha.closed} beta.closed=${beta.closed}`);
r = await post({ command: "click", instance: "Alpha", params: { selector: "#d" } });
check("重连后按名称路由到新 socket", r.status === 200 && r.json.result.answeredBy === "alpha-2", JSON.stringify(r.json).slice(0, 90));

// ---------- 6) 老扩展进 legacy 单槽 ----------
const legacyA = await connectFake({ name: "legacy-a" });
check("老扩展（无 instance）连上后共有 3 条，其中一条是 legacy", await waitFor(async () => {
  const s = await status();
  return s.instances.length === 3 && s.instances.some((it) => it.id === "legacy");
}), JSON.stringify((await status()).instances?.map(idOf)));
r = await post({ command: "ping", instance: "legacy", params: {} });
check("legacy 可以用 'legacy' 点名", r.status === 200 && r.json.result.answeredBy === "legacy-a", JSON.stringify(r.json).slice(0, 90));
const legacyB = await connectFake({ name: "legacy-b" });
check("第二个老扩展替换掉第一个（旧语义只在 legacy 槽保留）", await waitFor(() => legacyA.closed === true) && legacyB.closed === false,
  `legacyA.closed=${legacyA.closed} legacyB.closed=${legacyB.closed}`);
check("legacy 替换不增加条目数（仍是 3 条）", (await status()).instances.length === 3,
  JSON.stringify((await status()).instances?.map(idOf)));

// ---------- 7) 断开一个实例只失败它自己的在途命令 ----------
const slow = await connectFake({ name: "slow", instanceId: "33333333-aaaa-bbbb-cccc-000000000003", label: "Slow", answers: false });
check("慢实例连上后共有 4 条", await waitFor(async () => (await status()).instances.length === 4));

const inflight = post({ command: "click", instance: "Slow", params: {}, timeoutMs: 10_000 });
const other = post({ command: "click", instance: "Alpha-2", params: { selector: "#e" } });
await waitFor(() => slow.commands.length === 1);
slow.ws.close();
const inflightResult = await inflight;
check("在途命令所在的实例断开 → 只有它失败（link_lost / 504）",
  inflightResult.status === 504 && inflightResult.json.code === "link_lost", `${inflightResult.status} ${inflightResult.json.code}`);
const otherResult = await other;
check("另一个实例的在途命令照常返回（没有被连坐）",
  otherResult.status === 200 && otherResult.json.result.answeredBy === "beta", JSON.stringify(otherResult.json).slice(0, 90));
check("断开后实例数回到 3", await waitFor(async () => (await status()).instances.length === 3),
  JSON.stringify((await status()).instances?.map(idOf)));

// ---------- 8) 静态对账：每条驱动浏览器的工具都有 instance ----------
const src = await readFile("src/index.ts", "utf8");
const blocks = src.split("\n\tctx.tools.register(defineTool({").slice(1);
const audited = [];
for (const block of blocks) {
  const name = /name: '(browser_[a-z_]+)'/.exec(block)?.[1];
  if (name === undefined) continue;
  const params = /parameters: \{(.*?)\n\t\t\},/s.exec(block)?.[1] ?? "";
  audited.push({ name, hasParam: params.includes("INSTANCE_PARAM"), uses: block.includes("args.instance") });
}
const drivers = audited.filter((tool) => tool.name !== "browser_cleanup");
const missingParam = drivers.filter((tool) => !tool.hasParam).map((tool) => tool.name);
const missingUse = drivers.filter((tool) => !tool.uses).map((tool) => tool.name);
check("每条驱动浏览器的工具都接受 instance 参数", missingParam.length === 0, missingParam.join(",") || `${drivers.length} 条全覆盖`);
check("每条驱动浏览器的工具都真的把 instance 传下去", missingUse.length === 0, missingUse.join(",") || `${drivers.length} 条全覆盖`);
check("browser_cleanup 不碰浏览器，也不该有 instance",
  !audited.find((tool) => tool.name === "browser_cleanup")?.hasParam, "ok");

// ---------- 收尾 ----------
for (const state of [alphaAgain, beta, legacyB]) {
  try { state.ws.close(); } catch { /* 已经关了 */ }
}
await sleep(100);
await server.stop();

console.log(`\n结论：${fails === 0 ? "多实例路由全部通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
