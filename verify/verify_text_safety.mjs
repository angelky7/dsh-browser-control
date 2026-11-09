// UTF-16 截断安全台（issue #26）：半个 emoji 会让模型请求体整包 400，且随会话历史
// 每轮重放。四面：
//   1) 纯函数：ASCII/恰好上限/emoji 完整保留/切点落高位代理项时退一格/limit 0/空串/
//      页面自带孤立代理项 → U+FFFD；
//   2) 工具 render：任何模型可见 text 都经过 defineTool 包装层，孤立代理项必须被修好；
//   3) 截断报数：可见长度 + omittedChars = 总长度（退掉的半个代理对算进 omitted）；
//   4) 错误文本：扩展/page exception 带回的坏字符同样要修好（失败内容也进请求体）。
// 用法：node verify/verify_text_safety.mjs
import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";
import { sliceWellFormed, toWellFormed } from "../src/text.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const EMOJI = "😭"; // U+1F62D, two UTF-16 units
const LONE_HIGH = "\ud83d";

/* ============ 1. 纯函数 ============ */
check("ASCII 原样保留", sliceWellFormed("hello", 10) === "hello");
check("恰好等于上限不改", sliceWellFormed("abcde", 5) === "abcde");
check("emoji 完整落在上限内不改", sliceWellFormed(`A${EMOJI}B`, 4) === `A${EMOJI}B`);
{
  const split = sliceWellFormed(`${"A".repeat(79)}${EMOJI}`, 80);
  check("切点落高位代理项时退一格（80 → 79，不留半个字符）",
    split === "A".repeat(79) && split.isWellFormed(), JSON.stringify(split.slice(-3)));
}
check("limit 0 → 空串", sliceWellFormed("abc", 0) === "");
check("空串 → 空串", sliceWellFormed("", 5) === "");
{
  const fixed = toWellFormed(`A${LONE_HIGH}B`);
  check("页面自带的孤立代理项 → U+FFFD 且 well-formed",
    fixed.isWellFormed() && fixed.includes("\uFFFD") && fixed.length === 3, JSON.stringify(fixed));
}

/* ============ 1b. 扩展侧的同一个 helper（真实文件里抽出来执行） ============ */
{
  const bg = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const start = bg.indexOf("function pageClipWellFormed(");
  const end = bg.indexOf("\n}", start) + 2;
  check("扩展里能找到 pageClipWellFormed（注入页面表达式的那个 helper）", start >= 0 && end > start, `${start}..${end}`);
  const extClip = new Function(`return (${bg.slice(start, end)})`)();
  check("扩展侧 clip：切点落高位代理项时退一格",
    extClip(`${"A".repeat(79)}${EMOJI}`, 80) === "A".repeat(79));
  check("扩展侧 clip：页面自带坏字符 → U+FFFD",
    extClip(`A${LONE_HIGH}B`, 10).isWellFormed() && extClip(`A${LONE_HIGH}B`, 10).includes("\uFFFD"));
  // 评审列出的页面截断点必须都改走 clip；这些字面量一个都不许再出现。
  const stale = [
    "className || '').slice(0, 120)",
    "replace(/\\\\s+/g, ' ').slice(0, 160)",
    "trim().slice(0, 120)",
    "replace(/\\\\s+/g, ' ')).slice(0, 80)",
    "String(el.value ?? '').slice(0, 60)",
    "String(this.value).slice(0, 60)",
    "innerText.slice(0, 4000)",
  ].filter((s) => bg.includes(s));
  check("扩展侧 7 处页面文本截断都换成 clip（issue #26 的清单）", stale.length === 0, stale.join(" | ") || "none");
}

/* ============ 2-4. 真工具注册面 ============ */
const STATE = await mkdtemp(path.join(tmpdir(), "dsh-text-safety-"));
const PORT = 9812;
const TOKEN = "text-safety";
const tools = [];
const disposers = [];
const config = Config({ stateDir: STATE, enabled: true, port: PORT, token: TOKEN, shotsDir: path.join(STATE, "shots") });
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
await new Promise((r) => setTimeout(r, 400));

// 假扩展：eval 回一个带孤立代理项的错误，其余命令不需要。
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello", client: "fake-extension", version: "1.7.2", protocol: 1,
      browser: { name: "fake", version: "1", ua: "" }, capabilities: ["eval", "dialog"],
    }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    if (msg.command === "eval") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: `page exception: ${"A".repeat(79)}${LONE_HIGH}` }));
      return;
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { policy: "accept" } }));
  };
  setTimeout(r, 400);
});
await new Promise((r) => setTimeout(r, 150));

const tool = (n) => tools.find((t) => t.name === n);

{
  // browser_read 的 render 直接把页面正文拼进纯文本（真实事故就是这条路径）。
  const read = tool("browser_read");
  const text = read.output.render({}, {
    tabId: 1, mode: "text", title: "T", url: "https://x.test/",
    content: `A${LONE_HIGH}B`, truncated: false, offset: 0, totalChars: 3,
  })[0].text;
  check("纯文本 render 里的孤立代理项被修好（模型可见文本永远 well-formed）",
    text.isWellFormed() && text.includes("\uFFFD"), JSON.stringify(text.slice(-6)));
  // JSON.stringify 型 render 本身就该是 ASCII 转义；确认包装层没有破坏它。
  const dialogText = tool("browser_dialog").output.render({}, { policy: `${"A".repeat(79)}${LONE_HIGH}` })[0].text;
  check("JSON 型 render 仍 well-formed（包装层不破坏合法文本）",
    dialogText.isWellFormed(), JSON.stringify(dialogText.slice(-12)));
}

{
  // JSON 前缀 `{"blob":"` 占 9 码元；A×3990 之后正好是 emoji 的高位代理项落在第 4000 位。
  const value = { blob: `${"A".repeat(3990)}${EMOJI}${"B".repeat(100)}` };
  const text = tool("browser_dialog").output.render({}, value)[0].text;
  const marker = text.match(/renderedTruncated omittedChars=(\d+) limitChars=(\d+)/);
  const visible = text.slice(0, text.indexOf("\n… [renderedTruncated"));
  const total = JSON.stringify(value).length;
  check("4000 边界正好切在 emoji 中间：退一格后文本 well-formed",
    text.isWellFormed() && visible.length === 3999, `visible=${visible.length}`);
  check("omittedChars 报的是实际省略量（可见 + 省略 = 总长）",
    marker !== null && Number(marker[1]) === total - visible.length, marker ? `omitted=${marker[1]} total=${total} visible=${visible.length}` : "no marker");
}

{
  const evaluate = tool("browser_evaluate");
  const error = await evaluate.execute({ expression: "1" }, { signal: new AbortController().signal })
    .then(() => null, (e) => e);
  check("工具失败文本也 well-formed（失败内容同样进下一轮请求体）",
    error instanceof Error && error.message.isWellFormed() && error.message.includes("\uFFFD"), JSON.stringify(error?.message?.slice(-8)));
  check("失败文本仍保留错误契约前缀与分类",
    error instanceof Error && /^\[command_failed\]/.test(error.message) && /effectState=unknown/.test(error.message), error?.message?.slice(0, 40));
}

try { ws.close(); } catch {}
disposers.reverse().forEach((fn) => { try { fn(); } catch {} });
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
