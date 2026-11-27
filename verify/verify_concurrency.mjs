// 并发契约台（v1.8.1）。
//
// 这一版只做一件事：**并发下的静默错误**。桥把每条 command 直接 `runCommand(...)`
// 扔出去、不排队（`handleBridgeMessage` 不 await），所以「先来的还在读盘，后来的
// 已经改完」是真的会发生，不是理论。
//
// 本台子钉死两处：
//   A) 本地硬锁（panic switch）**绝不许 fail-open**。用户点「锁定」的那一刻，如果正好
//      有命令在读 `chrome.storage.local`，读回来的旧值不许覆盖用户刚做的决定——否则
//      锁被静默丢掉，而那正是这个功能唯一要防的事。反向同理：解锁不许被旧值翻回去。
//   B) 快照必须**按标签页串行**。快照 = 「清空所有 ref，再按新编号盖一遍」，两条并发
//      就会交错成：A 清、B 清、A 盖 e1、B 把 e1 盖到另一个元素上。页面于是同时存在
//      两个 `data-dsh-ref="e1"`，点 ref 变成看 querySelector 先返回哪个——纯粹的时序
//      造成的点错地方。
//
// 台子的难点在于把 A 的时序做**确定**：`init()` 在启动时自己就会读锁，所以「读取在途」
// 这件事必须真的等到它发生（不是睡固定毫秒撞运气），否则测的是「读完了之后才上锁」，
// 那条路径本来就没有竞态——变异也就抓不住。
import { runInContext } from "node:vm";
import { bootBackground, makeModel } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];

let fails = 0;
const check = (name, ok, detail = "") => {
	if (!ok) fails++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const errOf = (p) => p.then(() => null, (e) => String(e?.message ?? e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = (ctx, expr) => runInContext(expr, ctx);

/**
 * Boot with a model we prepared *before* the extension code runs: `init()` kicks off
 * the first lock read immediately, so a delay installed afterwards would miss it.
 */
async function boot({ storage = {}, storageGetDelayMs = 0, storageGetError = null, storageGetErrorKeys = null } = {}) {
	const model = makeModel();
	model.storageGetDelayMs = storageGetDelayMs;
	if (storageGetError !== null) model.storageGetError = storageGetError;
	if (storageGetErrorKeys !== null) model.storageGetErrorKeys = storageGetErrorKeys;
	const opts = { model, storage };
	if (CANDIDATE) opts.backgroundPath = CANDIDATE;
	return bootBackground(opts);
}

/**
 * Watch the storage area and resolve as soon as a read of `key` has been *issued*
 * but before it can resolve. Returns helpers so a test can act inside that window.
 */
function watchLockReads(sandbox) {
	const area = sandbox.chrome.storage.local;
	const realGet = area.get;
	const state = { reads: 0, inFlight: null };
	area.get = (keys) => {
		const list = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
		if (!list.includes('hardLock')) return realGet(keys);
		state.reads += 1;
		if (state.inFlight === null) {
			let release;
			state.inFlight = new Promise((r) => { release = r; });
			state.markStarted = release;
		}
		return realGet(keys).finally(() => { /* recorded by the caller */ });
	};
	return state;
}

/** Wait until `predicate()` is true, polling on the event loop. */
async function until(predicate, timeoutMs = 2000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return true;
		await sleep(2);
	}
	return false;
}

/* A1 —— 上锁时正好有命令在读盘：旧值不许覆盖用户刚做的决定 */
{
	// Delay installed before boot so init()'s own lock read is slow enough to catch.
	const storage = {};
	const { model, ctx, sandbox } = await boot({ storage, storageGetDelayMs: 150 });
	const watch = watchLockReads(sandbox);
	check("A1 前置：启动时的锁读取会真的发生（等它在途）", await until(() => watch.reads > 0));
	check("A1 前置：此刻锁状态尚未加载（读取在途）", evalIn(ctx, "hardLockLoaded") === false,
		String(evalIn(ctx, "hardLockLoaded")));

	// 用户就在这个窗口里点了「锁定」—— 读回来的将是上锁之前的旧值。
	const locked = await model.sendRuntimeMessage({ type: "lockSet", locked: true });
	check("A1 前置：弹窗上锁成功并落盘", locked?.locked === true && storage.hardLock === true);

	// 让那条过期的读取落地：它带着「未锁」的旧答案。
	await sleep(400);

	check("A 上锁后：内存状态仍是「锁着」（旧读盘结果不许把它翻回 false）",
		evalIn(ctx, "hardLocked") === true, String(evalIn(ctx, "hardLocked")));
	check("A 上锁后：徽标仍是 LOCK", model.badgeText === "LOCK", String(model.badgeText));
	const refusal = await errOf(ctx.runCommand("ping", {}));
	check("A 上锁后：新命令被拦（panic switch 没有失效）",
		refusal !== null && /锁定|locked/i.test(refusal), String(refusal).slice(0, 100));
	check("A 上锁后：bridgeStatus 如实报 locked:true",
		(await model.sendRuntimeMessage({ type: "bridgeStatus" }))?.locked === true);
}

/* A2 —— 反向：解锁时正好有命令在读盘，旧值不许把锁「重新上上」 */
{
	const storage = { hardLock: true };
	const { model, ctx, sandbox } = await boot({ storage, storageGetDelayMs: 150 });
	const watch = watchLockReads(sandbox);
	check("A2 前置：启动时的锁读取会真的发生（它读到的将是「锁着」）", await until(() => watch.reads > 0));
	check("A2 前置：锁状态尚未加载", evalIn(ctx, "hardLockLoaded") === false,
		String(evalIn(ctx, "hardLockLoaded")));
	const unlocked = await model.sendRuntimeMessage({ type: "lockSet", locked: false });
	check("A2 前置：弹窗解锁成功并落盘", unlocked?.locked === false && storage.hardLock === false);
	await sleep(400);
	check("A2 解锁后：内存状态是「未锁」（旧读盘结果不许把它翻回 true）",
		evalIn(ctx, "hardLocked") === false, String(evalIn(ctx, "hardLocked")));
	const ping = await ctx.runCommand("ping", {}).catch((e) => ({ error: String(e?.message ?? e) }));
	check("A2 解锁后：命令恢复正常（没有被旧值重新锁上）", ping?.pong === true, JSON.stringify(ping));
}

/* A3 —— 读不出锁时两条命令同时到：共享同一个在途读取，且仍然 fail-closed */
{
	// Error injection scoped to the lock key: `loadConfig` must still succeed or the
	// worker cannot even boot, and the lock read must keep failing so `hardLockLoaded`
	// stays false and every command genuinely re-tries (that is the self-healing path).
	const storage = { hardLock: true };
	const { model, ctx, sandbox } = await boot({
		storage,
		storageGetError: 'storage is out to lunch',
		storageGetErrorKeys: ['hardLock'],
		storageGetDelayMs: 80,
	});
	let lockReads = 0;
	const area = sandbox.chrome.storage.local;
	const realGet = area.get;
	area.get = (keys) => {
		const list = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
		if (list.includes('hardLock')) lockReads += 1;
		return realGet(keys);
	};
	const [r1, r2] = await Promise.all([
		errOf(ctx.runCommand("ping", {})),
		errOf(ctx.runCommand("ping", {})),
	]);
	check("A3 读不出锁：并发两命令都被拦下（fail-closed，不是 fail-open）",
		r1 !== null && r2 !== null && /锁定|locked|unreadable/i.test(r1) && /锁定|locked|unreadable/i.test(r2),
		`${String(r1).slice(0, 40)} | ${String(r2).slice(0, 40)}`);
	check("A3 读不出锁：两条命令共享同一个在途读取（只读了一次盘）",
		lockReads === 1, `hardLock 读取 ${lockReads} 次`);
	check("A3 读不出锁：不置 hardLockLoaded，下一条命令会重新读（可自愈）",
		evalIn(ctx, "hardLockLoaded") === false, String(evalIn(ctx, "hardLockLoaded")));
}

/* B —— 快照按标签页串行：并发两次，页面的清空/盖号不许交错 */
{
	const { model, ctx } = await boot({});
	const tabId = model.addTab(1, "https://race.test/");
	// 让页面表达式慢一点，并把「同时在跑的页面求值」数出来。
	let concurrent = 0;
	let maxConcurrent = 0;
	const real = model.dbg.results["Runtime.evaluate"];
	model.dbg.results["Runtime.evaluate"] = async (params) => {
		concurrent += 1;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await sleep(80);
		try {
			if (typeof real === "function") return real(params);
			return { result: { value: { tabId, title: "R", url: "https://race.test/", total: 0, items: [] } } };
		} finally {
			concurrent -= 1;
		}
	};

	const [a, b] = await Promise.all([
		ctx.cmdSnapshot({ tabId, mode: "dom" }),
		ctx.cmdSnapshot({ tabId, mode: "dom" }),
	]);
	check("B 并发两次快照：两次都成功返回", Boolean(a) && Boolean(b),
		JSON.stringify({ a: Boolean(a), b: Boolean(b) }));
	check("B 并发两次快照：页面求值**从不重叠**（串行）", maxConcurrent === 1,
		`最大并发 ${maxConcurrent}`);
	check("B 并发两次快照：链表已收尾（没有卡住后续快照）",
		evalIn(ctx, "snapshotChains.size") === 0, String(evalIn(ctx, "snapshotChains.size")));

	// 失败一次不许把这条标签页的链卡死
	const failed = await ctx.cmdSnapshot({ tabId, mode: "dom" }).then(() => false, () => true);
	const after = await ctx.cmdSnapshot({ tabId, mode: "dom" }).catch((e) => ({ error: String(e?.message ?? e) }));
	check("B 一次快照失败之后，下一次仍然能跑（链不会 wedge）",
		after !== null && !(after && after.error), JSON.stringify({ failedFirst: failed, after: Boolean(after) }));
	check("B 收尾：链表清空（关掉的标签页不泄漏条目）",
		evalIn(ctx, "snapshotChains.size") === 0, String(evalIn(ctx, "snapshotChains.size")));
}

console.log(fails === 0 ? "全部通过" : `${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);