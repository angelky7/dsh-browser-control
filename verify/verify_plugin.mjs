// 用最小假 cordis 上下文跑真实的 apply()，验证：
//  1) 按仓库 cordis.patch.yml 挂载后，桥接是否真的监听（#4）
//  2) settings 服务是 0.1.2 那种有 register 的，还是 0.1.7/0.2 那种只有 SettingsForms 的（#8）
//  3) 工具是否全部注册成功（v1.0.7 的 4 个新工具在不在）
// 用法: node verify/verify_plugin.mjs [legacy|new]
import net from "node:net";
import { readFile } from "node:fs/promises";
import { Config, apply } from "../lib/index.js";

const MODE = process.argv[2] ?? "legacy";
const PORT = 9777;

const logs = [];
const tools = [];
const disposers = [];
let injectedError;
let legacyScope;

const settingsService = MODE === "legacy"
  ? {
      // dsh-settings 0.1.2-rc.1：register(ns, schema, { base, validate }) -> scope{ get, watch }
      register(ns, schema, options) {
        let value = schema(options?.base ?? {});
        const watchers = [];
        const scope = {
          get: () => value,
          watch: (cb) => void watchers.push(cb),
          set: (next) => { value = next; watchers.forEach((w) => w()); },
        };
        legacyScope = scope;
        return scope;
      },
    }
  : MODE === "conflict"
    ? {
        // register 存在但抛错（命名空间冲突等），也必须走兜底
        register() { throw new Error("Settings namespace already registered: browser-bridge"); },
      }
    : {
        // dsh-settings 0.1.7-rc.2 / 0.2.0-rc.2 实测导出面：只有 configure/describe/update/replace/mutate
        configure: () => () => {},
        describe: () => [],
        update: async () => {},
        replace: async () => {},
        mutate: async () => {},
      };

const ctx = {
  logger: { info: (l) => logs.push(String(l)), warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => {
    if (!deps.includes("settings")) return;
    try { cb({ settings: settingsService, logger: ctx.logger }); }
    catch (error) { injectedError = error; }
  },
  tools: { register: (def) => tools.push(def?.name ?? "?") },
  systemPrompt: { section: () => {} },
};

const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
const config = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: /enabled:\s*true/.test(patch), port: PORT, token: "dsh-local" });

console.log(`mode=${MODE}  config.enabled=${config.enabled}  port=${config.port}`);
try {
  apply(ctx, config);
} catch (error) {
  console.log("apply() 直接抛错:", error.message);
}

await new Promise((r) => setTimeout(r, 300));

const portOpen = await new Promise((res) => {
  const s = net.connect(PORT, "127.0.0.1", () => { s.end(); res(true); });
  s.on("error", () => res(false));
});

console.log("settings 注入回调是否抛错:", injectedError ? `是 -> ${injectedError.constructor.name}: ${injectedError.message}` : "否");
console.log("9777 是否在监听:", portOpen);
console.log("注册的工具数:", tools.length);
console.log("工具清单:", tools.sort().join(", "));
console.log("桥接日志:", logs.slice(0, 4).join(" | "));

// 回归：老宿主上「设置改动 -> 桥接实时收敛」这条链不能被我改坏
if (MODE === "legacy" && legacyScope) {
  legacyScope.set(Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: false, port: PORT, token: "dsh-local" }));
  await new Promise((r) => setTimeout(r, 400));
  const stillOpen = await new Promise((res) => {
    const s = net.connect(PORT, "127.0.0.1", () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
  console.log("回归：把 enabled 改成 false 后端口应关闭 ->", stillOpen ? "仍监听（错）" : "已关闭（对）");
  legacyScope.set(Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: PORT, token: "dsh-local" }));
  await new Promise((r) => setTimeout(r, 400));
  const reopened = await new Promise((res) => {
    const s = net.connect(PORT, "127.0.0.1", () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
  console.log("回归：改回 true 后端口应重开 ->", reopened ? "已监听（对）" : "未监听（错）");
}

for (const [fn] of disposers) { try { await fn(); } catch {} }
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
