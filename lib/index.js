import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
//#endregion
//#region lib/types/errors.js
/**
* 工具调用失败时的结构化契约。
*
* Agent 拿到一句 `Error("...")` 文本时，其实无法决定下一步：该重试、该放弃、还是
* 该先去确认页面状态？真正需要区分的是两件事——
*
*   1. `code`：失败的可分类原因（链路没起、扩展没连、超时、扩展报错……）
*   2. `effectState`：这次调用的副作用**是否可能已经落到页面上**
*
* 第二条是重点：`click` 超时和"扩展中途断开"都属于**结果未知**——鼠标事件也许已经
* 发出去了。这时让 agent 盲目重试，就会点两次、提交两次表单。所以对写操作，
* 我们宁可报 `unknown` 并要求它先观察，也不假装"没发生"。
*
* 读操作（截图、读文本、查元素、列标签……）不改变页面，任何失败都是 `not_started`，
* 重试安全。
*/
/**
* 会改变页面或不可逆地改变浏览器状态的扩展命令；其余按只读处理。
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
	"tabs.activate",
	"dialog"
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
	cancelled: "调用被取消：按需重新发起，不必当作错误处理。",
	not_configured: "插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list）后再试。",
	command_failed: "扩展报回失败：按 error 文本处理，通常是选择器没命中、标签页已关闭或页面不允许该操作。"
};
/** 带分类的桥接错误；`message` 面向人，三个字段面向程序。 */
var BridgeError = class extends Error {
	code;
	effectState;
	hint;
	command;
	constructor(command, code, effectState, message) {
		super(`[${code}] ${message}`);
		this.name = "BridgeError";
		this.code = code;
		this.effectState = effectState;
		this.hint = HINTS[code];
		this.command = command;
	}
	/** 给 HTTP 面用的扁平 JSON 形状。 */
	toJSON() {
		return {
			ok: false,
			error: this.message.replace(/^\[[a-z_]+\]\s*/, ""),
			code: this.code,
			effectState: this.effectState,
			hint: this.hint
		};
	}
};
/**
* 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
* 保证多次包裹不会把 code 洗掉。
*/
function classify(command, error) {
	if (error instanceof BridgeError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const unknownIsPossible = isWriteCommand(command);
	let code;
	if (/no browser extension connected/.test(message)) code = "extension_offline";
	else if (/disconnected mid-command|browser-bridge stopped/.test(message)) code = "link_lost";
	else if (/timed out after/.test(message)) code = "command_timeout";
	else if (/cancelled/.test(message)) code = "cancelled";
	else if (/尚未加载配置|not configured yet/.test(message)) code = "not_configured";
	else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message)) code = "bridge_disabled";
	else code = "command_failed";
	return new BridgeError(command, code, code === "command_timeout" || code === "link_lost" ? unknownIsPossible ? "unknown" : "not_started" : code === "command_failed" ? unknownIsPossible ? "unknown" : "not_started" : "not_started", message);
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
				entry.reject(/* @__PURE__ */ new Error(`browser command cancelled: ${command}`));
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
			throw classify(command, error);
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
			this.hello = {
				client: typeof msg.client === "string" ? msg.client : "unknown",
				version: typeof msg.version === "string" ? msg.version : "unknown",
				protocol: declared,
				browser: msg.browser ?? {
					name: "unknown",
					version: "unknown",
					ua: ""
				}
			};
			this.log(`hello: client=${this.hello.client} v${this.hello.version} protocol=v${declared || "?"} browser=${this.hello.browser.name} ${this.hello.browser.version}`);
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
	shotsDir: z.string().default("dsh-browser-shots")
});
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
const READ_CONTENT_MAX_CHARS = 12e4;
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
	constructor(log) {
		this.log = log;
	}
	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir() {
		return this.current === void 0 ? void 0 : path.resolve(this.current.shotsDir);
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
		const server = this.server;
		if (server === void 0) throw classify(command, new Error(this.lastError ?? "浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）"));
		return server.execute(command, params, timeoutMs === void 0 ? { signal } : {
			signal,
			timeoutMs
		});
	}
	/**
	* Delete generated artifacts using the currently resolved directories;
	* works while the bridge is stopped because it never touches the socket.
	* @returns counts and names of what was removed.
	*/
	async cleanup() {
		const dir = this.shotsDir;
		if (dir === void 0) throw classify("cleanup", /* @__PURE__ */ new Error("browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录"));
		return cleanupArtifacts({ shotsDir: dir });
	}
	/** Stop the listener; safe to call repeatedly and during teardown. */
	stop() {
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		return previous?.stop() ?? Promise.resolve();
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value, maxChars) {
	return value.length <= maxChars ? {
		content: value,
		truncated: false
	} : {
		content: value.slice(0, maxChars),
		truncated: true
	};
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
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl
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
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller) {
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 112,
		text: "The browser_* tools drive the user's real, logged-in browser through the DSH Browser Control extension; they act on the active tab unless a tabId is passed. Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. browser_read extracts page text, browser_screenshot saves a PNG/JPEG and returns its file path (view it with an image tool). Calls fail with actionable copy while the bridge is disabled or no browser is connected."
	});
	ctx.tools.register(defineTool({
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
					siteUnreachable: { type: "boolean" }
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
			const params = { url: args.url };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await controller.execute("nav", params, exec.signal);
			const out = { tabId: raw.tabId };
			if (typeof raw.url === "string") out.url = raw.url;
			if (typeof raw.title === "string") out.title = raw.title;
			if (typeof raw.pendingUrl === "string") out.pendingUrl = raw.pendingUrl;
			if (raw.loadPending === true) out.loadPending = true;
			if (raw.siteUnreachable === true || typeof raw.siteUnreachable === "object" && raw.siteUnreachable !== null) out.siteUnreachable = true;
			return out;
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_read",
		description: "Read the current page: title, URL, ready state, and body text (or full HTML).",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			mode: {
				type: "string",
				description: "\"text\" (default) for visible text, \"html\" for the whole document."
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
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.title} (${value.url}) — ${value.content.length} chars${value.truncated ? ", truncated" : ""}`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const mode = args.mode === "html" ? "html" : "text";
			const raw = await controller.execute("content", args.tabId === void 0 ? { mode } : {
				mode,
				tabId: args.tabId
			}, exec.signal);
			const clamped = clampText(raw.content ?? "", READ_CONTENT_MAX_CHARS);
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? "",
				url: raw.url ?? "",
				content: clamped.content,
				truncated: clamped.truncated
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_snapshot",
		description: "Inventory the page's interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:\"ax\" numbers them by Chrome's accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			limit: {
				type: "number",
				description: "Max elements returned; defaults to 120, capped at 200."
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
			render: (_args, value) => [{
				type: "text",
				text: `${value.items.length} interactive elements on ${value.title} (mode ${value.mode ?? "dom"}); click or fill them by ref.`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Snapshot browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { limit: Math.min(200, Math.max(1, args.limit ?? 120)) };
			if (typeof args.tabId === "number") params.tabId = args.tabId;
			if (typeof args.mode === "string") params.mode = args.mode;
			const raw = await controller.execute("snapshot", params, exec.signal);
			return {
				tabId: raw.tabId,
				title: raw.title ?? "",
				url: raw.url ?? "",
				...raw.mode === void 0 ? {} : { mode: raw.mode },
				...raw.axFallback === void 0 ? {} : { axFallback: raw.axFallback },
				items: (raw.items ?? []).map((item) => ({
					ref: item.ref,
					tag: item.tag,
					...item.role === void 0 ? {} : { role: item.role },
					...item.name === void 0 ? {} : { name: item.name },
					...item.href === void 0 ? {} : { href: item.href }
				}))
			};
		}
	}));
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
		name: "browser_press",
		description: "Send a real keyboard event to the page (Enter, Tab, Escape, arrows, or a single character).",
		parameters: {
			key: {
				type: "string",
				required: true,
				description: "Named key (Enter, Escape, ArrowDown…) or a single character."
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
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("press", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
		name: "browser_tabs",
		description: "List tabs, or open/close/activate/group/ungroup one. Actions act on real browser windows.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: list, open, close, activate, group, ungroup."
			},
			url: {
				type: "string",
				description: "URL for the open action."
			},
			tabId: {
				type: "number",
				description: "Target tab for close/activate/group."
			},
			active: {
				type: "boolean",
				description: "Whether a newly opened tab becomes active; defaults to true."
			},
			group: {
				type: "boolean",
				description: "For open: put the new tab in the DSH tab group. Defaults to true; pass false to keep it loose."
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
					const params = { url: args.url };
					if (args.active !== void 0) params.active = args.active;
					if (args.group !== void 0) params.group = args.group;
					return await controller.execute("tabs.open", params, exec.signal);
				}
				case "close": return await controller.execute("tabs.close", { tabId: requireTabId(args, "close") }, exec.signal);
				case "activate": return await controller.execute("tabs.activate", { tabId: requireTabId(args, "activate") }, exec.signal);
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
	ctx.tools.register(defineTool({
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
			const raw = await controller.execute("eval", args.tabId === void 0 ? { expression: args.expression } : {
				expression: args.expression,
				tabId: args.tabId
			}, exec.signal);
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
	ctx.tools.register(defineTool({
		name: "browser_screenshot",
		description: "Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			fullPage: {
				type: "boolean",
				description: "Capture beyond the viewport."
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
					url: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Saved ${value.file} (${value.bytes} bytes)`
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
			return saveScreenshot(controller, await controller.execute("screenshot", params, exec.signal));
		}
	}));
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
		name: "browser_console_log",
		description: "Read the captured `console.log/info/warn/error` entries for a tab. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for \"what did the page log after I clicked submit\".",
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
							properties: {}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`
			}]
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
			return await controller.execute("console.log", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
							properties: {}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`
			}]
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
			return await controller.execute("network.log", params, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
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
	ctx.tools.register(defineTool({
		name: "browser_emulate",
		description: "Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:\"reset\"` restores the user's actual viewport. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			device: {
				type: "string",
				description: "Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below."
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
					userAgent: { type: "string" }
				}
			},
			render: (_args, value) => {
				if (value.reset) return [{
					type: "text",
					text: `Tab ${value.tabId}: emulation reset to default`
				}];
				return [{
					type: "text",
					text: `Tab ${value.tabId}: ${value.width || "?"}×${value.height || "?"} DPR=${value.deviceScaleFactor ?? "?"} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Emulate${args.device ? " " + args.device : " device"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (typeof args.device === "string") params.device = args.device;
			if (typeof args.width === "number") params.width = args.width;
			if (typeof args.height === "number") params.height = args.height;
			if (typeof args.deviceScaleFactor === "number") params.deviceScaleFactor = args.deviceScaleFactor;
			if (typeof args.isMobile === "boolean") params.isMobile = args.isMobile;
			if (typeof args.hasTouch === "boolean") params.hasTouch = args.hasTouch;
			if (typeof args.userAgent === "string") params.userAgent = args.userAgent;
			return await controller.execute("emulate", params, exec.signal);
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
export { BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, apply, inject, name };
