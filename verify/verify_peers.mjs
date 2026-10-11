// 依赖声明实测：范围形状、宿主包的归属、构建产物的 import 闭包、以及本地实际解析到的版本。
//
// 这条断言的存在理由（issue #13）：v1.0.8 把 peer 写成
//   ">=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.3.0-0"
// 看着像「放宽到 0.2 也能装」，但 semver 对预发布版有条硬规则——一个版本只要带
// `-rc`/`-alpha` 后缀，就只有当范围里**有一个同 [major,minor,patch] 元组**的比较符也带
// 预发布后缀时才匹配。于是上面那条范围实际只匹配 `0.1.0-rc.2 … 0.1.0-rc.8` 这 5 个包，
// 0.1.1-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 全都不在其中（实测：`npm view
// "@deepseek-ai/dsh-settings@<那条范围>" version` 只吐 0.1.0-rc.*）。而 @deepseek-ai
// 这一族**从来没有稳定版**（`latest` dist-tag 是 `0.0.1-rc.1`），所以任何「范围」写法都
// 不可能覆盖宿主实际在用的版本；官方插件一律直接钉具体版本（`"0.2.0-rc.2"`）或只用
// `~4.0.4` 这种稳定版波浪号。这里的断言就是把这个约定钉死，别再自己发明范围。
import { readFile } from "node:fs/promises";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const peers = pkg.peerDependencies ?? {};
const deps = pkg.dependencies ?? {};

/** 宿主自己提供的包：必须是 peer，不能是 dependency（否则装出第二份 cordis/dsh-tools）。 */
const HOST_OWNED = ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-invariants"];
/** 跟着包一起发的纯工具库：官方插件（dsh-persona / dsh-skill）都放 dependencies。 */
const BUNDLED = ["@deepseek-ai/schemastery"];

// ---- 1) 范围形状：每个选择支都必须是「精确版本 / ^stable / ~stable」 ----
// 允许 `"0.1.7-rc.2 || 0.2.0-rc.2"` 这种「把支持的宿主世代逐个精确列出」的写法——
// 预发布版只有作为**同元组的精确比较符**时才匹配得上。禁止的是 `>=x-rc.y <z` 这类
// 「下限带 rc、上限是别的元组」的复合比较：看着宽松，实际谁也匹配不到。
const ONE = /^(\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const alternatives = (range) => String(range).split("||").map((s) => s.trim()).filter(Boolean);
for (const [label, table] of [["peer", peers], ["dependency", deps]]) {
  for (const [name, range] of Object.entries(table)) {
    const parts = alternatives(range);
    const bad = parts.filter((p) => !ONE.test(p));
    check(`${label} ${name} 的每个选择支都是单一比较符`, bad.length === 0, `实际写成 "${range}"`);
    const preOp = parts.filter((p) => /-/.test(p.replace(/^[\^~]/, "")) && /^[\^~]/.test(p));
    check(`${label} ${name} 的预发布支用精确钉版（^/~ 配 rc 在 semver 里永远匹配不上）`, preOp.length === 0,
      preOp.join(" / "));
  }
}

// ---- 2) 归属：宿主包只能当 peer，工具库必须是 dependency ----
for (const name of HOST_OWNED) {
  const why = !(name in peers) ? "peer 里缺它" : name in deps ? "同时出现在 dependencies，会装出第二份宿主包" : "";
  check(`${name} 声明为 peer 且没有同时是 dependency`, why === "", why);
}
for (const name of BUNDLED) {
  check(`${name} 声明为 dependency`, name in deps && !(name in peers), `dependencies=${deps[name] ?? "(无)"}`);
}

// ---- 3) 本地实际解析到的版本必须符合声明 ----
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : null;
};
/** 只实现本仓库允许的那几种形状：精确、^stable、~stable，以及它们的 `||` 并列。 */
function satisfies(range, version) {
  return alternatives(range).some((part) => satisfiesOne(part, version))
}
function satisfiesOne(range, version) {
  const op = range.startsWith("^") ? "^" : range.startsWith("~") ? "~" : "";
  const base = parse(range.replace(/^[\^~]/, ""));
  const v = parse(version);
  if (!base || !v) return false;
  if (base.pre || v.pre || op === "") return `${op}${fmt(base)}` === version;
  if (op === "~") return v.major === base.major && v.minor === base.minor && v.patch >= base.patch;
  if (op === "^") {
    if (base.major > 0) return v.major === base.major && (v.minor > base.minor || (v.minor === base.minor && v.patch >= base.patch));
    if (base.minor > 0) return v.major === 0 && v.minor === base.minor && v.patch >= base.patch;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }
  return false;
}
const fmt = (p) => `${p.major}.${p.minor}.${p.patch}${p.pre ? `-${p.pre}` : ""}`;

const installed = {};
for (const name of new Set([...Object.keys(peers), ...Object.keys(deps)])) {
  try {
    installed[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version;
  } catch {
    installed[name] = undefined;
  }
}
for (const [name, range] of Object.entries({ ...peers, ...deps })) {
  check(`${name} 本地解析到的版本满足 "${range}"`,
    installed[name] !== undefined && satisfies(range, installed[name]),
    `实际装的是 ${installed[name] ?? "(未安装)"}`);
}

// ---- 4) 构建产物的 import 闭包：裸模块必须都有声明 ----
for (const bundle of ["lib/index.js", "lib/invariant.js"]) {
  const code = await readFile(bundle, "utf8");
  const bare = [...code.matchAll(/from\s+"([^"./][^"]*)"/g)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("node:"));
  const undeclared = [...new Set(bare)].filter((s) => !(s in deps) && !(s in peers));
  check(`${bundle} 的裸 import 全部有声明`, undeclared.length === 0,
    undeclared.length ? `没声明：${undeclared.join(", ")}` : `扫到 ${new Set(bare).size} 个：${[...new Set(bare)].join(", ")}`);
}

// ---- 5) 运行时 import 的宿主包必须是 peer（否则发布出去的包自带一份旧的） ----
const runtime = new Set();
for (const bundle of ["lib/index.js", "lib/invariant.js"]) {
  const code = await readFile(bundle, "utf8");
  for (const m of code.matchAll(/from\s+"(@deepseek-ai\/[^"]+)"/g)) runtime.add(m[1]);
}
const asDeps = [...runtime].filter((s) => s in deps && HOST_OWNED.includes(s));
check("运行时引用的宿主包没有被塞进 dependencies", asDeps.length === 0, asDeps.join(", "));
console.log(`   产物运行时真正 import 的宿主包：${[...runtime].join(", ")}`);

// ---- 6) schemastery 的范围与宿主自身的选择保持一致 ----
const schemaRange = deps["@deepseek-ai/schemastery"] ?? "";
check("schemastery 用 ~（跟宿主 ~3.18.x 同族），不是会跨 minor 的裸范围", /^~\d+\.\d+\.\d+$/.test(schemaRange), schemaRange);

// ---- 7) 不声明 engines：Node 版本由宿主决定，写死了反而多一条硬失败路径 ----
// （npm 上官方 dsh 插件一个都没写 engines；而 pnpm/npm 在 engine-strict 下会因它直接拒绝安装）
check("package.json 不写 engines", pkg.engines === undefined, pkg.engines === undefined ? "" : JSON.stringify(pkg.engines));

console.log(`\n结论：${fails === 0 ? "依赖声明符合宿主约定" : fails + " 项不符合"}`);
process.exit(fails ? 1 : 0);
