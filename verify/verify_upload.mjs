// browser_upload 的台子（v1.8.0 / PR #24 的安全版）：
//   1) 默认关闭：没配 allowUpload 时零命令；配了 allowUpload 没配 uploadDir 也零命令；
//   2) 目录白名单：相对路径、越界路径、`..` 穿越、指向目录外的符号链接全部拒绝且零命令；
//   3) 正常路径：tabs.list → DOM.getDocument → DOM.querySelector → DOM.setFileInputFiles
//      三步同 tabId、files/nodeId 逐字对上、回执带真实字节数、render 带路径与字节；
//   4) selector 未命中不发 setFileInputFiles；显式 tabId 不走 tabs.list；
//   5) 只读档拒绝；老扩展（无 cdp）走 extension-outdated 且零命令。
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const ROOT = await mkdtemp(path.join(tmpdir(), "dsh-upload-root-"));
const OUTSIDE_DIR = await mkdtemp(path.join(tmpdir(), "dsh-upload-out-"));
const INSIDE = path.join(ROOT, "hello 😭.txt");
const OUTSIDE = path.join(OUTSIDE_DIR, "secret.txt");
await writeFile(INSIDE, "hello", "utf8"); // 5 bytes
await writeFile(OUTSIDE, "secret", "utf8");
await mkdir(path.join(ROOT, "sub"));
await writeFile(path.join(ROOT, "sub", "nested.bin"), Buffer.from([0, 1, 2, 3]));
const LINK = path.join(ROOT, "link-to-outside.txt");
let linkCreated = false;
try {
  await symlink(OUTSIDE, LINK, "file");
  linkCreated = true;
} catch { /* Windows 无权限时跳过符号链接用例 */ }

function makeInstance({ port, token, overrides = {} }) {
  const tools = [];
  const disposers = [];
  const config = Config({ stateDir: (process.env.TEMP || "/tmp") + "/dsh-verify-state", enabled: true, port, token, shotsDir: path.join(ROOT, "shots"), ...overrides });
  const settings = { register(_ns, schema, options) { const v = schema(options?.base ?? config); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: c.logger }); },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, config);
  return { tools, port, token, dispose: () => disposers.reverse().forEach((fn) => { try { fn(); } catch {} }) };
}

async function connectFake(inst, { version = "1.7.2", capabilities = ["cdp", "tabs.list"], tabId = 9 } = {}) {
  const received = [];
  const sock = new WebSocket(`ws://127.0.0.1:${inst.port}/ws?token=${inst.token}`);
  await new Promise((r) => {
    sock.onopen = () => {
      const hello = { type: "hello", client: "fake", version, protocol: 1, browser: { name: "fake", version: "1", ua: "" } };
      if (capabilities !== null) hello.capabilities = capabilities;
      sock.send(JSON.stringify(hello));
      r();
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      received.push({ command: msg.command, params: msg.params ?? {} });
      if (msg.command === "tabs.list") {
        sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { activeTabId: tabId, count: 1, tabs: [{ id: tabId, active: true, url: "https://u.test/", title: "U" }] } }));
        return;
      }
      if (msg.command === "cdp") {
        const method = msg.params?.method;
        let result = {};
        if (method === "DOM.getDocument") result = { root: { nodeId: 1 } };
        else if (method === "DOM.querySelector") result = { nodeId: msg.params?.params?.selector === "#file" ? 11 : 0 };
        else if (method === "DOM.setFileInputFiles") result = {};
        sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
        return;
      }
      sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: {} }));
    };
    setTimeout(r, 300);
  });
  return { sock, received };
}

const down = (n) => path.join(ROOT, "..", path.basename(n));
const call = (tool, args) => tool.execute(args, { signal: new AbortController().signal }).then((r) => ({ ok: true, value: r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

/* ============ 1. 默认关闭 / 缺 uploadDir ============ */
{
  const inst = makeInstance({ port: 9813, token: "up-off" });
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectFake(inst);
  const tool = inst.tools.find((t) => t.name === "browser_upload");
  const off = await call(tool, { selector: "#file", files: [INSIDE] });
  check("默认关闭：allowUpload=false 时拒绝", off.ok === false && /allowUpload: true/.test(off.error) && /No command was sent/.test(off.error), off.error?.slice(0, 100));
  check("默认关闭：零命令", received.length === 0, received.map((x) => x.command).join(","));
  try { sock.close(); } catch {}
  inst.dispose();

  const inst2 = makeInstance({ port: 9814, token: "up-noroot", overrides: { allowUpload: true } });
  await new Promise((r) => setTimeout(r, 300));
  const fake2 = await connectFake(inst2);
  const tool2 = inst2.tools.find((t) => t.name === "browser_upload");
  const noroot = await call(tool2, { selector: "#file", files: [INSIDE] });
  check("allowUpload=true 但没配 uploadDir：拒绝并给配置指引", noroot.ok === false && /uploadDir/.test(noroot.error) && /no command was sent/i.test(noroot.error), noroot.error?.slice(0, 110));
  check("缺 uploadDir：零命令", fake2.received.length === 0);
  try { fake2.sock.close(); } catch {}
  inst2.dispose();
}

/* ============ 2. 目录白名单 ============ */
{
  const inst = makeInstance({ port: 9815, token: "up-allow", overrides: { allowUpload: true, uploadDir: ROOT } });
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectFake(inst);
  const tool = inst.tools.find((t) => t.name === "browser_upload");

  const rel = await call(tool, { selector: "#file", files: ["relative.txt"] });
  check("相对路径：拒绝且零命令", rel.ok === false && /not an absolute path/.test(rel.error) && received.length === 0, rel.error?.slice(0, 90));
  const outside = await call(tool, { selector: "#file", files: [OUTSIDE] });
  check("目录外文件：拒绝且零命令", outside.ok === false && /outside uploadDir/.test(outside.error) && received.length === 0, outside.error?.slice(0, 100));
  const traversal = await call(tool, { selector: "#file", files: [path.join(ROOT, "..", path.basename(OUTSIDE))] });
  check("`..` 穿越：拒绝且零命令", traversal.ok === false && /outside uploadDir|does not exist/.test(traversal.error) && received.length === 0, traversal.error?.slice(0, 100));
  if (linkCreated) {
    const link = await call(tool, { selector: "#file", files: [LINK] });
    check("指向目录外的符号链接：按真实路径拒绝且零命令", link.ok === false && /outside uploadDir/.test(link.error) && received.length === 0, link.error?.slice(0, 100));
  } else {
    console.log("SKIP  符号链接用例（当前环境不允许创建 symlink）");
  }
  const tooMany = await call(tool, { selector: "#file", files: Array.from({ length: 21 }, () => INSIDE) });
  check("超过单次文件数上限：调用前拒绝", tooMany.ok === false && /at most 20/.test(tooMany.error) && received.length === 0, tooMany.error?.slice(0, 80));

  /* ============ 3. 正常路径（无 tabId → tabs.list） ============ */
  received.length = 0;
  const ok = await call(tool, { selector: "#file", files: [INSIDE, path.join(ROOT, "sub", "nested.bin")] });
  check("正常路径：调用成功", ok.ok === true, ok.error);
  const commands = received.map((x) => x.command);
  check("命令顺序：tabs.list → 3 次 cdp", commands.join(",") === "tabs.list,cdp,cdp,cdp", commands.join(","));
  const cdpCalls = received.filter((x) => x.command === "cdp").map((x) => x.params);
  check("三步 CDP 顺序正确", cdpCalls.map((c) => c.method).join(",") === "DOM.getDocument,DOM.querySelector,DOM.setFileInputFiles", cdpCalls.map((c) => c.method).join(","));
  check("所有 CDP 命令落在同一个 tabId（9）",
    received.filter((x) => x.command === "cdp").every((x) => x.params.tabId === 9), JSON.stringify(received.map((x) => x.params.tabId)));
  const setCall = cdpCalls.find((c) => c.method === "DOM.setFileInputFiles");
  check("setFileInputFiles 的 files 与 nodeId 逐字对上",
    Array.isArray(setCall?.params?.files)
    && setCall.params.files[0] === path.resolve(INSIDE)
    && setCall.params.files[1] === path.resolve(path.join(ROOT, "sub", "nested.bin"))
    && setCall.params.nodeId === 11,
    JSON.stringify(setCall?.params));
  check("回执带真实字节数与路径（5 + 4 bytes）",
    ok.value?.files?.length === 2 && ok.value.files[0].bytes === 5 && ok.value.files[1].bytes === 4 && ok.value.totalBytes === 9
    && ok.value.files[0].path === path.resolve(INSIDE),
    JSON.stringify(ok.value));
  const rendered = tool.output.render({}, ok.value)[0].text;
  check("render 带文件数与路径、提示核验", /set 2 file\(s\) \(9 bytes\)/.test(rendered) && rendered.includes(path.resolve(INSIDE)) && /verify/i.test(rendered), rendered.slice(0, 160));

  /* 显式 tabId：不走 tabs.list */
  received.length = 0;
  const explicit = await call(tool, { selector: "#file", files: [INSIDE], tabId: 7 });
  check("显式 tabId：成功且不发 tabs.list", explicit.ok === true && !received.some((x) => x.command === "tabs.list"), received.map((x) => x.command).join(","));
  check("显式 tabId：所有 cdp 都用 7", received.filter((x) => x.command === "cdp").every((x) => x.params.tabId === 7), JSON.stringify(received.map((x) => x.params.tabId)));

  /* selector 未命中：不发 setFileInputFiles */
  received.length = 0;
  const miss = await call(tool, { selector: "#nope", files: [INSIDE] });
  check("selector 未命中：报错并点名 selector", miss.ok === false && /nothing matches "#nope"/.test(miss.error), miss.error?.slice(0, 100));
  check("selector 未命中：不发 setFileInputFiles（只发了 document/querySelector）",
    received.filter((x) => x.command === "cdp").map((x) => x.params.method).join(",") === "DOM.getDocument,DOM.querySelector",
    received.map((x) => x.params.method ?? x.command).join(","));

  try { sock.close(); } catch {}
  inst.dispose();
}

/* ============ 4. 只读档 ============ */
{
  const inst = makeInstance({ port: 9816, token: "up-ro", overrides: { allowUpload: true, uploadDir: ROOT, readOnly: true } });
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectFake(inst);
  const tool = inst.tools.find((t) => t.name === "browser_upload");
  const r = await call(tool, { selector: "#file", files: [INSIDE] });
  check("只读档：拒绝且零命令", r.ok === false && /read-only/.test(r.error) && received.length === 0, r.error?.slice(0, 90));
  try { sock.close(); } catch {}
  inst.dispose();
}

/* ============ 5. 老扩展（没有 cdp） ============ */
{
  const inst = makeInstance({ port: 9817, token: "up-old", overrides: { allowUpload: true, uploadDir: ROOT } });
  await new Promise((r) => setTimeout(r, 300));
  const { sock, received } = await connectFake(inst, { version: "1.7.1", capabilities: null });
  const tool = inst.tools.find((t) => t.name === "browser_upload");
  const r = await call(tool, { selector: "#file", files: [INSIDE] });
  check("老扩展：extension-outdated 且零命令", r.ok === false && /extension-outdated/.test(r.error) && received.length === 0, r.error?.slice(0, 100));
  try { sock.close(); } catch {}
  inst.dispose();
}

console.log(fails === 0 ? "\n文件上传闸门与链路全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
