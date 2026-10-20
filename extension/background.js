/**
 * DSH Browser Control — MV3 service worker.
 *
 * Maintains one outbound WebSocket to the local bridge (bridge/server.mjs),
 * receives JSON commands, executes them through chrome.tabs and the Chrome
 * DevTools Protocol (chrome.debugger), and replies with JSON results.
 *
 * Wire protocol (text frames, one JSON object each):
 *   ext -> bridge: {type:'hello', client, version, browser}
 *                  {type:'pong', t}                     (reply to {type:'ping'})
 *                  {type:'result', id, ok, result|error}
 *   bridge -> ext: {type:'ping', t}
 *                  {type:'command', id, command, params}
 */
'use strict';

const EXT_VERSION = chrome.runtime.getManifest().version;
/**
 * Wire protocol revision, independent of the app version: bumped only when the
 * frame contract changes (a command renamed, a payload reshaped). The bridge
 * compares it on `hello` so a version mismatch shows up as a line in the status
 * page instead of as "some commands mysteriously fail".
 */
const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_PORT = 9777;
const DEFAULT_TOKEN = 'dsh-local';

/** Stored config shape (version 2): {port, token, autoConnect}. */
const DEFAULT_CONFIG = Object.freeze({
	port: DEFAULT_PORT,
	token: DEFAULT_TOKEN,
	autoConnect: true,
});

let cfg = { ...DEFAULT_CONFIG };
let ws = null;
let wsState = 'idle'; // idle | connecting | open
let backoffAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let helloInfo = null;
let lastError = null;
/** True after the user clicks 断开连接 in the popup; blocks auto-reconnect
 *  until they click 立即连接 again. Reset on browser restart. */
let manualDisconnect = false;

/** Tab ids we hold a persistent debugger attachment on. Detach only on
 *  explicit disconnect, tab close, or DevTools stealing the tab. */
const attachedTabs = new Set();

/** Per-tab ring buffer of CDP `Runtime.consoleAPICalled` entries since attach.
 *  Map<tabId, Array<entry>>. Entries are capped at 500 per tab; older entries
 *  shift off. A new attach bumps the tab's generation so stale entries queued
 *  before re-attach are not surfaced as if they were current. */
const consoleLog = new Map();
/** Bumped on every re-attach so entries recorded against an old generation are
 *  dropped. Map<tabId, number>. */
const tabBufferGenerations = new Map();
/** Per-tab in-flight network entries keyed by `Network.requestId`; merged
 *  across `requestWillBeSent` / `responseReceived` / `loadingFinished` /
 *  `loadingFailed`. Map<tabId, Map<requestId, entry>>. */
const networkLog = new Map();

/**
 * Native dialog (alert/confirm/prompt) auto-answer policy. 'accept' answers
 * every dialog as OK (prompt uses defaultText), 'dismiss' cancels, 'manual'
 * leaves dialogs open. A command can pass params.dialogPolicy to override for
 * that call's duration; the default is accept so automation never deadlocks.
 */
let dialogPolicy = 'accept';
/** Dialogs answered since attach, surfaced in results for verification. */
const dialogLog = [];

/* ------------------------------------------------------------------ config */

async function loadConfig() {
	const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
	// v1→v2 migration: convert old serverUrl to port.
	if (stored.serverUrl && stored.port === undefined) {
		try {
			stored.port = new URL(stored.serverUrl).port ? Number(new URL(stored.serverUrl).port) : DEFAULT_PORT;
		} catch { stored.port = DEFAULT_PORT; }
		delete stored.serverUrl;
	}
	cfg = { ...DEFAULT_CONFIG, ...stored };
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	for (const [key, change] of Object.entries(changes)) {
		if (key in DEFAULT_CONFIG) cfg[key] = change.newValue;
	}
});

/* ------------------------------------------------------------ ws lifecycle */

function setBadge(text, color) {
	try {
		chrome.action.setBadgeBackgroundColor({ color });
		chrome.action.setBadgeText({ text });
	} catch (err) {
		console.warn('[dsh-bridge] badge unavailable:', err.message);
	}
}

function setState(state) {
	wsState = state;
	// While the local lock is on it owns the badge: "connected but frozen" must
	// not look like a healthy green ON.
	if (hardLocked) { setBadge('LOCK', '#dc2626'); return; }
	if (state === 'open') setBadge('ON', '#16a34a');
	else if (state === 'connecting') setBadge('…', '#d97706');
	else setBadge('OFF', '#6b7280');
}

function send(obj) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(obj));
	return true;
}

function scheduleReconnect() {
	if (manualDisconnect || !cfg.autoConnect) return;
	const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** backoffAttempt);
	backoffAttempt += 1;
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, delay);
}

function connect() {
	if (wsState === 'open' || wsState === 'connecting') return;
	clearTimeout(reconnectTimer);
	if (manualDisconnect || !cfg.autoConnect) return;

	let url;
	try {
		url = new URL(`ws://127.0.0.1:${cfg.port}/ws`);
	} catch (err) {
		lastError = `端口无法解析: ${err.message}`;
		setState('idle');
		return;
	}
	url.searchParams.set('token', cfg.token);

	setState('connecting');
	let sock;
	try {
		sock = new WebSocket(url.toString());
	} catch (err) {
		lastError = err.message;
		setState('idle');
		scheduleReconnect();
		return;
	}
	ws = sock;

	sock.onopen = () => {
		if (sock !== ws) return;
		backoffAttempt = 0;
		lastError = null;
		setState('open');
		startHeartbeat();
		sendHello();
	};
	sock.onmessage = (ev) => {
		if (sock !== ws || typeof ev.data !== 'string') return;
		let msg;
		try { msg = JSON.parse(ev.data); } catch { return; }
		handleBridgeMessage(msg);
	};
	sock.onclose = () => {
		if (sock !== ws) return;
		stopHeartbeat();
		ws = null;
		setState('idle');
		scheduleReconnect();
	};
	sock.onerror = () => { /* onclose always follows */ };
}

function disconnectNow() {
	clearTimeout(reconnectTimer);
	stopHeartbeat();
	if (ws) {
		const sock = ws;
		ws = null;
		sock.onclose = null;
		try { sock.close(); } catch { /* ignore */ }
	}
	detachAll();
	setState('idle');
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), HEARTBEAT_MS);
}

function stopHeartbeat() {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function sendHello() {
	const ua = navigator.userAgent;
	const name = /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : 'chromium';
	const versionMatch = ua.match(/(?:Edg|Chrome)\/([\d.]+)/);
	helloInfo = { name, version: versionMatch ? versionMatch[1] : 'unknown', ua };
	send({ type: 'hello', client: 'dsh-browser-extension', version: EXT_VERSION, protocol: PROTOCOL_VERSION, browser: helloInfo });
}

/* Alarm keeps the SW alive for reconnect even without user events. */
try { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); }
catch { chrome.alarms.create('keepalive', { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== 'keepalive') return;
	if (wsState === 'idle') connect();
	else send({ type: 'ping', t: Date.now() });
});

/* ------------------------------------------------------------- local lock */

/**
 * Local hard lock ("panic switch"): while on, every command from the bridge is
 * refused before it reaches a handler, and the WebSocket stays connected — so a
 * caller sees "reachable but frozen" instead of a dead link it might retry.
 *
 * Only the popup can toggle it, and that is structural rather than a promise:
 * the bridge speaks over the WebSocket, while this gate is set through a
 * `chrome.runtime` message, which only an extension page can post (the manifest
 * declares no `externally_connectable`). Nothing on the bridge side unlocks it.
 *
 * The flag is persisted in chrome.storage.local because MV3 evicts the service
 * worker after ~30s idle: an in-memory flag would silently lapse between two
 * commands, which is the one failure mode a panic switch cannot have.
 */
const HARD_LOCK_KEY = 'hardLock';
let hardLocked = false;
let hardLockLoaded = false;

/** Read the persisted flag once per worker lifetime. */
async function syncHardLock() {
	if (hardLockLoaded) return;
	try {
		const stored = await chrome.storage.local.get([HARD_LOCK_KEY]);
		hardLocked = stored[HARD_LOCK_KEY] === true;
	} catch (err) {
		// Reading the flag failed: stay open, but say so instead of pretending.
		lastError = `读取本地锁失败: ${err.message}`;
	}
	hardLockLoaded = true;
	// A worker that came back after eviction has not painted the badge yet; do it
	// now so "locked" is visible before the first command rather than after it.
	if (hardLocked) setState(wsState);
}

/** Persist and apply the lock; called only from the popup message handler. */
async function setHardLock(locked) {
	hardLocked = Boolean(locked);
	hardLockLoaded = true;
	await chrome.storage.local.set({ [HARD_LOCK_KEY]: hardLocked });
	setState(wsState);
	return hardLocked;
}

/** Refusal text the agent actually reads; it must say who can undo this. */
function hardLockRefusal(command) {
	return `本机扩展已被用户锁定：命令 ${command} 被拦下，没有向浏览器发出任何操作。`
		+ `解锁只能由用户在浏览器工具栏的扩展弹窗里点「已锁定」完成；在那之前请先与用户确认，不要重试。`;
}

/* ------------------------------------------------------------- dispatching */

function handleBridgeMessage(msg) {
	if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
	if (msg.type === 'command' && typeof msg.id === 'string') {
		runCommand(msg.command, msg.params ?? {})
			.then((result) => send({ type: 'result', id: msg.id, ok: true, result }))
			.catch((err) => send({ type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }));
	}
}

async function runCommand(command, params) {
	await syncHardLock();
	if (hardLocked) throw new Error(hardLockRefusal(command));
	const handler = COMMANDS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	return handler(params);
}

/* ------------------------------------------------------------ tab helpers */

async function resolveTab(tabId) {
	if (tabId !== undefined && tabId !== null) {
		const tab = await chrome.tabs.get(tabId);
		return tab;
	}
	const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (focused) return focused;
	const all = await chrome.tabs.query({});
	if (all.length > 0) return all[0];
	throw new Error('no tab available');
}

/**
 * Wait until the navigation that is about to start has actually settled, and
 * say whether it did.
 *
 * Two mistakes this avoids, both of which let `nav` / `tabs.open` report a
 * settled page that was not there:
 *   - arming the listener AFTER `tabs.update` / `tabs.create` races the
 *     document swap: the tab still answers `status:'complete'` for the PREVIOUS
 *     document (a brand-new tab answers `complete` for about:blank), so a single
 *     `chrome.tabs.get` resolves the wait instantly against the old page;
 *   - a timeout that resolves silently is indistinguishable from success.
 * So: poll, insist on having seen the new document load (`status:'loading'`),
 * and report the outcome — `false` means the budget ran out while the new
 * document was still not in place.
 */
/** 比较目的地与真正落到的地址：忽略 hash 片段与末尾斜杠这类同文档差异。 */
function landsAt(tabUrl, expectedUrl) {
	if (typeof expectedUrl !== 'string' || expectedUrl.length === 0) return true;
	const norm = (u) => String(u ?? '').replace(/#.*$/, '').replace(/\/$/, '');
	return norm(tabUrl) === norm(expectedUrl);
}

function waitForNavigationComplete(tabId, timeoutMs, expectedUrl) {
	const started = Date.now();
	return new Promise((resolve) => {
		let sawLoading = false;
		const tick = async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			if (tab) {
				if (tab.status === 'loading') sawLoading = true;
				else if (tab.status === 'complete') {
					if (sawLoading) return resolve(true);
					// No loading phase observed at all. Two very different things look
					// like this: the new document committed so fast we never polled a
					// loading state, and a navigation that never happened (a link that
					// turned into a download, a target Chrome refuses, a same-URL
					// no-op). The URL separates them — if the tab is not where we asked
					// it to be, nothing arrived and the caller must not say otherwise.
					if (Date.now() - started > 1200) return resolve(landsAt(tab.url, expectedUrl));
				}
			}
			if (Date.now() - started >= timeoutMs) return resolve(false);
			setTimeout(tick, 120);
		};
		void tick();
	});
}

/**
 * Await `promise`, but never longer than `ms`; resolve `fallback` on timeout or
 * rejection. CDP does not answer `Runtime.evaluate` while a navigation is stuck
 * before commit, so the post-navigation probes must not be able to outlive the
 * caller's budget (measured: an unbounded probe left `nav` unanswered for >40 s
 * while its own wait budget was 15 s).
 */
function withBudget(promise, ms, fallback) {
	return Promise.race([
		promise.catch(() => fallback),
		new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

/** Bring the tab and its window forward so real input can land, WITHOUT
 *  touching window geometry: `focused` only raises the window; tab activation
 *  never moves or resizes anything. The user's window size/position/state
 *  (maximized included) is never modified. A minimized window keeps its 0x0
 *  viewport where real input cannot land — report that instead of
 *  force-restoring it (state:'normal' would also un-maximize the window). */
async function activateTabWindow(tabId) {
	let win;
	try {
		const tab = await chrome.tabs.get(tabId);
		win = await chrome.windows.get(tab.windowId);
	} catch {
		return; // tab or window is closing; the command reports it downstream
	}
	if (win.state === 'minimized') {
		const err = new Error('browser window is minimized — real keyboard/mouse input cannot reach a 0x0 viewport; restore the window manually (automation never changes window size or position)');
		err.code = 'window_minimized';
		throw err;
	}
	try {
		await chrome.windows.update(win.id, { focused: true });
		await chrome.tabs.update(tabId, { active: true });
	} catch { /* tab may be closing; input will fail downstream anyway */ }
}

/* ---------------------------------------------------------- debugger (CDP) — persistent attachment */

/**
 * Ensure a persistent debugger attachment on `tabId`. Attaches once on first
 * CDP call and holds the attachment until explicit detach or tab close.
 * The Chrome "is being controlled" banner stays visible until detach.
 */
async function ensureAttached(tabId) {
	if (attachedTabs.has(tabId)) return;
	await new Promise((resolve, reject) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			const err = chrome.runtime.lastError;
			if (!err) { attachedTabs.add(tabId); resolve(); return; }
			if (/already attached/i.test(err.message)) {
				attachedTabs.add(tabId);
				resolve();
				return;
			}
			reject(new Error(`debugger attach failed: ${err.message} (DevTools 打开着这个页面? 先关掉)`));
		});
	});
	// Enable the domains whose events we consume (dialogs, navigation results,
	// console + network capture for the browser_console_log / browser_network_log tools).
	await dbgSend(tabId, 'Page.enable').catch(() => {});
	await dbgSend(tabId, 'Runtime.enable').catch(() => {});
	await dbgSend(tabId, 'Network.enable').catch(() => {});
	// Bump the per-attached-tab generation so in-flight network entries queued
	// against an old attachment are not surfaced as if they were current.
	tabBufferGenerations.set(tabId, (tabBufferGenerations.get(tabId) ?? 0) + 1);
}

/* Native dialog auto-answer: fires whenever the page opens alert/confirm/
 * prompt/beforeunload while a debugger is attached. Without an answer the
 * page's main thread stays blocked forever. */
chrome.debugger.onEvent.addListener((source, method, params) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	if (method === 'Page.javascriptDialogOpening') {
		const entry = {
			tabId, type: params.type, message: params.message,
			defaultPrompt: params.defaultPrompt, answeredAs: dialogPolicy, t: Date.now(),
		};
		dialogLog.push(entry);
		if (dialogLog.length > 50) dialogLog.shift();
		if (dialogPolicy === 'manual') return;
		chrome.debugger.sendCommand(
			{ tabId },
			'Page.handleJavaScriptDialog',
			{ accept: dialogPolicy === 'accept', promptText: params.defaultPrompt },
			() => void chrome.runtime.lastError,
		);
		return;
	}
	if (method === 'Runtime.consoleAPICalled') {
		// Skip the noisy "log-type:verbose / "time-start" pseudo entries.
		const level = (params.type || 'log').toLowerCase();
		if (level === 'verbose' || level === 'timeStart' || level === 'timeEnd') return;
		const text = (params.args || []).map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || '')).join(' ');
		let location;
		if (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) {
			const f = params.stackTrace.callFrames[0];
			location = `${f.url || '<inline>'}:${f.lineNumber}`;
		}
		const entry = { tabId, level, text, t: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now() };
		if (location) entry.location = location;
		const buf = consoleLog.get(tabId) || [];
		buf.push(entry);
		if (buf.length > 500) buf.shift();
		consoleLog.set(tabId, buf);
		return;
	}
	if (method === 'Network.requestWillBeSent') {
		// requestId from CDP; one per request. Key under the tab; the body is
		// capped at 64KB to keep the buffer from blowing up on large POSTs.
		const POST_LIMIT = 64 * 1024;
		const post = params.request.postData;
		const entry = {
			tabId,
			requestId: params.requestId,
			method: params.request.method,
			url: params.request.url,
			headers: params.request.headers,
			resourceType: params.type,
			postData: typeof post === 'string' && post.length > POST_LIMIT ? post.slice(0, POST_LIMIT) + '…(truncated)' : post,
			initiator: params.initiator && params.initiator.url,
			wallTime: params.wallTime,
		};
		let tabMap = networkLog.get(tabId);
		if (!tabMap) { tabMap = new Map(); networkLog.set(tabId, tabMap); }
		tabMap.set(params.requestId, entry);
		trimNetworkMap(tabMap);
		return;
	}
	if (method === 'Network.responseReceived') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.status = params.response.status;
		entry.statusText = params.response.statusText;
		entry.mimeType = params.response.mimeType;
		entry.responseHeaders = params.response.headers;
		return;
	}
	if (method === 'Network.loadingFinished') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.encodedDataLength = params.encodedDataLength;
		entry.finished = true;
		return;
	}
	if (method === 'Network.loadingFailed') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.failed = true;
		entry.errorText = params.errorText;
		entry.canceled = params.canceled;
		return;
	}
});

/** Cap a per-tab request map at 500 entries (LRU-by-insertion-order). */
function trimNetworkMap(tabMap) {
	if (tabMap.size <= 500) return;
	const overflow = tabMap.size - 500;
	const keys = tabMap.keys();
	for (let i = 0; i < overflow; i++) tabMap.delete(keys.next().value);
}

/** Drop every per-tab attachment artifact WITHOUT issuing a chrome.debugger
 *  call — safe to run from inside onDetach, where detaching again would be
 *  redundant. Deleting an unknown tabId is a no-op. */
function clearAttachment(tabId) {
	attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	tabBufferGenerations.delete(tabId);
}

function detachTab(tabId) {
	clearAttachment(tabId);
	chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

function detachAll() {
	for (const tabId of [...attachedTabs]) detachTab(tabId);
}

/* Clean up when a tab is closed (detaches automatically, but remove from set). */
chrome.tabs.onRemoved.addListener((tabId) => {
	clearAttachment(tabId);
});

/* Invalidate the attachment cache whenever the debugger detaches, for ANY
 * reason. The cache is the only thing standing between an unexpected detach
 * (DevTools opened on the tab, a chrome-extension:// page, a navigation race)
 * and a clean re-attach: ensureAttached() returns early on a cache hit, so a
 * stale entry makes every later command fail with "Debugger is not attached"
 * forever. tabs.onRemoved also calls clearAttachment, so tab closures are
 * covered twice — harmless, the operation is idempotent. */
chrome.debugger.onDetach.addListener((source) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	clearAttachment(tabId);
});

/* Chrome reports a lost CDP session with one of these wordings. The cache can
 * still say "attached" when the detach event was missed (service-worker
 * restart, a race with DevTools), so dbgSend treats them as a cache-invalidating
 * signal and lets withCDP transparently re-attach once.
 *
 * "Cannot access a chrome-extension:// URL" is deliberately NOT in this list.
 * It belongs to the ATTACH path, not the send path: the observed form on a real
 * machine is "debugger attach failed: Cannot access a chrome-extension:// URL of
 * different extension", raised by chrome.debugger.attach() for a sibling
 * extension's page. chrome.debugger.sendCommand() has not been seen to produce
 * it, and a restricted target refuses attach permanently rather than
 * transiently, so treating it as a lost session would only buy one doomed
 * re-attach before the same error surfaced anyway. */
const DETACHED_RE = /not attached|Detached while handling|Inspected target navigated or closed/i;

function dbgSend(tabId, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
			const err = chrome.runtime.lastError;
			if (!err) { resolve(res); return; }
			if (DETACHED_RE.test(err.message)) {
				// The cached entry is lying; drop it so the retry re-attaches.
				clearAttachment(tabId);
				const stale = new Error(`${method} failed: ${err.message}`);
				stale.code = 'cdp_detached';
				reject(stale);
				return;
			}
			reject(new Error(`${method} failed: ${err.message}`));
		});
	});
}

/** Persistent CDP: attaches (if not already) and holds. A command whose session
 *  was lost mid-flight re-attaches ONCE and replays — turning the old "detached
 *  means this tab is dead forever" behavior into a single transparent retry.
 *  A second failure propagates to the caller.
 *
 *  The replay is deliberately narrow: it happens ONLY when the first CDP call of
 *  the closure is the one that failed. Every later call means side effects have
 *  already landed on the page, so re-running the closure would fire them twice.
 *  That is not hypothetical — measured against a stubbed chrome.* on this repo,
 *  cmdClick's closure is evaluate(geometry) -> mouseMoved -> mousePressed ->
 *  mouseReleased, and replaying it after a detach on mouseReleased dispatched 6
 *  mouse events instead of 3, i.e. a second click reaching the page. cmdInput's
 *  mode:'type' is worse: each character is its own insertText, so a replay
 *  re-types part of the string. Single-shot read commands (browser_read,
 *  browser_snapshot) are idempotent and unaffected either way.
 *
 *  When the failure is NOT the first call the error is re-thrown untouched, and
 *  the caller re-issues the whole command. Semantically that is a NEW command,
 *  not a replay, which is the correct thing to ask of whoever wanted it. */
async function withCDP(tabId, fn) {
	let sends = 0;
	const call = (method, params) => { sends++; return dbgSend(tabId, method, params); };
	await ensureAttached(tabId);
	const started = sends;
	try {
		return await fn(call);
	} catch (error) {
		if (error?.code !== 'cdp_detached' || sends > started + 1) throw error;
		await ensureAttached(tabId);
		return fn(call);
	}
}

/* ------------------------------------------------------- command handlers */

async function cmdPing() {
	return { pong: true, t: Date.now(), version: EXT_VERSION };
}

/**
 * Return the recorded `Runtime.consoleAPICalled` entries for a tab. Filters
 * apply client-side so the model only sees the rows it asked for. `clear`
 * empties the buffer on the same call so the next call starts fresh; useful
 * for "give me the warnings that appeared after I clicked submit" without
 * earlier noise. `limit` defaults to 100, capped at 500.
 */
async function cmdConsoleLog(params) {
	const tab = await resolveTab(params.tabId);
	const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
	const levels = Array.isArray(params.levels) && params.levels.length > 0
		? new Set(params.levels.map((l) => String(l).toLowerCase()))
		: null;
	const pattern = typeof params.pattern === 'string' && params.pattern.length > 0
		? new RegExp(params.pattern, 'i')
		: null;
	const buf = consoleLog.get(tab.id) || [];
	const filtered = buf.filter((e) => {
		if (levels && !levels.has(e.level)) return false;
		if (pattern && !pattern.test(e.text || '')) return false;
		return true;
	});
	const tail = filtered.slice(-limit);
	if (params.clear === true) consoleLog.set(tab.id, []);
	return { tabId: tab.id, count: tail.length, total: filtered.length, entries: tail };
}

/**
 * Return merged request/response entries captured by `Network.*` events.
 * `includeStatic: true` surfaces images / fonts / stylesheets / scripts that
 * are filtered by default (they dominate the buffer in a typical page load).
 * `methodPattern` / `urlPattern` / `status` filter client-side.
 */
async function cmdNetworkLog(params) {
	const tab = await resolveTab(params.tabId);
	const tabMap = networkLog.get(tab.id);
	const all = tabMap ? [...tabMap.values()] : [];
	const includeStatic = params.includeStatic === true;
	const methodPattern = typeof params.methodPattern === 'string' && params.methodPattern.length > 0
		? new RegExp(params.methodPattern, 'i')
		: null;
	const urlPattern = typeof params.urlPattern === 'string' && params.urlPattern.length > 0
		? new RegExp(params.urlPattern, 'i')
		: null;
	const statusFilter = typeof params.status === 'string' && params.status.length > 0 ? params.status : null;
	const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Favicon', 'Manifest']);
	const filtered = all.filter((e) => {
		if (!includeStatic && staticTypes.has(e.resourceType)) return false;
		if (methodPattern && !methodPattern.test(e.method || '')) return false;
		if (urlPattern && !urlPattern.test(e.url || '')) return false;
		if (statusFilter) {
			if (e.failed) {
				if (!/^f/i.test(statusFilter)) return false;
			} else if (e.status === undefined) {
				if (!/^p/i.test(statusFilter)) return false; // pending
			} else if (statusFilter === '2xx' && (e.status < 200 || e.status >= 300)) return false;
			else if (statusFilter === '3xx' && (e.status < 300 || e.status >= 400)) return false;
			else if (statusFilter === '4xx' && (e.status < 400 || e.status >= 500)) return false;
			else if (statusFilter === '5xx' && (e.status < 500 || e.status >= 600)) return false;
		}
		return true;
	});
	filtered.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));
	const limit = Math.min(1000, Math.max(1, Number(params.limit) || 200));
	const out = filtered.slice(-limit).map((e) => {
		const { requestId: _id, tabId: _t, ...rest } = e;
		return rest;
	});
	if (params.clear === true) networkLog.set(tab.id, new Map());
	return { tabId: tab.id, count: out.length, total: filtered.length, requests: out };
}

async function cmdNetworkClear(params) {
	const tab = await resolveTab(params.tabId);
	networkLog.set(tab.id, new Map());
	return { tabId: tab.id, cleared: true };
}

/**
 * `Page.printToPDF` returns base64-encoded PDF. The extension's MV3 SW cannot
 * write to absolute paths on the host; the bridge decodes the base64 to a
 * `path` the caller supplies (or to `<shotsDir>/<tabId>-<t>.pdf` when no path
 * is given). The result echoes the saved path + size so callers can hand it
 * off to a reader tool.
 */
async function cmdPdf(params) {
	const tab = await resolveTab(params.tabId);
	return withCDP(tab.id, async (send) => {
		const cdpParams = {
			printBackground: params.printBackground !== false,
			landscape: params.landscape === true,
			...(typeof params.paperWidth === 'number' ? { paperWidth: params.paperWidth } : {}),
			...(typeof params.paperHeight === 'number' ? { paperHeight: params.paperHeight } : {}),
			...(typeof params.scale === 'number' ? { scale: params.scale } : {}),
			...(params.pageRanges ? { pageRanges: String(params.pageRanges) } : {}),
		};
		const res = await send('Page.printToPDF', cdpParams);
		if (!res || !res.data) throw new Error('Page.printToPDF returned no data');
		return { tabId: tab.id, base64: res.data };
	});
}

/**
 * Apply `Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` +
 * `setTouchEmulationEnabled` to switch how the page renders. Presets cover
 * the common shapes (desktop / iphone / ipad / pixel); a custom object
 * overrides any field. Restoring back to desktop is `device:"reset"` so
 * the agent can clean up after itself.
 */
async function cmdEmulate(params) {
	const tab = await resolveTab(params.tabId);
	const preset = params.device && params.device !== 'reset' ? PRESETS[String(params.device).toLowerCase()] : null;
	if (params.device && params.device !== 'reset' && !preset && typeof params.device === 'string') {
		throw new Error(`unknown device preset "${params.device}". Use one of: ${Object.keys(PRESETS).join(', ')}, reset, or pass width/height fields directly.`);
	}
	const width = Number(params.width ?? (preset && preset.width) ?? 0);
	const height = Number(params.height ?? (preset && preset.height) ?? 0);
	const deviceScaleFactor = Number(params.deviceScaleFactor ?? (preset && preset.deviceScaleFactor) ?? 1);
	const isMobile = params.isMobile ?? (preset && preset.isMobile) ?? false;
	const hasTouch = params.hasTouch ?? (preset && preset.hasTouch) ?? false;
	const userAgent = params.userAgent || (preset && preset.userAgent) || undefined;
	return withCDP(tab.id, async (send) => {
		if (params.device === 'reset') {
			await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
			await send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
			await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
			return { tabId: tab.id, reset: true };
		}
		if (width > 0 && height > 0) {
			await send('Emulation.setDeviceMetricsOverride', {
				width, height, deviceScaleFactor, mobile: isMobile,
			}).catch((e) => { throw new Error(`setDeviceMetricsOverride failed: ${e.message}`); });
		}
		if (userAgent) {
			await send('Emulation.setUserAgentOverride', { userAgent }).catch(() => {});
		}
		await send('Emulation.setTouchEmulationEnabled', { enabled: hasTouch }).catch(() => {});
		return {
			tabId: tab.id,
			width, height, deviceScaleFactor, isMobile, hasTouch,
			userAgent: userAgent || null,
		};
	});
}

const PRESETS = {
	desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: '' },
	'mobile-iphone-13': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
	'mobile-pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
	'tablet-ipad': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
};

async function cmdBrowserInfo() {
	return { client: 'dsh-browser-extension', version: EXT_VERSION, browser: helloInfo };
}

async function cmdTabsList() {
	const tabs = await chrome.tabs.query({});
	// Compact shape (id/url/active/title only): the bridge serializes this
	// straight into a tool result and wide shapes were truncating mid-JSON.
	return {
		count: tabs.length,
		activeTabId: tabs.find((t) => t.active)?.id,
		tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
	};
}

/* ------------------------------------------------------ agent tab grouping */

/**
 * Tabs the agent opens get collected into one labelled, coloured group per
 * window, so a human can see at a glance which tabs a machine is driving and
 * sweep them away afterwards. Grouping straight after `tabs.create` races
 * Chrome's own tab bookkeeping, hence the short backoff.
 */
const AGENT_GROUP_TITLE = 'DSH';
const AGENT_GROUP_COLOR = 'blue';
const GROUP_RETRY_DELAYS_MS = [50, 150, 400];

/** windowId -> groupId, rebuilt from the title after a service-worker restart. */
const agentGroupsByWindow = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tabGroupsAvailable() {
	return typeof chrome.tabGroups?.update === 'function' && typeof chrome.tabs?.group === 'function';
}

async function findAgentGroup(windowId) {
	const cached = agentGroupsByWindow.get(windowId);
	if (cached !== undefined) {
		// A cached id goes stale when the user ungroups it or closes its last tab.
		const live = await chrome.tabGroups.get(cached).catch(() => null);
		if (live !== null) return cached;
		agentGroupsByWindow.delete(windowId);
	}
	const titled = await chrome.tabGroups.query({ title: AGENT_GROUP_TITLE, windowId }).catch(() => []);
	const found = titled[0]?.id;
	if (found !== undefined) agentGroupsByWindow.set(windowId, found);
	return found;
}

/** Put one tab in the window's agent group, creating the group if needed. */
async function addToAgentGroup(tabId) {
	if (!tabGroupsAvailable()) {
		return { grouped: false, reason: 'tabGroups API 不可用（需 Chrome ≥ 89 且已授予 tabGroups 权限）' };
	}
	let lastError = 'unknown';
	for (let attempt = 0; attempt <= GROUP_RETRY_DELAYS_MS.length; attempt += 1) {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab === null || tab.windowId === undefined) return { grouped: false, reason: '标签页已不存在' };
		try {
			const existing = await findAgentGroup(tab.windowId);
			if (existing !== undefined) {
				await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
				return { grouped: true, groupId: existing, created: false };
			}
			const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
			await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: AGENT_GROUP_COLOR });
			agentGroupsByWindow.set(tab.windowId, groupId);
			return { grouped: true, groupId, created: true };
		} catch (error) {
			lastError = error?.message ?? String(error);
			agentGroupsByWindow.delete(tab.windowId);
			const wait = GROUP_RETRY_DELAYS_MS[attempt];
			if (wait === undefined) break;
			await sleep(wait);
		}
	}
	return { grouped: false, reason: lastError };
}

/** Release every agent group (one window, or all) back to plain tabs. */
async function dissolveAgentGroups(windowId) {
	if (!tabGroupsAvailable()) return { ungrouped: 0, groups: 0, reason: 'tabGroups API 不可用' };
	const wanted = windowId === undefined
		? { title: AGENT_GROUP_TITLE }
		: { title: AGENT_GROUP_TITLE, windowId: Number(windowId) };
	const groups = await chrome.tabGroups.query(wanted).catch(() => []);
	let ungrouped = 0;
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map((t) => t.id).filter((id) => id !== undefined);
		if (ids.length === 0) continue;
		try {
			await chrome.tabs.ungroup(ids);
			ungrouped += ids.length;
		} catch { /* 用户可能已经手动拆开了 */ }
	}
	agentGroupsByWindow.clear();
	return { ungrouped, groups: groups.length };
}

async function cmdTabGroup(params) {
	if (params?.tabId === undefined) throw new Error('params.tabId is required');
	const result = await addToAgentGroup(Number(params.tabId));
	if (result.grouped !== true) throw new Error(`group failed: ${result.reason}`);
	return { tabId: Number(params.tabId), ...result };
}

async function cmdTabUngroup(params) {
	return dissolveAgentGroups(params?.windowId);
}

async function cmdTabsOpen(params) {
	if (!params.url) throw new Error('params.url is required');
	const created = await chrome.tabs.create({
		url: params.url,
		active: params.active !== undefined ? Boolean(params.active) : true,
	});
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter before the tab starts loading: a created tab is born on
	// about:blank and reports `complete` immediately, so a waiter armed
	// afterwards can conclude "already settled" while the requested URL has not
	// even started.
	const settled = params.wait === false ? true : await waitForNavigationComplete(created.id, timeoutMs, params.url);
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
// A pending navigation is not visible in `url` (a tab that has not committed
	// anything yet reports an empty url); `pendingUrl` is where it is heading.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh.url ? fresh.pendingUrl : undefined;
	// 归组失败不该让「打开标签」这件事失败，只把结果带回去。
	const group = params.group === false ? { grouped: false, reason: 'group:false' } : await addToAgentGroup(created.id);
	return {
		tabId: created.id,
		url: fresh?.url,
		title: fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(settled === true ? {} : { loadPending: true }),
		...group,
	};
}

/** 这个 id 现在还在不在。关闭前先问一次，是为了不让「已经没了」把整批连坐。 */
async function tabStillThere(tabId) {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

/**
 * 一句给人/模型看的失败文案。跨 realm 抛来的 Error（`instanceof Error` 为假，
 * 例如从注入上下文或 chrome API 代理里冒出来的）也要认出它的 `message`，
 * 否则文案会变成 `Error: <原因>` 这种带前缀的二手货。
 */
function failureText(error) {
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message);
	return String(error);
}

/**
 * 关闭一个或多个标签页，并把**每个 id** 的去向报清楚。
 *
 * 为什么不允许「第一个失败就抛出」：关标签是有副作用的写操作，前面的 id 可能
 * 已经真的关掉了。只回一句错误，模型会以为什么都没发生，然后重放整批；而
 * `effectState` 那套（errors.ts）对写操作的底线正是「不许把已发生的副作用藏起来」。
 * 所以这里收齐 `closed` / `alreadyGone` / `failed`，并且**不猜**：调用
 * `chrome.tabs.remove` 之后逐个复查，还在的才算 failed。
 *
 * `alreadyGone` 是幂等成功，不是错误 —— 这样重试是安全的。
 */
async function cmdTabsCloseMany(params) {
	const raw = Array.isArray(params.tabIds) ? params.tabIds : [];
	const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
	if (ids.length === 0) throw new Error('params.tabIds must be a non-empty array of tab ids');
	const present = [];
	const alreadyGone = [];
	for (const id of ids) (await tabStillThere(id)) ? present.push(id) : alreadyGone.push(id);
	let report = null;
	if (present.length > 0) {
		try {
			// 一次调用、数组形态：一批标签在链路上是一条命令、一份超时预算。
			await chrome.tabs.remove(present);
		} catch (error) {
			report = failureText(error);
		}
	}
	const closed = [];
	const failed = [];
	for (const id of present) {
		if (await tabStillThere(id)) failed.push({ tabId: id, error: report ?? 'tabs.remove resolved but the tab is still open' });
		else closed.push(id);
	}
	return { requested: ids.length, closed, alreadyGone, failed };
}

async function cmdTabsClose(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	return cmdTabsCloseMany({ tabIds: [Number(params.tabId)] });
}

async function cmdTabsActivate(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	await chrome.tabs.update(Number(params.tabId), { active: true });
	return { activated: Number(params.tabId) };
}

async function cmdNav(params) {
	if (!params.url) throw new Error('params.url is required');
	const tab = await resolveTab(params.tabId);
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter BEFORE triggering the navigation — see
	// waitForNavigationComplete for why the order decides the answer.
	const settling = params.wait === false ? Promise.resolve(true) : waitForNavigationComplete(tab.id, timeoutMs, params.url);
	await chrome.tabs.update(tab.id, { url: params.url });
	const settled = await settling;
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally. Both probes
	// are budgeted: CDP stays silent while a navigation is stuck before commit,
	// and an unbounded await there outlives the command's own timeout.
	const landedUrl = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: 'location.href', awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((r) => String(r.result?.value ?? ''))), 2000, '');
	let siteUnreachable;
	if (/^chrome-error:/.test(landedUrl)) {
		const errText = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? ''))), 2000, '');
		// Error-page copy is localized (zh-CN shows 无法找到 … 的 DNS 地址,
		// en-US shows ERR_NAME_NOT_RESOLVED); match either plus any bare DNS
		// mention such as DNS_PROBE_STARTED.
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\bDNS\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
	}
	// While a navigation is pending, `url` is still the OLD document (or empty for
	// a tab that has not committed anything yet) and the destination only exists
	// in `pendingUrl` — report it so "still going to X" is visible.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh?.url ? fresh.pendingUrl : undefined;
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(siteUnreachable ? { siteUnreachable } : {}),
		// A timed-out wait must never read as "the page is there": loadPending
		// says the new document was still not in place when the budget ran out.
		...(siteUnreachable === undefined && settled !== true ? { loadPending: true } : {}),
	};
}

async function cmdEval(params) {
	if (typeof params.expression !== 'string' || params.expression.length === 0) {
		throw new Error('params.expression is required');
	}
	const tab = await resolveTab(params.tabId);
	// Frame targeting: params.frameSelector (CSS selector of an <iframe>) runs
	// the expression inside that frame via contentDocument (same-origin).
	// Cross-origin frames need a separate debugger target — reported clearly.
	let expression = params.expression;
	if (Array.isArray(params.argNames) && Array.isArray(params.args)
		&& params.argNames.length === params.args.length && params.argNames.length > 0) {
		const argValues = params.args.map((a) => JSON.stringify(a)).join(', ');
		expression = `((${params.argNames.join(', ')}) => { ${params.expression} })(${argValues})`;
	}
	if (params.frameSelector) {
		const inner = expression.startsWith('(') ? expression : `(() => { ${expression} })()`;
		// Rebind document/window to the frame by passing them as parameters of
		// the wrapping arrow — parameter shadowing, no TDZ hazard. A `const
		// document = doc` declaration in the same scope would throw
		// "Cannot access 'document' before initialization" at the host lookup
		// above it.
		expression = `(() => {
			const host = document.querySelector(${JSON.stringify(String(params.frameSelector))});
			if (!host || !(host instanceof HTMLIFrameElement)) throw new Error('iframe not found: ${String(params.frameSelector).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');
			if (!host.contentDocument) throw new Error('cross-origin iframe: same-origin only supported, use a frame-specific tool');
			const doc = host.contentDocument, win = host.contentWindow;
			return ((document, window) => ${inner})(doc, win);
		})()`;
	}
	// params.timeoutMs races the evaluation: a hung awaitPromise (looping
	// promise, blocked page) must fail at the caller's budget instead of
	// riding the bridge-wide 60s default.
	const evalTimeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 0)) || null;
	const raceTimeout = (ms) => new Promise((_, reject) => setTimeout(() => {
		const err = new Error(`eval timeout after ${ms}ms`);
		err.code = 'eval_timeout';
		reject(err);
	}, ms));
	const evaluate = withCDP(tab.id, async (send) => {
		// Evaluate WITHOUT returnByValue first: the RemoteObject's type/subtype
		// metadata tells us honestly what came back. Newer Chrome serializes
		// un-serializable objects to `{}` under returnByValue:true, which would
		// masquerade as a legitimate empty object.
		return send('Runtime.evaluate', {
			expression,
			awaitPromise: params.awaitPromise !== false,
			returnByValue: false,
			userGesture: true,
		}).then(async (res) => {
			if (res.exceptionDetails) {
				const d = res.exceptionDetails;
				const desc = String(d.exception?.description ?? d.text);
				if (CONTEXT_DESTROYED_RE.test(desc)) {
					const err = new Error('context_destroyed: page navigated while evaluate was pending');
					err.code = 'context_destroyed';
					throw err;
				}
				throw new Error(`page exception: ${desc}`);
			}
			const ro = res.result;
			// Primitives carry their value inline; nothing more to transfer.
			const isPrimitiveLike = ro.type === 'number' || ro.type === 'string' || ro.type === 'boolean'
				|| ro.type === 'bigint' || ro.type === 'undefined' || ro.subtype === 'null';
			if (isPrimitiveLike || !ro.objectId) return ro;
			// Objects known un-serializable by value get an honest report instead
			// of a silent {} (DOM nodes, functions, proxies, symbols, Map/Set…).
			const NOT_BY_VALUE = new Set(['node', 'function', 'proxy', 'symbol', 'map', 'set',
				'weakmap', 'weakset', 'iterator', 'generator']);
			if (NOT_BY_VALUE.has(ro.subtype ?? '') || ro.type === 'function' || ro.type === 'symbol') return ro;
			// Transfer by value without re-executing the expression:
			// callFunctionOn(identity) on the existing objectId.
			const ser = await send('Runtime.callFunctionOn', {
				objectId: ro.objectId,
				functionDeclaration: 'function () { return this; }',
				returnByValue: true,
			});
			if (ser.exceptionDetails) return ro;
			return { ...ro, value: ser.result.value };
		}).catch((err) => {
			// Protocol-level variant: Chrome rejects the whole sendCommand with
			// -32000 "Inspected target navigated or closed" when the target dies
			// mid-call; surface it under the same structural code.
			if (err instanceof Error && CONTEXT_DESTROYED_RE.test(err.message)) {
				const wrapped = new Error('context_destroyed: page navigated while evaluate was pending');
				wrapped.code = 'context_destroyed';
				throw wrapped;
			}
			throw err;
		});
	});
	const value = evalTimeoutMs
		? await Promise.race([evaluate, raceTimeout(evalTimeoutMs)])
		: await evaluate;
	// Serialize what we honestly got. `value` here is a RemoteObject; a
	// missing `.value` on a non-primitive means transfer was impossible.
	let out;
	if (value.value !== undefined) {
		out = value.value;
	} else if (value.type === 'undefined') {
		out = null;
	} else if (value.subtype === 'node') {
		out = `[dom:${value.className ?? 'Node'} — wrap in JSON.stringify() or read specific properties]`;
	} else {
		out = `[${value.type}${value.subtype ? `:${value.subtype}` : ''}: not serializable — wrap the expression in JSON.stringify()]`;
	}
	return { tabId: tab.id, value: out, valueType: value.type };
}

async function cmdContent(params) {
	const mode = params.mode === 'html' ? 'html' : 'text';
	const tab = await resolveTab(params.tabId);
	const inner = mode === 'html'
		? 'document.documentElement.outerHTML'
		: '(document.body && (document.body.innerText || document.body.textContent)) || ""';
	const payload = await withCDP(tab.id, (send) =>
		send('Runtime.evaluate', {
			expression: `JSON.stringify({title: document.title, url: location.href, readyState: document.readyState, content: ${inner}})`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(`page exception: ${res.exceptionDetails.text}`);
			return JSON.parse(res.result.value);
		}));
	return { tabId: tab.id, mode, ...payload };
}

async function cmdFind(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
	const tab = await resolveTab(params.tabId);
	const payload = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const els = [...document.querySelectorAll(${JSON.stringify(String(params.selector))})];
			return JSON.stringify({
				count: els.length,
				items: els.slice(0, ${limit}).map((el) => {
					const r = el.getBoundingClientRect();
					return {
						tag: el.tagName.toLowerCase(), id: el.id || undefined,
						class: String(el.className || '').slice(0, 120) || undefined,
						text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160) || undefined,
						href: el instanceof Element && el.hasAttribute('href') ? el.getAttribute('href') : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					};
				}),
			});
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => JSON.parse(res.result.value)));
	return { tabId: tab.id, selector: params.selector, ...payload };
}

async function cmdClick(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const tab = await resolveTab(params.tabId);
	// Mouse events land on whatever is under the viewport coordinates of the
	// focused tab; ensure our tab is frontmost so coordinates are meaningful.
	await activateTabWindow(tab.id);
	return withCDP(tab.id, async (send) => {
		const hit = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				// elementFromPoint at the intended hit point catches overlays
				// (sticky headers, ads) that would swallow the click.
				const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
				const topEl = document.elementFromPoint(x, y);
				const isTop = topEl === el || el.contains(topEl);
				return { x, y, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120),
					hitTag: topEl ? topEl.tagName.toLowerCase() : null, isTop };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		if (!hit) throw new Error(`element not found: ${params.selector}`);
		const clickCount = params.doubleClick ? 2 : 1;
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount });
		return {
			tabId: tab.id,
			clicked: { x: hit.x, y: hit.y, tag: hit.tag, text: hit.text },
			hitVerified: hit.isTop,
			...(hit.isTop ? {} : { hitInstead: hit.hitTag }),
			dialogsAnswered: dialogLog.filter((d) => d.tabId === tab.id && Date.now() - d.t < 5000).length,
		};
	});
}

async function cmdInput(params) {
	if (!params.selector) throw new Error('params.selector is required');
	if (params.value === undefined) throw new Error('params.value is required');
	const tab = await resolveTab(params.tabId);
	// 'type' mode drives the real keyboard pipeline (Input.insertText per
	// keystroke) so stateful components (React-controlled, search bars with
	// internal suggestion state) observe every character. 'fill' (default)
	// sets the value directly — fast, but bypasses component keystroke logic.
	const mode = params.mode === 'type' ? 'type' : 'fill';
	// Real key events require the tab to have OS-level focus; activate first.
	if (mode === 'type') await activateTabWindow(tab.id);

	// Locate + focus + clear in one evaluate, shared by both modes.
	const located = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(String(params.selector))});
			if (!el) return null;
			el.scrollIntoView({ block: 'center', inline: 'center' });
			el.focus();
			let tag = el.tagName.toLowerCase();
			let cleared = '';
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
				el.dispatchEvent(new Event('input', { bubbles: true }));
				tag = tag + '[' + (el.getAttribute('type') || 'text') + ']';
				cleared = '';
			} else if (el.isContentEditable) {
				el.textContent = '';
				el.dispatchEvent(new InputEvent('input', { bubbles: true }));
			} else if (el instanceof HTMLSelectElement) {
				tag = 'select';
			}
			return { tag };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	}));
	if (!located) throw new Error(`element not found: ${params.selector}`);

	if (mode === 'fill') {
		const result = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				const value = ${JSON.stringify(String(params.value))};
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (el.isContentEditable) {
					el.textContent = value;
					el.dispatchEvent(new InputEvent('input', { bubbles: true }));
				} else if (el instanceof HTMLSelectElement) {
					el.value = value;
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					el.textContent = value;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		}));
		return { tabId: tab.id, mode, filled: result };
	}

	// 'type' mode: per-character real key events. dispatchKeyEvent with the
	// text field performs a full keyDown→char→keyUp; insertText would skip
	// per-key keydown handlers, so we use rawKeyDown+char for letters and
	// dispatchKeyEvent(text=…) for everything else.
	const text = String(params.value);
	return withCDP(tab.id, async (send) => {
		for (const ch of text) {
			if (ch === '\n') {
				await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter', text: '\r' });
				await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter' });
				continue;
			}
			// Non-ASCII (CJK, emoji) cannot travel through keyEvent text — the
			// protocol mangles them to '?'. Route them through insertText which
			// performs a real composition-style insertion; ASCII keeps full
			// keyDown/char/keyUp so per-key handlers still fire.
			if (ch.charCodeAt(0) > 127 || ch.codePointAt(0) > 0xFFFF) {
				await send('Input.insertText', { text: ch });
				continue;
			}
			await send('Input.dispatchKeyEvent', {
				type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
				windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			});
			// NOTE: no separate 'char' event — Chrome inserts the character from
			// keyDown's text field; an explicit char event duplicates the input.
			await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
		}
		// Read back what actually landed in the element.
		const readBack = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => res.result.value);
		return { tabId: tab.id, mode, filled: readBack };
	});
}

const KEY_CODES = {
	Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
	Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
	ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
	ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
	Home: [36, 'Home'], End: [35, 'End'],
	PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 };

/** 把 "Ctrl+A" 这类组合串拆成真正的按键 + 修饰键集合。 */
function parseKeySpec(key, rawModifiers) {
	const mods = new Set((Array.isArray(rawModifiers) ? rawModifiers : []).map((m) => String(m).toLowerCase()));
	// 只有长度 > 1 且含 '+' 才当组合串：`+` 与 `=` 这类键本身就是单字符。
	const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
	const finalKey = parts.pop();
	for (const part of parts) {
		const name = part.trim().toLowerCase();
		if (!(name in MODIFIER_BITS)) {
			throw new Error(`unknown modifier "${part.trim()}" in key "${key}". Valid: alt, ctrl/control, meta/command, shift — or pass modifiers: ["ctrl"] together with key: "a".`);
		}
		mods.add(name);
	}
	return { key: finalKey, modifiers: [...mods] };
}

async function cmdPress(params) {
	const raw = String(params.key ?? '');
	if (raw.length === 0) throw new Error('params.key is required');
	const tab = await resolveTab(params.tabId);
	const { key, modifiers: modifierNames } = parseKeySpec(raw, params.modifiers);
	// Key events need OS focus; a background tab swallows them silently.
	await activateTabWindow(tab.id);
	let keyCode, code;
	if (KEY_CODES[key]) { [keyCode, code] = KEY_CODES[key]; }
	else if (key.length === 1) {
		keyCode = key.toUpperCase().charCodeAt(0);
		if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
		else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
	}
	if (keyCode === undefined) {
		// 以前这里不报错，照样把 undefined 的 keyCode/code 发出去：Chrome 什么都不做，
		// 调用方却收到 `{key:"…", pressed:true}`——静默失败比失败本身更糟。
		throw new Error(`unknown key "${raw}". Use one of ${Object.keys(KEY_CODES).join(', ')}, a single character, or a combination like "Ctrl+A" / "Shift+ArrowRight".`);
	}
	const text = params.text !== undefined
		? String(params.text)
		: key === 'Enter' ? '\r' // '\r' makes keyDown perform implicit form submission
		: key.length === 1 && !modifierNames.some((m) => m in MODIFIER_BITS && m !== 'shift') ? key : undefined;
	let modifiers = 0;
	for (const m of modifierNames) modifiers |= MODIFIER_BITS[String(m).toLowerCase()] ?? 0;
	return withCDP(tab.id, async (send) => {
		// NOTE: no separate 'char' event — Chrome inserts the character from
		// keyDown's text field; an explicit char event duplicates the input
		// (double characters, and Enter submitted the form twice). Same rule
		// `cmdInput`'s type mode already follows; see issue #14.
		await send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, text, unmodifiedText: text, modifiers,
		});
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		return { tabId: tab.id, key, pressed: true, ...(modifiers ? { modifiers } : {}) };
	});
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params.tabId);
	const format = params.format === 'jpeg' ? 'jpeg' : 'png';
	const res = await withCDP(tab.id, async (send) => {
		// Element capture: resolve the selector to a CSS-pixel rect, then pass
		// it as clip. Page.captureScreenshot's clip is in CSS pixels and it
		// handles DPR internally (unlike raw base64 math).
		if (params.selector) {
			const rect = await send('Runtime.evaluate', {
				expression: `(() => {
					const el = document.querySelector(${JSON.stringify(String(params.selector))});
					if (!el) return null;
					el.scrollIntoView({ block: 'center', inline: 'center' });
					const r = el.getBoundingClientRect();
					return { x: r.left, y: r.top, width: r.width, height: r.height };
				})()`,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => {
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
				return r.result.value;
			});
			if (!rect) throw new Error(`element not found: ${params.selector}`);
			return send('Page.captureScreenshot', {
				format,
				quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
				clip: { ...rect, scale: 1 },
			}).then((shot) => ({ shot, elementRect: rect }));
		}
		const shot = await send('Page.captureScreenshot', {
			format,
			quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
			captureBeyondViewport: Boolean(params.fullPage),
		});
		return { shot };
	});
	return {
		tabId: tab.id,
		format,
		base64: res.shot.data,
		tabTitle: tab.title,
		tabUrl: tab.url,
		...(res.elementRect ? {
			elementRect: {
				x: Math.round(res.elementRect.x), y: Math.round(res.elementRect.y),
				w: Math.round(res.elementRect.width), h: Math.round(res.elementRect.height),
			},
		} : {}),
	};
}

async function cmdScroll(params) {
	const tab = await resolveTab(params.tabId);
	const dx = Number.isFinite(Number(params.x)) ? Number(params.x) : 0;
	const dy = Number.isFinite(Number(params.y)) ? Number(params.y) : 0;
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			window.scrollBy({ left: ${JSON.stringify(dx)}, top: ${JSON.stringify(dy)}, behavior: 'instant' });
			return { tabId: ${tab.id}, scrollX: window.scrollX, scrollY: window.scrollY,
				pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => res.result.value));
}

/** All CDP message variants that mean "the page went away mid-evaluation". */
const CONTEXT_DESTROYED_RE = /Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/i;

const SNAPSHOT_SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], '
	+ '[role="tab"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]';

/** DOM mode: stamp `data-dsh-ref` on everything matching the selector list. */
async function snapshotViaDom(send, tab, limit) {
	const payload = await send('Runtime.evaluate', {
		expression: `(() => {
			const ATTR = 'data-dsh-ref';
			document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
			const nodes = [...document.querySelectorAll(${JSON.stringify(SNAPSHOT_SELECTOR)})];
			const items = [];
			let n = 0;
			for (const el of nodes) {
				if (items.length >= ${limit}) break;
				const r = el.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				const ref = 'e' + (++n);
				el.setAttribute(ATTR, ref);
				const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
				items.push({
					ref, tag: el.tagName.toLowerCase(),
					type: el.getAttribute('type') || undefined,
					role: el.getAttribute('role') || undefined,
					name: (el.getAttribute('aria-label') || el.getAttribute('placeholder')
						|| (el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 80) || undefined,
					value: isField || el instanceof HTMLSelectElement ? String(el.value ?? '').slice(0, 60) : undefined,
					href: el.hasAttribute('href') ? el.href : undefined,
					rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
				});
			}
			return { tabId: ${tab.id}, title: document.title, url: location.href, total: nodes.length, items };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	});
	payload.limitedTo = limit;
	return payload;
}

/* --------------------------------------------------- snapshot: a11y (AX) mode */

/**
 * Roles an agent can actually act on. Chrome computes these (including the
 * accessible name, which is what makes this survive a DOM redesign), so the list
 * is deliberately an allow-list: internal nodes like `GenericContainer`,
 * `StaticText` and `InlineTextBox` would otherwise dominate the tree and eat the
 * whole `limit` budget on a text-heavy page.
 */
const AX_ACTIONABLE_ROLES = new Set([
	'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'menuitem',
	'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch',
	'slider', 'spinbutton', 'tab', 'treeitem', 'gridcell', 'columnheader', 'rowheader',
]);

/**
 * Runs in the page: returns null for anything invisible (so no ref is consumed
 * and no attribute is left behind), otherwise stamps the ref and reports back
 * what the DOM node actually is. One round trip per kept element.
 */
const AX_STAMP_FN = 'function(ref){'
	+ 'var r = this.getBoundingClientRect();'
	+ 'if (r.width === 0 && r.height === 0) return null;'
	+ 'this.setAttribute("data-dsh-ref", ref);'
	+ 'return {'
	+ ' tag: this.tagName.toLowerCase(),'
	+ ' type: (this.type ? String(this.type) : undefined),'
	+ ' href: (this.href ? String(this.href) : undefined),'
	+ ' value: (this.value === undefined || this.value === null) ? undefined : String(this.value).slice(0, 60),'
	+ ' rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }'
	+ '};'
	+ '}';

/**
 * AX mode: read Chrome's accessibility tree, then stamp the **same**
 * `data-dsh-ref` attribute onto the real DOM node behind each interesting a11y
 * node. That keeps the ref contract intact — `browser_click` / `browser_type`
 * still resolve `[data-dsh-ref="e7"]` — while the agent gets `role` + accessible
 * `name` instead of a guessed selector.
 */
async function snapshotViaAx(send, tab, limit) {
	await send('DOM.enable').catch(() => {});
	await send('Accessibility.enable').catch(() => {});
	// Clear refs from a previous snapshot first: a stale attribute would otherwise
	// let an old ref click whatever is on screen now.
	await send('Runtime.evaluate', {
		expression: 'document.querySelectorAll("[data-dsh-ref]").forEach((el) => el.removeAttribute("data-dsh-ref")); void 0;',
		returnByValue: true,
	}).catch(() => {});
	const tree = await send('Accessibility.getFullAXTree');
	const nodes = (tree && tree.nodes) || [];
	if (!Array.isArray(nodes)) throw new Error('Accessibility.getFullAXTree 没有返回 nodes');
	const candidates = nodes.filter((node) => node
		&& node.ignored !== true
		&& node.backendDOMNodeId !== undefined
		&& AX_ACTIONABLE_ROLES.has(String(node.role && node.role.value || '').toLowerCase()));
	const items = [];
	const skipped = { unresolved: 0, invisible: 0 };
	for (const node of candidates) {
		if (items.length >= limit) break;
		const ref = 'e' + (items.length + 1);
		let resolved = null;
		try {
			resolved = await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
		} catch {
			resolved = null;
		}
		const objectId = resolved && resolved.object && resolved.object.objectId;
		if (!objectId) { skipped.unresolved += 1; continue; }
		let call = null;
		try {
			call = await send('Runtime.callFunctionOn', {
				objectId, functionDeclaration: AX_STAMP_FN, arguments: [{ value: ref }], returnByValue: true,
			});
		} catch {
			skipped.unresolved += 1;
			continue;
		}
		const geo = call && call.result ? call.result.value : null;
		if (call && call.exceptionDetails) { skipped.unresolved += 1; continue; }
		// null means invisible: the stamp function refused to write the attribute,
		// so this ref number is simply reused by the next candidate.
		if (!geo) { skipped.invisible += 1; continue; }
		items.push({
			ref,
			tag: geo.tag,
			role: String(node.role && node.role.value || '').toLowerCase() || undefined,
			name: String(node.name && node.name.value || '').replace(/\s+/g, ' ').slice(0, 80) || undefined,
			type: geo.type,
			href: geo.href,
			value: geo.value,
			rect: geo.rect,
		});
	}
	return {
		tabId: tab.id,
		mode: 'ax',
		title: await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
			.then((r) => r.result && r.result.value).catch(() => undefined),
		url: await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
			.then((r) => r.result && r.result.value).catch(() => undefined),
		total: candidates.length,
		ax: { nodes: nodes.length, candidates: candidates.length, ...skipped },
		items,
		limitedTo: limit,
	};
}

async function cmdSnapshot(params) {
	const tab = await resolveTab(params.tabId);
	const limit = Math.min(200, Math.max(1, Number(params.limit) || 120));
	const wantAx = String(params.mode ?? params.source ?? 'dom').toLowerCase() === 'ax';
	return withCDP(tab.id, async (send) => {
		await send('Runtime.enable').catch(() => {});
		if (!wantAx) return snapshotViaDom(send, tab, limit);
		try {
			return await snapshotViaAx(send, tab, limit);
		} catch (error) {
			// A page (or an older Chrome) that will not give us an accessibility
			// tree must still produce a usable snapshot: fall back to the DOM
			// selectors and say out loud that we did.
			const payload = await snapshotViaDom(send, tab, limit);
			payload.mode = 'dom';
			payload.axFallback = String((error && error.message) || error);
			return payload;
		}
	});
}

const COMMANDS = {
	ping: cmdPing, 'browser.info': cmdBrowserInfo,
	'tabs.list': cmdTabsList, 'tabs.open': cmdTabsOpen, 'tabs.close': cmdTabsClose, 'tabs.closeMany': cmdTabsCloseMany, 'tabs.activate': cmdTabsActivate,
	'tabs.group': cmdTabGroup, 'tabs.ungroup': cmdTabUngroup,
	nav: cmdNav, eval: cmdEval, content: cmdContent, find: cmdFind,
	click: cmdClick, input: cmdInput, press: cmdPress, scroll: cmdScroll,
	snapshot: cmdSnapshot, screenshot: cmdScreenshot,
	wait: cmdWait, dialog: cmdDialogPolicy,
	'console.log': cmdConsoleLog, 'network.log': cmdNetworkLog, 'network.clear': cmdNetworkClear,
	pdf: cmdPdf, emulate: cmdEmulate,
};

/**
 * Explicit wait primitive: poll until a selector appears, page text contains
 * a string, or a predicate function returns truthy. Polls inside the page via
 * requestAnimationFrame-ish loop (50ms interval) — no bridge round-trips.
 */
async function cmdWait(params) {
	const tab = await resolveTab(params.tabId);
	const timeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 15_000));
	let condition;
	if (params.selector) {
		condition = `!!document.querySelector(${JSON.stringify(String(params.selector))})`;
	} else if (typeof params.text === 'string') {
		condition = `(document.body && document.body.innerText.includes(${JSON.stringify(params.text)}))`;
	} else if (typeof params.fn === 'string' && params.fn.length > 0) {
		// Accept both a predicate function ("() => x.ready") and a bare boolean
		// expression ("x.ready === true"): call function values, evaluate
		// everything else as-is.
		condition = `(() => { const f = (${params.fn}); return typeof f === 'function' ? Boolean(f()) : Boolean(f); })()`;
	} else {
		throw new Error('provide one of selector, text, or fn');
	}
	return withCDP(tab.id, async (send) => {
		const started = Date.now();
		for (;;) {
			const res = await send('Runtime.evaluate', {
				expression: condition,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => ({ result: { value: false } }));
			if (res.exceptionDetails) throw new Error(`wait condition error: ${res.exceptionDetails.text}`);
			if (res.result.value === true) return { tabId: tab.id, waited: Date.now() - started };
			if (Date.now() - started >= timeoutMs) throw new Error(`wait timeout after ${timeoutMs}ms`);
			await new Promise((r) => setTimeout(r, 50));
		}
	});
}

/**
 * Read or set the native-dialog auto-answer policy. Passing `policy`
 * ('accept' | 'dismiss' | 'manual') sets it; omitting it is a read. Always
 * returns {policy, recent} — the last 10 answered dialogs, so a caller can
 * verify one actually fired.
 */
async function cmdDialogPolicy(params) {
	if (params?.policy !== undefined) {
		const p = String(params.policy);
		if (!['accept', 'dismiss', 'manual'].includes(p)) throw new Error(`invalid dialog policy: ${p}`);
		dialogPolicy = p;
	}
	return { policy: dialogPolicy, recent: dialogLog.slice(-10) };
}

/* ------------------------------------------------------------ popup link */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === 'bridgeStatus') {
		sendResponse({ state: wsState, cfg, helloInfo, lastError, locked: hardLocked });
		return false;
	}
	if (msg?.type === 'lockSet') {
		// The lock is set from the popup only (see the local-lock section): this
		// channel cannot be reached by the bridge, so "unlock from the browser"
		// is enforced by where the code lives, not by who asks nicely.
		// Fail closed: only an explicit `locked: false` unlocks, so a malformed
		// message cannot quietly unfreeze the browser.
		setHardLock(msg.locked !== false)
			.then((locked) => sendResponse({ locked }))
			.catch((err) => sendResponse({ locked: hardLocked, error: String((err && err.message) || err) }));
		return true;
	}
	if (msg?.type === 'reconnect') {
		manualDisconnect = false;
		backoffAttempt = 0;
		disconnectNow();
		loadConfig().then(() => { connect(); sendResponse({ started: true }); });
		return true;
	}
	if (msg?.type === 'disconnect') {
		manualDisconnect = true;
		disconnectNow();
		sendResponse({ started: true });
		return false;
	}
	return false;
});

/* -------------------------------------------------------------- lifecycle */

async function init() {
	await loadConfig();
	connect();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
