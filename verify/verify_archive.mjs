// browser_archive 的台子（roadmap 第 1 层「整页存档」，Page.captureSnapshot MHTML）。
// 与 pdf/screenshot 同一家族：MV3 SW 不落盘，扩展回原始载荷、插件写文件。断言钉三件事：
//   1) 扩展侧逐字透传（假件按真 CDP 响应形状回 {data}，不套 Runtime.evaluate 那种信封）；
//   2) 插件侧逐字节落盘（utf8 原样写入、bytes 是真实字节数、路径如实回报）；
//   3) 只读档拒绝（本地写文件 = 不进只读白名单），且策略表通用对账不靠这单记住它。
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { bootBackground } from "./ext_harness.mjs";
import { Config, apply, policyRefusal } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const MHTML_SAMPLE = "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"----=_NextPart_000\"\r\n\r\n------=_NextPart_000\r\nContent-Location: https://a.test/\r\nContent-Type: text/html\r\n\r\n<html><body>存档正文</body></html>\r\n------=_NextPart_000--\r\n";

/* ============ 扩展侧 ============ */
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://a.test/");
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  model.dbg.results["Page.captureSnapshot"] = { data: MHTML_SAMPLE };
  const out = await ctx.cmdArchive({ tabId });
  check("扩展侧：mhtml 原样透传（不套信封、不改一字）", out.mhtml === MHTML_SAMPLE, JSON.stringify(out).slice(0, 80));
  check("扩展侧：tabId 如实回带", out.tabId === tabId, String(out.tabId));
  check("扩展侧：只发 Page.captureSnapshot 一种 CDP", model.dbg.sends["Page.captureSnapshot"] === 1, JSON.stringify(model.dbg.sends));
}
{
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, "https://a.test/");
  await ctx.withCDP(tabId, (send) => send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  model.dbg.results["Page.captureSnapshot"] = {};
  const out = await ctx.cmdArchive({ tabId }).then((r) => r, (e) => ({ error: String(e.message) }));
  check("扩展侧：CDP 回空时如实报错，不假成功", /returned no data/.test(String(out.error)), String(out.error));
}

/* ============ 插件侧：真 BridgeServer + 假扩展，真写盘 ============ */
const PORT = 9787;
const TOKEN = "archive-test";
const SHOTS = "verify-tmp-archive";
const tools = [];
const disposers = [];

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

const archive = tools.find((t) => t.name === "browser_archive");
check("browser_archive 已注册", Boolean(archive));
const props = archive?.parameters?.properties ?? {};
check("参数表只有 instance / tabId / path", "tabId" in props && "path" in props && "instance" in props && Object.keys(props).length === 3, Object.keys(props).join(","));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.5.0", protocol: 1, browser: { name: "fake", version: "1", ua: "" } }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 9, mhtml: MHTML_SAMPLE } }));
  };
  setTimeout(r, 400);
});

const signal = () => new AbortController().signal;

// 默认落盘：进 shotsDir、.mhtml 后缀、内容逐字节一致
const saved = await archive.execute({}, { signal: signal() });
check("默认保存进 shotsDir 且带 .mhtml 后缀", saved.file.replaceAll("\\", "/").includes(SHOTS) && saved.file.endsWith(".mhtml"), saved.file);
const onDisk = await readFile(saved.file, "utf8");
check("落盘内容与扩展载荷逐字节一致", onDisk === MHTML_SAMPLE, `${Buffer.byteLength(onDisk)} vs ${Buffer.byteLength(MHTML_SAMPLE)}`);
check("bytes 是真实 utf8 字节数", saved.bytes === Buffer.byteLength(MHTML_SAMPLE, "utf8"), String(saved.bytes));
check("tabId 如实回带", saved.tabId === 9, String(saved.tabId));

// 指定绝对路径：原样落在那里
const custom = saved.file.replace(/[^/\\]+$/, "custom-archive.mhtml");
const saved2 = await archive.execute({ path: custom }, { signal: signal() });
check("绝对 path 被尊重", saved2.file === custom, saved2.file);
check("自定义路径内容同样逐字节一致", (await readFile(custom, "utf8")) === MHTML_SAMPLE);

/* ============ 策略：只读档拒（本地写文件不进白名单），机制级断言 ============ */
check("readOnly: true 拒 archive", policyRefusal("archive", { readOnly: true }) !== undefined, String(policyRefusal("archive", { readOnly: true })));
check("正常档放行", policyRefusal("archive", {}) === undefined);
check("不在只读白名单里（写本地文件的家族与 pdf/screenshot 同类）", !(await import("../lib/index.js")).READ_ONLY_ALLOWED.has("archive"));

// 台子自清理
disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
try { ws.close(); } catch {}
try { await rm(SHOTS, { recursive: true, force: true }); } catch {}
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
