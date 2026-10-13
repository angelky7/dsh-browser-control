// 三层对账：扩展命令表 ↔ 插件实际调用的命令 ↔ 文档里的工具表 ↔ 构建产物。
// 这条断言的存在理由是一类反复出现的缺陷：browser_wait 在 README 和 BEHAVIOR 里
// 承诺过但代码没注册；find / wait / dialog 在扩展里实现好了却没暴露成工具；
// 以及 1.0.7 那次「src 有 16 个工具、发布包只有 11 个」。
import { readFile } from "node:fs/promises";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const src = await readFile("src/index.ts", "utf8");
const bg = await readFile("extension/background.js", "utf8");
const lib = await readFile("lib/index.js", "utf8");
const readme = await readFile("README.md", "utf8");
const readmeEn = await readFile("README.en.md", "utf8");
const behavior = await readFile("docs/BEHAVIOR.md", "utf8");

// 1) 扩展命令表
const at = bg.indexOf("const COMMANDS = {");
if (at < 0) { check("找到扩展 COMMANDS 表", false); }
let depth = 0, i = bg.indexOf("{", at), end = bg.length;
for (; i < bg.length; i++) {
  if (bg[i] === "{") depth++;
  else if (bg[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
}
const table = bg.slice(at, end);
// 键有两种写法：`nav: cmdNav` 和 `'tabs.list': cmdTabsList`，都得抓到
const extCommands = new Set(
  [...table.matchAll(/(?:^|[{,\s])'?([a-zA-Z_.]+)'?\s*:\s*cmd[A-Z]\w*/g)].map((m) => m[1]),
);
check("扩展命令表可解析", extCommands.size >= 20, `${extCommands.size} 个：${[...extCommands].join(", ")}`);

// 2) 插件调用的命令
//    命令名允许大写后缀（`tabs.closeMany`）。原来的 `[a-z_.]+` 会把它截成 `tabs.close`：
//    「扩展实现了但 agent 拿不到」那条断言于是**漏判**，而新命令又因为前缀恰好存在，
//    静默通过了第 2 条 ghost 检查 —— 两个方向同时瞎掉。
const pluginCommands = new Set(
  [...src.matchAll(/controller\.execute\(\s*'([A-Za-z_.]+)'/g)].map((m) => m[1]),
);
const ghost = [...pluginCommands].filter((c) => !extCommands.has(c));
check("插件调用的命令都在扩展表里", ghost.length === 0, ghost.length ? `扩展没有：${ghost.join(", ")}` : `${pluginCommands.size} 个全部命中`);

// 3) 扩展实现了但插件没暴露（ping 是链路保活，允许内部使用）
const INTERNAL_OK = new Set(["ping"]);
const unexposed = [...extCommands].filter((c) => !pluginCommands.has(c) && !INTERNAL_OK.has(c));
check("扩展没有「实现了但 agent 拿不到」的命令", unexposed.length === 0, unexposed.length ? unexposed.join(", ") : "全部已暴露");

// 4) 源码工具 ↔ 构建产物
const srcTools = new Set([...src.matchAll(/name: '(browser_[a-z_]+)'/g)].map((m) => m[1]));
const libTools = new Set([...lib.matchAll(/name: "(browser_[a-z_]+)"/g)].map((m) => m[1]));
const stale = [...srcTools].filter((t) => !libTools.has(t));
check("构建产物与源码工具一致", stale.length === 0, stale.length ? `lib/ 缺：${stale.join(", ")}` : `${srcTools.size} 个一致`);

// 5) 源码工具 ↔ 两份 README 的工具表
for (const [label, doc] of [["README.md", readme], ["README.en.md", readmeEn]]) {
  const section = doc.slice(doc.indexOf("## 工具清单") >= 0 ? doc.indexOf("## 工具清单") : doc.indexOf("## Tools"));
  const body = section.slice(0, 4000);
  const documented = new Set([...body.matchAll(/`(browser_[a-z_]+)`/g)].map((m) => m[1]));
  const missing = [...srcTools].filter((t) => !documented.has(t));
  const phantom = [...documented].filter((t) => !srcTools.has(t));
  check(`${label} 工具表覆盖全部工具`, missing.length === 0, missing.length ? `表里缺：${missing.join(", ")}` : `${documented.size} 行`);
  check(`${label} 工具表没有不存在的工具`, phantom.length === 0, phantom.length ? `文档吹了：${phantom.join(", ")}` : "无");
}

// 6) BEHAVIOR.md 里提到的工具必须存在
const mentioned = new Set([...behavior.matchAll(/\`(browser_[a-z_]+)\`/g)].map((m) => m[1]));
const badMention = [...mentioned].filter((t) => !srcTools.has(t));
check("docs/BEHAVIOR.md 没有指向不存在的工具", badMention.length === 0, badMention.length ? badMention.join(", ") : `提到 ${mentioned.size} 个`);

// 7) llms.txt：工具名要存在，写的工具数要和源码一致（这里已经错过一次：写着 16，实际 20）
const llms = await readFile("llms.txt", "utf8");
const llmsTools = new Set([...llms.matchAll(/\`(browser_[a-z_]+)\`/g)].map((m) => m[1]));
const llmsBad = [...llmsTools].filter((t) => !srcTools.has(t));
check("llms.txt 没有指向不存在的工具", llmsBad.length === 0, llmsBad.length ? llmsBad.join(", ") : `提到 ${llmsTools.size} 个`);
const claimed = [...llms.matchAll(/(\d+)\s*个\s?\`?browser_\*`?/g)].map((m) => Number(m[1]));
const countWrong = claimed.filter((c) => c !== srcTools.size);
check("llms.txt 写的工具数量与源码一致", claimed.length === 0 ? true : countWrong.length === 0,
  claimed.length ? `写的是 ${claimed.join("/")}，实际 ${srcTools.size}` : "没写数量");

console.log(`\n结论：${fails === 0 ? "三层一致" : fails + " 项不一致"}`);
process.exit(fails === 0 ? 0 : 1);
