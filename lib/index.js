import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
/**
* Incremental frame parser over arbitrary TCP chunks. `drain` parses every
* complete frame currently buffered and keeps the remainder; an oversized or
* unmasked data frame throws, and the caller closes the link.
*/
var FrameReader = class {
	buffer = Buffer.alloc(0);
	/** Append one TCP chunk to the parse buffer. */
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
	}
	/** Parse and consume every complete frame, invoking `onFrame` per frame in order. */
	drain(onFrame) {
		for (;;) {
			const frame = this.readFrame();
			if (!frame) return;
			onFrame(frame);
		}
	}
	readFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const fin = (buf[0] & 128) !== 0;
		const opcode = buf[0] & 15;
		const masked = (buf[1] & 128) !== 0;
		let length = buf[1] & 127;
		let offset = 2;
		if (length === 126) {
			if (buf.length < offset + 2) return null;
			length = buf.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buf.length < offset + 8) return null;
			const extended = buf.readBigUInt64BE(offset);
			offset += 8;
			if (extended > BigInt(67108864)) throw new Error(`websocket frame too large: ${extended} bytes`);
			length = Number(extended);
		}
		let maskKey = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + length) return null;
		if (!masked && (opcode === 1 || opcode === 0 || opcode === 2)) throw new Error("websocket client sent an unmasked data frame");
		const payload = Buffer.from(buf.subarray(offset, offset + length));
		if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ maskKey[i & 3];
		this.buffer = buf.subarray(offset + length);
		return {
			fin,
			opcode,
			payload
		};
	}
};
/** Encode one unmasked text frame carrying a UTF-8 JSON message. */
function encodeTextFrame(text) {
	const payload = Buffer.from(text, "utf8");
	if (payload.length < 126) return Buffer.from([
		129,
		payload.length,
		...payload
	]);
	if (payload.length < 65536) {
		const header = Buffer.alloc(4);
		header[0] = 129;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = 129;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}
/** Encode one control frame (opcode 0x8 close, 0x9 ping, 0xA pong); payload stays ≤ 125 bytes. */
function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
	return Buffer.concat([Buffer.from([128 | opcode, payload.length]), payload]);
}
/** Build the close-frame bytes for a status code plus a UTF-8 reason within the 125-byte limit. */
function encodeCloseFrame(code, reason) {
	const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
	const body = Buffer.alloc(2 + reasonBytes.length);
	body.writeUInt16BE(code, 0);
	reasonBytes.copy(body, 2);
	return encodeControlFrame(8, body);
}
/**
* 会改变页面或不可逆地改变浏览器状态的命令；其余按只读处理。
*
* 表里绝大多数是**扩展命令名**（`classify()` 按调用方传进来的名字查表），但也包含
* 插件本地命令（见下面 `cleanup`）：判据始终是同一条——失败之后重试会不会多造成一次损害。
*
* 判据是「重试会不会造成额外损害」，不是「有没有动到浏览器」。所以标签分组
* （`tabs.group` / `tabs.ungroup`）不在这里：把已经在组里的标签再归一次是空操作，
* 拆组失败后再拆一次也不会多拆坏东西，重试安全；而 `tabs.open` 重试会多出标签页、
* `tabs.close` 重试可能关掉用户正在看的页面，必须报 unknown。
*/
const WRITE_COMMANDS = /* @__PURE__ */ new Set([
	"nav",
	"click",
	"input",
	"press",
	"scroll",
	"eval",
	"emulate",
	"tabs.open",
	"tabs.close",
	"tabs.closeMany",
	"tabs.activate",
	"dialog",
	"tabs.back",
	"tabs.forward",
	"cdp",
	"cleanup",
	"hold",
	"windows.open"
]);
/** 该命令是否可能留下副作用。 */
function isWriteCommand(command) {
	return WRITE_COMMANDS.has(command);
}
/** 每个 code 对应的下一步建议（写给 agent，不是写给用户看的日志）。 */
const HINTS = {
	bridge_disabled: "桥接未启用：在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true 后重启 dsh；不要重试本命令。",
	extension_offline: "浏览器扩展没连上：让用户打开装了 DSH Browser Control 的那个浏览器（扩展图标应为绿色），确认端口与 Token 两边一致后再试。",
	command_timeout: "扩展超时未回应：先别重试。用 browser_find / browser_snapshot 看页面当前状态，判断动作是否其实已经生效。",
	link_lost: "命令在途时链路断了：动作可能已经落到页面上。先用只读工具确认页面状态，再决定是否重做。",
	cancelled: "调用被取消：effectState=not_started 时命令确定没发出去，可以按需重新发起；unknown 时动作可能已经执行，先确认页面状态再决定，不要直接重做。",
	not_configured: "插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list）后再试。",
	held_by_user: "这是用户在页面上的接管浮层里按下的「中止操作」，不是故障：命令一条都没有发出。先与用户确认；他同意继续之后调用 browser_hold action=off 解除，然后再继续原来的步骤。不要重试，也不要换成别的工具绕过它。",
	blocked_by_policy: "这是本机策略拦下的，不是故障：命令没有发给浏览器（零副作用）。要放开改 profile 的 cordis.patch.yml（browser-bridge 的 readOnly / allowScript）并重启 dsh，或换成本机允许的只读工具；不要原地重试。",
	locked_by_user: "这是用户在扩展弹窗里按下的「锁定」，不是故障：命令一条都没有发出。请先与用户确认，由他在同一个弹窗里点「已锁定」解除；不要重试，也不要试图改配置绕过它。",
	lock_unreadable: "扩展这次读不出锁的状态，按冻结处理了：命令没有发出。下一条命令会重新读一次，所以可以再试一次，但不要循环重试；一直如此就请用户重启浏览器或重装扩展。",
	command_failed: "扩展报回失败：按 error 文本处理，通常是选择器没命中、标签页已关闭或页面不允许该操作。"
};
/**
* 失败文案里「该不该重试」那半句。
*
* 宿主的失败内容是 `Error: ${message}`（`@deepseek-ai/dsh-tools` `lib/index.js:3616-3623`），
* `code` / `effectState` / `hint` 这些结构化字段只进 `error.info` 与 HTTP 面，
* **模型读不到**。所以决定下一步所需的两个信息——副作用状态与下一步动作——必须写进
* message 本身，否则整个错误契约对 agent 失效（和「render 只写摘要」是同一类缺陷）。
*/
function effectClause(effectState) {
	switch (effectState) {
		case "unknown": return "effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态，再决定要不要重做，不要直接重试";
		case "committed": return "effectState=committed：动作已经生效";
		default: return "effectState=not_started：这次调用没有动到页面，重试安全";
	}
}
/** 带分类的桥接错误；`message` 面向模型，`toJSON()` 面向程序。 */
var BridgeError = class extends Error {
	code;
	effectState;
	hint;
	command;
	/** 原始失败描述：HTTP 面的 `error` 字段就是它，不含我们追加的契约文案。 */
	detail;
	constructor(command, code, effectState, message) {
		super(`[${code}] ${message} — ${effectClause(effectState)}。下一步：${HINTS[code]}`);
		this.name = "BridgeError";
		this.code = code;
		this.effectState = effectState;
		this.hint = HINTS[code];
		this.command = command;
		this.detail = message;
	}
	/** 给 HTTP 面用的扁平 JSON 形状。 */
	toJSON() {
		return {
			ok: false,
			error: this.detail,
			code: this.code,
			effectState: this.effectState,
			hint: this.hint
		};
	}
};
/**
* 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
* 保证多次包裹不会把 code 洗掉。
* @param params - 这次调用的参数。只有 `wait` 需要它：`fn` 是在页面里执行任意 JS，
*   超时/掉线时与写命令同档报 `unknown`（谓词跑过就不能断言页面没被动过）；
*   不带 `fn` 的 wait 仍是只读。
*/
function classify(command, error, params) {
	if (error instanceof BridgeError) return error;
	const raw = error instanceof Error ? error.message : String(error);
	const locked = raw.startsWith("browser-locked-by-user:") ? "locked_by_user" : raw.startsWith("browser-lock-unreadable:") ? "lock_unreadable" : raw.startsWith("browser-hold-aborted:") ? "held_by_user" : void 0;
	const markerLength = locked === "locked_by_user" ? 23 : locked === "lock_unreadable" ? 24 : locked === "held_by_user" ? 21 : 0;
	const message = locked ? raw.slice(markerLength).trim() : raw;
	const unknownIsPossible = isWriteCommand(command) || command === "wait" && typeof params?.fn === "string" && params.fn.trim().length > 0;
	let code;
	if (locked !== void 0) code = locked;
	else if (/no browser extension connected/.test(message)) code = "extension_offline";
	else if (/disconnected mid-command|browser-bridge stopped/.test(message)) code = "link_lost";
	else if (/timed out after/.test(message)) code = "command_timeout";
	else if (/cancelled/.test(message)) code = "cancelled";
	else if (/尚未加载配置|not configured yet/.test(message)) code = "not_configured";
	else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message)) code = "bridge_disabled";
	else code = "command_failed";
	const effectState = code === "command_timeout" || code === "link_lost" ? unknownIsPossible ? "unknown" : "not_started" : code === "command_failed" ? unknownIsPossible ? "unknown" : "not_started" : code === "cancelled" ? /cancelled before send/.test(message) ? "not_started" : unknownIsPossible ? "unknown" : "not_started" : "not_started";
	return new BridgeError(command, code, effectState, message);
}
//#endregion
//#region lib/types/server.js
/**
* Local WebSocket+HTTP bridge between one browser extension and dsh. The
* extension connects OUT to `ws://127.0.0.1:<port>/ws?token=...`, so no
* native-messaging host or registry setup exists; dsh drives commands through
* {@link BridgeServer.execute} and reads link state through {@link BridgeServer.status}.
* A small HTTP face (`/api/status`, `/api/command`, `/api/cleanup`, `/`) keeps
* the bridge usable from curl while the server runs. `/api/command` and
* `/api/cleanup` demand the same token as the WebSocket upgrade; `/` and
* `/api/status` stay readable because the status page needs them and they only
* report link state. No response carries `Access-Control-Allow-Origin`, and the
* upgrade checks `Host` plus `Origin` so neither a web page nor a rebound
* hostname can attach.
*
* Wire protocol (text frames, one JSON object each):
* - extension → server: `{type:'hello',…}`, `{type:'pong',t}`, `{type:'result',id,ok,result?|error}`
* - server → extension: `{type:'ping',t}`, `{type:'command',id,command,params}`
*
* Command names (sent in `command`) include: `ping`, `browser.info`, `tabs.list/open/close/activate`,
* `nav`, `eval`, `content`, `find`, `click`, `input`, `press`, `scroll`, `snapshot`, `screenshot`,
* `wait`, `dialog`, `console.log`, `network.log`, `network.clear`, `pdf`, `emulate`.
* @module @deepseek-ai/dsh-browser-bridge/server
*/
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
const MAX_COMMAND_TIMEOUT_MS = 3e5;
const MAX_HTTP_BODY_BYTES = 2097152;
/** The published default. It ships in README and `cordis.patch.yml`, so it is public knowledge. */
const DEFAULT_TOKEN = "dsh-local";
/** Tokens shorter than this cannot be brute-forced meaningfully; the bridge warns at start. */
const MIN_RECOMMENDED_TOKEN_LENGTH = 16;
/** Agent scratch-file convention: `__name.mjs`-style temp artifacts at the top level only. */
const SCRATCH_FILE_PATTERN = /^__[^/\\]+\.(mjs|cjs|js|png|jpg|jpeg)$/i;
/**
* Clear the screenshots directory and delete agent scratch files. Only the
* top level of each location is touched; nested trees stay untouched.
* @param options - `shotsDir` is cleared of direct file children; `scratchDir`
*   defaults to the process working directory and loses only scratch-named files.
* @returns counts and names of what was removed.
*/
async function cleanupArtifacts(options) {
	await mkdir(options.shotsDir, { recursive: true });
	const shotsEntries = await readdir(options.shotsDir, { withFileTypes: true });
	let shotsRemoved = 0;
	for (const entry of shotsEntries) {
		if (!entry.isFile()) continue;
		await rm(path.join(options.shotsDir, entry.name));
		shotsRemoved += 1;
	}
	const scratchDir = options.scratchDir ?? process.cwd();
	const scratchEntries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
	const scratchRemoved = [];
	for (const entry of scratchEntries) {
		if (!entry.isFile() || !SCRATCH_FILE_PATTERN.test(entry.name)) continue;
		await rm(path.join(scratchDir, entry.name));
		scratchRemoved.push(entry.name);
	}
	return {
		shotsRemoved,
		scratchRemoved
	};
}
/**
* One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
* a fresh listener is built per start so a changed config reuses the class
* without re-allocation concerns. Exactly one extension link is held at a
* time; a newer WebSocket replaces the older one.
*/
var BridgeServer = class {
	options;
	httpServer;
	clientSocket;
	hello;
	connectedAt;
	pending = /* @__PURE__ */ new Map();
	lastError;
	continuationRemainder = "";
	continuationOpen = false;
	constructor(options) {
		this.options = options;
	}
	/** Current link state, also served verbatim as `/api/status`. */
	get status() {
		return {
			listening: this.httpServer !== void 0,
			port: this.httpServer !== void 0 ? this.options.port : void 0,
			extensionConnected: this.clientSocket !== void 0,
			connectedAt: this.connectedAt?.toISOString(),
			hello: this.hello,
			bridgeProtocol: 1,
			extensionProtocol: this.hello?.protocol ?? 0,
			protocolCompatible: this.protocolNote === null,
			protocolNote: this.protocolNote,
			pendingCommands: this.pending.size,
			lastError: this.lastError,
			insecureToken: this.insecureToken
		};
	}
	get insecureToken() {
		return this.options.token === DEFAULT_TOKEN || this.options.token.trim().length < MIN_RECOMMENDED_TOKEN_LENGTH;
	}
	/** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
	async start() {
		if (this.httpServer !== void 0) return;
		const server = http.createServer((req, res) => {
			try {
				this.handleHttp(req, res);
			} catch (error) {
				this.log(`http handler failed: ${errorMessage$1(error)}`);
				res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: false,
					error: "internal error"
				}));
			}
		});
		server.on("upgrade", (req, socket) => {
			try {
				this.handleUpgrade(req, socket);
			} catch (error) {
				this.log(`upgrade failed: ${errorMessage$1(error)}`);
				socket.destroy();
			}
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				this.lastError = errorMessage$1(error);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.options.port, "127.0.0.1");
		});
		this.httpServer = server;
		this.log(`listening on ws://127.0.0.1:${this.options.port}/ws`);
		if (this.insecureToken) this.log(`insecure token (${this.options.token === DEFAULT_TOKEN ? "the published default" : "shorter than 16 chars"}) — any local process can present it; set a longer \`token\` in the browser-bridge config`);
	}
	/** Close the extension link, fail every pending command, and release the port. Idempotent. */
	async stop() {
		const server = this.httpServer;
		if (server === void 0) return;
		this.httpServer = void 0;
		this.closeClientSocket(1001, "server stopping");
		this.failAllPending(/* @__PURE__ */ new Error("browser-bridge stopped"));
		await new Promise((resolve) => {
			server.close(() => resolve());
		});
		this.log("stopped");
	}
	/**
	* Send one command to the connected extension and await its result.
	* Throws while no extension is linked; the rejection message names the fix.
	*/
	async execute(command, params, options = {}) {
		const socket = this.clientSocket;
		if (socket === void 0) throw classify(command, /* @__PURE__ */ new Error("no browser extension connected — open the browser that has the DSH Browser Control extension installed"));
		const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? 6e4));
		const signal = options.signal;
		if (signal?.aborted) throw new Error(`browser command cancelled before send: ${command}`);
		const id = randomUUID();
		const entry = {
			command,
			resolve: () => {},
			reject: () => {},
			timer: setTimeout(() => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command timed out after ${timeoutMs}ms: ${command}`));
			}, timeoutMs)
		};
		const result = new Promise((resolve, reject) => {
			entry.resolve = resolve;
			entry.reject = reject;
		});
		if (signal !== void 0) {
			entry.onAbort = () => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command cancelled after send: ${command}`));
			};
			signal.addEventListener("abort", entry.onAbort, { once: true });
		}
		this.pending.set(id, entry);
		this.log(`-> ${command} (${id})`);
		socket.write(encodeTextFrame(JSON.stringify({
			type: "command",
			id,
			command,
			params
		})));
		try {
			return await result;
		} catch (error) {
			throw classify(command, error, params);
		} finally {
			clearTimeout(entry.timer);
			if (entry.onAbort !== void 0 && signal !== void 0) signal.removeEventListener("abort", entry.onAbort);
		}
	}
	/**
	* Delete generated screenshots and agent scratch files via
	* {@link cleanupArtifacts} using this server's configured directories.
	*/
	async cleanup() {
		const result = await cleanupArtifacts({
			shotsDir: this.options.shotsDir,
			...this.options.scratchDir === void 0 ? {} : { scratchDir: this.options.scratchDir }
		});
		this.log(`cleanup: ${result.shotsRemoved} screenshot(s), ${result.scratchRemoved.length} scratch file(s)`);
		return result;
	}
	log(line) {
		this.options.log?.(line);
	}
	/**
	* Mismatch description, or null when the two sides can talk. An older
	* extension that declares nothing is treated as v1-compatible: it still
	* answers every command this bridge has ever sent, so failing the link would
	* break working installs for a cosmetic gap.
	*/
	get protocolNote() {
		if (this.hello === void 0) return null;
		const theirs = this.hello.protocol;
		if (theirs === 0) return null;
		if (theirs > 1) return `扩展声明协议 v${theirs}，本桥只支持到 v1 —— 请升级 dsh 插件，否则新命令会报「未知命令」`;
		if (theirs < 1) return `扩展协议 v${theirs} 低于本桥 v1 —— 旧扩展可能缺少新命令，必要时重新下载扩展包`;
		return null;
	}
	/**
	* Whether a request carries the bridge token, the same credential the WebSocket
	* upgrade checks. Accepted forms: `Authorization: Bearer <token>`, `X-Token: <token>`
	* and `?token=<token>` (the query form exists for curl and for the status page).
	*/
	authorized(req, url) {
		const authorization = req.headers.authorization;
		const header = typeof authorization === "string" && /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, "") : typeof req.headers["x-token"] === "string" ? req.headers["x-token"] : "";
		return tokenMatches(header.length > 0 ? header : url.searchParams.get("token") ?? "", this.options.token);
	}
	rejectUnauthenticated(res, route) {
		this.log(`http ${route}: rejected (missing or wrong token)`);
		this.respondJson(res, 401, {
			ok: false,
			error: "unauthorized: pass the bridge token as \"Authorization: Bearer <token>\", \"X-Token: <token>\" or ?token=<token>"
		});
	}
	handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/api/status" && req.method === "GET") {
			this.respondJson(res, 200, {
				ok: true,
				...this.status,
				wsUrl: `ws://127.0.0.1:${this.options.port}/ws`,
				shotsDir: path.resolve(this.options.shotsDir)
			});
			return;
		}
		if (url.pathname === "/api/cleanup" && req.method === "POST") {
			if (!this.authorized(req, url)) {
				this.rejectUnauthenticated(res, "POST /api/cleanup");
				return;
			}
			this.cleanup().then((result) => this.respondJson(res, 200, {
				ok: true,
				...result
			}), (error) => this.respondJson(res, 500, {
				ok: false,
				error: errorMessage$1(error)
			}));
			return;
		}
		if (url.pathname === "/api/command" && req.method === "POST") {
			if (!this.authorized(req, url)) {
				this.rejectUnauthenticated(res, "POST /api/command");
				return;
			}
			this.handleCommandRequest(req, res);
			return;
		}
		if (url.pathname === "/" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(statusPageHtml(this.options.port));
			return;
		}
		this.respondJson(res, 404, {
			ok: false,
			error: `no route: ${req.method} ${url.pathname}`
		});
	}
	respondJson(res, statusCode, body) {
		res.writeHead(statusCode, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store"
		});
		res.end(JSON.stringify(body));
	}
	handleCommandRequest(req, res) {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_HTTP_BODY_BYTES) {
				aborted = true;
				chunks.length = 0;
				this.respondJson(res, 413, {
					ok: false,
					error: "body too large"
				});
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				this.respondJson(res, 400, {
					ok: false,
					error: `invalid JSON body: ${errorMessage$1(error)}`
				});
				return;
			}
			if (typeof parsed.command !== "string" || parsed.command.length === 0) {
				this.respondJson(res, 400, {
					ok: false,
					error: "body must be {\"command\": \"...\", \"params\": {...}}"
				});
				return;
			}
			const timeoutMs = typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : void 0;
			this.execute(parsed.command, parsed.params ?? {}, timeoutMs === void 0 ? {} : { timeoutMs }).then((result) => this.respondJson(res, 200, {
				ok: true,
				result
			}), (error) => {
				if (error instanceof BridgeError) {
					const status = error.code === "extension_offline" || error.code === "bridge_disabled" || error.code === "not_configured" ? 503 : error.code === "command_timeout" || error.code === "link_lost" ? 504 : 502;
					this.respondJson(res, status, error.toJSON());
					return;
				}
				this.respondJson(res, 502, {
					ok: false,
					error: errorMessage$1(error)
				});
			});
		});
	}
	handleUpgrade(req, socket) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		if (!tokenMatches(url.searchParams.get("token") ?? "", this.options.token)) {
			this.log("websocket rejected: bad token");
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		if (!isLoopbackHost(String(req.headers.host ?? ""))) {
			this.log(`websocket rejected: host ${req.headers.host}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
		if (!isTrustedUpgradeOrigin(origin)) {
			this.log(`websocket rejected: origin ${origin}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r\n\r
`);
		this.closeClientSocket(1e3, "replaced by a newer connection");
		this.clientSocket = socket;
		this.hello = void 0;
		this.connectedAt = /* @__PURE__ */ new Date();
		this.continuationRemainder = "";
		this.continuationOpen = false;
		this.log(`extension connected from ${socket.remoteAddress}:${socket.remotePort}`);
		const reader = new FrameReader();
		socket.on("data", (chunk) => {
			reader.push(chunk);
			try {
				reader.drain((frame) => this.handleFrame(frame));
			} catch (error) {
				this.log(`protocol error: ${errorMessage$1(error)}`);
				this.lastError = errorMessage$1(error);
				this.closeClientSocket(1002, "protocol error");
			}
		});
		socket.on("error", (error) => {
			this.logVerbose(`socket error: ${errorMessage$1(error)}`);
			this.closeClientSocket(1011, "server error");
		});
		socket.on("close", () => {
			if (this.clientSocket !== socket) return;
			this.closeClientSocket(1e3, "");
		});
	}
	handleFrame(frame) {
		switch (frame.opcode) {
			case 1:
			case 0:
				this.handleText(frame.payload.toString("utf8"), frame.fin, frame.opcode);
				return;
			case 8:
				this.closeClientSocket(1e3, "");
				return;
			case 9:
				this.clientSocket?.write(encodeControlFrame(10, frame.payload));
				return;
			default: return;
		}
	}
	handleText(text, fin, opcode) {
		if (opcode === 0 && !this.continuationOpen) return;
		if (opcode === 1) this.continuationRemainder = "";
		this.continuationOpen = opcode === 0 || !fin;
		this.continuationRemainder += text;
		if (!fin) return;
		const full = this.continuationRemainder;
		this.continuationRemainder = "";
		this.continuationOpen = false;
		let msg;
		try {
			msg = JSON.parse(full);
		} catch {
			this.logVerbose("dropped a non-JSON extension message");
			return;
		}
		if (msg.type === "hello") {
			const declared = typeof msg.protocol === "number" ? msg.protocol : 0;
			const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((c) => typeof c === "string") : void 0;
			this.hello = {
				client: typeof msg.client === "string" ? msg.client : "unknown",
				version: typeof msg.version === "string" ? msg.version : "unknown",
				protocol: declared,
				browser: msg.browser ?? {
					name: "unknown",
					version: "unknown",
					ua: ""
				},
				...capabilities !== void 0 ? { capabilities } : {}
			};
			this.log(`hello: client=${this.hello.client} v${this.hello.version} protocol=v${declared || "?"} browser=${this.hello.browser.name} ${this.hello.browser.version}${capabilities ? ` capabilities=${capabilities.length}` : ""}`);
			const note = this.protocolNote;
			if (note !== null) this.log(`protocol mismatch: ${note}`);
			return;
		}
		if (msg.type === "pong") return;
		if (msg.type === "result" && typeof msg.id === "string") {
			const entry = this.pending.get(msg.id);
			if (entry === void 0) {
				this.logVerbose(`result for unknown id ${msg.id}`);
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok === true) entry.resolve(msg.result);
			else entry.reject(new Error(typeof msg.error === "string" && msg.error.length > 0 ? msg.error : "unknown extension error"));
		}
	}
	closeClientSocket(code, reason) {
		const socket = this.clientSocket;
		if (socket === void 0) return;
		this.clientSocket = void 0;
		this.hello = void 0;
		this.connectedAt = void 0;
		this.failAllPending(/* @__PURE__ */ new Error("the browser extension disconnected mid-command"));
		try {
			socket.write(encodeCloseFrame(code, reason));
			socket.end();
			setTimeout(() => socket.destroy(), 500).unref();
		} catch {
			socket.destroy();
		}
		if (reason.length > 0) this.log(`extension disconnected (${reason})`);
	}
	failAllPending(error) {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
	logVerbose(line) {
		this.options.log?.(line);
	}
};
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Constant-time token comparison; a length mismatch is the only thing leaked. */
function tokenMatches(presented, expected) {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
/**
* `Host` must name the loopback address this server binds. Rejecting anything else is
* what stops a rebinding setup (a public hostname resolving to 127.0.0.1) from reaching
* the bridge through the browser.
*/
function isLoopbackHost(host) {
	const withoutPort = host.replace(/:\d+$/, "");
	return withoutPort === "127.0.0.1" || withoutPort === "localhost" || withoutPort === "[::1]" || withoutPort === "::1";
}
/**
* An `Origin` of a web scheme means a page opened the socket — WebSocket handshakes are
* not covered by CORS, so that has to be refused here. Extension schemes (`chrome-extension:`
* etc.) and non-browser clients that send no Origin at all are accepted.
*/
function isTrustedUpgradeOrigin(origin) {
	if (origin === "") return true;
	if (/^(?:chrome|moz|ms|safari)-extension:\/\//.test(origin)) return true;
	return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin);
}
/** Minimal self-refreshing status page with the cleanup action. */
function statusPageHtml(port) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Browser Control — 状态</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--dim:#94a3b8;
        --green:#22c55e;--green-bg:rgba(34,197,94,.12);--red:#ef4444;--red-bg:rgba(239,68,68,.10)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);
       color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:440px;width:100%;overflow:hidden}
  .head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--red)}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .head h1{font-size:15px;font-weight:600}.head small{color:var(--dim);font-size:11px}
  .rows{padding:16px 24px}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;
       border-bottom:1px solid var(--border);font-size:13px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--dim)}.row .v{font-weight:500;text-align:right;max-width:260px;word-break:break-all}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
  .badge.on{background:var(--green-bg);color:var(--green)}.badge.off{background:var(--red-bg);color:var(--red)}
  .actions{padding:8px 24px;display:flex;gap:8px}
  .btn{padding:7px 14px;border:1px solid var(--border);border-radius:9px;background:var(--card);
       color:var(--text);font-size:12px;cursor:pointer}.btn:hover{background:#334155}
  .btn.danger{border-color:var(--red);color:var(--red)}.btn.danger:hover{background:var(--red-bg)}
  .tok{flex:1;min-width:150px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;
       background:var(--bg);color:var(--text);font-size:12px}
  .hint{color:var(--dim);font-size:11px;padding:4px 24px 8px}
  .pre{background:var(--bg);border-top:1px solid var(--border);padding:12px 24px}
  .pre code{color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-all}
  .foot{text-align:center;padding:12px;font-size:11px;color:var(--dim)}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="dot" id="dot"></div>
    <div><h1>DSH Browser Control</h1><small id="sub">加载中…</small></div>
  </div>
  <div class="rows" id="rows"></div>
  <div class="actions">
    <input class="tok" id="token" type="password" placeholder="桥接 Token（清理按钮需要）" autocomplete="off">
    <button class="btn" onclick="refresh()">刷新</button>
    <button class="btn danger" id="cleanup">🧹 清理截图 + 脚本草稿</button>
  </div>
  <div class="hint">Token 只保存在本次浏览器会话（sessionStorage），不写盘；留空则点按钮时询问。/api/command 与 /api/cleanup 现在都要求带 Token。</div>
  <div class="pre"><code id="raw"> </code></div>
  <div class="foot">DSH Browser Bridge · 127.0.0.1:${port}</div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    const connected=j.extensionConnected;
    document.getElementById('dot').className='dot'+(connected?' on':'');
    document.getElementById('sub').textContent=connected
      ?(j.hello?j.hello.client+' '+j.hello.browser.name+' '+j.hello.browser.version:'已连接')
      :'等待浏览器扩展连接…';
    const rows=[
      ['监听端口','<span class="badge on">'+j.port+'</span>'],
      ['扩展状态',connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>'],
      ['扩展类型',j.hello?(j.hello.client+' v'+j.hello.version):'—'],
      ['浏览器',j.hello?(j.hello.browser.name+' '+j.hello.browser.version):'—'],
      ['等待命令',String(j.pendingCommands??0)],
      ['连接时间',j.connectedAt?new Date(j.connectedAt).toLocaleString():'—'],
      ['截图目录',j.shotsDir||'—'],
      ['令牌强度',j.insecureToken?'<span class="badge off">默认/过短，建议改了</span>':'<span class="badge on">已自定义</span>'],
      ['协议版本','桥 v'+j.bridgeProtocol+' / 扩展 v'+(j.extensionProtocol||'?')+(j.protocolCompatible?'':' <span class="badge off">不匹配</span>')],
    ];
    if(j.protocolNote) rows.push(['协议提示','<span style="color:var(--red)">'+j.protocolNote+'</span>']);
    document.getElementById('rows').innerHTML=rows.map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>').join('');
    document.getElementById('raw').textContent=JSON.stringify(j,null,2);
  }catch(e){document.getElementById('sub').textContent='连接失败: '+e.message}
}
function bridgeToken(){
  const el=document.getElementById('token');
  let t=(el.value||'').trim()||sessionStorage.getItem('dshBridgeToken')||'';
  if(!t){ t=(prompt('桥接 Token（在 profile 的 browser-bridge 配置里，token 字段）')||'').trim(); el.value=t; }
  if(t) sessionStorage.setItem('dshBridgeToken',t);
  return t;
}
document.getElementById('cleanup').onclick=async()=>{
  if(!confirm('确认清理截图与临时脚本？'))return;
  const r=await fetch('/api/cleanup',{method:'POST',headers:{'Authorization':'Bearer '+bridgeToken()}});
  const j=await r.json();
  if(r.status===401){alert('Token 不对，清理没有执行。');return;}
  alert(j.ok?('已删除 '+j.shotsRemoved+' 个截图，'+j.scratchRemoved.length+' 个草稿'):('失败：'+j.error));
  refresh();
};
refresh();setInterval(refresh,2000);
<\/script>
</body></html>`;
}
//#endregion
//#region lib/types/policy.js
/**
* 本机策略闸门：只读档（`readOnly`）与脚本开关（`allowScript`）。
*
* 这两张表与 `errors.ts` 里的 `WRITE_COMMANDS` **故意不是同一张**，别合并：
*
*   - `WRITE_COMMANDS` 回答「超时或掉线之后重试，会不会多留一次副作用」，那是
*     `effectState` 的语义。所以 `tabs.group` / `tabs.ungroup` 在那里**刻意算只读**：
*     重复把标签归进同一个组是空操作，重试安全。
*   - 这里回答的是「这条命令会不会改变页面、文件或浏览器状态」，用户开只读档时想要的
*     正是这个。所以 `tabs.group` / `tabs.ungroup` / `tabs.activate` / `emulate` /
*     `dialog` / `network.clear` 都不在白名单里。
*
* 白名单是**默认拒绝**：扩展以后新增一条命令，它自动被只读档拦下，等人判断完再放进来。
* `verify/verify_policy.mjs` 会把扩展 `COMMANDS` 表逐条对账，让这个判断无法被跳过。
*
* 第三张表 `LOCAL_DESTRUCTIVE_COMMANDS` 是给**不经过扩展**的插件本地命令的：闸门如果只长在
* `execute()` 上，这类调用就整个绕开只读档（`browser_cleanup` 合并进来时正是这样）。
*/
/** 只读档允许的命令：读页面、读扩展自己的缓冲、或者把页面**内容**落到本机文件。 */
const READ_ONLY_ALLOWED = /* @__PURE__ */ new Set([
	"ping",
	"browser.info",
	"content",
	"find",
	"snapshot",
	"screenshot",
	"pdf",
	"wait",
	"tabs.list",
	"console.log",
	"network.log",
	"windows.list",
	"cookies.get",
	"metrics"
]);
/**
* 会执行**任意页面脚本**的扩展命令。这条与只读档分开管，因为用户可能想「可以读、
* 也可以点，但别在我页面里跑任意 JS」——`browser_evaluate` 能绕开其他所有工具做的事。
*
* **按命令名判不够**：`wait` 的 `fn` 参数同样是在页面里执行任意 JS（扩展侧用
* `(${fn})()` 求出谓词），只按名字看它会从只读白名单和脚本开关两道门缝里同时漏过去。
* 所以真正判「是不是脚本」的是下面 `isScriptCall()`：命令名 + 参数一起看，
* `wait(selector)` / `wait(text)` 仍按只读处理，`wait({fn})` 与 `eval` 同档。
*/
const SCRIPT_COMMANDS = /* @__PURE__ */ new Set(["eval"]);
/**
* 这次调用会不会在页面里执行任意 JS。判据是「这次实际要做的动作」，不是命令名：
* `wait` 只有带 `fn` 时才升级为脚本调用（`selector` / `text` 是纯查询）。
*/
function isScriptCall(command, params) {
	if (SCRIPT_COMMANDS.has(command)) return true;
	return command === "wait" && typeof params?.fn === "string" && params.fn.trim().length > 0;
}
/**
* 不经过扩展、直接在插件进程里改动本机文件的命令名。
*
* `browser_cleanup` 走 `BridgeController.cleanup()`，**不经过 `execute()`**，所以它天然
* 绕开了上面两张表管的那条路。只读档下仍然能删掉用户的整个截图目录，这正是「只读」
* 最不该允许的动作，所以单独列一张表，并且由 `cleanup()` 自己调闸门。
*/
const LOCAL_DESTRUCTIVE_COMMANDS = /* @__PURE__ */ new Set(["cleanup"]);
/**
* 明确登记「会改页面 DOM」的命令 —— 只读档里必须拒，理由写在名字旁边。
*
* 现在只有 `hold`（接管浮层）：它往页面 `<html>` 下插一个宿主元素。默认拒绝其实已经
* 盖住它（不在 `READ_ONLY_ALLOWED` 里），但「默认拒绝是对的」不等于「不需要解释」：
* 这一条要的不是安全性，是**拒绝理由**——告诉模型为什么一个「只是提示用户」的动作
* 在只读档里也算写操作。
*
* `hold` 是一条命令带 `action`（on/off/status）：on/off 改 DOM，**status 只读**
* （它读 session 里的条目 + 探一下页面上还有没有那层宿主），所以只读档放行 status。
* 这也是 `policyRefusal` 唯一需要看参数的地方——判据是「这个动作改不改东西」，
* 不是「这个命令名字在不在表里」。
*/
const PAGE_MUTATING_COMMANDS = /* @__PURE__ */ new Set(["hold"]);
const CONFIG_HINT = "开关在 profile 的 cordis.patch.yml 里（browser-bridge 的 config），改完重启 dsh；dsh 0.1.7+ 的宿主也会在「设置 → 插件」里直接列出这两项";
/**
* 判断一条命令是否被本机策略拦下。
* @param command - 扩展命令名（`click` / `eval` / `tabs.close` …），或 `LOCAL_DESTRUCTIVE_COMMANDS` 里的插件本地命令名。
* @param flags - 当前的两个闸门值。
* @param params - 这条命令的参数；只有带动作的命令（目前是 `hold`）需要它来分辨「这个动作改不改东西」。
* @returns 拒绝时写给 agent 的整句理由；放行时 `undefined`。
*/
function policyRefusal(command, flags, params) {
	const scriptCall = isScriptCall(command, params);
	if (!flags.allowScript && scriptCall) return `在页面里执行任意脚本已被关闭（allowScript: false）：${command === "wait" ? "命令 wait 的 fn 参数（会在页面里执行任意 JS）被拒绝" : `命令 ${command} 被拒绝`}，没有向浏览器发出任何操作。要等页面就绪请改用 wait 的 selector / text（只读），读页面内容用 browser_read / browser_snapshot / browser_find；确实需要执行脚本时，${CONFIG_HINT}之后再说。`;
	if (flags.readOnly && command === "wait" && scriptCall) return `只读模式已开启（readOnly: true）：命令 wait 的 fn 参数会在页面里执行任意 JS（可能改变页面状态），已被拒绝，没有向浏览器发出任何操作。要等页面就绪请改用 wait 的 selector / text（只读）；要放开请由用户关掉 readOnly，${CONFIG_HINT}不要原地重试本命令。`;
	if (flags.readOnly && LOCAL_DESTRUCTIVE_COMMANDS.has(command)) return `只读模式已开启（readOnly: true）：命令 ${command} 会删除本机保存的截图与临时文件，删除不可逆，所以已被拒绝，没有任何文件被删除。只读档的含义是「什么都不要改」，清理属于改动；要释放磁盘请由用户自己关掉 readOnly，${CONFIG_HINT}。不要原地重试本命令。`;
	const isReadOnlyAction = command === "hold" && params?.action === "status";
	if (flags.readOnly && PAGE_MUTATING_COMMANDS.has(command) && !isReadOnlyAction) return `只读模式已开启（readOnly: true）：命令 ${command} 会往页面里插入一层接管浮层（改页面 DOM），已被拒绝，没有向浏览器发出任何操作。浮层是给用户看的提示层，不是安全边界；只读档里连这种「只是提示」的改动也一并拒绝。要开浮层请由用户关掉 readOnly，${CONFIG_HINT}不要原地重试本命令。`;
	if (flags.readOnly && !READ_ONLY_ALLOWED.has(command) && !isReadOnlyAction) return `只读模式已开启（readOnly: true）：命令 ${command} 会改变页面或浏览器状态，已被拒绝，没有向浏览器发出任何操作。只读模式下可用的工具是读页面与读日志那几类；要放开写操作，${CONFIG_HINT}不要原地重试本命令。`;
}
/** 单条参数摘要上限：审计要的是形状，不是全文。 */
const AUDIT_PARAMS_MAX_CHARS = 300;
/** 失败描述上限。 */
const AUDIT_ERROR_MAX_CHARS = 200;
/** eval 表达式只留前 120 字符：里面可能有凭据。 */
const AUDIT_EXPRESSION_MAX_CHARS = 120;
/** 参数里这些键的值一律打码（大小写不敏感）。 */
const SECRET_KEY = /^(token|authorization|password|passwd|secret|apikey|api_key|cookie)$/i;
/**
* 哪个命令的 `value` 字段是敏感内容：`input` 是往页面里打的字（可能是密码），
* `cookies.set` 直接写凭据。其余命令的 value 字段（如果有）不动。
*/
const VALUE_REDACTED_COMMANDS = /* @__PURE__ */ new Set(["input", "cookies.set"]);
function redactValue(value) {
	return `[redacted:${typeof value === "string" ? [...value].length : 0} chars]`;
}
/**
* 把一次调用的参数压成可审计的摘要：敏感键打码、特定命令的 value 打码、
* 长表达式截断、整体限长。返回 JSON 文本——审计工具原样把它交给模型。
*/
function summarizeAuditParams(command, params) {
	let text;
	try {
		text = JSON.stringify(params, (key, value) => {
			if (SECRET_KEY.test(key)) return "[redacted]";
			if (key === "value" && VALUE_REDACTED_COMMANDS.has(command)) return redactValue(value);
			if (key === "expression" && typeof value === "string" && [...value].length > AUDIT_EXPRESSION_MAX_CHARS) return `${[...value].slice(0, AUDIT_EXPRESSION_MAX_CHARS).join("")}…[+${[...value].length - AUDIT_EXPRESSION_MAX_CHARS} chars]`;
			return value;
		}) ?? "{}";
	} catch {
		text = "[unserializable params]";
	}
	return [...text].length > AUDIT_PARAMS_MAX_CHARS ? `${[...text].slice(0, AUDIT_PARAMS_MAX_CHARS).join("")}…[+${[...text].length - AUDIT_PARAMS_MAX_CHARS} chars]` : text;
}
/** 记账器。一个桥（一个插件实例）一份；`record` 只追加，`list` 只读。 */
var AuditLog = class {
	entries = [];
	nextSeq = 1;
	now;
	constructor(now = Date.now) {
		this.now = now;
	}
	/**
	* 记一笔。
	* @param input - 命令、摘要与结果；seq/t 由账本自己盖，durationMs 由调用方量。
	*/
	record(input) {
		const entry = {
			seq: this.nextSeq++,
			t: this.now(),
			command: input.command,
			params: input.params,
			ok: input.ok,
			durationMs: Math.max(0, Math.round(input.durationMs))
		};
		if (input.tabId !== void 0) entry.tabId = input.tabId;
		if (input.code !== void 0) entry.code = input.code;
		if (input.effectState !== void 0) entry.effectState = input.effectState;
		if (input.error !== void 0) entry.error = [...input.error].length > AUDIT_ERROR_MAX_CHARS ? `${[...input.error].slice(0, AUDIT_ERROR_MAX_CHARS).join("")}…` : input.error;
		this.entries.push(entry);
		if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
		return entry;
	}
	/** 现有条目数（被挤掉的不算）。 */
	size() {
		return this.entries.length;
	}
	/**
	* 过滤并取最新的一批。
	* @param filter - tabId / 命令子串 / sinceSeq / limit；返回按 seq 升序。
	*/
	list(filter = {}) {
		let matched = this.entries;
		if (filter.tabId !== void 0) matched = matched.filter((e) => e.tabId === filter.tabId);
		if (filter.command !== void 0 && filter.command.length > 0) {
			const needle = filter.command.toLowerCase();
			matched = matched.filter((e) => e.command.toLowerCase().includes(needle));
		}
		if (filter.sinceSeq !== void 0) {
			const floor = filter.sinceSeq;
			matched = matched.filter((e) => e.seq > floor);
		}
		const limit = Math.min(200, Math.max(1, Math.trunc(filter.limit ?? 50)));
		return matched.slice(Math.max(0, matched.length - limit));
	}
};
//#endregion
//#region lib/types/journal.js
/**
* 会话恢复（v1.7.5）：把审计账本持久化到磁盘，dsh 重启以后还查得到上一个会话做过什么。
*
* 为什么是文件而不是数据库：一条命令一行 JSONL，出问题时能直接打开看、能 grep、
* 写坏了最多丢一行（读到坏行跳过，不炸整本账）。上限 1000 行，超了在**启动时**
* 裁掉最旧的——运行中不裁剪，append 永远是纯追加。
*
* 隐私与审计同一套：写盘的就是 AuditLog 里那份脱敏后的摘要（输入值/cookie 值已
* 打码），journal 层不再碰原始参数。文件在 <stateDir>/journal.jsonl，stateDir
* 默认 ~/.dsh-browser-control，可在 profile 的 browser-bridge 配置里改。
*/
/** 磁盘上最多保留的条数（启动时裁剪）。 */
const JOURNAL_MAX_LINES = 1e3;
/** 防御性上限：正常文件远小于它；超过就只读尾巴，别为了一本账吃掉内存。 */
const JOURNAL_MAX_BYTES = 8388608;
function isEntry(value) {
	if (value === null || typeof value !== "object") return false;
	const v = value;
	return typeof v.run === "string" && typeof v.command === "string" && typeof v.seq === "number" && typeof v.t === "number" && typeof v.params === "string" && typeof v.ok === "boolean" && typeof v.durationMs === "number";
}
/** 拆行并解析；坏行（截断、手改坏）跳过——一本账不能因为一行烂掉就全废。 */
function parseLines(text) {
	const out = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line);
			if (isEntry(parsed)) out.push(parsed);
		} catch {}
	}
	return out;
}
/**
* 打开（并按需裁剪）一个 journal 目录。
* @param stateDir - 目录（不存在会创建）；journal 文件是 `<stateDir>/journal.jsonl`。
* @param log - 一行式日志；打开/裁剪的结论写进去。
* @returns 带 run 编号的追加器；`close()` 等所有在途写入落盘。
*/
var Journal = class Journal {
	/** 这次运行的编号：启动时刻（毫秒精度；秒级精度下两次启动同秒会撞号）。 */
	runId;
	file;
	log;
	chain = Promise.resolve();
	warned = false;
	constructor(file, runId, log) {
		this.file = file;
		this.runId = runId;
		this.log = log;
	}
	static async open(stateDir, log) {
		await mkdir(stateDir, { recursive: true });
		const file = path.join(stateDir, "journal.jsonl");
		let existing = [];
		try {
			const text = await readFile(file, "utf8");
			existing = parseLines(text.length > JOURNAL_MAX_BYTES ? text.slice(-8388608) : text);
		} catch {}
		if (existing.length > 1e3) {
			const kept = existing.slice(existing.length - JOURNAL_MAX_LINES);
			const tmp = `${file}.tmp`;
			await writeFile(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
			await rename(tmp, file);
			log(`journal: pruned ${existing.length - kept.length} old entries (${JOURNAL_MAX_LINES} kept)`);
		} else if (existing.length > 0) {
			const last = existing[existing.length - 1];
			log(`journal: restored context — ${existing.length} entries on disk, last from run ${last.run} (#${last.seq} ${last.command})`);
		}
		return new Journal(file, (/* @__PURE__ */ new Date()).toISOString().slice(0, 23).replace("T", " "), log);
	}
	/**
	* 追加一条（异步、排队写；失败只告警一次，绝不阻塞命令路径）。
	* @param entry - AuditLog 刚记下的条目（参数已脱敏）。
	*/
	append(entry) {
		const line = `${JSON.stringify({
			run: this.runId,
			...entry
		})}\n`;
		this.chain = this.chain.then(() => appendFile(this.file, line, "utf8")).catch((error) => {
			if (!this.warned) {
				this.warned = true;
				this.log(`journal: write failed — ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}
	/** 等在途写入落盘（teardown / 测试用）。 */
	async close() {
		await this.chain.catch(() => {});
	}
};
/**
* 读 journal 的尾部（不要求 Journal 实例——读在线程外也能工作，扩展离线也行）。
* @param stateDir - journal 所在目录。
* @param filter - tabId / 命令子串 / 条数（默认 50，最大 500；取最新）。
*/
async function readJournal(stateDir, filter = {}) {
	let text;
	try {
		text = await readFile(path.join(stateDir, "journal.jsonl"), "utf8");
	} catch {
		return {
			total: 0,
			entries: []
		};
	}
	if (text.length > JOURNAL_MAX_BYTES) text = text.slice(-8388608);
	let matched = parseLines(text);
	if (filter.tabId !== void 0) matched = matched.filter((e) => e.tabId === filter.tabId);
	if (filter.command !== void 0 && filter.command.length > 0) {
		const needle = filter.command.toLowerCase();
		matched = matched.filter((e) => e.command.toLowerCase().includes(needle));
	}
	const limit = Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 50)));
	return {
		total: matched.length,
		entries: matched.slice(Math.max(0, matched.length - limit))
	};
}
//#endregion
//#region lib/types/sessions.js
var SessionRegistry = class {
	sessions = /* @__PURE__ */ new Map();
	/** 记一次活动（无论成败）。 */
	touch(sessionId) {
		const now = Date.now();
		const existing = this.sessions.get(sessionId);
		if (existing === void 0) {
			this.sessions.set(sessionId, {
				sessionId,
				lastActiveAt: now,
				calls: 1,
				createdAt: now
			});
			return;
		}
		existing.lastActiveAt = now;
		existing.calls += 1;
	}
	/** 把某个标签页记为这个会话的工作标签页。 */
	adopt(sessionId, tabId) {
		const state = this.sessions.get(sessionId);
		if (state === void 0) {
			this.sessions.set(sessionId, {
				sessionId,
				workingTabId: tabId,
				lastActiveAt: Date.now(),
				calls: 0,
				createdAt: Date.now()
			});
			return;
		}
		state.workingTabId = tabId;
		state.lastActiveAt = Date.now();
	}
	/** 当前记录的工作标签页（不核对是否还开着——核对是控制器的事）。 */
	workingTab(sessionId) {
		return this.sessions.get(sessionId)?.workingTabId;
	}
	/** 清掉工作标签页；返回被清掉的 id。 */
	release(sessionId) {
		const state = this.sessions.get(sessionId);
		if (state === void 0) return void 0;
		const previous = state.workingTabId;
		state.workingTabId = void 0;
		return previous;
	}
	/** 全部会话，最近活跃的在前。 */
	list() {
		return [...this.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map((s) => {
			const info = {
				sessionId: s.sessionId,
				lastActiveAt: s.lastActiveAt,
				calls: s.calls
			};
			if (s.workingTabId !== void 0) info.workingTabId = s.workingTabId;
			return info;
		});
	}
	size() {
		return this.sessions.size;
	}
};
//#endregion
//#region lib/types/index.js
/**
* Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
* extension connects to, plus the model-facing `browser_*` tools that drive
* it. The Settings-managed `enabled` flag starts and stops the listener live
* through dsh-settings' change hook — no reload needed.
*
* Settings integration is feature-detected, never assumed. The plugin bypasses the
* higher-level `installSettingsSection` helper (importing it on a build that does not
* export it crashes the plugin at module load) and calls the lower-level
* `sctx.settings.register` only when the host actually has it — dsh-settings up to
* 0.1.2-rc.1. 0.1.7-rc.2 and 0.2.x export `SettingsForms` with no `register`, so there
* the bridge converges from the profile config alone and the host projects this
* plugin's own `Config` schema into the settings page.
*
* Tools stay mounted whenever the plugin does; calling one while the bridge
* is disabled or the extension is offline fails with a message naming the
* fix, so the model can tell the user what to do instead of hanging.
* @module @deepseek-ai/dsh-browser-bridge
*/
/** Navigation wait ceiling (same as browser_wait); the bridge gets this plus BRIDGE_MARGIN_MS. */
const NAV_MAX_MS = 12e4;
/**
* Same tier table as the extension's NAV_TIERS (extension/background.js). Both
* literals must stay in lockstep — verify_nav_waituntil.mjs extracts the
* extension's by regex and asserts the two agree (cross-side literals are wire
* protocol: a value only one side knows is a lie on the other).
*/
const NAV_TIERS = {
	none: 0,
	commit: 4e3,
	domcontentloaded: 4e3,
	load: 15e3
};
/**
* Commands whose params carry no meaningful single tab: link probes, tab
* management, window management and the global dialog policy. Everything else
* defaults to the calling session's working tab when tabId is omitted
* (v1.7.6 isolation). New tab-scoped commands need no registration here —
* they inherit the default, which is the safe direction.
*/
const NO_TAB_DEFAULT_COMMANDS = /* @__PURE__ */ new Set([
	"ping",
	"browser.info",
	"tabs.list",
	"tabs.open",
	"tabs.group",
	"tabs.ungroup",
	"windows.list",
	"windows.open",
	"windows.update",
	"windows.close",
	"windows.moveTab",
	"dialog"
]);
/**
* Extra time handed to the bridge on top of the navigation budget. Without it a
* caller-requested budget longer than the bridge default (60s) would be beaten by
* the bridge, and the model would get `command_timeout` (effect unknown) instead
* of a navigation timeout (nothing was touched) - two very different next steps.
*/
const BRIDGE_MARGIN_MS = 2e3;
/**
* 每个工具体都跑在调用方 agent 的会话上下文里（exec.agent.id）。控制器用它
* 解析「这个会话的工作标签页」。没有 agent 身份的调用（HTTP 面、测试、老宿主）
* store 是 undefined，行为与以前完全一致。
*/
const TOOL_SESSION = new AsyncLocalStorage();
/**
* 包一层宿主的 defineTool：注册处全部走这里，工具体自动带上会话上下文。
* 这是 v1.7.6 多 session 隔离能集中实现、而不用改二十多处 execute 的原因。
*/
function defineTool$1(options) {
	const inner = options.execute;
	const execute = ((args, exec) => {
		const agent = exec.agent;
		const sessionId = typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : void 0;
		return TOOL_SESSION.run(sessionId, () => inner(args, exec));
	});
	return defineTool({
		...options,
		execute
	});
}
/** Cordis plugin name used by loader diagnostics. */
const name = "browser-bridge";
/** The tool registry this plugin contributes `browser_*` tools to. */
const inject = ["tools", "systemPrompt"];
/** Settings namespace carrying the bridge switch and endpoint options. */
const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
const Config = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65535).default(9777),
	token: z.string().default("dsh-local"),
	shotsDir: z.string().default("dsh-browser-shots"),
	stateDir: z.string().default(path.join(homedir(), ".dsh-browser-control")),
	readOnly: z.boolean().default(false),
	allowScript: z.boolean().default(true)
});
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
/** One `browser_read` window, in characters of page text. Longer pages are paged
*  with `offset`, so no single call can put a whole site into the transcript. */
const READ_WINDOW_MAX_CHARS = 2e4;
/**
* Extension command surface, as deltas over the pre-1.5 baseline. Used when a
* connected extension predates the capability handshake (no `capabilities` in
* its hello frame): the plugin maps its reported version to the commands it
* must have. Anything not listed here exists since the baseline and is assumed
* present; a version newer than every entry is assumed to have everything
* (forward compatible — an extension never removes commands).
*/
const EXTENSION_COMMANDS_BY_VERSION = [
	{
		since: "1.5.0",
		commands: ["archive"]
	},
	{
		since: "1.6.0",
		commands: [
			"windows.list",
			"windows.open",
			"windows.update",
			"windows.close",
			"windows.moveTab"
		]
	},
	{
		since: "1.7.0",
		commands: ["tabs.back", "tabs.forward"]
	},
	{
		since: "1.7.1",
		commands: ["metrics"]
	},
	{
		since: "1.7.2",
		commands: ["cdp"]
	}
];
/** Compare two `x.y.z` version strings numerically; unparseable input sorts lowest. */
function compareVersions(a, b) {
	const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) ?? []).slice(1).map(Number);
	const [pa, pb] = [parse(a), parse(b)];
	if (pa.length === 0 || pb.length === 0) return pa.length === pb.length ? 0 : pa.length === 0 ? -1 : 1;
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}
/**
* The plugin updated, the extension did not: the invariant is that this combo is
* never WORSE than the matched pair from the extension's era — existing tools
* behave identically, and tools that need commands the old extension lacks fail
* with an actionable upgrade pointer instead of a raw "unknown command".
*/
function extensionOutdatedError(have, command, since) {
	const message = "extension-outdated: the connected browser extension" + (have === void 0 ? "" : ` (v${have})`) + ` does not have the "${command}" command this action needs (added in extension v${since}). One-time fix: download DSH-Browser-Control.zip from https://github.com/angelky7/dsh-browser-control/releases/latest, unzip, then chrome://extensions → Developer mode → replace the loaded folder (remove the old one first). That update makes the extension compatible with all future plugin updates — CDP-level features ship plugin-side from v1.7.2 on.`;
	const error = new Error(message);
	error.code = "extension_outdated";
	return error;
}
/**
* Owns zero or one live {@link BridgeServer} and restarts it whenever the
* resolved settings change. Reconciles serialize through a promise chain so a
* burst of settings commits cannot interleave stop/start pairs.
*/
var BridgeController = class {
	log;
	server;
	serverKey = "";
	lastError;
	chain = Promise.resolve();
	current;
	journal;
	journalKey = "";
	/** 操作审计账本（内存环形缓冲，200 条；命令层记录，见 audit.ts 顶部注释）。 */
	audit = new AuditLog();
	/** 多 session 隔离：每个 dsh 会话的工作标签页（见 sessions.ts）。 */
	sessions = new SessionRegistry();
	constructor(log) {
		this.log = log;
	}
	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir() {
		return this.current === void 0 ? void 0 : path.resolve(this.current.shotsDir);
	}
	/** 审计账本落盘目录；配置到达之前是 undefined。 */
	get stateDir() {
		return this.current === void 0 ? void 0 : path.resolve(this.current.stateDir);
	}
	/**
	* Record one audit entry in memory and, when the journal is open, on disk.
	* Journal appends are queued and never block the command path.
	*/
	recordAudit(input) {
		const entry = this.audit.record(input);
		this.journal?.append(entry);
	}
	/**
	* Current policy flags. Tools that compose several commands (browser_drag
	* runs `cdp`/`eval`) read this to refuse with a tool-level message; the
	* per-command gate in execute() stays as the enforcement backstop.
	*/
	get policy() {
		return {
			readOnly: this.current?.readOnly === true,
			allowScript: this.current?.allowScript !== false
		};
	}
	/** Version the connected extension reported in its hello frame, if any. */
	extensionVersion() {
		return this.server?.status.hello?.version;
	}
	/**
	* Whether the connected extension implements `command`. Exact when the hello
	* carries a capabilities list (v1.7.2+); otherwise derived from the reported
	* version via the surface-delta map. No connection ⇒ true: the not-enabled
	* error from execute is the right failure there, not a capability complaint.
	*/
	hasExtensionCommand(command) {
		const hello = this.server?.status.hello;
		if (hello?.capabilities !== void 0) return hello.capabilities.includes(command);
		const version = hello?.version;
		if (version === void 0 || version === "unknown") return true;
		const entry = EXTENSION_COMMANDS_BY_VERSION.find((e) => e.commands.includes(command));
		if (entry === void 0) return true;
		return compareVersions(version, entry.since) >= 0;
	}
	/**
	* Pre-flight capability gate: throw the actionable upgrade error before the
	* command is sent, so an old extension answers with a what-to-do, never with
	* a bare "unknown command" the model cannot act on.
	*/
	requireExtensionCommand(command, since) {
		if (this.hasExtensionCommand(command)) return;
		this.recordAudit({
			command,
			params: "",
			ok: false,
			code: "extension_outdated",
			effectState: "not_started",
			error: `connected extension v${this.extensionVersion() ?? "?"} lacks ${command} (added in ${since})`,
			durationMs: 0
		});
		throw extensionOutdatedError(this.extensionVersion(), command, since);
	}
	/**
	* Converge the live server onto `config`. With `throwOnError`, an initial
	* start failure rejects (fail-loud activation); later changes record the
	* failure instead, so a bad port cannot tear down an otherwise running session.
	* @param config - the freshly resolved settings snapshot.
	* @param options - set `throwOnError` only for the activation-time call.
	* @returns a promise settling once the convergence attempt finished.
	*/
	reconcile(config, options = {}) {
		this.current = config;
		const run = this.chain.then(() => this.reconcileNow(config));
		this.chain = run.catch(() => {});
		if (options.throwOnError === true) return run.catch((error) => {
			throw error instanceof Error ? error : new Error(String(error));
		});
		return Promise.resolve();
	}
	async reconcileNow(config) {
		const shotsDir = path.resolve(config.shotsDir);
		const stateDir = path.resolve(config.stateDir);
		if (stateDir !== this.journalKey) {
			const previousJournal = this.journal;
			this.journal = void 0;
			this.journalKey = stateDir;
			await previousJournal?.close();
			try {
				this.journal = await Journal.open(stateDir, this.log);
			} catch (error) {
				this.log(`journal: disabled — ${errorMessage(error)}`);
			}
		}
		const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : "";
		if (key === this.serverKey) return;
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		await previous?.stop();
		if (!config.enabled) {
			this.lastError = void 0;
			return;
		}
		const server = new BridgeServer({
			port: config.port,
			token: config.token,
			shotsDir,
			log: this.log
		});
		try {
			await server.start();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
			this.log(this.lastError);
			throw error instanceof Error ? error : new Error(message);
		}
		this.server = server;
		this.serverKey = key;
		this.lastError = void 0;
	}
	/**
	* Run one extension command over the live link.
	* @param command - extension command name (`nav`, `click`, …).
	* @param params - wire params passed through to the extension.
	* @param signal - tool-execution cancellation propagated to the pending command.
	* @param timeoutMs - per-command bridge ceiling; omit for the default. Commands
	*   that wait inside the page (browser_wait) must pass a value larger than their
	*   own page-level timeout, otherwise the bridge aborts first and the caller
	*   cannot tell a slow page from a dead link.
	* @returns the extension's result payload verbatim.
	*/
	async execute(command, params, signal, timeoutMs) {
		const started = Date.now();
		const sessionId = TOOL_SESSION.getStore();
		const resolved = sessionId === void 0 ? params : await this.isolateParams(command, params, sessionId, signal);
		const summary = summarizeAuditParams(command, resolved);
		const tabId = typeof resolved.tabId === "number" ? resolved.tabId : void 0;
		try {
			this.policyGate(command, resolved);
			const server = this.server;
			if (server === void 0) throw classify(command, new Error(this.lastError ?? "浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）"));
			const result = await server.execute(command, resolved, timeoutMs === void 0 ? { signal } : {
				signal,
				timeoutMs
			});
			if (sessionId !== void 0) this.noteSession(sessionId, resolved, result);
			this.recordAudit({
				command,
				tabId,
				params: summary,
				ok: true,
				durationMs: Date.now() - started
			});
			return result;
		} catch (error) {
			if (sessionId !== void 0) this.sessions.touch(sessionId);
			const code = error.code;
			const effectState = error.effectState;
			this.recordAudit({
				command,
				tabId,
				params: summary,
				ok: false,
				code: typeof code === "string" ? code : void 0,
				effectState: typeof effectState === "string" ? effectState : void 0,
				error: errorMessage(error),
				durationMs: Date.now() - started
			});
			throw error;
		}
	}
	/**
	* Apply per-session tab isolation: when a call omits `tabId`, default it to
	* the calling session's working tab — but only after asking the extension
	* whether that tab is still open. A stale id must never fail a call that used
	* to work; when it is gone we forget it and let the browser's active tab
	* answer, exactly like before this feature existed.
	*/
	async isolateParams(command, params, sessionId, signal) {
		if (typeof params.tabId === "number" || NO_TAB_DEFAULT_COMMANDS.has(command)) return params;
		const recorded = this.sessions.workingTab(sessionId);
		if (recorded === void 0) return params;
		const server = this.server;
		if (server !== void 0) try {
			const listing = await server.execute("tabs.list", {}, { signal });
			if (!(Array.isArray(listing?.tabs) && listing.tabs.some((tab) => tab?.id === recorded))) {
				this.sessions.release(sessionId);
				return params;
			}
		} catch {}
		return {
			...params,
			tabId: recorded
		};
	}
	/** Record the call and adopt the tab it actually touched (params or result). */
	noteSession(sessionId, params, result) {
		this.sessions.touch(sessionId);
		if (typeof params.tabId === "number") this.sessions.adopt(sessionId, params.tabId);
		const resultTab = result?.tabId;
		if (typeof resultTab === "number") this.sessions.adopt(sessionId, resultTab);
	}
	/**
	* Refuse a command the local policy forbids, before anything is sent or deleted.
	*
	* The gate sits above the link and above the filesystem, not inside either: a
	* refused command must not leave a side effect behind. Reading `current` on every
	* call is what makes a settings edit take effect live.
	* @param command - extension command name, or a `LOCAL_DESTRUCTIVE_COMMANDS` name.
	* @param params - the command's params: action-bearing commands (`hold`) need them so a
	*   read-only action (`status`) is not judged by the command name alone.
	*/
	policyGate(command, params) {
		const refusal = policyRefusal(command, {
			readOnly: this.current?.readOnly === true,
			allowScript: this.current?.allowScript !== false
		}, params);
		if (refusal !== void 0) throw new BridgeError(command, "blocked_by_policy", "not_started", refusal);
	}
	/**
	* Delete generated artifacts using the currently resolved directories;
	* works while the bridge is stopped because it never touches the socket.
	* @returns counts and names of what was removed.
	*/
	async cleanup() {
		const started = Date.now();
		try {
			this.policyGate("cleanup");
			const dir = this.shotsDir;
			if (dir === void 0) throw classify("cleanup", /* @__PURE__ */ new Error("browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录"));
			try {
				const result = await cleanupArtifacts({ shotsDir: dir });
				this.recordAudit({
					command: "cleanup",
					params: "{}",
					ok: true,
					durationMs: Date.now() - started
				});
				return result;
			} catch (error) {
				throw classify("cleanup", error);
			}
		} catch (error) {
			const code = error.code;
			const effectState = error.effectState;
			this.recordAudit({
				command: "cleanup",
				params: "{}",
				ok: false,
				code: typeof code === "string" ? code : void 0,
				effectState: typeof effectState === "string" ? effectState : void 0,
				error: errorMessage(error),
				durationMs: Date.now() - started
			});
			throw error;
		}
	}
	/** Stop the listener; safe to call repeatedly and during teardown. */
	async stop() {
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		await (previous?.stop() ?? Promise.resolve());
		const journal = this.journal;
		this.journal = void 0;
		this.journalKey = "";
		await journal?.close();
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Cap one rendered payload and *say* it was cut. The previous fixed slices
* (200 / 300 / 400 / 600 / 1200 chars) cut JSON mid-token, so the model received
* malformed JSON with no sign that anything was missing. Click/type/press/scroll
* results are well under this cap, so they now arrive complete; bigger payloads
* are cut at a character boundary and marked twice: once for a human reading the
* card, once as a stable `[renderedTruncated …]` token an agent can parse to
* decide whether to re-issue a narrower query.
*/
const MAX_RENDERED_CHARS = 4e3;
function clampRendered(text, maxChars = MAX_RENDERED_CHARS) {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n… [renderedTruncated omittedChars=${omitted} limitChars=${maxChars}] narrow the query and call again to see the rest`;
}
/** Model-facing budget for one snapshot listing; `limit` narrows the listing. */
const SNAPSHOT_RENDER_MAX_CHARS = 8e3;
/** Model-facing budget for one console/network log listing. */
const LOG_RENDER_MAX_CHARS = 6e3;
/** Collapse one page-supplied field to a single line inside a rendered listing. */
function flattenOneLine(value, maxChars) {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
/** `HH:MM:SS` in UTC from an epoch-milliseconds stamp. */
function formatClock(epochMs) {
	return new Date(epochMs).toISOString().slice(11, 19);
}
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
/**
* Reduce one captured network row to the fields this tool declares. The buffer
* also carries request/response header maps and POST bodies; those stay out of
* the value, because the value never reaches the model and the header dump is
* what would blow the transcript.
*/
function networkRow(row) {
	const out = {
		method: typeof row.method === "string" ? row.method : "GET",
		url: flattenOneLine(typeof row.url === "string" ? row.url : "", 200)
	};
	if (typeof row.resourceType === "string") out.resourceType = row.resourceType;
	if (typeof row.status === "number") out.status = row.status;
	if (typeof row.statusText === "string" && row.statusText.length > 0) out.statusText = flattenOneLine(row.statusText, 60);
	if (typeof row.mimeType === "string") out.mimeType = row.mimeType;
	if (typeof row.encodedDataLength === "number") out.bytes = row.encodedDataLength;
	if (typeof row.wallTime === "number") out.time = formatClock(row.wallTime * 1e3);
	if (row.finished === true) out.finished = true;
	if (row.failed === true) out.failed = true;
	if (row.canceled === true) out.canceled = true;
	if (typeof row.errorText === "string" && row.errorText.length > 0) out.errorText = flattenOneLine(row.errorText, 120);
	return out;
}
/**
* Resolve the element target a click/type tool received.
* @param args - validated tool arguments carrying at most one targeting field.
* @returns the CSS selector to send on the wire, refs translated to their attribute form.
*/
function targetSelector(args) {
	const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
	const hasRef = typeof args.ref === "string" && args.ref.length > 0;
	if (hasSelector === hasRef) throw new Error("provide exactly one of selector or ref (ref comes from browser_snapshot)");
	if (hasRef) {
		const ref = args.ref;
		if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`);
		return `[data-dsh-ref="${ref}"]`;
	}
	return args.selector;
}
function requireTabId(args, action) {
	if (typeof args.tabId !== "number") throw new Error(`${action} requires tabId`);
	return args.tabId;
}
function requireWindowId(args, action) {
	if (typeof args.windowId !== "number") throw new Error(`${action} requires windowId`);
	return args.windowId;
}
/**
* Every tab the caller asked to close. `tabId` and `tabIds` are both accepted
* (a batch call that repeats one id, or passes both, must not close it twice),
* and the ids are deduplicated and normalised before they leave the host.
*/
function closeTabIds(args) {
	const asked = [...Array.isArray(args.tabIds) ? args.tabIds : [], ...typeof args.tabId === "number" ? [args.tabId] : []];
	const ids = [...new Set(asked.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
	if (ids.length === 0) throw new Error("close requires tabId or tabIds");
	return ids;
}
/** Actual pixel dimensions straight from the PNG's IHDR chunk (width/height are
*  big-endian at offsets 16/20 after the 8-byte signature + 4-byte length + 4-byte
*  type). The receipt should say how big the picture IS — fullPage captures are
*  often 3-5 viewports tall and the model cannot tell from the byte count. */
function pngDimensions(buffer) {
	if (buffer.length < 24 || buffer.toString("latin1", 12, 16) !== "IHDR") return {};
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20)
	};
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	await mkdir(dir, { recursive: true });
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const random = Math.random().toString(36).slice(2, 6);
	const file = path.join(dir, `${stamp}-${random}.${payload.format === "jpeg" ? "jpg" : "png"}`);
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	const dims = payload.format === "png" ? pngDimensions(buffer) : {};
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl,
		...dims,
		...payload.elementRect === void 0 ? {} : { elementRect: payload.elementRect }
	};
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
*  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	let file;
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath;
		await mkdir(path.dirname(file), { recursive: true });
	} else {
		await mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const random = Math.random().toString(36).slice(2, 6);
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
		file = path.join(dir, name);
	}
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		...payload.tabTitle === void 0 ? {} : { title: payload.tabTitle },
		...payload.tabUrl === void 0 ? {} : { url: payload.tabUrl }
	};
}
/** Write one MHTML archive payload to `path` (absolute or under `controller.shotsDir`).
*  Mirrors savePdf's contract; MHTML is text, so it is written verbatim as UTF-8. */
async function saveMhtml(controller, payload, requestedPath) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	let file;
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath;
		await mkdir(path.dirname(file), { recursive: true });
	} else {
		await mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const random = Math.random().toString(36).slice(2, 6);
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.mhtml`;
		file = path.join(dir, name);
	}
	const buffer = Buffer.from(payload.mhtml, "utf8");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId
	};
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller) {
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 112,
		text: "The browser_* tools drive the user's real, logged-in browser through the DSH Browser Control extension; they act on the active tab unless a tabId is passed. Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. browser_read extracts page text in a window (offset/limit) and reports how much text is left, browser_screenshot saves a PNG/JPEG and returns its file path (view it with an image tool). Calls fail with actionable copy while the bridge is disabled or no browser is connected. When a result is cut to bound token cost it is marked \"[renderedTruncated omittedChars=N limitChars=L]\" — re-issue a narrower query (smaller limit, a pattern filter, or browser_read's offset) instead of assuming the page is shorter than it is."
	});
	ctx.tools.register(defineTool$1({
		name: "browser_navigate",
		description: "Navigate a browser tab to a URL and wait for the page load to settle.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open in the tab."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			waitUntil: {
				type: "string",
				description: "When the navigation counts as arrived: \"load\" (default) waits for the page load event (15s budget), \"domcontentloaded\" returns once the DOM is parsed (async components may still be mounting — follow with browser_wait if an element is missing), \"commit\" once the new document's address lands, \"none\" returns immediately with no arrival check at all."
			},
			timeoutMs: {
				type: "number",
				description: `How long to wait for the page load to settle: defaults to the waitUntil tier (load 15000, commit/domcontentloaded 4000), capped at ${NAV_MAX_MS}. An explicit value always wins over the tier.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					url: { type: "string" },
					title: { type: "string" },
					pendingUrl: { type: "string" },
					loadPending: { type: "boolean" },
					siteUnreachable: { type: "boolean" },
					waitUntil: { type: "string" },
					waitedMs: { type: "number" },
					readyState: { type: "string" }
				}
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter((part) => typeof part === "string" && part.length > 0).join(" — ");
				const shows = label.length > 0 ? label : "(untitled)";
				if (value.siteUnreachable === true) return [{
					type: "text",
					text: `Tab ${value.tabId} could not load ${String(value.url ?? "")} — the browser landed on its own error page (DNS failure or no connection), so browser_read/browser_snapshot return that error page, not the site.`
				}];
				if (value.loadPending === true) {
					const to = typeof value.pendingUrl === "string" && value.pendingUrl.length > 0 ? value.pendingUrl : "the requested URL";
					return [{
						type: "text",
						text: `Tab ${value.tabId} is still loading ${to} — the load had not settled when the wait budget ran out, so the tab may still be showing ${shows}. Re-check with browser_read before acting on it (or raise timeoutMs).`
					}];
				}
				if (typeof value.pendingUrl === "string" && value.pendingUrl.length > 0) return [{
					type: "text",
					text: `Tab ${value.tabId} shows ${shows} and is navigating to ${value.pendingUrl}`
				}];
				return [{
					type: "text",
					text: `Tab ${value.tabId} now shows ${shows}`
				}];
			}
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: "generic",
			title: `Open ${args.url}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const waitUntil = args.waitUntil === void 0 ? "load" : String(args.waitUntil);
			if (!(waitUntil in NAV_TIERS)) throw new Error(`browser_navigate: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`);
			const params = {
				url: args.url,
				waitUntil
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			let budgetMs = NAV_TIERS[waitUntil];
			if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)));
			if (waitUntil !== "none") params.timeoutMs = budgetMs;
			const raw = await controller.execute("nav", params, exec.signal, waitUntil === "none" ? void 0 : budgetMs + BRIDGE_MARGIN_MS);
			const out = { tabId: raw.tabId };
			if (typeof raw.url === "string") out.url = raw.url;
			if (typeof raw.title === "string") out.title = raw.title;
			if (typeof raw.pendingUrl === "string") out.pendingUrl = raw.pendingUrl;
			if (raw.loadPending === true) out.loadPending = true;
			if (raw.siteUnreachable === true || typeof raw.siteUnreachable === "object" && raw.siteUnreachable !== null) out.siteUnreachable = true;
			if (typeof raw.waitUntil === "string") out.waitUntil = raw.waitUntil;
			if (typeof raw.waitedMs === "number") out.waitedMs = raw.waitedMs;
			if (typeof raw.readyState === "string" && raw.readyState.length > 0) out.readyState = raw.readyState;
			return out;
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_read",
		description: "Read the current page: title, URL and the page text itself (or full HTML) in a window you control with offset/limit. The returned text is what you see — no separate fetch step is needed.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			mode: {
				type: "string",
				description: "\"text\" (default) for visible text, \"html\" for the whole document."
			},
			offset: {
				type: "number",
				description: `Character index the window starts at; default 0. Use the "call again with offset=" value the previous result reported.`
			},
			limit: {
				type: "number",
				description: `Characters to return; default and cap ${READ_WINDOW_MAX_CHARS}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					mode: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					content: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					offset: {
						type: "number",
						required: true
					},
					totalChars: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => {
				const end = value.offset + value.content.length;
				return [{
					type: "text",
					text: `${`${value.title} (${value.url}) — ${value.mode} chars ${value.offset}-${end} of ${value.totalChars}` + (value.truncated ? `; call again with offset=${end} to continue` : "")}\n\n${value.content}`
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const mode = args.mode === "html" ? "html" : "text";
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
			const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS));
			const raw = await controller.execute("content", args.tabId === void 0 ? { mode } : {
				mode,
				tabId: args.tabId
			}, exec.signal);
			const full = raw.content ?? "";
			const content = full.slice(offset, offset + limit);
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? "",
				url: raw.url ?? "",
				content,
				truncated: offset + content.length < full.length,
				offset,
				totalChars: full.length
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_snapshot",
		description: "Inventory the page's interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:\"ax\" numbers them by Chrome's accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			offset: {
				type: "number",
				description: "Skip this many items into the inventory (paging); default 0. Refs are valid for THIS call only — take the next page in the same breath if you need stable refs."
			},
			limit: {
				type: "number",
				description: "Page size: max items returned by this call; defaults to 120. The extension supplies up to a 200-item window per call."
			},
			mode: {
				type: "string",
				description: "\"ax\" for the accessibility tree, \"dom\" (default) for the selector list. \"ax\" falls back to \"dom\" with axFallback set if the page gives no a11y tree."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					mode: { type: "string" },
					axFallback: { type: "string" },
					offset: {
						type: "number",
						required: true
					},
					total: { type: "number" },
					returned: { type: "number" },
					nextOffset: { type: "number" },
					hasMore: {
						type: "boolean",
						required: true
					},
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								ref: {
									type: "string",
									required: true
								},
								tag: {
									type: "string",
									required: true
								},
								role: { type: "string" },
								name: { type: "string" },
								href: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const shown = value.items.length;
				const start = value.offset + 1;
				const end = value.offset + shown;
				const totalText = value.total === void 0 ? `${value.returned ?? shown} available` : `${value.total} on the page`;
				return [{
					type: "text",
					text: clampRendered([`${shown === 0 ? `no items at offset ${value.offset}` : `items ${start}–${end} of ${totalText}`}${value.total !== void 0 && value.returned !== void 0 && value.total > value.returned ? ` (this extension returns at most ${value.returned}-item windows — use browser_find/browser_read to reach the rest)` : ""}${value.nextOffset === void 0 ? "" : `; next page: offset ${value.nextOffset}`} (mode ${value.mode ?? "dom"}); click or fill them by ref:` + (value.axFallback === void 0 ? "" : `\n(mode ax fell back to dom: ${value.axFallback})`), ...value.items.map((item) => {
						const name = item.name === void 0 ? "" : ` "${flattenOneLine(item.name, 80)}"`;
						const href = item.href === void 0 ? "" : ` -> ${flattenOneLine(item.href, 100)}`;
						return `[${item.ref}] ${item.role ?? item.tag}${name}${href}`;
					})].join("\n"), SNAPSHOT_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Snapshot browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const offset = Math.max(0, Math.trunc(typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : 0));
			const limit = Math.min(200, Math.max(1, typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 120));
			const params = { limit: 200 };
			if (typeof args.tabId === "number") params.tabId = args.tabId;
			if (typeof args.mode === "string") params.mode = args.mode;
			const raw = await controller.execute("snapshot", params, exec.signal);
			const requestedAx = args.mode === "ax";
			const gotAx = raw.mode === "ax" || raw.ax !== void 0;
			const axFallback = typeof raw.axFallback === "string" && raw.axFallback.length > 0 ? raw.axFallback : requestedAx && !gotAx ? "this extension ignored mode:\"ax\" and returned CSS-DOM matches (AX mode needs DSH Browser Control extension v1.0.11 or newer) — the names below are tag names, not accessible names" : void 0;
			const window = Array.isArray(raw.items) ? raw.items : [];
			const returned = window.length;
			const reportedTotal = typeof raw.total === "number" && Number.isFinite(raw.total) ? Math.trunc(raw.total) : void 0;
			const total = reportedTotal === void 0 ? void 0 : Math.max(returned, reportedTotal);
			const page = window.slice(offset, offset + limit);
			const hasMore = offset + page.length < returned;
			return {
				tabId: raw.tabId,
				title: raw.title ?? "",
				url: raw.url ?? "",
				...raw.mode === void 0 ? {} : { mode: raw.mode },
				...axFallback === void 0 ? {} : { axFallback },
				offset,
				...total === void 0 ? {} : { total },
				returned,
				hasMore,
				...hasMore ? { nextOffset: offset + page.length } : {},
				items: page.map((item) => ({
					ref: item.ref,
					tag: item.tag,
					...item.role === void 0 ? {} : { role: item.role },
					...item.name === void 0 ? {} : { name: item.name },
					...item.href === void 0 ? {} : { href: item.href }
				}))
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_click",
		description: "Click a page element with real mouse events; target it by snapshot ref or CSS selector.",
		parameters: {
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot (e.g. \"e3\"); wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			doubleClick: {
				type: "boolean",
				description: "Send a double click instead."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Click ${args.ref ?? args.selector ?? ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { selector: targetSelector(args) };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.doubleClick !== void 0) params.doubleClick = args.doubleClick;
			return await controller.execute("click", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_type",
		description: "Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.",
		parameters: {
			value: {
				type: "string",
				required: true,
				description: "Text to put into the element."
			},
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot; wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			submit: {
				type: "boolean",
				description: "Press Enter after filling."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Type into ${args.ref ?? args.selector ?? "element"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				selector: targetSelector(args),
				value: args.value
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const filled = await controller.execute("input", params, exec.signal);
			if (args.submit === true) await controller.execute("press", args.tabId === void 0 ? { key: "Enter" } : {
				key: "Enter",
				tabId: args.tabId
			}, exec.signal);
			return filled;
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_press",
		description: "Send a real keyboard event to the page: a named key (Enter, Tab, Escape, ArrowDown…), a single character, or a combination such as \"Ctrl+A\" / \"Shift+ArrowRight\".",
		parameters: {
			key: {
				type: "string",
				required: true,
				description: "Named key, a single character, or \"Modifier+Key\" (alt, ctrl/control, meta/command, shift). Unknown names now fail loudly instead of doing nothing."
			},
			modifiers: {
				type: "array",
				items: { type: "string" },
				description: "Alternative to the \"Ctrl+A\" spelling: [\"ctrl\", \"shift\"]. Shift alone still lets the character be typed; ctrl/meta suppress insertion."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Press ${args.key}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { key: args.key };
			if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("press", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_scroll",
		description: "Scroll the page viewport by a delta and report the resulting position.",
		parameters: {
			x: {
				type: "number",
				description: "Horizontal delta in pixels; defaults to 0."
			},
			y: {
				type: "number",
				description: "Vertical delta in pixels; positive scrolls down."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Scroll browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				x: args.x ?? 0,
				y: args.y ?? 0
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("scroll", params, exec.signal);
		}
	}));
	/** Page-side ceiling of `cmdWait`; the bridge budget adds slack on top. */
	const WAIT_MAX_MS = 12e4;
	ctx.tools.register(defineTool$1({
		name: "browser_wait",
		description: "Block until a selector appears, some text shows up in the body, or a page-side predicate turns true. Use it after navigation for SPA routes and lazy-rendered content, which browser_navigate does not wait for.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector that must exist in the document."
			},
			text: {
				type: "string",
				description: "Literal substring that must appear in document.body.innerText."
			},
			fn: {
				type: "string",
				description: "JS predicate evaluated in the page: an expression (\"window.x === 3\") or a function body (\"() => !!document.querySelector('.row')\")."
			},
			timeoutMs: {
				type: "number",
				description: `Give up after this many milliseconds; defaults to 15000, capped at ${WAIT_MAX_MS}.`
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Wait for ${args.selector ?? args.text ?? "page condition"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const given = [
				"selector",
				"text",
				"fn"
			].filter((k) => args[k] !== void 0 && String(args[k]).length > 0);
			if (given.length === 0) throw new Error("browser_wait needs exactly one of selector, text, fn — otherwise there is nothing to wait for");
			if (given.length > 1) throw new Error(`browser_wait takes one condition, got ${given.join(" + ")} — pick the one you actually mean`);
			const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.timeoutMs ?? 15e3)));
			const params = {
				[given[0]]: args[given[0]],
				timeoutMs
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("wait", params, exec.signal, timeoutMs + 1e4);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_find",
		description: "Describe the elements matching a CSS selector — count, tag, id, class, text, href and viewport rect. Read-only; use it to decide what to click and to verify the page state.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector to query."
			},
			limit: {
				type: "number",
				description: "Maximum items to describe; defaults to 10, capped at 50 (count is always the full total)."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Find ${args.selector}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { selector: args.selector };
			if (args.limit !== void 0) params.limit = args.limit;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("find", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_hold",
		description: "Put a cancellable take-over overlay on a tab so the user can see that you are working on this page and cannot mis-click. The card title is fixed by the extension; your `note` is the body text only (≤400 chars, newlines flattened). The user double-clicks the page (or presses Escape twice, or holds Escape) to close it — you can keep working. Pressing the card's abort button blocks your click/input/press/nav on that tab until you call action=\"off\" (which counts as confirming you continue). This is a soft layer, not a security boundary: the popup lock is the thing that actually freezes the browser. Returns `covered:false` with a `reason` when the page cannot be covered (browser pages, error pages, CSP-strict frames, PDF viewer, an open native dialog).",
		parameters: {
			action: {
				type: "string",
				enum: [
					"on",
					"off",
					"status"
				],
				required: true,
				description: "\"on\" shows the overlay, \"off\" removes it (and clears the abort state), \"status\" reports what is actually on the page."
			},
			note: {
				type: "string",
				description: "on: body text — say what you are doing (e.g. \"正在把「局域网」档改成放行\"). The title cannot be set."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Overlay ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const action = String(args.action);
			if (![
				"on",
				"off",
				"status"
			].includes(action)) throw new Error("browser_hold action must be on, off or status");
			const params = { action };
			if (args.action === "on" && args.note !== void 0) params.note = args.note;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("hold", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_cookies",
		description: "Read, set or remove cookies of a tab (CDP Network.*, no new permission). Cookie values are credentials — a get returns them in full and they land in the model-visible text, so filter by domain and do not point this at a page whose cookies you do not actually need. set/remove need an anchor: url, or domain (with optional path).",
		parameters: {
			action: {
				type: "string",
				enum: [
					"get",
					"set",
					"remove"
				],
				required: true,
				description: "\"get\" lists cookies visible to the tab (domain filter optional); \"set\" writes one; \"remove\" deletes one and reports whether it is still visible afterwards."
			},
			name: {
				type: "string",
				description: "set/remove: cookie name (required)."
			},
			value: {
				type: "string",
				description: "set: cookie value (required; pass an empty string to clear the content)."
			},
			domain: {
				type: "string",
				description: "get: only cookies whose domain contains this substring. set/remove: anchor — the cookie domain."
			},
			url: {
				type: "string",
				description: "set/remove: alternative anchor — Chrome derives origin/secure defaults from it."
			},
			path: {
				type: "string",
				description: "set/remove: cookie path."
			},
			secure: {
				type: "boolean",
				description: "set: https-only cookie."
			},
			httpOnly: {
				type: "boolean",
				description: "set: hide the cookie from page scripts."
			},
			sameSite: {
				type: "string",
				description: "set: Strict | Lax | None."
			},
			expires: {
				type: "number",
				description: "set: Unix seconds; omit for a session cookie."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Cookies ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const command = args.action === "get" ? "cookies.get" : args.action === "set" ? "cookies.set" : args.action === "remove" ? "cookies.remove" : null;
			if (command === null) throw new Error("browser_cookies action must be get, set or remove");
			const params = {};
			if (args.name !== void 0) params.name = args.name;
			if (args.value !== void 0) params.value = args.value;
			if (args.domain !== void 0) params.domain = args.domain;
			if (args.url !== void 0) params.url = args.url;
			if (args.path !== void 0) params.path = args.path;
			if (args.secure !== void 0) params.secure = args.secure;
			if (args.httpOnly !== void 0) params.httpOnly = args.httpOnly;
			if (args.sameSite !== void 0) params.sameSite = args.sameSite;
			if (args.expires !== void 0) params.expires = args.expires;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (command === "cookies.get") return await controller.execute("cookies.get", params, exec.signal);
			if (command === "cookies.set") return await controller.execute("cookies.set", params, exec.signal);
			return await controller.execute("cookies.remove", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_dialog",
		description: "Read or change how native alert/confirm/prompt dialogs are answered (accept, dismiss, or manual), and get the recent dialog log so you can prove one appeared.",
		parameters: { policy: {
			type: "string",
			enum: [
				"accept",
				"dismiss",
				"manual"
			],
			description: "Set this policy; omit to only read the current one."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.policy ? `Dialog policy → ${args.policy}` : "Read dialog policy",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.policy !== void 0) params.policy = args.policy;
			return await controller.execute("dialog", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_info",
		description: "Report which browser and which extension build is actually attached. Run it first when behaviour looks wrong — a stale extension or the wrong browser profile explains most of it.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser identity",
			kind: "other"
		}),
		async execute(_args, exec) {
			return await controller.execute("browser.info", {}, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_tabs",
		description: "List tabs, or open/close/activate/group/ungroup, or go back/forward in the tab's history. `close` takes one tab (`tabId`) or several (`tabIds`); the result accounts for every id, so a retry is safe.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: list, open, close, activate, group, ungroup, back, forward."
			},
			url: {
				type: "string",
				description: "URL for the open action."
			},
			tabId: {
				type: "number",
				description: "Target tab for close/activate/group/back/forward; defaults to the active tab for back/forward."
			},
			tabIds: {
				type: "array",
				items: { type: "number" },
				description: "For close: every tab to close in one call. The result reports each id (closed / alreadyGone / failed) instead of stopping at the first failure."
			},
			active: {
				type: "boolean",
				description: "Whether a newly opened tab becomes active; defaults to true."
			},
			group: {
				type: "boolean",
				description: "For open: put the new tab in the DSH tab group. Defaults to true; pass false to keep it loose."
			},
			waitUntil: {
				type: "string",
				description: "For open/back/forward: when the navigation counts as arrived — same tiers as browser_navigate (load default / domcontentloaded / commit / none). back/forward report unchanged:true + a reason when the tab is already at the oldest/newest history entry."
			},
			timeoutMs: {
				type: "number",
				description: "For open/back/forward: wait budget, overriding the waitUntil tier (load 15000, commit/domcontentloaded 4000)."
			},
			windowId: {
				type: "number",
				description: "For ungroup: only dissolve that window’s DSH group; omit to clear every window."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Browser tabs: ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			switch (args.action) {
				case "list": return await controller.execute("tabs.list", {}, exec.signal);
				case "open": {
					if (typeof args.url !== "string" || args.url.length === 0) throw new Error("open requires url");
					const waitUntil = args.waitUntil === void 0 ? "load" : String(args.waitUntil);
					if (!(waitUntil in NAV_TIERS)) throw new Error(`browser_tabs open: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`);
					const params = {
						url: args.url,
						waitUntil
					};
					if (args.active !== void 0) params.active = args.active;
					if (args.group !== void 0) params.group = args.group;
					if (waitUntil === "none") return await controller.execute("tabs.open", params, exec.signal);
					let budgetMs = NAV_TIERS[waitUntil];
					if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)));
					params.timeoutMs = budgetMs;
					return await controller.execute("tabs.open", params, exec.signal, budgetMs + BRIDGE_MARGIN_MS);
				}
				case "close": {
					const ids = closeTabIds(args);
					return ids.length === 1 ? await controller.execute("tabs.close", { tabId: ids[0] }, exec.signal) : await controller.execute("tabs.closeMany", { tabIds: ids }, exec.signal);
				}
				case "activate": return await controller.execute("tabs.activate", { tabId: requireTabId(args, "activate") }, exec.signal);
				case "back":
				case "forward": {
					const waitUntil = args.waitUntil === void 0 ? "load" : String(args.waitUntil);
					if (!(waitUntil in NAV_TIERS)) throw new Error(`browser_tabs ${args.action}: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`);
					const params = { waitUntil };
					if (args.tabId !== void 0) params.tabId = args.tabId;
					let budgetMs = NAV_TIERS[waitUntil];
					if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)));
					params.timeoutMs = budgetMs;
					if (args.action === "back") {
						controller.requireExtensionCommand("tabs.back", "1.7.0");
						return await controller.execute("tabs.back", params, exec.signal, budgetMs + BRIDGE_MARGIN_MS);
					}
					controller.requireExtensionCommand("tabs.forward", "1.7.0");
					return await controller.execute("tabs.forward", params, exec.signal, budgetMs + BRIDGE_MARGIN_MS);
				}
				case "group": return await controller.execute("tabs.group", { tabId: requireTabId(args, "group") }, exec.signal);
				case "ungroup": {
					const params = {};
					if (typeof args.windowId === "number") params.windowId = args.windowId;
					return await controller.execute("tabs.ungroup", params, exec.signal);
				}
				default: throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`);
			}
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_windows",
		description: "Inspect and control browser windows: list windows with geometry and state, open a new window (optionally positioned/sized), update state (minimize / maximize / fullscreen / focus) or geometry, close a whole window (all its tabs go too), or move tabs between windows. Geometry and state changes happen only through this tool. open is the only non-idempotent action: if it times out, run action:\"list\" first — the window may already exist.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: list, open, update, close, moveTab."
			},
			windowId: {
				type: "number",
				description: "Target window for update/close/moveTab."
			},
			url: {
				type: "string",
				description: "For open: a URL or an array of URLs (one tab each); defaults to about:blank."
			},
			state: {
				type: "string",
				description: "For open/update: normal | minimized | maximized | fullscreen."
			},
			left: {
				type: "number",
				description: "For open/update: window left edge in screen pixels."
			},
			top: {
				type: "number",
				description: "For open/update: window top edge in screen pixels."
			},
			width: {
				type: "number",
				description: "For open/update: window width in screen pixels."
			},
			height: {
				type: "number",
				description: "For open/update: window height in screen pixels."
			},
			focused: {
				type: "boolean",
				description: "For open/update: focus the window. focused:true on a minimized window restores it WITHOUT un-maximizing (state:\"normal\" would un-maximize)."
			},
			alwaysOnTop: {
				type: "boolean",
				description: "For update: keep the window above others."
			},
			drawAttention: {
				type: "boolean",
				description: "For update: flash the taskbar entry to get the user's attention without stealing focus."
			},
			incognito: {
				type: "boolean",
				description: "For open: open in incognito. Fails honestly when the extension is not allowed in incognito."
			},
			tabId: {
				type: "number",
				description: "For moveTab: one tab to move."
			},
			tabIds: {
				type: "array",
				items: { type: "number" },
				description: "For moveTab: several tabs to move in order; each is reported individually."
			},
			index: {
				type: "number",
				description: "For moveTab: target position in the destination window; omit for the end."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Browser windows: ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			switch (args.action) {
				case "list":
					controller.requireExtensionCommand("windows.list", "1.6.0");
					return await controller.execute("windows.list", {}, exec.signal);
				case "open": {
					const params = {};
					if (args.url !== void 0) params.url = args.url;
					if (args.state !== void 0) params.state = args.state;
					if (args.incognito === true) params.incognito = true;
					for (const k of [
						"left",
						"top",
						"width",
						"height"
					]) if (typeof args[k] === "number") params[k] = args[k];
					if (args.focused !== void 0) params.focused = args.focused;
					controller.requireExtensionCommand("windows.open", "1.6.0");
					return await controller.execute("windows.open", params, exec.signal);
				}
				case "update": {
					const params = { windowId: requireWindowId(args, "update") };
					if (args.state !== void 0) params.state = args.state;
					for (const k of [
						"left",
						"top",
						"width",
						"height"
					]) if (typeof args[k] === "number") params[k] = args[k];
					if (args.focused !== void 0) params.focused = args.focused;
					if (args.alwaysOnTop !== void 0) params.alwaysOnTop = args.alwaysOnTop;
					if (args.drawAttention === true) params.drawAttention = true;
					controller.requireExtensionCommand("windows.update", "1.6.0");
					return await controller.execute("windows.update", params, exec.signal);
				}
				case "close":
					controller.requireExtensionCommand("windows.close", "1.6.0");
					return await controller.execute("windows.close", { windowId: requireWindowId(args, "close") }, exec.signal);
				case "moveTab": {
					if (args.tabId === void 0 && args.tabIds === void 0) throw new Error("moveTab requires tabId or tabIds");
					const params = { windowId: requireWindowId(args, "moveTab") };
					if (args.tabId !== void 0) params.tabId = args.tabId;
					if (args.tabIds !== void 0) params.tabIds = args.tabIds;
					if (args.index !== void 0) params.index = args.index;
					controller.requireExtensionCommand("windows.moveTab", "1.6.0");
					return await controller.execute("windows.moveTab", params, exec.signal);
				}
				default: throw new Error(`unknown windows action: ${String(args.action)} (use list|open|update|close|moveTab)`);
			}
		}
	}));
	/** Page-side ceiling of the eval race in the extension; the bridge budget adds slack on top. */
	const EVAL_MAX_MS = 12e4;
	ctx.tools.register(defineTool$1({
		name: "browser_evaluate",
		description: "Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression or statement sequence; awaited like a promise body."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			timeoutMs: {
				type: "number",
				description: `Give up after this many milliseconds; defaults to 60000, capped at ${EVAL_MAX_MS}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(value.json)
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Evaluate in page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { expression: args.expression };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			let bridgeCeiling;
			if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) {
				const evalBudget = Math.min(EVAL_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)));
				params.timeoutMs = evalBudget;
				bridgeCeiling = evalBudget + 2e3;
			}
			const raw = await controller.execute("eval", params, exec.signal, bridgeCeiling);
			let json;
			try {
				json = JSON.stringify(raw.value) ?? String(raw.value);
			} catch {
				json = String(raw.value);
			}
			return {
				tabId: raw.tabId,
				json
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_screenshot",
		description: "Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path plus the image's real pixel size. fullPage captures the whole scrollable page in one shot (sticky/fixed headers may repeat); selector captures one element.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			fullPage: {
				type: "boolean",
				description: "Capture the entire scrollable page instead of just the viewport. The receipt's width/height show the real size."
			},
			selector: {
				type: "string",
				description: "CSS selector: capture just that element (scrolled into view); the receipt carries its rect."
			},
			format: {
				type: "string",
				description: "\"png\" (default) or \"jpeg\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					},
					title: { type: "string" },
					url: { type: "string" },
					width: { type: "number" },
					height: { type: "number" },
					elementRect: {
						type: "object",
						additionalProperties: false,
						properties: {
							x: {
								type: "number",
								required: true
							},
							y: {
								type: "number",
								required: true
							},
							w: {
								type: "number",
								required: true
							},
							h: {
								type: "number",
								required: true
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Saved ${value.file} (${value.bytes} bytes${value.width !== void 0 && value.height !== void 0 ? `, ${value.width}×${value.height}` : ""}${value.elementRect !== void 0 ? `, element at ${value.elementRect.x},${value.elementRect.y} size ${value.elementRect.w}×${value.elementRect.h}` : ""})`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser screenshot",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { format: args.format === "jpeg" ? "jpeg" : "png" };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.fullPage !== void 0) params.fullPage = args.fullPage;
			if (args.selector !== void 0) params.selector = args.selector;
			return saveScreenshot(controller, await controller.execute("screenshot", params, exec.signal));
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_cleanup",
		description: "Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					shotsRemoved: {
						type: "number",
						required: true
					},
					scratchRemoved: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clean up browser artifacts",
			kind: "other"
		}),
		async execute() {
			const result = await controller.cleanup();
			return {
				shotsRemoved: result.shotsRemoved,
				scratchRemoved: Array.from(result.scratchRemoved)
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_console_log",
		description: "Read the captured `console.log/info/warn/error` entries for a tab, with the entry text itself. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for \"what did the page log after I clicked submit\".",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			levels: {
				type: "array",
				items: { type: "string" },
				description: "Filter to one or more of: log, info, warn, error, debug."
			},
			pattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the formatted text."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 100, capped at 500."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								level: {
									type: "string",
									required: true
								},
								text: {
									type: "string",
									required: true
								},
								time: { type: "string" },
								location: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: clampRendered([`Tab ${value.tabId}: ${value.count} of ${value.total} console entries (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit to see more` : ""}:`, ...value.entries.map((entry, index) => `${index + 1}. [${entry.time ?? "?"}] ${entry.level}${entry.location === void 0 ? "" : ` @${entry.location}`} — ${entry.text}`)].join("\n"), LOG_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser console",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (Array.isArray(args.levels)) params.levels = args.levels;
			if (typeof args.pattern === "string") params.pattern = args.pattern;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			const raw = await controller.execute("console.log", params, exec.signal);
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				entries: (raw.entries ?? []).map((entry) => ({
					level: entry.level ?? "log",
					text: flattenOneLine(entry.text ?? "", 400),
					...entry.t === void 0 ? {} : { time: formatClock(entry.t) },
					...entry.location === void 0 ? {} : { location: entry.location }
				}))
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_network_log",
		description: "Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			includeStatic: {
				type: "boolean",
				description: "Include images / fonts / stylesheets / scripts. Default false."
			},
			methodPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the HTTP method."
			},
			urlPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the URL."
			},
			status: {
				type: "string",
				description: "One of: 2xx, 3xx, 4xx, 5xx, failed, pending."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 200, capped at 1000."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					requests: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								method: {
									type: "string",
									required: true
								},
								url: {
									type: "string",
									required: true
								},
								resourceType: { type: "string" },
								status: { type: "number" },
								statusText: { type: "string" },
								mimeType: { type: "string" },
								bytes: { type: "number" },
								time: { type: "string" },
								finished: { type: "boolean" },
								failed: { type: "boolean" },
								canceled: { type: "boolean" },
								errorText: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: clampRendered([`Tab ${value.tabId}: ${value.count} of ${value.total} network requests (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit or filter by urlPattern/status` : ""}:`, ...value.requests.map((row, index) => {
						const outcome = row.failed === true ? `FAILED ${row.errorText ?? ""}`.trim() : row.status === void 0 ? "PENDING" : `${row.status} ${row.statusText ?? ""}`.trim();
						const size = row.bytes === void 0 ? "" : ` ${formatBytes(row.bytes)}`;
						const type = row.resourceType === void 0 ? "" : ` ${row.resourceType}`;
						return `${index + 1}. [${row.time ?? "?"}] ${row.method} ${outcome}${type}${size} ${row.url}`;
					})].join("\n"), LOG_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.includeStatic === true) params.includeStatic = true;
			if (typeof args.methodPattern === "string") params.methodPattern = args.methodPattern;
			if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
			if (typeof args.status === "string") params.status = args.status;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			const raw = await controller.execute("network.log", params, exec.signal);
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				requests: (raw.requests ?? []).map((row) => networkRow(row))
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_network_clear",
		description: "Empty the per-tab network capture buffer without returning the rows.",
		parameters: { tabId: {
			type: "number",
			description: "Target tab; defaults to the active tab."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					cleared: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: network log cleared`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clear browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("network.clear", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_pdf",
		description: "Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			path: {
				type: "string",
				description: "Absolute path. Omit to save under the configured shotsDir with a timestamped name."
			},
			landscape: {
				type: "boolean",
				description: "Use landscape orientation."
			},
			printBackground: {
				type: "boolean",
				description: "Render CSS backgrounds. Default true."
			},
			paperWidth: {
				type: "number",
				description: "Paper width in inches."
			},
			paperHeight: {
				type: "number",
				description: "Paper height in inches."
			},
			scale: {
				type: "number",
				description: "Page scale (0.1–2.0)."
			},
			pageRanges: {
				type: "string",
				description: "Sub-range, e.g. \"1-3\" or \"1,4-6\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Save PDF${args.path ? " → " + args.path : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.landscape === true) params.landscape = true;
			if (args.printBackground === false) params.printBackground = false;
			if (typeof args.paperWidth === "number") params.paperWidth = args.paperWidth;
			if (typeof args.paperHeight === "number") params.paperHeight = args.paperHeight;
			if (typeof args.scale === "number") params.scale = args.scale;
			if (typeof args.pageRanges === "string") params.pageRanges = args.pageRanges;
			return await savePdf(controller, await controller.execute("pdf", params, exec.signal), typeof args.path === "string" ? args.path : void 0);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_archive",
		description: "Save the whole page as a single-file MHTML archive (text, images and styles inline; no network needed to reopen it). Returns the absolute path. The archive is a snapshot of when it was taken — scripts inside do not run and later page changes are not reflected; read it back with file tools or grep it like text.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			path: {
				type: "string",
				description: "Absolute path. Omit to save under the configured shotsDir with a timestamped .mhtml name."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `MHTML archive written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Save page archive${args.path ? " → " + args.path : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			controller.requireExtensionCommand("archive", "1.5.0");
			return await saveMhtml(controller, await controller.execute("archive", params, exec.signal), typeof args.path === "string" ? args.path : void 0);
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_emulate",
		description: "Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing, and throttle the network or CPU to test slow conditions. `device:\"reset\"` restores the user's actual viewport and clears all throttling. `network` presets (this tool's own numbers): slow3g = 400ms RTT + ~50KB/s both ways, fast3g = 150ms + ~200KB/s down / ~94KB/s up, offline, reset to clear. `cpuThrottlingRate` multiplies CPU cost (1 = off, up to 20). Throttling lives in the debugger session — it is gone when the extension detaches, and device:\"reset\" clears it too. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			device: {
				type: "string",
				description: "Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below."
			},
			network: {
				type: "string",
				description: "slow3g | fast3g | offline | reset. The receipt reports the applied latency/throughput in bytes per second."
			},
			cpuThrottlingRate: {
				type: "number",
				description: "CPU slowdown multiplier: 1 = none (default), 4 = mid-range phone, up to 20."
			},
			width: {
				type: "number",
				description: "Custom viewport width in CSS px."
			},
			height: {
				type: "number",
				description: "Custom viewport height in CSS px."
			},
			deviceScaleFactor: {
				type: "number",
				description: "Custom DPR (1 = standard, 2 = retina, 3 = super-retina)."
			},
			isMobile: {
				type: "boolean",
				description: "Pass as mobile to the page (affects responsive meta)."
			},
			hasTouch: {
				type: "boolean",
				description: "Enable touch event dispatch."
			},
			userAgent: {
				type: "string",
				description: "Custom User-Agent string. Empty string clears."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					reset: { type: "boolean" },
					width: { type: "number" },
					height: { type: "number" },
					deviceScaleFactor: { type: "number" },
					isMobile: { type: "boolean" },
					hasTouch: { type: "boolean" },
					userAgent: { type: "string" },
					network: { type: "string" },
					latency: { type: "number" },
					downloadThroughput: { type: "number" },
					uploadThroughput: { type: "number" },
					cpuThrottlingRate: { type: "number" }
				}
			},
			render: (_args, value) => {
				if (value.reset) return [{
					type: "text",
					text: `Tab ${value.tabId}: emulation reset to default (network unthrottled, CPU rate 1)`
				}];
				const ua = value.userAgent === void 0 ? "" : ` UA="${flattenOneLine(value.userAgent, 80)}"`;
				const net = value.network === void 0 ? "" : ` network=${value.network}(${value.latency}ms↓${value.downloadThroughput}B/s↑${value.uploadThroughput}B/s)`;
				const cpu = value.cpuThrottlingRate === void 0 ? "" : ` cpu×${value.cpuThrottlingRate}`;
				return [{
					type: "text",
					text: `Tab ${value.tabId}: ${value.width || "?"}×${value.height || "?"} DPR=${value.deviceScaleFactor ?? "?"} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}${ua}${net}${cpu}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Emulate${args.device ? " " + args.device : ""}${args.network ? " " + args.network : ""}${args.cpuThrottlingRate ? " cpu×" + args.cpuThrottlingRate : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (typeof args.device === "string") params.device = args.device;
			if (typeof args.network === "string") params.network = args.network;
			if (typeof args.cpuThrottlingRate === "number") params.cpuThrottlingRate = args.cpuThrottlingRate;
			if (typeof args.width === "number") params.width = args.width;
			if (typeof args.height === "number") params.height = args.height;
			if (typeof args.deviceScaleFactor === "number") params.deviceScaleFactor = args.deviceScaleFactor;
			if (typeof args.isMobile === "boolean") params.isMobile = args.isMobile;
			if (typeof args.hasTouch === "boolean") params.hasTouch = args.hasTouch;
			if (typeof args.userAgent === "string") params.userAgent = args.userAgent;
			const raw = await controller.execute("emulate", params, exec.signal);
			return {
				tabId: raw.tabId,
				...raw.reset === true ? { reset: true } : {},
				...typeof raw.width === "number" ? { width: raw.width } : {},
				...typeof raw.height === "number" ? { height: raw.height } : {},
				...typeof raw.deviceScaleFactor === "number" ? { deviceScaleFactor: raw.deviceScaleFactor } : {},
				...typeof raw.isMobile === "boolean" ? { isMobile: raw.isMobile } : {},
				...typeof raw.hasTouch === "boolean" ? { hasTouch: raw.hasTouch } : {},
				...typeof raw.userAgent === "string" && raw.userAgent.length > 0 ? { userAgent: raw.userAgent } : {},
				...typeof raw.network === "string" ? { network: raw.network } : {},
				...typeof raw.latency === "number" ? { latency: raw.latency } : {},
				...typeof raw.downloadThroughput === "number" ? { downloadThroughput: raw.downloadThroughput } : {},
				...typeof raw.uploadThroughput === "number" ? { uploadThroughput: raw.uploadThroughput } : {},
				...typeof raw.cpuThrottlingRate === "number" ? { cpuThrottlingRate: raw.cpuThrottlingRate } : {}
			};
		}
	}));
	ctx.tools.register(defineTool$1({
		name: "browser_metrics",
		description: "Read the tab's performance counters (Performance.getMetrics): DOM node count, JS heap usage, layout/style recalc counts, script/task durations. Use it to back \"this page is heavy\" with numbers, before and after an action. Read-only.",
		parameters: { tabId: {
			type: "number",
			description: "Target tab; defaults to the active tab."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					metrics: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							Timestamp: { type: "number" },
							Documents: { type: "number" },
							Frames: { type: "number" },
							JSEventListeners: { type: "number" },
							Nodes: { type: "number" },
							LayoutCount: { type: "number" },
							RecalcStyleCount: { type: "number" },
							LayoutDuration: { type: "number" },
							RecalcStyleDuration: { type: "number" },
							ScriptDuration: { type: "number" },
							TaskDuration: { type: "number" },
							JSHeapUsedSize: { type: "number" },
							JSHeapTotalSize: { type: "number" }
						}
					}
				}
			},
			render: (_args, value) => {
				const m = value.metrics ?? {};
				const parts = [];
				if (m.Nodes !== void 0) parts.push(`nodes=${m.Nodes}`);
				if (m.JSHeapUsedSize !== void 0) {
					const total = m.JSHeapTotalSize !== void 0 ? `/${(m.JSHeapTotalSize / 1048576).toFixed(1)}MB` : "";
					parts.push(`heap=${(m.JSHeapUsedSize / 1048576).toFixed(1)}${total}`);
				}
				if (m.LayoutCount !== void 0) parts.push(`layouts=${m.LayoutCount}`);
				if (m.ScriptDuration !== void 0) parts.push(`script=${Number(m.ScriptDuration).toFixed(2)}s`);
				if (m.TaskDuration !== void 0) parts.push(`tasks=${Number(m.TaskDuration).toFixed(2)}s`);
				return [{
					type: "text",
					text: `Tab ${value.tabId}: ${parts.join(" ") || JSON.stringify(value.metrics)}`
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser metrics",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			controller.requireExtensionCommand("metrics", "1.7.1");
			return await controller.execute("metrics", params, exec.signal);
		}
	}));
	registerDragTool(ctx, controller);
	registerAuditTool(ctx, controller);
	registerJournalTool(ctx, controller);
	registerSessionsTool(ctx, controller);
}
/** One CDP round-trip over the embedded `cdp` passthrough (extension v1.7.2+). */
async function cdpCall(ctrl, tabId, method, params, signal) {
	return await ctrl.execute("cdp", {
		method,
		params,
		tabId
	}, signal);
}
function dragTargetArgs(selector, x, y, side) {
	const hasSel = typeof selector === "string" && selector.length > 0;
	const hasX = typeof x === "number" && Number.isFinite(x);
	const hasY = typeof y === "number" && Number.isFinite(y);
	if (hasSel && (hasX || hasY)) throw new Error(`${side}: give either "${side}" (CSS selector) or "${side}X"/"${side}Y" coordinates, not both`);
	if (!hasSel && !(hasX && hasY)) throw new Error(`${side}: needs a CSS selector ("${side}") or both "${side}X" and "${side}Y" coordinates`);
	if (hasSel) return { selector };
	return {
		x,
		y
	};
}
/**
* Resolve a drag endpoint. Selector endpoints become viewport coordinates via
* the CDP DOM domain — no page JavaScript, so mouse mode also works with
* `allowScript: false`. Top document only; cross-origin iframes are a later
* iteration.
*/
async function resolveDragPoint(ctrl, tabId, target, signal) {
	if (target.selector === void 0) return {
		x: target.x,
		y: target.y
	};
	const selector = target.selector;
	const rootId = (await cdpCall(ctrl, tabId, "DOM.getDocument", { depth: 0 }, signal))?.root?.nodeId;
	if (typeof rootId !== "number") throw new Error("DOM.getDocument returned no root node");
	const nodeId = (await cdpCall(ctrl, tabId, "DOM.querySelector", {
		nodeId: rootId,
		selector
	}, signal))?.nodeId ?? 0;
	if (nodeId === 0) throw new Error(`no element matches selector ${JSON.stringify(selector)} (top document only)`);
	await cdpCall(ctrl, tabId, "DOM.scrollIntoViewIfNeeded", { nodeId }, signal);
	let box;
	try {
		box = await cdpCall(ctrl, tabId, "DOM.getBoxModel", { nodeId }, signal);
	} catch (error) {
		throw new Error(`cannot measure ${JSON.stringify(selector)} — hidden, zero-size or detached? (${error instanceof Error ? error.message : String(error)})`);
	}
	const q = box?.model?.content;
	if (!Array.isArray(q) || q.length < 8) throw new Error(`DOM.getBoxModel returned no quad for ${JSON.stringify(selector)}`);
	return {
		selector,
		x: (q[0] + q[2] + q[4] + q[6]) / 4,
		y: (q[1] + q[3] + q[5] + q[7]) / 4,
		width: typeof box?.model?.width === "number" ? box.model.width : Math.hypot(q[2] - q[0], q[3] - q[1]),
		height: typeof box?.model?.height === "number" ? box.model.height : Math.hypot(q[4] - q[2], q[5] - q[3]),
		nodeId
	};
}
/** Whether the source declares the native HTML5 `draggable` attribute. */
async function sourceIsDraggable(ctrl, tabId, nodeId, signal) {
	const attrs = await cdpCall(ctrl, tabId, "DOM.getAttributes", { nodeId }, signal);
	const list = Array.isArray(attrs?.attributes) ? attrs.attributes.map(String) : [];
	const at = list.indexOf("draggable");
	return at >= 0 && list[at + 1] === "true";
}
/**
* Synthesize a native-order HTML5 drag in the page: dragstart on the source,
* dragenter/dragover on the target, drop only when dragover was prevented
* (the browser's own rule), dragend on the source, all sharing one DataTransfer.
* Untrusted events — pages that gate on `event.isTrusted` will ignore them,
* which the tool description states instead of pretending otherwise.
*/
function html5DragExpression(fromSelector, to) {
	const toExpr = to.selector !== void 0 ? `document.querySelector(${JSON.stringify(to.selector)})` : `document.elementFromPoint(${to.x}, ${to.y})`;
	return `(() => {
  const src = document.querySelector(${JSON.stringify(fromSelector)});
  if (!src) return { error: 'no element matches from selector ' + ${JSON.stringify(fromSelector)} };
  const dst = ${toExpr};
  if (!dst) return { error: 'target element not found' };
  const dt = new DataTransfer();
  const log = [];
  const sr = src.getBoundingClientRect();
  const dr = dst.getBoundingClientRect();
  const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
  const tx = dr.left + dr.width / 2, ty = dr.top + dr.height / 2;
  const fire = (type, target, cx, cy) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: cx, clientY: cy });
    target.dispatchEvent(ev);
    log.push({ type, defaultPrevented: ev.defaultPrevented });
    return ev.defaultPrevented;
  };
  const startCancelled = fire('dragstart', src, sx, sy);
  let dragenterDefaultPrevented = false, overPrevented = false, dropFired = false, dropPrevented = false;
  if (!startCancelled) {
    dragenterDefaultPrevented = fire('dragenter', dst, tx, ty);
    overPrevented = fire('dragover', dst, tx, ty);
    if (overPrevented) {
      dropFired = true;
      dropPrevented = fire('drop', dst, tx, ty);
    }
  }
  fire('dragend', src, sx, sy);
  return { startCancelled, dragenterDefaultPrevented, overPrevented, dropFired, dropPrevented, events: log.length, log };
})()`;
}
function roundDragPoint(p) {
	const out = {
		x: Math.round(p.x * 100) / 100,
		y: Math.round(p.y * 100) / 100
	};
	if (p.selector !== void 0) out.selector = p.selector;
	if (p.width !== void 0) out.width = Math.round(p.width * 100) / 100;
	if (p.height !== void 0) out.height = Math.round(p.height * 100) / 100;
	return out;
}
function registerDragTool(ctx, controller) {
	ctx.tools.register(defineTool$1({
		name: "browser_drag",
		description: "Drag a page element or point onto another with real input. mode \"mouse\" sends trusted press→moves→release input via CDP (canvas, sliders, sortable widgets); mode \"html5\" synthesizes dragstart/dragover/drop in the page for [draggable] elements and needs page scripting; \"auto\" (default) picks html5 only when the source declares draggable=\"true\". Endpoints are CSS selectors (top document) or fromX/fromY + toX/toY viewport coordinates. Needs browser extension v1.7.2+ (embedded cdp channel).",
		parameters: {
			from: {
				type: "string",
				description: "CSS selector of the drag source; use fromX/fromY instead for raw coordinates."
			},
			to: {
				type: "string",
				description: "CSS selector of the drop target; use toX/toY instead for raw coordinates."
			},
			fromX: {
				type: "number",
				description: "Viewport x of the drag start point (with fromY)."
			},
			fromY: {
				type: "number",
				description: "Viewport y of the drag start point (with fromX)."
			},
			toX: {
				type: "number",
				description: "Viewport x of the drop point (with toY)."
			},
			toY: {
				type: "number",
				description: "Viewport y of the drop point (with toX)."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			mode: {
				type: "string",
				description: "\"auto\" (default), \"mouse\" or \"html5\" — see the tool description."
			},
			steps: {
				type: "number",
				description: "Intermediate mouse moves in mouse mode, 1–50 (default 12)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					mode: {
						type: "string",
						required: true
					},
					from: {
						type: "object",
						additionalProperties: false,
						properties: {
							selector: { type: "string" },
							x: { type: "number" },
							y: { type: "number" },
							width: { type: "number" },
							height: { type: "number" }
						}
					},
					to: {
						type: "object",
						additionalProperties: false,
						properties: {
							selector: { type: "string" },
							x: { type: "number" },
							y: { type: "number" },
							width: { type: "number" },
							height: { type: "number" }
						}
					},
					steps: { type: "number" },
					dispatched: { type: "number" },
					startCancelled: { type: "boolean" },
					dragenterDefaultPrevented: { type: "boolean" },
					overPrevented: { type: "boolean" },
					dropFired: { type: "boolean" },
					dropPrevented: { type: "boolean" },
					events: { type: "number" },
					elapsedMs: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				const d = (p) => p?.selector !== void 0 ? p.selector : `(${p?.x ?? "?"},${p?.y ?? "?"})`;
				if (v.mode === "mouse") return [{
					type: "text",
					text: `Tab ${v.tabId}: dragged ${d(v.from)} → ${d(v.to)} with mouse input (${v.steps} steps, ${v.dispatched} dispatches, ${v.elapsedMs}ms)`
				}];
				const verdict = v.startCancelled === true ? "dragstart was cancelled by the page — nothing dropped" : v.overPrevented === true ? v.dropPrevented === true ? "drop fired and was handled" : "drop fired but no drop handler ran" : "target did not accept the drop (no dragover preventDefault)";
				return [{
					type: "text",
					text: `Tab ${v.tabId}: dragged ${d(v.from)} → ${d(v.to)} with html5 events (${v.events} events, ${v.elapsedMs}ms) — ${verdict}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Drag ${args.from ?? `(${args.fromX},${args.fromY})`} → ${args.to ?? `(${args.toX},${args.toY})`}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const mode = args.mode === void 0 ? "auto" : args.mode;
			if (mode !== "auto" && mode !== "mouse" && mode !== "html5") throw new Error(`mode must be "auto", "mouse" or "html5" — got ${JSON.stringify(mode)}`);
			const from = dragTargetArgs(args.from, args.fromX, args.fromY, "from");
			const to = dragTargetArgs(args.to, args.toX, args.toY, "to");
			controller.requireExtensionCommand("cdp", "1.7.2");
			if (controller.policy.readOnly) throw new Error("browser_drag changes page state and read-only mode is on — turn readOnly off in the browser-bridge config to drag");
			let tabId = args.tabId;
			if (tabId === void 0) {
				const listing = await controller.execute("tabs.list", {}, exec.signal);
				if (typeof listing?.activeTabId !== "number") throw new Error("could not resolve the active tab — pass tabId explicitly");
				tabId = listing.activeTabId;
			}
			const started = Date.now();
			let resolvedMode = mode === "auto" ? "mouse" : mode;
			let source;
			if (mode !== "html5") source = await resolveDragPoint(controller, tabId, from, exec.signal);
			if (mode === "auto" && source?.nodeId !== void 0 && await sourceIsDraggable(controller, tabId, source.nodeId, exec.signal)) resolvedMode = "html5";
			if (resolvedMode === "mouse") {
				const target = await resolveDragPoint(controller, tabId, to, exec.signal);
				const steps = Math.min(50, Math.max(1, Math.trunc(typeof args.steps === "number" ? args.steps : 12)));
				const sx = source.x, sy = source.y, tx = target.x, ty = target.y;
				const dispatch = async (params) => {
					await cdpCall(controller, tabId, "Input.dispatchMouseEvent", params, exec.signal);
				};
				await dispatch({
					type: "mouseMoved",
					x: sx,
					y: sy,
					button: "none",
					buttons: 0
				});
				await dispatch({
					type: "mousePressed",
					x: sx,
					y: sy,
					button: "left",
					buttons: 1,
					clickCount: 1
				});
				for (let i = 1; i <= steps; i++) {
					const f = i / steps;
					await dispatch({
						type: "mouseMoved",
						x: sx + (tx - sx) * f,
						y: sy + (ty - sy) * f,
						button: "left",
						buttons: 1
					});
				}
				await dispatch({
					type: "mouseReleased",
					x: tx,
					y: ty,
					button: "left",
					buttons: 0,
					clickCount: 1
				});
				await dispatch({
					type: "mouseMoved",
					x: tx,
					y: ty,
					button: "none",
					buttons: 0
				});
				return {
					tabId,
					mode: "mouse",
					from: roundDragPoint(source),
					to: roundDragPoint(target),
					steps,
					dispatched: steps + 4,
					elapsedMs: Date.now() - started
				};
			}
			if (from.selector === void 0) throw new Error("html5 mode needs a CSS selector for \"from\" (a point has no draggable element)");
			if (!controller.policy.allowScript) throw new Error("html5 drag synthesizes DOM events and needs page scripting — allowScript is off; use mode:\"mouse\" or re-enable the script switch");
			const raw = await controller.execute("eval", {
				expression: html5DragExpression(from.selector, to),
				tabId
			}, exec.signal);
			const outcome = raw?.value;
			if (outcome === void 0 || typeof outcome !== "object") throw new Error("html5 drag expression returned no outcome — page may have navigated mid-drag");
			if (typeof outcome.error === "string") throw new Error(outcome.error);
			return {
				tabId: typeof raw?.tabId === "number" ? raw.tabId : tabId,
				mode: "html5",
				from: from.selector !== void 0 ? { selector: from.selector } : roundDragPoint(from),
				to: to.selector !== void 0 ? { selector: to.selector } : {
					x: to.x,
					y: to.y
				},
				startCancelled: outcome.startCancelled === true,
				dragenterDefaultPrevented: outcome.dragenterDefaultPrevented === true,
				overPrevented: outcome.overPrevented === true,
				dropFired: outcome.dropFired === true,
				dropPrevented: outcome.dropPrevented === true,
				events: typeof outcome.events === "number" ? outcome.events : 0,
				elapsedMs: Date.now() - started
			};
		}
	}));
}
function registerAuditTool(ctx, controller) {
	ctx.tools.register(defineTool$1({
		name: "browser_audit",
		description: "Read this plugin session's in-memory audit trail: every command sent to the browser extension (and every policy/gate refusal), with redacted params, outcome code and duration. Newest last; capped at 200 entries and wiped when dsh restarts. Values typed into pages and cookie values are redacted; eval expressions are truncated. Plugin-local read — works in read-only mode.",
		parameters: {
			command: {
				type: "string",
				description: "Only entries whose command contains this substring (e.g. \"nav\", \"cookies\", \"tabs\")."
			},
			tabId: {
				type: "number",
				description: "Only entries that carried this tabId."
			},
			sinceSeq: {
				type: "number",
				description: "Only entries with seq greater than this (paging)."
			},
			limit: {
				type: "number",
				description: `Max entries to return (newest last), 1–200; default 50.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					total: {
						type: "number",
						required: true
					},
					shown: {
						type: "number",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								seq: {
									type: "number",
									required: true
								},
								t: {
									type: "number",
									required: true
								},
								command: {
									type: "string",
									required: true
								},
								tabId: { type: "number" },
								params: {
									type: "string",
									required: true
								},
								ok: {
									type: "boolean",
									required: true
								},
								code: { type: "string" },
								effectState: { type: "string" },
								error: { type: "string" },
								durationMs: {
									type: "number",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				if (v.entries.length === 0) return [{
					type: "text",
					text: `Audit: ${v.total} entries, none match — the trail starts when a command is executed.`
				}];
				const lines = v.entries.map((e) => {
					const tab = e.tabId === void 0 ? "" : ` tab ${e.tabId}`;
					const outcome = e.ok ? "ok" : `FAIL ${e.code ?? "error"}${e.effectState ? `/${e.effectState}` : ""}`;
					const err = e.ok || e.error === void 0 ? "" : ` — ${e.error}`;
					return `#${e.seq} ${formatClock(e.t)} ${e.command}${tab} ${outcome} ${e.durationMs}ms ${e.params}${err}`;
				});
				return [{
					type: "text",
					text: clampRendered(`Audit: ${v.total} entries (showing ${v.shown})\n${lines.join("\n")}`)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser audit",
			kind: "other"
		}),
		async execute(args) {
			const entries = controller.audit.list({
				tabId: args.tabId,
				command: args.command,
				sinceSeq: args.sinceSeq,
				limit: args.limit
			});
			return {
				total: controller.audit.size(),
				shown: entries.length,
				entries
			};
		}
	}));
}
function registerJournalTool(ctx, controller) {
	ctx.tools.register(defineTool$1({
		name: "browser_journal",
		description: "Read the persistent command journal across dsh restarts: every command from previous runs of this plugin (written to <stateDir>/journal.jsonl, last 1000 entries), grouped by run. Same redaction as browser_audit. Plugin-local disk read — works with the extension offline and in read-only mode, so it is the way to recover \"what was I doing\" after a restart.",
		parameters: {
			command: {
				type: "string",
				description: "Only entries whose command contains this substring."
			},
			tabId: {
				type: "number",
				description: "Only entries that carried this tabId."
			},
			limit: {
				type: "number",
				description: "Max entries to return (newest last), 1–500; default 50."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					total: {
						type: "number",
						required: true
					},
					shown: {
						type: "number",
						required: true
					},
					runs: {
						type: "number",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								run: {
									type: "string",
									required: true
								},
								seq: {
									type: "number",
									required: true
								},
								t: {
									type: "number",
									required: true
								},
								command: {
									type: "string",
									required: true
								},
								tabId: { type: "number" },
								params: {
									type: "string",
									required: true
								},
								ok: {
									type: "boolean",
									required: true
								},
								code: { type: "string" },
								effectState: { type: "string" },
								error: { type: "string" },
								durationMs: {
									type: "number",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				if (v.entries.length === 0) return [{
					type: "text",
					text: `Journal: ${v.total} entries on disk, none match — nothing recorded across runs yet.`
				}];
				const lines = [];
				let run = "";
				for (const e of v.entries) {
					if (e.run !== run) {
						run = e.run;
						lines.push(`── run ${run}`);
					}
					const tab = e.tabId === void 0 ? "" : ` tab ${e.tabId}`;
					const outcome = e.ok ? "ok" : `FAIL ${e.code ?? "error"}`;
					lines.push(`#${e.seq} ${formatClock(e.t)} ${e.command}${tab} ${outcome} ${e.durationMs}ms ${e.params}`);
				}
				return [{
					type: "text",
					text: clampRendered(`Journal: ${v.total} entries in ${v.runs} run(s) (showing ${v.shown})\n${lines.join("\n")}`)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser journal",
			kind: "other"
		}),
		async execute(args) {
			const dir = controller.stateDir;
			if (dir === void 0) throw new Error("browser-bridge is not configured yet — the journal has no stateDir to read");
			const { total, entries } = await readJournal(dir, {
				command: args.command,
				tabId: args.tabId,
				limit: args.limit
			});
			return {
				total,
				shown: entries.length,
				runs: new Set(entries.map((e) => e.run)).size,
				entries
			};
		}
	}));
}
function registerSessionsTool(ctx, controller) {
	ctx.tools.register(defineTool$1({
		name: "browser_sessions",
		description: "List the dsh agent sessions sharing this browser and each one's working tab, or release your own working tab (\"release\"). Isolation: when a browser tool omits tabId, it defaults to THIS session's working tab (verified live against the extension) instead of the browser's active tab — concurrent sessions stop fighting over whatever tab is active. Explicit tabId always wins. Plugin-local; works read-only.",
		parameters: { action: {
			type: "string",
			description: "\"list\" (default) or \"release\" (forget your working tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					current: { type: "string" },
					sessions: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								sessionId: {
									type: "string",
									required: true
								},
								workingTabId: { type: "number" },
								lastActiveAt: {
									type: "number",
									required: true
								},
								calls: {
									type: "number",
									required: true
								}
							}
						}
					},
					releasedTabId: { type: "number" }
				}
			},
			render: (_args, value) => {
				const v = value;
				const short = (id) => id.length <= 18 ? id : `${id.slice(0, 16)}…`;
				if (v.releasedTabId !== void 0) return [{
					type: "text",
					text: `Sessions: released your working tab ${v.releasedTabId} — later calls without tabId follow the browser's active tab again.`
				}];
				if (v.sessions.length === 0) return [{
					type: "text",
					text: "Sessions: 0 — no agent-scoped tool calls yet (calls without an agent identity keep the old active-tab behaviour)."
				}];
				const lines = v.sessions.map((s) => {
					const me = s.sessionId === v.current ? "* " : "  ";
					const tab = s.workingTabId === void 0 ? "no working tab" : `tab ${s.workingTabId}`;
					return `${me}${short(s.sessionId)} — ${tab}, ${s.calls} calls, last ${formatClock(s.lastActiveAt)}`;
				});
				return [{
					type: "text",
					text: clampRendered(`Sessions: ${v.sessions.length}${v.current === void 0 ? "" : ` (you: ${short(v.current)})`}\n${lines.join("\n")}`)
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.action === "release" ? "Release session tab" : "Browser sessions",
			kind: "other"
		}),
		async execute(args) {
			const current = TOOL_SESSION.getStore();
			if (args.action === "release") {
				const sessions = controller.sessions.list();
				if (current === void 0) return { sessions };
				const released = controller.sessions.release(current);
				const payload = {
					current,
					sessions
				};
				if (released !== void 0) payload.releasedTabId = released;
				return payload;
			}
			if (args.action !== void 0 && args.action !== "list") throw new Error(`action must be "list" or "release" — got ${JSON.stringify(args.action)}`);
			const payload = { sessions: controller.sessions.list() };
			if (current !== void 0) payload.current = current;
			return payload;
		}
	}));
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
function apply(ctx, config) {
	const resolved = config;
	if (resolved.enabled && resolved.token.trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
	const controller = new BridgeController((line) => ctx.logger.info(line));
	let current = () => resolved;
	ctx.inject(["settings"], (sctx) => {
		const settings = sctx.settings;
		/** Converge without a namespace: the profile config stays authoritative. */
		const withoutNamespace = (why) => {
			current = () => resolved;
			ctx.logger.info(`browser-bridge: settings integration skipped (${why})`);
			controller.reconcile(current());
		};
		const register = settings.register;
		if (typeof register !== "function") {
			const configure = settings.configure;
			if (typeof configure === "function") try {
				ctx.effect(() => configure({ auto: true }), "browser-bridge: settings presentation");
			} catch (error) {
				ctx.logger.info(`browser-bridge: settings presentation skipped: ${errorMessage(error)}`);
			}
			withoutNamespace("no settings.register on this dsh-settings build");
			return;
		}
		let scope;
		try {
			scope = register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
				base: config,
				validate: (value) => {
					if (value.enabled && (value.token ?? "").trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
				}
			});
		} catch (error) {
			ctx.logger.info(`browser-bridge: settings namespace failed: ${errorMessage(error)}`);
			withoutNamespace("register threw");
			return;
		}
		current = () => scope.get();
		ctx.effect(() => () => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			current = () => resolved;
			controller.reconcile(current());
		}, "browser-bridge: settings cleanup");
		controller.reconcile(current());
		scope.watch(() => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			controller.reconcile(current());
		});
	});
	controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
		throw new Error(`browser-bridge: ${errorMessage(error)}`);
	});
	applyBrowserTools(ctx, controller);
	ctx.effect(() => () => {
		controller.stop();
	}, "browser-bridge: server lifecycle");
}
//#endregion
export { BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, LOCAL_DESTRUCTIVE_COMMANDS, PAGE_MUTATING_COMMANDS, READ_ONLY_ALLOWED, SCRIPT_COMMANDS, apply, inject, name, policyRefusal };
