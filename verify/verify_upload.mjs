// browser_upload 实测台（v1.8.0 / PR）：
// 上传能力走扩展的 `cdp` 透传：宿主先校验绝对路径与文件是否存在，再依次发
// DOM.getDocument → DOM.querySelector → DOM.setFileInputFiles。
// 这里用真 BridgeServer + 假扩展把「命令序列、参数、tabId 解析、错误前置、版本闸门」全部钉住：
//   - 相对路径 / 不存在的文件：在**发命令之前**就拒绝；
//   - 正常路径：三个 cdp 命令都用同一个 tabId，files 原样、nodeId 来自 querySelector；
//   - 没传 tabId：先用 tabs.list 取 activeTabId，再拿它跑 cdp；
//   - selector 没命中（nodeId 0）：不发 setFileInputFiles，直接报错；
//   - 扩展缺 cdp 能力（<1.7.2）：报 extension-outdated，命令一条都不发。
// 用法: node verify/verify_upload.mjs
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const rejects = async (promise, pattern) => {
  try {
    await promise;
    return { ok: false, error: "did not reject" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: pattern.test(message), error: message };
  }
};

const PORT = 9789;
const TOKEN = "upload-test-token";
const tools = [];
const disposers = [];
const SHOTS = await mkdtemp(path.join(tmpdir(), "dsh-upload-"));
const config = Config({ enabled: true, port: PORT, token: TOKEN, shotsDir: SHOTS });

const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
    const watchers = [];
    return {
      get: () => value,
      watch: (cb) => void watchers.push(cb),
      set: (next) => { value = next; watchers.forEach((w) => w()); },
    };
  },
};

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: ctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};

apply(ctx, config);
await new Promise((resolve) => setTimeout(resolve, 400));

// 能力清单取自扩展 COMMANDS 表原文：缺了 cdp 就是 <1.7.2 的老扩展
const bgText = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const tableAt = bgText.indexOf("const COMMANDS = {");
const commandTable = bgText.slice(tableAt, bgText.indexOf("}", tableAt));
const COMMAND_KEYS = [...commandTable.matchAll(/(?:^|[{,\s])'?([a-zA-Z_.]+)'?\s*:\s*cmd[A-Z]\w*/gm)].map((match) => match[1]);
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));

let seen = [];
let answers = {};
let ws = null;

const connect = ({ capabilities = COMMAND_KEYS } = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  socket.onerror = () => reject(new Error("fake extension could not connect"));
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "hello", client: "fake-extension", version: manifest.version, protocol: 1,
      browser: { name: "fake", version: "1", ua: "" }, capabilities,
    }));
    setTimeout(resolve, 150);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "command") return;
    seen.push({ command: message.command, params: message.params ?? {} });
    const answer = answers[message.command];
    const result = typeof answer === "function" ? answer(message.params ?? {}) : (answer ?? {});
    socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, result }));
  };
  ws = socket;
});

await connect();

const upload = tools.find((tool) => tool.name === "browser_upload");
check("browser_upload 已注册", upload !== undefined);
const params = upload?.parameters?.properties ?? {};
check("参数表只有 selector / files / tabId", ["selector", "files", "tabId"].every((key) => key in params) && Object.keys(params).length === 3, Object.keys(params).join(","));
const requiredKeys = upload?.parameters?.required ?? [];
check("selector 与 files 必填、tabId 可选", requiredKeys.length === 2 && requiredKeys.includes("selector") && requiredKeys.includes("files") && !requiredKeys.includes("tabId"), JSON.stringify(requiredKeys));

const run = (args) => upload.execute(args, { signal: new AbortController().signal });

// 造一个真实的本机文件
const filePath = path.join(SHOTS, "upload-me.txt");
const fileBody = "hello from local disk\n";
await writeFile(filePath, fileBody);

answers = {
  "tabs.list": () => ({ count: 1, activeTabId: 42, tabs: [{ id: 42, active: true }] }),
  cdp: (params) => {
    if (params.method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (params.method === "DOM.querySelector") return { nodeId: params.params.selector === "#missing" ? 0 : 8 };
    if (params.method === "DOM.setFileInputFiles") return {};
    return { unexpected: params.method };
  },
};

// ---- 1) 路径校验发生在任何命令之前 ----
seen = [];
let result = await rejects(run({ selector: "#f", files: ["relative/path.txt"], tabId: 3 }), /absolute path/);
check("相对路径 → 调用前就报 absolute path", result.ok, result.error);
check("相对路径：零命令下发", seen.length === 0, `${seen.length} 条`);

seen = [];
result = await rejects(run({ selector: "#f", files: [path.join(SHOTS, "missing.txt")], tabId: 3 }), /does not exist/);
check("不存在的文件 → 调用前就报 does not exist", result.ok, result.error);
check("不存在的文件：零命令下发", seen.length === 0, `${seen.length} 条`);

// ---- 2) 正常路径：三步 CDP，参数对得上 ----
seen = [];
const value = await run({ selector: "#f", files: [filePath], tabId: 3 });
const violations = validateJsonSchemaValue(upload.output.schema, value, "value");
check("返回值过自己的输出 schema", violations.length === 0, violations.join(" | "));
check("返回值带真实字节数", value.files?.[0]?.bytes === Buffer.byteLength(fileBody), JSON.stringify(value.files));
check("tabId 原样回执", value.tabId === 3, String(value.tabId));
const text = upload.output.render({ selector: "#f", files: [filePath], tabId: 3 }, value).map((part) => part.text ?? "").join("\n");
check("模型可见文本里有文件与字节数", text.includes("Set 1 file(s)") && text.includes(filePath) && text.includes(`${Buffer.byteLength(fileBody)} bytes`), text);

const cdpSeen = seen.filter((entry) => entry.command === "cdp").map((entry) => entry.params);
check("按顺序发 DOM.getDocument → DOM.querySelector → DOM.setFileInputFiles",
  cdpSeen.length === 3 && cdpSeen[0].method === "DOM.getDocument" && cdpSeen[1].method === "DOM.querySelector" && cdpSeen[2].method === "DOM.setFileInputFiles",
  JSON.stringify(cdpSeen.map((entry) => entry.method)));
check("三个命令都用同一个 tabId", cdpSeen.every((entry) => entry.tabId === 3), JSON.stringify(cdpSeen.map((entry) => entry.tabId)));
check("querySelector 用的是调用方给的 selector", cdpSeen[1].params?.selector === "#f", JSON.stringify(cdpSeen[1].params));
check("setFileInputFiles 收到绝对路径与 querySelector 的 nodeId",
  JSON.stringify(cdpSeen[2].params?.files) === JSON.stringify([filePath]) && cdpSeen[2].params?.nodeId === 8,
  JSON.stringify(cdpSeen[2].params));

// ---- 3) 没传 tabId：先 tabs.list 取 activeTabId ----
seen = [];
const auto = await run({ selector: "#f", files: [filePath] });
check("没传 tabId → 用 activeTabId 作为目标", auto.tabId === 42, String(auto.tabId));
check("没传 tabId 时先问 tabs.list", seen[0]?.command === "tabs.list", seen.map((entry) => entry.command).join(","));
check("后续 cdp 全部使用 activeTabId",
  seen.filter((entry) => entry.command === "cdp").every((entry) => entry.params.tabId === 42),
  JSON.stringify(seen.map((entry) => entry.params.tabId)));

// ---- 4) selector 没命中：不发 setFileInputFiles ----
seen = [];
result = await rejects(run({ selector: "#missing", files: [filePath], tabId: 3 }), /nothing matches/);
check("selector 没命中 → 报 nothing matches", result.ok, result.error);
check("没命中时不发 setFileInputFiles", seen.every((entry) => entry.params.method !== "DOM.setFileInputFiles"),
  seen.map((entry) => entry.params.method ?? entry.command).join(","));

// ---- 5) 老扩展（无 cdp 能力）：extension-outdated，零命令 ----
try { ws.close(); } catch { /* ignore */ }
await new Promise((resolve) => setTimeout(resolve, 100));
await connect({ capabilities: COMMAND_KEYS.filter((command) => command !== "cdp") });
seen = [];
result = await rejects(run({ selector: "#f", files: [filePath], tabId: 3 }), /extension-outdated/);
check("扩展缺 cdp 能力 → extension-outdated（带重装指引）", result.ok && /releases\/latest/.test(result.error), result.error);
check("老扩展：命令一条都不发", seen.length === 0, `${seen.length} 条`);

try { await rm(SHOTS, { recursive: true, force: true }); } catch { /* 系统临时目录，留着无害 */ }
for (const disposer of disposers) {
  try { await disposer[0](); } catch { /* teardown 不参与断言 */ }
}
try { ws.close(); } catch { /* already closed */ }

console.log(fails === 0 ? "\n上传能力全部符合契约" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
