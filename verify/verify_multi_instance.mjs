// 多实例路由台子（v1.8.0，issue #22）。
//
// 要拦的是什么：**命令落到哪个浏览器**。同一个 dsh 会话同时驱动两个 Chrome profile
// （工作号 / 个人号）时，一个 tabId 是**实例内**编号——浏览器 A 的第 7 个标签页和
// 浏览器 B 的第 7 个标签页是两回事。猜错一次就是把点击、输入、甚至删除操作打在
// 另一个登录态上。所以这一版的核心契约是 **fail-closed**：多个浏览器在线又没说
// 是哪一个时，命令一条都不发，直接报错。
//
// 本台子钉死八件事：
//   1) 两个带实例身份的浏览器能**并存**，按 label / 完整 id / 唯一前缀路由；
//   2) 同一 id 重连**只替换它自己**（另一个不被踢掉——这就是多实例的意义）；
//   3) 多实例 + 没指定 instance ⇒ `instance_required`，且**零派发**；
//   4) 名称或前缀命中多个 ⇒ `instance_not_found`（列候选），同样零派发；
//   5) 老扩展（hello 无 instance）进 legacy 单槽，保留「后连替换先连」的旧语义，
//      并能与新实例并存、用 instance:"legacy" 点名；
//   6) 某个实例掉线只失败它自己的在途命令，别的实例照常返回；
//   7) `/api/status` 单实例时旧字段照旧填（老调用者看不到差别），多实例时留空、
//      以 instances[] 为准；HTTP 面 409/404 对得上；
//   8) 会话工作页按 (instance, tabId) 记：A 的 tab 7 不会被当成 B 的 tab 7。
//
// 静态对账另起一节：26 个浏览器工具都必须带 instance 并真的往下传，
// 4 个本地工具（cleanup/audit/journal/sessions）必须**不**带。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config, apply } from "../lib/index.js";

let fails = 0;
const check = (name, ok, detail = "") => {
	if (!ok) fails++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const STATE = await mkdtemp(path.join(tmpdir(), "dsh-multi-"));
const PORT = 9809; // 9777 装机 / 9785 批量关闭 / 9801 审计 / 9807 慢输入·会话
const TOKEN = "multi-instance-test";
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

/** 假扩展要声明的命令面：闸门按 capabilities 精确判定，缺一条就会被拦。 */
const CAPS = [
	"ping", "browser.info", "tabs.list", "tabs.open", "tabs.close", "tabs.closeMany", "tabs.activate",
	"tabs.group", "tabs.ungroup", "nav", "eval", "content", "find", "click", "input", "press", "scroll",
	"snapshot", "screenshot", "wait", "dialog", "hold", "metrics", "cdp", "cookies.get", "cookies.set",
	"cookies.remove", "archive", "emulate", "console.log", "network.log", "network.clear", "pdf",
];

/**
 * 打开一条假扩展连接。`hello` 决定它有没有实例身份；`autoReply:false` 时命令挂起，
 * 用来测「在途命令只失败自己那一条」。
 */
async function connectExtension(hello = {}, options = {}) {
	const autoReply = options.autoReply !== false;
	// Each fake owns a tab list so the session-isolation liveness probe has something
	// real to answer: a working tab is only reused if the browser still reports it.
	const fake = { received: [], held: [], closed: false, liveTabs: new Set([1]), activeTab: 1 };
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
	fake.ws = ws;
	const answer = (msg, payload) => ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: payload }));
	const payloadFor = (msg) => {
		if (msg.command === "tabs.list") {
			const tabs = [...fake.liveTabs].map((id) => ({ id, active: id === fake.activeTab }));
			return { tabs, activeTabId: fake.activeTab, count: tabs.length };
		}
		return { tabId: typeof msg.params?.tabId === "number" ? msg.params.tabId : fake.activeTab, clicked: true, filled: true, value: "x", url: "https://a.test/", title: "A" };
	};
	await new Promise((resolve) => {
		ws.onopen = () => {
			ws.send(JSON.stringify({
				type: "hello", client: "fake-extension", version: "1.8.0", protocol: 1,
				browser: { name: "fake", version: "1", ua: "" },
				capabilities: CAPS,
				...hello,
			}));
			resolve();
		};
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.type !== "command") return;
			fake.received.push({ command: msg.command, params: msg.params ?? {} });
			if (!autoReply) { fake.held.push(msg); return; }
			answer(msg, payloadFor(msg));
		};
		setTimeout(resolve, 400);
	});
	fake.releaseAll = () => {
		const pending = fake.held.splice(0);
		for (const msg of pending) answer(msg, payloadFor(msg));
	};
	fake.close = () => { try { ws.close(); } catch { /* already gone */ } };
	await new Promise((r) => setTimeout(r, 180));
	return fake;
}

const status = () => (async () => (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json())();
const httpCommand = async (body) => {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
};
const tool = (n) => tools.find((t) => t.name === n);
const run = (name, args, agentId) => tool(name).execute(args, {
	signal: new AbortController().signal,
	...(agentId === undefined ? {} : { agent: { id: agentId } }),
}).then((r) => ({ ok: true, value: r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

const ID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ID_B = "bbbbbbbb-2222-4222-8222-222222222222";

/* 1 —— 单实例：行为与 1.7.x 逐字一致（先证明「没变」，再证明「能变」） */
const solo = await connectExtension({ instance: { id: ID_A, label: "work" } });
{
	const s = await status();
	check("单实例：instances 有 1 条", s.instances?.length === 1, JSON.stringify(s.instances?.map((i) => i.key)));
	check("单实例：旧字段仍然填着（hello / connectedAt / extensionProtocol）",
		s.hello !== undefined && s.connectedAt !== undefined && s.extensionProtocol === 1,
		`hello=${s.hello === undefined ? "absent" : "present"} connectedAt=${s.connectedAt === undefined ? "absent" : "present"}`);
	check("单实例：hello 里带着实例身份", s.hello?.instance?.id === ID_A && s.hello?.instance?.label === "work");
	solo.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a" });
	check("单实例：省略 instance 照旧执行（零倒退）", r.ok === true && solo.received.some((m) => m.command === "click"), r.ok ? "" : r.error);
	check("单实例：instance 没有混进发给扩展的 params", solo.received.every((m) => m.params.instance === undefined));
}

/* 2 —— 并存 + 路由 */
solo.close();
await new Promise((r) => setTimeout(r, 200));
const work = await connectExtension({ instance: { id: ID_A, label: "work" } });
const personal = await connectExtension({ instance: { id: ID_B, label: "personal" } });
{
	const s = await status();
	check("并存：两个实例同时在线", s.instances?.length === 2 && s.extensionConnected === true, JSON.stringify(s.instances?.map((i) => i.label)));
	check("并存：多实例时 hello/connectedAt 留空（两个 hello 争不了一个字段）",
		s.hello === undefined && s.connectedAt === undefined, `hello=${s.hello === undefined ? "absent" : "present"}`);
	check("并存：instances[] 带 label 与 id",
		s.instances.some((i) => i.id === ID_A && i.label === "work") && s.instances.some((i) => i.id === ID_B && i.label === "personal"));

	const route = async (label, value) => {
		work.received.length = 0; personal.received.length = 0;
		const r = await run("browser_click", { tabId: 7, selector: ".a", instance: value });
		return {
			ok: r.ok, error: r.error,
			workHits: work.received.length, personalHits: personal.received.length,
		};
	};
	const byName = await route("label", "work");
	check("路由：按 label 精确命中 work", byName.ok && byName.workHits === 1 && byName.personalHits === 0,
		`work=${byName.workHits} personal=${byName.personalHits}`);
	const byUpper = await route("label 大小写不敏感", "PERSONAL");
	check("路由：label 大小写不敏感", byUpper.ok && byUpper.personalHits === 1 && byUpper.workHits === 0);
	const byId = await route("完整 id", ID_B);
	check("路由：完整 id 命中 personal", byId.ok && byId.personalHits === 1 && byId.workHits === 0);
	const byPrefix = await route("唯一前缀", "aaaa");
	check("路由：唯一 id 前缀命中 work", byPrefix.ok && byPrefix.workHits === 1 && byPrefix.personalHits === 0);

	work.received.length = 0; personal.received.length = 0;
	const missing = await run("browser_click", { tabId: 7, selector: ".a" });
	check("fail-closed：多实例没指定 ⇒ instance_required",
		missing.ok === false && /instance_required/.test(missing.error), String(missing.error).slice(0, 120));
	check("fail-closed：报错里列出候选（能照着改名/取 id）",
		missing.ok === false && /work/.test(missing.error) && /personal/.test(missing.error), String(missing.error).slice(0, 200));
	check("fail-closed：**零派发**（两个浏览器都没收到命令）",
		work.received.length === 0 && personal.received.length === 0,
		`work=${work.received.length} personal=${personal.received.length}`);

	const bogus = await run("browser_click", { tabId: 7, selector: ".a", instance: "nope" });
	check("fail-closed：指定不存在的 instance ⇒ instance_not_found",
		bogus.ok === false && /instance_not_found/.test(bogus.error), String(bogus.error).slice(0, 120));
	check("fail-closed：不存在时也零派发", work.received.length === 0 && personal.received.length === 0);
}

/* 3 —— 同一 id 重连只替换自己 */
const work2 = await connectExtension({ instance: { id: ID_A, label: "work" } });
{
	await new Promise((r) => setTimeout(r, 200));
	const s = await status();
	check("重连：仍然只有 2 个实例（同 id 被原地替换，没有变成 3 个）", s.instances?.length === 2, String(s.instances?.length));
	work.received.length = 0; personal.received.length = 0; work2.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a", instance: "work" });
	check("重连：命令落到**新**连接上", r.ok && work2.received.length === 1 && work.received.length === 0,
		`new=${work2.received.length} old=${work.received.length}`);
	check("重连：另一个实例不受影响（personal 还活着）", personal.ws.readyState === 1, String(personal.ws.readyState));
	personal.received.length = 0;
	const still = await run("browser_click", { tabId: 7, selector: ".a", instance: "personal" });
	check("重连：personal 照常收命令", still.ok && personal.received.length === 1);
}

/* 4 —— 歧义：命中多个必须报错，绝不挑一个 */
work2.close();
personal.close();
await new Promise((r) => setTimeout(r, 250));
const dup1 = await connectExtension({ instance: { id: "cccccccc-3333-4333-8333-333333333333", label: "dup" } });
const dup2 = await connectExtension({ instance: { id: "cccccccc-4444-4444-8444-444444444444", label: "dup" } });
{
	dup1.received.length = 0; dup2.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a", instance: "dup" });
	check("歧义：同名 label 命中两个 ⇒ instance_not_found", r.ok === false && /instance_not_found/.test(r.error),
		String(r.error).slice(0, 120));
	check("歧义：报错说清是按 label 命中的、并给出两个完整 id",
		r.ok === false && /by label/.test(r.error) && /cccccccc-3333/.test(r.error) && /cccccccc-4444/.test(r.error),
		String(r.error).slice(0, 200));
	check("歧义：零派发", dup1.received.length === 0 && dup2.received.length === 0);

	dup1.received.length = 0; dup2.received.length = 0;
	const prefix = await run("browser_click", { tabId: 7, selector: ".a", instance: "cccccccc" });
	check("歧义：共享前缀命中两个 ⇒ instance_not_found", prefix.ok === false && /by prefix/.test(prefix.error),
		String(prefix.error).slice(0, 160));
	check("歧义：前缀歧义时也零派发", dup1.received.length === 0 && dup2.received.length === 0);

	// 完整 id 仍然能精确命中，歧义不影响精确指定
	dup1.received.length = 0; dup2.received.length = 0;
	const exact = await run("browser_click", { tabId: 7, selector: ".a", instance: "cccccccc-3333-4333-8333-333333333333" });
	check("歧义：完整 id 仍可精确命中其中一个", exact.ok && dup1.received.length === 1 && dup2.received.length === 0);
}
dup1.close();
dup2.close();
await new Promise((r) => setTimeout(r, 250));

/* 5 —— legacy：老扩展保留「后连替换先连」，且能与新实例并存 */
const legacy1 = await connectExtension({}); // 无 instance 字段
{
	const s = await status();
	check("legacy：单连的老扩展占 legacy 槽", s.instances?.length === 1 && s.instances[0].legacy === true && s.instances[0].key === "legacy",
		JSON.stringify(s.instances?.map((i) => i.key)));
	legacy1.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a" });
	check("legacy：只有一个时，省略 instance 照旧可用（零倒退）", r.ok && legacy1.received.length === 1);
}
const legacy2 = await connectExtension({});
{
	await new Promise((r) => setTimeout(r, 200));
	const s = await status();
	check("legacy：第二个老扩展**替换**第一个（旧单槽语义）",
		s.instances?.length === 1 && s.instances[0].legacy === true, String(s.instances?.length));
	legacy1.received.length = 0; legacy2.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a" });
	check("legacy：命令落到新连上的那个", r.ok && legacy2.received.length === 1 && legacy1.received.length === 0);
}
const named = await connectExtension({ instance: { id: ID_A, label: "work" } });
{
	await new Promise((r) => setTimeout(r, 200));
	const s = await status();
	check("legacy：老扩展能与带身份的新实例**并存**",
		s.instances?.length === 2 && s.instances.some((i) => i.legacy) && s.instances.some((i) => i.id === ID_A),
		JSON.stringify(s.instances?.map((i) => i.key)));
	legacy2.received.length = 0; named.received.length = 0;
	const viaLegacy = await run("browser_click", { tabId: 7, selector: ".a", instance: "legacy" });
	check("legacy：可以用 instance:\"legacy\" 点名老扩展",
		viaLegacy.ok && legacy2.received.length === 1 && named.received.length === 0);
	legacy2.received.length = 0; named.received.length = 0;
	const r = await run("browser_click", { tabId: 7, selector: ".a" });
	check("legacy：有老扩展在场且多实例时，省略 instance 仍然 fail-closed",
		r.ok === false && /instance_required/.test(r.error) && legacy2.received.length === 0 && named.received.length === 0);
}

/* 6 —— 掉线只失败自己的在途命令 */
legacy2.close();
await new Promise((r) => setTimeout(r, 200));
const slowA = await connectExtension({ instance: { id: ID_A, label: "work" } }, { autoReply: false });
const fastB = await connectExtension({ instance: { id: ID_B, label: "personal" } });
{
	const pending = run("browser_click", { tabId: 7, selector: ".a", instance: "work" });
	await new Promise((r) => setTimeout(r, 150));
	check("掉线：work 的命令已在途（被挂起）", slowA.held.length === 1, String(slowA.held.length));
	const other = await run("browser_click", { tabId: 7, selector: ".a", instance: "personal" });
	check("掉线：另一个实例的命令照常返回（互不连坐）", other.ok === true, other.ok ? "" : other.error);
	slowA.close();
	const failed = await pending;
	check("掉线：work 的在途命令失败", failed.ok === false, String(failed.error).slice(0, 100));
	check("掉线：失败原因说得出是链路断了", failed.ok === false && /disconnected mid-command|link_lost/.test(failed.error),
		String(failed.error).slice(0, 140));
	check("掉线：personal 仍然在线", fastB.ws.readyState === 1);
	fastB.received.length = 0;
	const after = await run("browser_click", { tabId: 7, selector: ".a", instance: "personal" });
	check("掉线：之后 personal 的命令仍然正常", after.ok && fastB.received.length === 1);
}

/* 7 —— HTTP 面：409 / 404 / 200 */
// Re-attach `work` first: section 6 deliberately disconnected it, and every assertion
// here (and in 8) is about what happens while TWO browsers are online.
const workBack = await connectExtension({ instance: { id: ID_A, label: "work" } });
{
	await new Promise((r) => setTimeout(r, 150));
	const two = await status();
	check("HTTP 前置：两个实例重新在线", two.instances?.length === 2, String(two.instances?.length));

	const noTarget = await httpCommand({ command: "click", params: { tabId: 7, selector: ".a" } });
	workBack.received.length = 0; fastB.received.length = 0;
	const noTarget2 = await httpCommand({ command: "click", params: { tabId: 7, selector: ".a" } });
	check("HTTP：多实例没指定 ⇒ 409 + instance_required",
		noTarget2.status === 409 && noTarget2.body.code === "instance_required",
		`${noTarget2.status} ${noTarget2.body.code}`);
	check("HTTP：409 时零派发", workBack.received.length === 0 && fastB.received.length === 0,
		`work=${workBack.received.length} personal=${fastB.received.length}`);
	const wrong = await httpCommand({ command: "click", params: { tabId: 7, selector: ".a" }, instance: "ghost" });
	check("HTTP：指定不存在 ⇒ 404 + instance_not_found",
		wrong.status === 404 && wrong.body.code === "instance_not_found", `${wrong.status} ${wrong.body.code}`);
	fastB.received.length = 0;
	const good = await httpCommand({ command: "click", params: { tabId: 7, selector: ".a" }, instance: "personal" });
	check("HTTP：带上 instance 后 200 并通过桥派发",
		good.status === 200 && good.body.ok === true && fastB.received.length === 1,
		`${good.status} hits=${fastB.received.length}`);
	check("HTTP：instance 不进 params（扩展收到的仍是 1.7.x 的形状）",
		fastB.received.every((m) => m.params.instance === undefined));
}

/* 8 —— browser_info：多实例时只做发现，不碰任何浏览器 */
{
	fastB.received.length = 0;
	const r = await run("browser_info", {});
	check("browser_info：多实例且没指定 ⇒ 返回 instances 清单",
		r.ok && Array.isArray(r.value?.instances) && r.value.instances.length >= 1, JSON.stringify(Object.keys(r.value ?? {})));
	check("browser_info：**零派发**（纯发现步骤，不碰任何浏览器）",
		fastB.received.length === 0, String(fastB.received.length));
	check("browser_info：带上 how-to 提示", r.ok && typeof r.value?.hint === "string" && /instance_required/.test(r.value.hint));

	fastB.received.length = 0;
	const one = await run("browser_info", { instance: "personal" });
	check("browser_info：指定 instance 时照常派发并回带身份",
		one.ok && fastB.received.some((m) => m.command === "browser.info") && one.value?.instance?.id === ID_B,
		JSON.stringify(one.value?.instance));
}

/* 9 —— 会话工作页按 (instance, tabId)：A 的 tab 不会被当成 B 的 tab */
{
	// `work` is already back from section 7; give it a live tab 42 so the
	// session-isolation liveness probe can actually confirm the working tab.
	workBack.liveTabs = new Set([1, 42]);
	await new Promise((r) => setTimeout(r, 100));
	workBack.received.length = 0; fastB.received.length = 0;
	// 会话在 work 上收养 tab 42
	const adopt = await run("browser_click", { tabId: 42, selector: ".a", instance: "work" }, "session-x");
	check("会话前置：在 work 上收养 tab 42", adopt.ok === true, adopt.ok ? "" : adopt.error);

	// 同一实例上省略 tabId：应当恢复 42（先证明「记忆本身是好的」）
	workBack.received.length = 0;
	await run("browser_click", { selector: ".a", instance: "work" }, "session-x");
	const sameInstance = workBack.received.find((m) => m.command === "click");
	check("会话：同一实例内恢复本会话的工作页", sameInstance !== undefined && sameInstance.params.tabId === 42,
		JSON.stringify(sameInstance?.params));

	// 同一会话改去 personal，省略 tabId：绝不能把 42 注入过去
	fastB.received.length = 0;
	await run("browser_click", { selector: ".a", instance: "personal" }, "session-x");
	const personalClick = fastB.received.find((m) => m.command === "click");
	check("会话：A 的 tabId 不会被注入到 B 的调用里",
		personalClick !== undefined && personalClick.params.tabId === undefined,
		JSON.stringify(personalClick?.params));

	// 文档化的语义：会话的「工作上下文」只有一个指针，用了哪个浏览器就跟着它走。
	// 所以再回 work 时不会凭空恢复 42——要让会话落回 work 的某个页，显式传 tabId。
	const back = await run("browser_click", { selector: ".a", instance: "personal" }, "session-x");
	check("会话：上下文跟着最近一次调用走（不会在浏览器之间来回跳）", back.ok === true, back.ok ? "" : back.error);
}

/* 10 —— 审计带上 instance 维度 */
{
	fastB.received.length = 0;
	await run("browser_click", { tabId: 7, selector: ".a", instance: "personal" });
	const audit = await run("browser_audit", { limit: 5 });
	const entries = audit.ok ? audit.value?.entries ?? [] : [];
	const hit = entries.filter((e) => e.command === "click").pop();
	check("审计：条目带 instance 字段", hit !== undefined && hit.instance === "personal", JSON.stringify(hit?.instance));
	const filtered = await run("browser_audit", { instance: "personal", limit: 5 });
	check("审计：可以按 instance 过滤",
		filtered.ok && (filtered.value?.entries ?? []).every((e) => e.instance === "personal"),
		JSON.stringify((filtered.value?.entries ?? []).map((e) => e.instance)));
}

/* 11 —— 静态对账：26 个浏览器工具带 instance，4 个本地工具不带 */
{
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const browserTools = [
		"navigate", "read", "snapshot", "click", "type", "press", "scroll", "wait", "find", "hold",
		"cookies", "dialog", "info", "tabs", "windows", "evaluate", "screenshot", "console_log",
		"network_log", "network_clear", "pdf", "archive", "emulate", "metrics", "upload", "drag",
	];
	const localTools = ["cleanup", "audit", "journal", "sessions"];
	const blockOf = (name) => {
		const at = src.indexOf(`name: 'browser_${name}',`);
		if (at < 0) return "";
		const end = src.indexOf("ctx.tools.register(", at + 10);
		return src.slice(at, end < 0 ? src.length : end);
	};
	const missingParam = browserTools.filter((t) => !/instance: INSTANCE_PARAM/.test(blockOf(t)));
	const missingForward = browserTools.filter((t) => !/args\.instance/.test(blockOf(t)));
	check(`静态：${browserTools.length} 个浏览器工具都声明了 instance`, missingParam.length === 0, missingParam.join(","));
	check(`静态：${browserTools.length} 个浏览器工具都把 instance 传下去了`, missingForward.length === 0, missingForward.join(","));
	const localHasParam = localTools.filter((t) => /instance: INSTANCE_PARAM/.test(blockOf(t)));
	check("静态：本地工具（cleanup/audit/journal/sessions）不带 instance", localHasParam.length === 0, localHasParam.join(","));
	check("静态：instance 从不写进 params", !/params\.instance/.test(src));
}

/* 12 —— 扩展侧：身份落盘、hello 携带、改名不换 id */
{
	const { readFileSync } = await import("node:fs");
	const bg = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
	check("扩展：有身份加载与存量 id 复用（loadInstance）", /async function loadInstance\(/.test(bg));
	check("扩展：id 落 chrome.storage.local，且是一次性铸造", /INSTANCE_STORAGE_KEY/.test(bg) && /chrome\.storage\.local\.set/.test(bg));
	check("扩展：hello 帧带 instance", /type: 'hello'[\s\S]{0,400}instance:/.test(bg));
	check("扩展：改名只改 label，不重新铸 id", /async function setInstanceLabel\(/.test(bg) && /instance = \{ id: current\.id, label \}/.test(bg));
	check("扩展：改名在同一 socket 上重报 hello（不重连）", /instanceSetLabel[\s\S]{0,400}sendHello\(\)/.test(bg));

	const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
	const perms = manifest.permissions ?? [];
	check("扩展：身份不需要新权限（permissions 未变）",
		JSON.stringify(perms) === JSON.stringify(["debugger", "tabs", "tabGroups", "storage", "alarms"]), JSON.stringify(perms));
}

await new Promise((r) => setTimeout(r, 100));
console.log(fails === 0 ? "全部通过" : `${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);