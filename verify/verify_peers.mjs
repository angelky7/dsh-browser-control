// 依赖声明实测：同一条 peer 范围有**两个读法完全不同的消费者**，必须同时满足。
//
//   1) 宿主的兼容门禁（@deepseek-ai/dsh-app-boot/lib/index.js:294-300，实测读法）：
//      只看名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer，拿**宿主版本号**
//      去 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；
//      不过就 throw（:931），插件 bundle 被整个跳过，要 `dsh plugin allow-version` 才救得回来。
//   2) 包管理器（pnpm/npm，默认语义，不带 includePrerelease）：拿**包自己的版本列表**去匹配。
//      semver 对预发布版的规则是「范围里必须有同 [major,minor,patch] 元组的预发布比较符」，
//      而 `@deepseek-ai/dsh-*` 全族没有任何稳定版。
//
// v1.0.8 栽在只想着 1)：`">=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.3.0-0"` 对宿主门禁全过
// （实测 `satisfies('0.2.0-rc.2', …, includePre)` = true），但对 2) 最大只解析到
// **0.1.0-rc.8**——pnpm 默认 `auto-install-peers=true`，于是干净目录里装发布包真的拉了
// 一整棵 0.1.0 时代的依赖树（19 个包，含 `dsh-agent@0.1.0-*`），typecheck 也一直在校半年前的 API。
// 只钉精确版本（`"0.2.0-rc.2"`）则反过来死在 1)：dsh 0.1.7 / 0.2.1 宿主上门禁直接判不兼容。
//
// 所以能同时过两关的写法只有一种：**精确钉版 `||` 宽范围**——
// `"0.2.0-rc.2 || >=0.1.0-rc.1 <0.3.0-0"`。实测：包管理器 maxSatisfying 得到 0.2.0-rc.2，
// 宿主门禁对 0.1.2-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 全过。
import { readFile } from "node:fs/promises";
import semver from "semver";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** 本插件声称兼容、且实测过（假宿主形状 + 特性探测）的宿主世代。抬 ceiling 是一次有意的决定。 */
const SUPPORTED_HOSTS = ["0.1.2-rc.1", "0.1.7-rc.2", "0.2.0-rc.2", "0.2.1-alpha.2"];
/** 宿主注入的包：必须是 peer，且只有 @deepseek-ai/dsh* 会被门禁检查。 */
const HOST_OWNED = ["@deepseek-ai/cordis", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-invariants"];
/** 跟着包一起发的纯工具库：官方插件（dsh-persona / dsh-skill）都放 dependencies。 */
const BUNDLED = ["@deepseek-ai/schemastery"];

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const peers = pkg.peerDependencies ?? {};
const deps = pkg.dependencies ?? {};
const gated = (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
const alternatives = (range) => String(range).split("||").map((s) => s.trim()).filter(Boolean);
const isExact = (part) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(part);
const isStableCaretTilde = (part) => /^[\^~]\d+\.\d+\.\d+$/.test(part);

const installed = {};
for (const name of new Set([...Object.keys(peers), ...Object.keys(deps)])) {
  try {
    installed[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version;
  } catch {
    installed[name] = undefined;
  }
}

/* 1 —— 形状：每个选择支都得是包管理器看得懂的形式，且至少要有一个精确支 */
for (const [label, table] of [["peer", peers], ["dependency", deps]]) {
  for (const [name, range] of Object.entries(table)) {
    const parts = alternatives(range);
    const junk = parts.filter((p) => !isExact(p) && !isStableCaretTilde(p) && !/^>=[^|]*<[^|]*$/.test(p));
    check(`${label} ${name} 的选择支形式合法`, junk.length === 0, junk.length ? `"${range}" 里的 ${junk.join(" / ")}` : "");
    const needsAnchor = parts.some((p) => /-/.test(p.replace(/^[\^~]/, "")));
    check(`${label} ${name} 涉及预发布版时必须有一条精确支当锚点（否则解析器只会拿到远古版）`,
      !needsAnchor || parts.some(isExact), needsAnchor && !parts.some(isExact) ? `"${range}" 没有精确支` : "");
  }
}

/* 2 —— 包管理器视角：我们构建时用的那个版本，必须满足我们对外声明的范围 */
for (const [name, range] of Object.entries({ ...peers, ...deps })) {
  const have = installed[name];
  if (have === undefined) { check(`${name} 本地已安装`, false, "node_modules 里没有它"); continue; }
  check(`包管理器视角：${name}@${have} 满足 "${range}"`, semver.satisfies(have, range),
    semver.satisfies(have, range) ? "" : `satisfies=false，解析器只会拿到 ${semver.maxSatisfying([have], range) ?? "null"}`);
}

/* 3 —— 宿主门禁视角：声称支持的每一代宿主都必须过 evaluatePluginCompatibility */
for (const [name, range] of Object.entries(peers)) {
  if (!gated(name)) continue;
  for (const host of SUPPORTED_HOSTS) {
    check(`宿主门禁：dsh ${host} 装本插件时 peer ${name} 要判兼容`,
      semver.satisfies(host, range, { includePrerelease: true }), semver.satisfies(host, range, { includePrerelease: true }) ? "" : `宿主会被判不兼容：${range}`);
  }
}

/* 4 —— 归属：宿主包只能当 peer，工具库必须是 dependency */
for (const name of HOST_OWNED) {
  const why = !(name in peers) ? "peer 里缺它" : name in deps ? "同时出现在 dependencies，会装出第二份宿主包" : "";
  check(`${name} 声明为 peer 且没有同时是 dependency`, why === "", why);
}
for (const name of BUNDLED) {
  check(`${name} 声明为 dependency`, name in deps && !(name in peers), `dependencies=${deps[name] ?? "(无)"}`);
}

/* 5 —— 构建产物的 import 闭包：裸模块必须都有声明 */
const runtime = new Set();
for (const bundle of ["lib/index.js", "lib/invariant.js"]) {
  const code = await readFile(bundle, "utf8");
  const bare = [...code.matchAll(/from\s+"([^"./][^"]*)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("node:"));
  for (const s of bare) runtime.add(s);
  const undeclared = [...new Set(bare)].filter((s) => !(s in deps) && !(s in peers));
  check(`${bundle} 的裸 import 全部有声明`, undeclared.length === 0,
    undeclared.length ? `没声明：${undeclared.join(", ")}` : `扫到 ${new Set(bare).size} 个：${[...new Set(bare)].join(", ") || "(无)"}`);
}
const asDeps = [...runtime].filter((s) => s in deps && HOST_OWNED.includes(s));
check("运行时引用的宿主包没有被塞进 dependencies", asDeps.length === 0, asDeps.join(", "));
console.log(`   产物运行时真正 import 的外部包：${[...runtime].join(", ")}`);

/* 6 —— schemastery 与宿主同族（~），且不需要门禁锚点（它有稳定版） */
const schemaRange = deps["@deepseek-ai/schemastery"] ?? "";
check("schemastery 用 ~（宿主自己也是 ~3.18.x）", /^~\d+\.\d+\.\d+$/.test(schemaRange), schemaRange);

/* 7 —— 不声明 engines：Node 版本由宿主决定；宿主门禁实测只看 peerDependencies */
check("package.json 不写 engines", pkg.engines === undefined, pkg.engines === undefined ? "" : JSON.stringify(pkg.engines));

console.log(`\n结论：${fails === 0 ? "依赖声明同时过宿主门禁与包管理器两关" : fails + " 项不过"}`);
process.exit(fails ? 1 : 0);
