// snapshot 分页的台子（v1.7.7，纯插件特性）。扩展侧的快照命令没有 offset 参数，
// 但回执里一直带 total——所以分页在插件侧完成：每次向扩展要最大窗口（200 条），
// 再按 offset/limit 切片，回执如实给 total/returned/nextOffset/hasMore。
// 断言面：页边界（含越界与窗口耗尽）、clamp、total 缺失时的退化、AX 透传、
// render 的「第几到第几 / 下一页 offset / 窗口上限说明」。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const STATE = await mkdtemp(path.join(tmpdir(), "dsh-snapshot-page-"));
const PORT = 9809;
const TOKEN = "snapshot-page";
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
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: pctx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};
apply(pctx, config);
await new Promise((r) => setTimeout(r, 400));

/** 假扩展：回一条 200 条的窗口（refs e1..e200），total 可配；mode:"ax" 会回报 ax。 */
const WINDOW = Array.from({ length: 200 }, (_, i) => ({ ref: `e${i + 1}`, tag: "button", name: `BTN-${i + 1}` }));
let pageTotal = 300;
const seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "1.7.2", protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: ["snapshot"] }));
    r();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "command") return;
    seen.push({ command: msg.command, params: msg.params ?? {} });
    if (msg.command !== "snapshot") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { tabId: 7 } }));
      return;
    }
    const ax = msg.params?.mode === "ax";
    const payload = {
      tabId: 7, title: "Big page", url: "https://big.test/", items: WINDOW.slice(0, Number(msg.params?.limit) || 120),
      ...(pageTotal === null ? {} : { total: pageTotal }),
      ...(ax ? { mode: "ax", ax: { nodes: 200 } } : {}),
    };
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: payload }));
  };
  setTimeout(r, 400);
});
await new Promise((r) => setTimeout(r, 100));

const snap = tools.find((t) => t.name === "browser_snapshot");
check("browser_snapshot 已注册（工具面仍是 30 条）", Boolean(snap) && tools.length === 30, String(tools.length));
check("参数表加了 offset", snap?.parameters?.properties?.offset !== undefined, Object.keys(snap?.parameters?.properties ?? {}).join(","));
const signal = () => new AbortController().signal;
const call = (args) => snap.execute(args, { signal: signal() }).then((r) => ({ ok: true, value: r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

/* 1) 默认页 */
{
  const at = seen.length;
  const page = await call({ tabId: 7 });
  check("默认页：向扩展要 200 的窗口（分页在插件侧）", seen.slice(at).some((s) => s.command === "snapshot" && Number(s.params.limit) === 200), JSON.stringify(seen.slice(at).map((s) => s.params)));
  check("默认页：1–120 / total 300，给出下一页 offset", page.value.offset === 0 && page.value.items.length === 120 && page.value.total === 300 && page.value.returned === 200 && page.value.nextOffset === 120 && page.value.hasMore === true, JSON.stringify({ o: page.value.offset, n: page.value.items.length, t: page.value.total, r: page.value.returned, next: page.value.nextOffset }));
  check("默认页：refs 从 e1 开始", page.value.items[0].ref === "e1" && page.value.items[119].ref === "e120", `${page.value.items[0].ref}..${page.value.items[119].ref}`);
  const rendered = snap.output.render({}, page.value)[0].text;
  check("render：第几到第几 / 页总数 / 下一页 / 窗口上限说明都在",
    /items 1–120 of 300 on the page/.test(rendered) && /next page: offset 120/.test(rendered) && /at most 200-item windows/.test(rendered), rendered.split("\n")[0]);
}

/* 2) 中间页 */
{
  const page = await call({ tabId: 7, offset: 120, limit: 50 });
  check("中间页：121–170，下一页 170", page.value.items[0].ref === "e121" && page.value.items.length === 50 && page.value.nextOffset === 170, JSON.stringify({ first: page.value.items[0].ref, n: page.value.items.length, next: page.value.nextOffset }));
  const rendered = snap.output.render({}, page.value)[0].text;
  check("render：中间页区间正确", /items 121–170 of 300 on the page/.test(rendered), rendered.split("\n")[0]);
}

/* 3) 窗口耗尽：190..200，仍有 total>returned，但没有下一页（窗口到头） */
{
  const page = await call({ tabId: 7, offset: 190, limit: 50 });
  check("窗口尾页：只回 10 条且不再给 nextOffset", page.value.items.length === 10 && page.value.hasMore === false && page.value.nextOffset === undefined, JSON.stringify({ n: page.value.items.length, more: page.value.hasMore, next: page.value.nextOffset }));
  const rendered = snap.output.render({}, page.value)[0].text;
  check("render：窗口耗尽仍提示总数与找剩余的办法", /items 191–200 of 300 on the page/.test(rendered) && /at most 200-item windows/.test(rendered), rendered.split("\n")[0]);
}

/* 4) 越界与 clamp */
{
  const past = await call({ tabId: 7, offset: 250 });
  check("offset 越过窗口：空页且不崩，render 说清楚", past.ok === true && past.value.items.length === 0 && past.value.hasMore === false, JSON.stringify({ n: past.value.items.length }));
  const rendered = snap.output.render({}, past.value)[0].text;
  check("render：空页文案点名 offset", /no items at offset 250/.test(rendered), rendered.split("\n")[0]);
  const clamped = await call({ tabId: 7, offset: -5, limit: 999 });
  check("clamp：负 offset → 0，超大 limit → 200", clamped.value.offset === 0 && clamped.value.items.length === 200 && clamped.value.hasMore === false, JSON.stringify({ o: clamped.value.offset, n: clamped.value.items.length }));
}

/* 5) total 缺失（更老的扩展）：退回「returned 即全部」 */
{
  pageTotal = null;
  const page = await call({ tabId: 7, limit: 200 });
  check("total 缺失：如实省略 total，hasMore=false（不编造页总数）", page.value.total === undefined && page.value.hasMore === false && page.value.items.length === 200, JSON.stringify({ t: page.value.total, more: page.value.hasMore }));
  const rendered = snap.output.render({}, page.value)[0].text;
  check("render：无 total 时说「200 available」", /items 1–200 of 200 available/.test(rendered), rendered.split("\n")[0]);
  pageTotal = 300;
}

/* 6) AX 透传不受分页影响 */
{
  const page = await call({ tabId: 7, mode: "ax" });
  check("mode:ax 透传：回执 mode=ax、无 fallback", page.value.mode === "ax" && page.value.axFallback === undefined, JSON.stringify({ mode: page.value.mode }));
}

try { ws.close(); } catch {}
disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} });
console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
