// 会话恢复的台子（v1.7.5，纯插件特性）。四面：
//   1) journal 单元：追加/读取/坏行跳过/启动裁剪到 1000 行/run 编号分组。
//   2) 跨重启恢复（真桥 + 假扩展）：实例 A 跑两条命令后销毁，同一 stateDir 起
//      实例 B——browser_journal 读得到 A 的条目（run 边界清楚），而 browser_audit
//      只报 B 自己跑的命令（内存账本与磁盘账本分工）。
//   3) 离线可读：B 没连扩展时 browser_journal 照常工作，失败命令也进 journal。
//   4) 策略与契约：只读档可查；stateDir 默认值落在用户主目录；render 带 run 头。
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";
import { Journal, readJournal, JOURNAL_MAX_LINES } from "../src/journal.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/* ============ 1. journal 单元 ============ */
{
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-journal-unit-"));
  const journal = await Journal.open(dir, () => {});
  const make = (seq, command, extra = {}) => ({ seq, t: 1_760_000_000_000 + seq, command, params: "{}", ok: true, durationMs: 1, ...extra });
  for (let i = 1; i <= 5; i++) journal.append(make(i, "ping"));
  await journal.close();
  const raw = await readFile(path.join(dir, "journal.jsonl"), "utf8");
  check("5 条命令 → 5 行 JSONL，每行带 run 编号", raw.trim().split("\n").length === 5 && raw.includes(`"run":"${journal.runId}"`), `${raw.trim().split("\n").length} lines`);
  const first = JSON.parse(raw.split("\n")[0]);
  check("磁盘条目形状完整（run/seq/t/command/params/ok/durationMs）",
    typeof first.run === "string" && first.seq === 1 && first.command === "ping" && first.params === "{}" && first.ok === true && typeof first.durationMs === "number",
    JSON.stringify(first));
  const read = await readJournal(dir, {});
  check("readJournal 原样读回 5 条", read.total === 5 && read.entries.length === 5 && read.entries[4].seq === 5, String(read.total));

  await writeFile(path.join(dir, "journal.jsonl"), `${raw}this line is broken\n`, "utf8");
  const withBroken = await readJournal(dir, {});
  check("坏行跳过，不炸整本账", withBroken.total === 5, String(withBroken.total));

  const filterDir = await mkdtemp(path.join(tmpdir(), "dsh-journal-filter-"));
  const j2 = await Journal.open(filterDir, () => {});
  j2.append(make(1, "nav", { tabId: 7 }));
  j2.append(make(2, "input", { tabId: 7 }));
  j2.append(make(3, "tabs.open", { tabId: 9 }));
  j2.append(make(4, "nav", { tabId: 9, ok: false, code: "command_failed" }));
  await j2.close();
  const byTab = await readJournal(filterDir, { tabId: 9 });
  check("tabId 过滤", byTab.total === 2 && byTab.entries.every((e) => e.tabId === 9), String(byTab.total));
  const byCmd = await readJournal(filterDir, { command: "nav" });
  check("命令子串过滤", byCmd.total === 2 && byCmd.entries.every((e) => e.command.includes("nav")), String(byCmd.total));
  const limited = await readJournal(filterDir, { limit: 2 });
  check("limit 取最新（升序给出）", limited.entries.map((e) => e.seq).join(",") === "3,4" && limited.total === 4, limited.entries.map((e) => e.seq).join(","));

  const pruneDir = await mkdtemp(path.join(tmpdir(), "dsh-journal-prune-"));
  const lines = [];
  for (let i = 1; i <= JOURNAL_MAX_LINES + 5; i++) {
    lines.push(JSON.stringify({ run: "old-run", seq: i, t: 1_760_000_000_000 + i, command: "ping", params: "{}", ok: true, durationMs: 1 }));
  }
  await writeFile(path.join(pruneDir, "journal.jsonl"), `${lines.join("\n")}\n`, "utf8");
  await Journal.open(pruneDir, () => {});
  const pruned = await readFile(path.join(pruneDir, "journal.jsonl"), "utf8");
  check(`启动裁剪到 ${JOURNAL_MAX_LINES} 行（保留最新的）`,
    pruned.trim().split("\n").length === JOURNAL_MAX_LINES && pruned.includes(`"seq":${JOURNAL_MAX_LINES + 5}`) && !pruned.includes('"seq":1,'),
    `${pruned.trim().split("\n").length} lines`);
}

/* ============ 2. 跨重启恢复 ============ */
const signal = () => new AbortController().signal;

function bootInstance({ port, token, stateDir }) {
  const instTools = [];
  const instDisposers = [];
  const cfg = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port, token, shotsDir: path.join(stateDir, "shots"), stateDir });
  const settings = { register(_ns, schema, options) { const v = schema(options?.base ?? cfg); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => instDisposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: c.logger }); },
    tools: { register: (def) => instTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, cfg);
  return { tools: instTools, dispose: () => instDisposers.reverse().forEach((fn) => { try { fn(); } catch {} }) };
}

/** 等 journal 文件出现并达到期望行数（dispose 是 fire-and-forget 的）。 */
async function waitLines(stateDir, expected, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    try {
      const text = await readFile(path.join(stateDir, "journal.jsonl"), "utf8");
      const count = text.trim().length === 0 ? 0 : text.trim().split("\n").length;
      if (count >= expected) return count;
    } catch { /* 还没建出来 */ }
    if (Date.now() - started > timeoutMs) return -1;
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function connectFake(inst, { answer }) {
  const sock = new WebSocket(`ws://127.0.0.1:${inst.port}/ws?token=${inst.token}`);
  await new Promise((r) => {
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", client: "fake", version: "1.7.2", protocol: 1, browser: { name: "fake", version: "1", ua: "" }, capabilities: ["nav", "input"] }));
      r();
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "command") return;
      sock.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: answer }));
    };
    setTimeout(r, 400);
  });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    try {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/status`, { headers: { authorization: `Bearer ${inst.token}` } });
      if ((await res.json()).hello?.version !== undefined) break;
    } catch { /* 等桥 */ }
  }
  return sock;
}

const STATE = await mkdtemp(path.join(tmpdir(), "dsh-journal-recovery-"));
let runAId = null;
{
  const instA = bootInstance({ port: 9804, token: "journal-a", stateDir: STATE });
  await new Promise((r) => setTimeout(r, 400));
  const sock = await connectFake({ port: 9804, token: "journal-a" }, { answer: { tabId: 7, url: "https://a.test/", title: "A" } });
  const tool = (n) => instA.tools.find((t) => t.name === n);
  await tool("browser_navigate").execute({ url: "https://a.test/", tabId: 7 }, { signal: signal() });
  await tool("browser_type").execute({ selector: "#q", value: "top-secret-typed", tabId: 7 }, { signal: signal() });
  await new Promise((r) => setTimeout(r, 150));
  const rawA = await readFile(path.join(STATE, "journal.jsonl"), "utf8");
  runAId = JSON.parse(rawA.split("\n")[0]).run;
  check("运行 A：两条命令落盘（run 编号一致）", rawA.trim().split("\n").length === 2 && rawA.includes(`"run":"${runAId}"`), String(rawA.trim().split("\n").length));
  check("输入值在磁盘上也是打码的（明文不落盘）", rawA.includes("[redacted:16 chars]") && !rawA.includes("top-secret-typed"), rawA.slice(0, 160));
  try { sock.close(); } catch {}
  instA.dispose();
  await waitLines(STATE, 2);
}

{
  const instB = bootInstance({ port: 9805, token: "journal-b", stateDir: STATE });
  await new Promise((r) => setTimeout(r, 400));
  const tool = (n) => instB.tools.find((t) => t.name === n);
  // B 还没连扩展——journal 是纯本地读，必须照常工作
  const journal = await tool("browser_journal").execute({}, { signal: signal() });
  check("运行 B：扩展离线时 browser_journal 照常可读（纯本地）", journal.total === 2 && journal.runs === 1, JSON.stringify({ total: journal.total, runs: journal.runs }));
  check("正常运行：journal.enabled=true（本次确实在写盘）", journal.journal?.enabled === true, JSON.stringify(journal.journal));
  check("读回的是运行 A 的账（run 编号与 A 一致、含 nav 与 input）",
    journal.entries[0].run === runAId && journal.entries.map((e) => e.command).join(",") === "nav,input", journal.entries.map((e) => e.command).join(","));
  const audit = await tool("browser_audit").execute({}, { signal: signal() });
  check("browser_audit 只报本运行（B 的内存账本是空的，不与 A 混）", audit.total === 0, String(audit.total));

  const failedNav = await tool("browser_navigate").execute({ url: "https://b.test/", tabId: 9 }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("B 没连扩展：命令如实失败（extension_offline 或未启用）", failedNav.ok === false, failedNav.error?.slice(0, 80));
  await waitLines(STATE, 3);
  const merged = await tool("browser_journal").execute({}, { signal: signal() });
  check("失败命令也进 journal，且分属第二次运行（runs=2）", merged.total === 3 && merged.runs === 2 && merged.entries[2].ok === false, JSON.stringify({ total: merged.total, runs: merged.runs }));
  check("两次运行的 run 编号必须不同（同秒启动也不许撞号）", merged.entries[2].run !== runAId, );
  const filtered = await tool("browser_journal").execute({ tabId: 7 }, { signal: signal() });
  check("journal 的 tabId 过滤跨运行可用", filtered.total === 2 && filtered.entries.every((e) => e.tabId === 7), String(filtered.total));
  const rendered = tool("browser_journal").output.render({}, merged)[0].text;
  check("render 按 run 分组（run 头 + 条目 + 失败原因码）",
    (rendered.match(/── run /g) ?? []).length === 2 && /#\d+ /.test(rendered) && /FAIL/.test(rendered) && /Journal: 3 entries in 2 run/.test(rendered), rendered.slice(0, 140));
  instB.dispose();
  await new Promise((r) => setTimeout(r, 150));
}

/* ============ 3. 只读档与默认值 ============ */
{
  const cfg = Config({});
  check("stateDir 默认落在用户主目录（与启动目录无关）", cfg.stateDir === path.join(homedir(), ".dsh-browser-control"), String(cfg.stateDir));
}
{
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-journal-ro-"));
  const instTools = [];
  const disposers = [];
  const cfg = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: 9806, token: "journal-ro", shotsDir: path.join(dir, "shots"), stateDir: dir, readOnly: true });
  const settings = { register(_ns, schema, options) { const v = schema(options?.base ?? cfg); return { get: () => v, watch: () => {}, set: () => {} }; } };
  const c = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings, logger: c.logger }); },
    tools: { register: (def) => instTools.push(def) },
    systemPrompt: { section: () => {} },
  };
  apply(c, cfg);
  await new Promise((r) => setTimeout(r, 350));
  const journalTool = instTools.find((t) => t.name === "browser_journal");
  const out = await journalTool.execute({}, { signal: signal() });
  check("只读档下 browser_journal 照常可查", out.total === 0 && Array.isArray(out.entries));
  const write = await instTools.find((t) => t.name === "browser_click").execute({ selector: "#x" }, { signal: signal() }).then((r) => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  check("只读档仍拒写命令（会话恢复不破策略）", write.ok === false && /blocked_by_policy/.test(write.error));
  disposers.reverse().forEach((fn) => { try { fn(); } catch {} });
}

console.log(fails === 0 ? "\n全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
