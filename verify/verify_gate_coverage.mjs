// 版本闸门的覆盖率台子（1.7.14 新增）。
//
// 为什么需要它：`hasExtensionCommand()` 在老扩展报的版本查不到映射条目时会
// `return true` 放行——那是**故意的**（不认识的扩展不该被拦死），但它把「映射表
// 有没有漏登记」的举证责任全推给了映射表本身。1.7.14 之前那张表只登记了 1.5.0 起
// 的五个版本，把 1.0.2/1.0.7/1.0.10/1.0.17/1.0.19/1.2.0 引入的 13 条命令当成
// 「基线命令，任何版本都有」。于是 1.0.7 的扩展调 browser_cookies 会收到一句没有
// 出处的 `unknown command: cookies.get`——模型不知道是扩展旧，只会以为功能坏了。
//
// 现存的 verify_surface.mjs 第 8 节对账的是「闸门 ↔ 映射」两个插件侧文本，两条
// 断言都管不到这件事：
//   1) 它不检查映射表**漏了**真实存在的引入版本（基线假设错了）；
//   2) 它不检查「扩展有这条命令、插件也调了，但根本没有任何闸门」。
// 本台子把真值来源换成了 git 里的历史 manifest.json + background.js —— 40 个
// tag 逐个体检，不是读文档、不是读注释。

// 真值：把每个 tag 的扩展代码从 git 里取出来，按出现顺序算出「命令 → 首次出现的
// 扩展版本」。这是唯一可信的来源：manifest.json 的 version 是扩展版本，
// background.js 的 COMMANDS 表是它真正认识哪些命令。

import { execSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cacheDir = repoRoot + ".compat-cache/commands/";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const tags = execSync("git tag --list \"v1.*\"", { cwd: repoRoot, maxBuffer: 1024 * 1024 })
  .toString().split("\n").map((s) => s.trim()).filter((s) => s !== "")
  .sort((a, b) => {
    const pa = a.slice(1).split(".").map(Number);
    const pb = b.slice(1).split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  });
check("git 里有足够多的历史 tag（40 个）", tags.length >= 40, `${tags.length} 个`);

mkdirSync(cacheDir, { recursive: true });

// 与 verify_surface.mjs 抽法一致：定位 COMMANDS 表，按 `名字: cmdXxx` 抓。
const commandsOf = (bg) => {
  const at = bg.indexOf("const COMMANDS = {");
  if (at < 0) return null;
  const table = bg.slice(at, bg.indexOf("}", at));
  return new Set([...table.matchAll(/(?:^|[{,\s])'?([a-zA-Z_.]+)'?\s*:\s*cmd[A-Z]\w*/gm)].map((m) => m[1]));
};

// 首次出现版本：按 tag 顺序扫，命令第一次出现在哪个扩展版本就是它的 since。
const firstSeen = new Map();
let prev = new Set();
const extVersionOf = new Map();
for (const tag of tags) {
  const cache = `${cacheDir}${tag.slice(1)}/`;
  const bgPath = `${cache}background.js`;
  const mfPath = `${cache}manifest.json`;
  if (!existsSync(bgPath) || !existsSync(mfPath)) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(bgPath, execSync(`git show ${tag}:extension/background.js`, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }));
    writeFileSync(mfPath, execSync(`git show ${tag}:extension/manifest.json`, { cwd: repoRoot, maxBuffer: 1024 * 1024 }));
  }
  // 早期 manifest.json 带 UTF-8 BOM（后来才去掉），JSON.parse 会直接炸。
  const manifest = JSON.parse(readFileSync(mfPath, "utf8").replace(/^\uFEFF/, ""));
  const extVersion = manifest.version;
  extVersionOf.set(tag, extVersion);
  const cmds = commandsOf(readFileSync(bgPath, "utf8"));
  check(`${tag}: 扩展命令表可解析`, cmds !== null && cmds.size > 0);
  if (cmds === null) continue;
  // 扩展从不删命令：新版本的命令面必须是旧版本的超集。
  const removed = [...prev].filter((c) => !cmds.has(c));
  check(`${tag}: 相对上一版只增不减`, removed.length === 0, removed.join(", ") || `${cmds.size} 条`);
  for (const cmd of cmds) if (!firstSeen.has(cmd)) firstSeen.set(cmd, extVersion);
  prev = cmds;
}

// 同一个扩展版本可能出现在多个 tag 上（插件升版、扩展没动，比如 v1.1.0 仍是
// 扩展 1.0.19）。那种情况下 since 取扩展版本，天然正确。
const BASELINE = (() => {
  let lowest = null;
  for (const [cmd, ver] of firstSeen) {
    if (lowest === null || cmp(ver, lowest) < 0) lowest = ver;
  }
  return lowest;
})();

function cmp(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 插件侧：从构建产物里读映射表与闸门（验的是模型真正跑的那份代码）。
const lib = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
const mapAt = lib.indexOf("const EXTENSION_COMMANDS_BY_VERSION");
check("lib/index.js 里能找到版本映射表", mapAt >= 0);
const mapBlock = lib.slice(mapAt, lib.indexOf("];", mapAt));
const chunks = mapBlock.split(/since: "([\d.]+)"/);
const declared = new Map();
for (let i = 1; i < chunks.length; i += 2) {
  declared.set(chunks[i], [...chunks[i + 1].matchAll(/"([a-zA-Z_.]+)"/g)].map((m) => m[1]));
}

// 断言 1（核心）：映射表登记的命令，必须与「首次出现版本 ≠ 基线」完全一致。
// 两个方向都要查：漏登记（老扩展被放行到 unknown command）与多登记
// （把基线命令说成新命令，会让老扩展被无理由拦住）。
{
  const expected = new Map();
  for (const [cmd, ver] of firstSeen) {
    if (cmp(ver, BASELINE) <= 0) continue;
    if (!expected.has(ver)) expected.set(ver, []);
    expected.get(ver).push(cmd);
  }
  const missing = [];
  for (const [ver, cmds] of expected) {
    const have = new Set(declared.get(ver) ?? []);
    for (const cmd of cmds) if (!have.has(cmd)) missing.push(`${cmd}@${ver}`);
  }
  check("映射表没有漏登记任何「非基线」命令", missing.length === 0, missing.join(", ") || `${expected.size} 个版本组全覆盖`);

  const extra = [];
  for (const [ver, cmds] of declared) {
    for (const cmd of cmds) {
      const real = firstSeen.get(cmd);
      if (real === undefined) extra.push(`${cmd}（扩展从没有过这个命令）`);
      else if (cmp(real, ver) !== 0) extra.push(`${cmd}@${ver} 实际是 @${real}`);
    }
  }
  check("映射表的每一条都对得上历史真值", extra.length === 0, extra.join(", ") || `${[...declared.values()].flat().length} 条全部吻合`);
}

// 断言 2：凡是插件会 execute 的命令，要么在 1.0.0 基线里，要么必须有闸门。
// 没有闸门的非基线命令 = 旧扩展会收到它不认识的命令（修之前那 13 条就是这样）。
{
  const executed = new Set([...lib.matchAll(/controller\.execute\(\s*["']([A-Za-z_.]+)["']/g)].map((m) => m[1]));
  const gated = new Set([...lib.matchAll(/requireExtensionCommand\(\s*["']([A-Za-z_.]+)["']\s*,/g)].map((m) => m[1]));
  // ping 与 cdp 是内部命令：前者是探活，后者从 1.7.2 起由插件侧特性统一经
  // requireExtensionCommand("cdp","1.7.2") 闸住（走的是 ctrl.execute 而不是
  // controller.execute，所以上面的字面量扫描抓不到它）。
  check("cdp 有闸门（它是经 ctrl.execute 发的，字面量扫描抓不到）", gated.has("cdp"));
  const unguarded = [...executed].filter((c) => !gated.has(c));
  const notBaseline = unguarded.filter((c) => {
    const ver = firstSeen.get(c);
    return ver === undefined || cmp(ver, BASELINE) > 0;
  });
  // 基线命令（1.0.0 就在）本来就不该有闸门——给它们加闸门只会让老扩展被无理由拦住。
  // 所以这里只盯「非基线却无闸门」，那才是会把不认识的命令发下去的缺口。
  check("没有非基线命令漏掉闸门", notBaseline.length === 0,
    notBaseline.join(", ") || `无闸门的 ${unguarded.length} 条全是 ${BASELINE} 基线命令`);
}

// 断言 3：映射表本身要按 since 升序且不重复——hasExtensionCommand 用 find() 取
// 第一条命中，顺序错了会拿错阈值。
{
  const order = [...declared.keys()];
  let ok = true;
  for (let i = 1; i < order.length; i++) if (cmp(order[i - 1], order[i]) >= 0) ok = false;
  check("映射表按 since 严格升序、无重复", ok, order.join(" < "));
}

console.log("");
console.log(`历史真值：${firstSeen.size} 条命令，基线扩展 ${BASELINE}，共扫 ${tags.length} 个 tag`);
console.log(fails === 0 ? "\n版本闸门覆盖全部对得上：映射表既不漏也不吹，非基线命令一条不落闸门" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
