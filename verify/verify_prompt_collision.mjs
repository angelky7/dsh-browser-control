// #27：prompt section 重名不能拖垮整条激活链。
// 真 apply() + 假 cordis 上下文；让 systemPrompt.section 抛「already registered」，
// 断言工具仍然全部注册、日志里说明跳过；同时确认我们用的是自己的名字。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

function boot({ sectionThrows = false } = {}) {
  const tools = [];
  const disposers = [];
  const logs = [];
  const sections = [];
  const cfg = Config({ enabled: false, stateDir: path.join(tmpdir(), "dsh-prompt-collision"), port: 9818, token: "x" });
  const ctx = {
    logger: { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: { register() { throw new Error("no settings in this bench"); } }, logger: ctx.logger }); },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: (s) => { if (sectionThrows) throw new Error('prompt section "tool:browser" is already registered'); sections.push(s); } },
  };
  apply(ctx, cfg);
  return { tools, logs, sections, dispose: () => disposers.reverse().forEach((fn) => { try { fn(); } catch {} }) };
}

/* 1) 重名抛错时：工具照样注册，日志说明跳过 */
{
  const { tools, logs, dispose } = boot({ sectionThrows: true });
  check("prompt section 重名：apply() 不抛错", true);
  check("prompt section 重名：30 个工具仍然全部注册", tools.length === 30, String(tools.length));
  check("prompt section 重名：留下可诊断的 warning",
    logs.some((l) => /prompt section skipped/.test(l) && /already registered/.test(l)), logs.slice(-2).join(" | "));
  dispose();
}

/* 2) 正常路径：用我们自己的名字，不占 dsh-builtin-browser 的 tool:browser */
{
  const { tools, sections, dispose } = boot();
  check("正常路径：工具仍然 30 个", tools.length === 30, String(tools.length));
  check("正常路径：section 名字是 tool:browser-control",
    sections.length === 1 && sections[0]?.name === "tool:browser-control", JSON.stringify(sections.map((s) => s.name)));
  check("正常路径：不再使用会撞车的 tool:browser",
    sections.every((s) => s.name !== "tool:browser"), JSON.stringify(sections.map((s) => s.name)));
  dispose();
}

console.log(fails === 0 ? "\nprompt 段落不再拖垮激活" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
