// #4 验证：证明「patch 里显式写的 enabled 会覆盖 schema 的 default(true)」，
// 也就是 cordis.patch.yml 改成 true 之前，装上必然不监听 9777。
// schemastery 的 schema 本身就是校验函数：Schema(data) -> 补全默认值并校验。
import { readFile } from "node:fs/promises";
import { Config, BROWSER_BRIDGE_SETTINGS_NAMESPACE } from "../lib/index.js";

const cases = [
  { name: "无任何配置（只有 schema 默认）", input: {} },
  { name: "旧 patch 显式 enabled:false", input: { enabled: false, port: 9777, token: "dsh-local" } },
  { name: "新 patch 显式 enabled:true", input: { enabled: true, port: 9777, token: "dsh-local" } },
];

console.log("settings namespace:", BROWSER_BRIDGE_SETTINGS_NAMESPACE);
for (const c of cases) {
  const out = Config(c.input);
  console.log(`${c.name.padEnd(28)} -> enabled=${String(out.enabled)} port=${out.port} token=${out.token}`);
}

const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
const line = patch.split(/\r?\n/).find((l) => l.trim().startsWith("enabled:"));
console.log("\n仓库 cordis.patch.yml:", line?.trim());
const mounted = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: /enabled:\s*true/.test(patch), port: 9777, token: "dsh-local" });
console.log("=> 按这份 patch 挂载后，插件 apply() 拿到的 enabled =", mounted.enabled);
console.log("=> reconcile 是否 bind 端口:", mounted.enabled ? "会监听 127.0.0.1:" + mounted.port : "不会监听（issue #4 的现象）");
