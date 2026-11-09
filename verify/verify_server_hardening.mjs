// 桥接边界加固台（专家评审 P1/P2 的插件侧部分）：
//   1) WS 分片按**字节**累积：多字节 UTF-8 字符跨片时解码不能碎（旧实现逐片
//      toString('utf8') 再拼字符串，中文会被拆成替换符）；
//   2) 旧连接不能影响新连接：A 被 B 顶掉后，A 再发 close 帧不许把 B 关掉；
//   3) HTTP 空/非对象 body（"null"）回 400，而不是在事件回调里抛 TypeError；
//   4) HTTP /api/command 与工具走同一道策略闸门与同一本审计账（只读档下写命令
//      回 403 blocked_by_policy，并且账本里有记录）。
// 用法：node verify/verify_server_hardening.mjs
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeServer } from "../src/server.ts";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw client frame (masked, as a browser sends it). Payload < 64 KiB only. */
function maskedFrame(opcode, payload, { fin = true } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  if (p.length >= 65_536) throw new Error("test frame too large");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header;
  if (p.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(p.length, 2);
  }
  const masked = Buffer.from(p);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Manual RFC6455 handshake over net (the WebSocket client API cannot fragment). */
function connectRaw(port, token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = Buffer.from(randomUUID()).toString("base64");
      socket.write(
        `GET /ws?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const head = buffer.subarray(0, end).toString("utf8");
      if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error(head)); return; }
      resolve(socket);
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** Answer server→client command frames on a raw socket (unmasked server frames). */
function answerCommands(socket) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString("utf8")); } catch { continue; }
      if (msg.type === "command") {
        socket.write(maskedFrame(0x1, JSON.stringify({ type: "result", id: msg.id, ok: true, result: { pong: true } })));
      }
    }
  });
}

const helloJson = (version, client) => JSON.stringify({
  type: "hello", client, version, protocol: 1, browser: { name: "fake", version: "1", ua: "" },
});

/* ============ 1+2. 帧解码与连接身份（裸 TCP） ============ */
const PORT = 9810;
const TOKEN = "hardening-test";
const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

{
  const a = await connectRaw(PORT, TOKEN);
  const hello = helloJson("1.7.2", "测试扩展");
  const bytes = Buffer.from(hello, "utf8");
  const charStart = bytes.indexOf(Buffer.from("测", "utf8"));
  check("测试自检：能定位多字节字符的起始字节", charStart > 0, String(charStart));
  // 在「测」的第一个字节之后切开：片 1 以半个 UTF-8 字符结束。
  const cut = charStart + 1;
  a.write(maskedFrame(0x1, bytes.subarray(0, cut), { fin: false }));
  a.write(maskedFrame(0x0, bytes.subarray(cut), { fin: true }));
  await sleep(250);
  check("分片消息按字节累积后解码：中文 client 逐字完整",
    server.status.hello?.client === "测试扩展", JSON.stringify(server.status.hello?.client));

  // A 还是当前连接；用 B 顶掉它，再让 A 发 close —— 旧实现会因此关掉 B。
  const b = await connectRaw(PORT, TOKEN);
  answerCommands(b);
  b.write(maskedFrame(0x1, helloJson("1.7.3", "newer")));
  await sleep(200);
  check("B 顶掉 A 之后，hello 是 B 的", server.status.hello?.version === "1.7.3", JSON.stringify(server.status.hello));
  a.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
  await sleep(250);
  check("被顶掉的 A 再发 close 帧，不许关掉新连接 B",
    server.status.extensionConnected === true && server.status.hello?.version === "1.7.3",
    JSON.stringify({ connected: server.status.extensionConnected, hello: server.status.hello?.version }));
  const executed = await server.execute("ping", {}, { timeoutMs: 2_000 }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e?.message ?? e) }));
  check("B 仍能执行命令（连接没有被旧连接的帧污染）", executed.ok === true, JSON.stringify(executed).slice(0, 120));
  b.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
  await sleep(150);
  a.destroy();
  b.destroy();
}

{
  const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/command?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  let res = await post("null");
  check("body 为 null → 400（不是回调里抛 TypeError）", res.status === 400, `实际 ${res.status}`);
  res = await post("[1,2]");
  check("body 为数组 → 400", res.status === 400, `实际 ${res.status}`);
  res = await fetch(`http://127.0.0.1:${PORT}/api/status`);
  check("坏 body 之后服务仍然活着", res.status === 200, `实际 ${res.status}`);
}
await server.stop();

/* ============ 3. HTTP 命令面走同一个策略闸门与审计 ============ */
{
  const PORT2 = 9811;
  const STATE = await mkdtemp(path.join(tmpdir(), "dsh-hardening-"));
  const tools = [];
  const disposers = [];
  const config = Config({ stateDir: STATE, enabled: true, port: PORT2, token: "http-gate", readOnly: true });
  const settingsService = {
    register(_ns, schema, options) {
      const value = schema(options?.base ?? config);
      return { get: () => value, watch: () => {}, set: () => {} };
    },
  };
  const pctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: pctx.logger }); },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(pctx, config);
  await sleep(400);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT2}/ws?token=http-gate`);
  await new Promise((resolve) => {
    ws.onopen = () => {
      ws.send(helloJson("1.7.2", "fake"));
      resolve();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "command") {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { pong: true } }));
      }
    };
    setTimeout(resolve, 400);
  });
  await sleep(150);
  const post = (body) => fetch(`http://127.0.0.1:${PORT2}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer http-gate" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const blocked = await post({ command: "click", params: { selector: "#x", tabId: 1 } });
  check("只读档：HTTP 写命令 → 403 blocked_by_policy / not_started",
    blocked.status === 403 && blocked.json.code === "blocked_by_policy" && blocked.json.effectState === "not_started",
    `${blocked.status} ${JSON.stringify(blocked.json).slice(0, 100)}`);
  const allowed = await post({ command: "ping", params: {} });
  check("只读档：HTTP 只读命令照常执行（闸门不是一刀切）", allowed.status === 200 && allowed.json.ok === true,
    `${allowed.status} ${JSON.stringify(allowed.json).slice(0, 100)}`);
  const auditTool = tools.find((t) => t.name === "browser_audit");
  const audit = await auditTool.execute({}, { signal: new AbortController().signal });
  check("HTTP 命令进了同一本审计账（click 被拒 + ping 成功）",
    audit.entries.some((e) => e.command === "click" && e.code === "blocked_by_policy")
    && audit.entries.some((e) => e.command === "ping" && e.ok === true),
    JSON.stringify(audit.entries.map((e) => [e.command, e.ok, e.code])));
  try { ws.close(); } catch {}
  await sleep(150);
  disposers.reverse().forEach((fn) => { try { fn(); } catch {} });
}

console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
