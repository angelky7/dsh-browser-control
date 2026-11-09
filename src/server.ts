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

import http from 'node:http'
import type net from 'node:net'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { encodeCloseFrame, encodeControlFrame, encodeTextFrame, FrameReader } from './ws.ts'
import { BridgeError, classify } from './errors.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/**
 * Wire protocol revision this bridge speaks. Kept separate from the package
 * version: an extension that is one patch newer still works, an extension that
 * speaks a different frame contract does not, and only the second case should
 * light up.
 */
export const BRIDGE_PROTOCOL_VERSION = 1
/** Per-command ceiling when the caller passes none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
export const MAX_COMMAND_TIMEOUT_MS = 300_000
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024
/** The published default. It ships in README and `cordis.patch.yml`, so it is public knowledge. */
const DEFAULT_TOKEN = 'dsh-local'
/** Tokens shorter than this cannot be brute-forced meaningfully; the bridge warns at start. */
const MIN_RECOMMENDED_TOKEN_LENGTH = 16

/** Identity the extension announces right after the handshake completes. */
export interface BridgeHello {
  readonly client: string
  readonly version: string
  /** Frame-contract revision the extension declared; 0 when it predates versioning. */
  readonly protocol: number
  readonly browser: { readonly name: string; readonly version: string; readonly ua: string }
  /**
   * Command names the extension implements (v1.7.2+). Absent when the extension
   * predates the capability handshake — callers fall back to a version map.
   */
  readonly capabilities?: readonly string[]
}

/** Snapshot of the link and in-flight work, served verbatim on `/api/status`. */
export interface BridgeServerStatus {
  readonly listening: boolean
  readonly port: number | undefined
  readonly extensionConnected: boolean
  readonly connectedAt: string | undefined
  readonly hello: BridgeHello | undefined
  /** Protocol revision this bridge speaks. */
  readonly bridgeProtocol: number
  /** Protocol revision the extension declared; absent/0 when it predates versioning. */
  readonly extensionProtocol: number
  /** False when the two sides cannot agree on the frame contract, with the reason. */
  readonly protocolCompatible: boolean
  readonly protocolNote: string | null
  readonly pendingCommands: number
  readonly lastError: string | undefined
  /** True when the active token is the published default or too short to be a secret. */
  readonly insecureToken: boolean
}

/** Caller controls for one {@link BridgeServer.execute} round-trip. */
export interface BridgeExecuteOptions {
  /** Fail the command after this many milliseconds; defaults to 60s, capped at 300s. */
  readonly timeoutMs?: number
  /** Cancellation from the tool execution; aborting fails the in-flight command. */
  readonly signal?: AbortSignal
}

/** What {@link BridgeServer.cleanup} removed. */
export interface CleanupResult {
  /** Files deleted directly inside the screenshots directory. */
  readonly shotsRemoved: number
  /** Scratch files deleted (agent temp scripts/artifacts matched by convention). */
  readonly scratchRemoved: readonly string[]
}

interface PendingEntry {
  readonly command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onAbort?: () => void
}

export interface BridgeServerOptions {
  readonly port: number
  readonly token: string
  /** Directory whose direct contents `cleanup()` clears; created on demand. */
  readonly shotsDir: string
  /** Directory scanned for agent scratch files by `cleanup()`; defaults to the process working directory. */
  readonly scratchDir?: string
  /** Optional line logger for lifecycle diagnostics. */
  readonly log?: (line: string) => void
  /**
   * Executor for the HTTP command face. The plugin passes its controller so
   * `/api/command` goes through the same policy gate and audit trail as tools;
   * without it (bare BridgeServer users, tests) the face stays raw.
   */
  readonly httpCommand?: (command: string, params: Record<string, unknown>, options: BridgeExecuteOptions) => Promise<unknown>
}

/** Agent scratch-file convention: `__name.mjs`-style temp artifacts at the top level only. */
const SCRATCH_FILE_PATTERN = /^__[^/\\]+\.(mjs|cjs|js|png|jpg|jpeg)$/i

/**
 * Clear the screenshots directory and delete agent scratch files. Only the
 * top level of each location is touched; nested trees stay untouched.
 * @param options - `shotsDir` is cleared of direct file children; `scratchDir`
 *   defaults to the process working directory and loses only scratch-named files.
 * @returns counts and names of what was removed.
 */
export async function cleanupArtifacts(options: { shotsDir: string; scratchDir?: string }): Promise<CleanupResult> {
	await mkdir(options.shotsDir, { recursive: true })
	const shotsEntries = await readdir(options.shotsDir, { withFileTypes: true })
	let shotsRemoved = 0
	for (const entry of shotsEntries) {
		if (!entry.isFile()) continue
		await rm(path.join(options.shotsDir, entry.name))
		shotsRemoved += 1
	}
	const scratchDir = options.scratchDir ?? process.cwd()
	const scratchEntries = await readdir(scratchDir, { withFileTypes: true }).catch(() => [])
	const scratchRemoved: string[] = []
	for (const entry of scratchEntries) {
		if (!entry.isFile() || !SCRATCH_FILE_PATTERN.test(entry.name)) continue
		await rm(path.join(scratchDir, entry.name))
		scratchRemoved.push(entry.name)
	}
	return { shotsRemoved, scratchRemoved }
}

/**
 * One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
 * a fresh listener is built per start so a changed config reuses the class
 * without re-allocation concerns. Exactly one extension link is held at a
 * time; a newer WebSocket replaces the older one.
 */
export class BridgeServer {
  private readonly options: BridgeServerOptions
  private httpServer: http.Server | undefined
  private clientSocket: net.Socket | undefined
  private hello: BridgeHello | undefined
  private connectedAt: Date | undefined
  private readonly pending = new Map<string, PendingEntry>()
  private lastError: string | undefined
  /**
   * Payloads of the message being reassembled. **Buffers, not strings**: decoding
   * each fragment with `toString('utf8')` corrupts any multi-byte character that
   * straddles a fragment boundary. Decode once, at FIN.
   */
  private continuationChunks: Buffer[] = []
  private continuationOpen = false

  constructor(options: BridgeServerOptions) {
    this.options = options
  }

  /** Current link state, also served verbatim as `/api/status`. */
  get status(): BridgeServerStatus {
    return {
      listening: this.httpServer !== undefined,
      port: this.httpServer !== undefined ? this.options.port : undefined,
      extensionConnected: this.clientSocket !== undefined,
      connectedAt: this.connectedAt?.toISOString(),
      hello: this.hello,
      bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
      extensionProtocol: this.hello?.protocol ?? 0,
      protocolCompatible: this.protocolNote === null,
      protocolNote: this.protocolNote,
      pendingCommands: this.pending.size,
      lastError: this.lastError,
      insecureToken: this.insecureToken,
    }
  }

  private get insecureToken(): boolean {
    return this.options.token === DEFAULT_TOKEN || this.options.token.trim().length < MIN_RECOMMENDED_TOKEN_LENGTH
  }

  /** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
  async start(): Promise<void> {
    if (this.httpServer !== undefined) return
    const server = http.createServer((req, res) => {
      try {
        this.handleHttp(req, res)
      } catch (error) {
        this.log(`http handler failed: ${errorMessage(error)}`)
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'internal error' }))
      }
    })
    server.on('upgrade', (req, socket) => {
      try {
        this.handleUpgrade(req, socket as net.Socket)
      } catch (error) {
        this.log(`upgrade failed: ${errorMessage(error)}`)
        socket.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.lastError = errorMessage(error)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, '127.0.0.1')
    })
    this.httpServer = server
    this.log(`listening on ws://127.0.0.1:${this.options.port}/ws`)
    if (this.insecureToken) {
      // Loud, but not a hard refusal: the published default keeps a fresh install working,
      // and refusing here would break every existing extension pairing.
      this.log(`insecure token (${this.options.token === DEFAULT_TOKEN ? 'the published default' : 'shorter than ' + MIN_RECOMMENDED_TOKEN_LENGTH + ' chars'}) — any local process can present it; set a longer \`token\` in the browser-bridge config`)
    }
  }

  /** Close the extension link, fail every pending command, and release the port. Idempotent. */
  async stop(): Promise<void> {
    const server = this.httpServer
    if (server === undefined) return
    this.httpServer = undefined
    this.closeClientSocket(1001, 'server stopping')
    this.failAllPending(new Error('browser-bridge stopped'))
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    this.log('stopped')
  }

  /**
   * Send one command to the connected extension and await its result.
   * Throws while no extension is linked; the rejection message names the fix.
   */
  async execute(command: string, params: Record<string, unknown>, options: BridgeExecuteOptions = {}): Promise<unknown> {
    const socket = this.clientSocket
    if (socket === undefined) {
      throw classify(command, new Error('no browser extension connected — open the browser that has the DSH Browser Control extension installed'))
    }
    const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS))
    const signal = options.signal
    if (signal?.aborted) throw new Error(`browser command cancelled before send: ${command}`)
    const id = randomUUID()
    const entry: PendingEntry = {
      command,
      resolve: () => {},
      reject: () => {},
      timer: setTimeout(() => {
        if (!this.pending.delete(id)) return
        entry.reject(new Error(`browser command timed out after ${timeoutMs}ms: ${command}`))
      }, timeoutMs),
    }
    const result = new Promise<unknown>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (signal !== undefined) {
      entry.onAbort = (): void => {
        if (!this.pending.delete(id)) return
        // 监听器只可能在 socket.write 之后触发（execute 从注册到写出是同步的、中间
        // 没有 await），所以这里必须说 after send：写命令的结果是未知，而不是
        // 「取消 = 什么都没发生」。before send 的那条检查在函数开头，措辞不同。
        entry.reject(new Error(`browser command cancelled after send: ${command}`))
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    this.pending.set(id, entry)
    this.log(`-> ${command} (${id})`)
    socket.write(encodeTextFrame(JSON.stringify({ type: 'command', id, command, params })))
    try {
      return await result
    } catch (error) {
      // One choke point: everything above this line that can fail is a link or
      // extension failure, and the caller needs to know whether the page may
      // already have been changed. See src/errors.ts. `params` matters for wait(fn):
      // 谓词是任意 JS，超时/取消时按写命令报 unknown。
      throw classify(command, error, params)
    } finally {
      clearTimeout(entry.timer)
      if (entry.onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', entry.onAbort)
    }
  }

  /**
   * Delete generated screenshots and agent scratch files via
   * {@link cleanupArtifacts} using this server's configured directories.
   */
  async cleanup(): Promise<CleanupResult> {
    const result = await cleanupArtifacts({
      shotsDir: this.options.shotsDir,
      ...(this.options.scratchDir === undefined ? {} : { scratchDir: this.options.scratchDir }),
    })
    this.log(`cleanup: ${result.shotsRemoved} screenshot(s), ${result.scratchRemoved.length} scratch file(s)`)
    return result
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /**
   * Mismatch description, or null when the two sides can talk. An older
   * extension that declares nothing is treated as v1-compatible: it still
   * answers every command this bridge has ever sent, so failing the link would
   * break working installs for a cosmetic gap.
   */
  private get protocolNote(): string | null {
    if (this.hello === undefined) return null
    const theirs = this.hello.protocol
    if (theirs === 0) return null
    if (theirs > BRIDGE_PROTOCOL_VERSION) {
      return `扩展声明协议 v${theirs}，本桥只支持到 v${BRIDGE_PROTOCOL_VERSION} —— 请升级 dsh 插件，否则新命令会报「未知命令」`
    }
    if (theirs < BRIDGE_PROTOCOL_VERSION) {
      return `扩展协议 v${theirs} 低于本桥 v${BRIDGE_PROTOCOL_VERSION} —— 旧扩展可能缺少新命令，必要时重新下载扩展包`
    }
    return null
  }

  /* ------------------------------------------------------------- HTTP face */

  /**
   * Whether a request carries the bridge token, the same credential the WebSocket
   * upgrade checks. Accepted forms: `Authorization: Bearer <token>`, `X-Token: <token>`
   * and `?token=<token>` (the query form exists for curl and for the status page).
   */
  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const authorization = req.headers.authorization
    const header = typeof authorization === 'string' && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '')
      : typeof req.headers['x-token'] === 'string'
        ? (req.headers['x-token'] as string)
        : ''
    const presented = header.length > 0 ? header : (url.searchParams.get('token') ?? '')
    return tokenMatches(presented, this.options.token)
  }

  private rejectUnauthenticated(res: http.ServerResponse, route: string): void {
    this.log(`http ${route}: rejected (missing or wrong token)`)
    this.respondJson(res, 401, {
      ok: false,
      error: 'unauthorized: pass the bridge token as "Authorization: Bearer <token>", "X-Token: <token>" or ?token=<token>',
    })
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'OPTIONS') {
      // No cross-origin access is granted any more: the status page is same-origin and
      // the extension only ever talks over the WebSocket. Answering a preflight without
      // `Access-Control-Allow-Origin` is what makes the browser block the real request.
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      this.respondJson(res, 200, { ok: true, ...this.status, wsUrl: `ws://127.0.0.1:${this.options.port}/ws`, shotsDir: path.resolve(this.options.shotsDir) })
      return
    }
    if (url.pathname === '/api/cleanup' && req.method === 'POST') {
      // Deletes files, so it authenticates like the command endpoint does.
      if (!this.authorized(req, url)) {
        this.rejectUnauthenticated(res, 'POST /api/cleanup')
        return
      }
      void this.cleanup().then(
        (result) => this.respondJson(res, 200, { ok: true, ...result }),
        (error) => this.respondJson(res, 500, { ok: false, error: errorMessage(error) }),
      )
      return
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      // Reaches the extension command table (eval / click / input / screenshot), so it
      // used to be the whole attack surface; 127.0.0.1 alone never was a boundary.
      if (!this.authorized(req, url)) {
        this.rejectUnauthenticated(res, 'POST /api/command')
        return
      }
      this.handleCommandRequest(req, res)
      return
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(statusPageHtml(this.options.port))
      return
    }
    this.respondJson(res, 404, { ok: false, error: `no route: ${req.method} ${url.pathname}` })
  }

  private respondJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    // This is the shared exit for every JSON reply, so it is also where cross-origin
    // access used to leak: no `Access-Control-Allow-Origin` is sent at all now.
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  private handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return // keep discarding so the client sees the 413 instead of a reset
      size += chunk.length
      if (size > MAX_HTTP_BODY_BYTES) {
        aborted = true
        chunks.length = 0
        this.respondJson(res, 413, { ok: false, error: 'body too large' })
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        this.respondJson(res, 400, { ok: false, error: `invalid JSON body: ${errorMessage(error)}` })
        return
      }
      // `null` parses fine and is NOT an object: without this guard the property
      // reads below throw a TypeError inside an event callback (uncaught).
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.respondJson(res, 400, { ok: false, error: 'body must be {"command": "...", "params": {...}}' })
        return
      }
      const body = parsed as { command?: unknown; params?: unknown; timeoutMs?: unknown }
      if (typeof body.command !== 'string' || body.command.length === 0) {
        this.respondJson(res, 400, { ok: false, error: 'body must be {"command": "...", "params": {...}}' })
        return
      }
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined
      const options: BridgeExecuteOptions = timeoutMs === undefined ? {} : { timeoutMs }
      // The plugin's controller carries the read-only / script gates and the audit
      // trail; the raw execute() below is only the fallback for bare users.
      const run = this.options.httpCommand ?? ((command, params, opts) => this.execute(command, params, opts))
      run(body.command, (body.params ?? {}) as Record<string, unknown>, options).then(
        (result) => this.respondJson(res, 200, { ok: true, result }),
        (error) => {
          if (error instanceof BridgeError) {
            // 503 = 现在根本没法工作；504 = 超时且结果未知；403 = 本机策略拦下（零副作用）；
            // 502 = 扩展报了具体失败
            const status = error.code === 'extension_offline' || error.code === 'bridge_disabled' || error.code === 'not_configured'
              ? 503
              : error.code === 'command_timeout' || error.code === 'link_lost'
                ? 504
                : error.code === 'blocked_by_policy'
                  ? 403
                  : 502
            this.respondJson(res, status, error.toJSON())
            return
          }
          this.respondJson(res, 502, { ok: false, error: errorMessage(error) })
        },
      )
    })
  }

  /* ------------------------------------------------------- websocket link */

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (!tokenMatches(url.searchParams.get('token') ?? '', this.options.token)) {
      this.log('websocket rejected: bad token')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    // A WebSocket handshake is not CORS-guarded, so a page could dial 127.0.0.1 freely if
    // it had a token to present. Origin and Host pin it down: no web-scheme caller, and no
    // hostname that resolves back to the loopback via rebinding.
    if (!isLoopbackHost(String(req.headers.host ?? ''))) {
      this.log(`websocket rejected: host ${req.headers.host}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    if (!isTrustedUpgradeOrigin(origin)) {
      this.log(`websocket rejected: origin ${origin}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + '\r\n',
    )
    this.closeClientSocket(1000, 'replaced by a newer connection')
    this.clientSocket = socket
    this.hello = undefined
    this.connectedAt = new Date()
    this.continuationChunks = []
    this.continuationOpen = false
    this.log(`extension connected from ${socket.remoteAddress}:${socket.remotePort}`)
    const reader = new FrameReader()
    socket.on('data', (chunk: Buffer) => {
      // A replaced connection can still deliver buffered frames. Without this
      // guard its pong/frames would be applied to the NEW link, and its close
      // event could tear the new socket down (the close handler already checks,
      // the data handler did not).
      if (this.clientSocket !== socket) {
        socket.destroy()
        return
      }
      reader.push(chunk)
      try {
        reader.drain((frame) => this.handleFrame(frame))
      } catch (error) {
        this.log(`protocol error: ${errorMessage(error)}`)
        this.lastError = errorMessage(error)
        this.closeClientSocket(1002, 'protocol error')
      }
    })
    socket.on('error', (error) => {
      this.logVerbose(`socket error: ${errorMessage(error)}`)
      this.closeClientSocket(1011, 'server error')
    })
    socket.on('close', () => {
      if (this.clientSocket !== socket) return
      this.closeClientSocket(1000, '')
    })
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case 0x1:
      case 0x0:
        this.handleText(frame.payload, frame.fin, frame.opcode)
        return
      case 0x8:
        this.closeClientSocket(1000, '')
        return
      case 0x9:
        this.clientSocket?.write(encodeControlFrame(0xA, frame.payload))
        return
      default:
        return // pong or binary: nothing to do
    }
  }

  private handleText(payload: Buffer, fin: boolean, opcode: number): void {
    if (opcode === 0x0 && !this.continuationOpen) return // stray continuation
    if (opcode === 0x1) this.continuationChunks = []
    this.continuationOpen = opcode === 0x0 || !fin
    this.continuationChunks.push(payload)
    if (!fin) return
    // Decode only the complete message: per-fragment toString('utf8') splits
    // multi-byte characters at fragment boundaries and corrupts the JSON.
    const full = Buffer.concat(this.continuationChunks).toString('utf8')
    this.continuationChunks = []
    this.continuationOpen = false
    let msg: { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; t?: unknown; client?: unknown; version?: unknown; protocol?: unknown; browser?: unknown; capabilities?: unknown }
    try {
      msg = JSON.parse(full) as typeof msg
    } catch {
      this.logVerbose('dropped a non-JSON extension message')
      return
    }
    if (msg.type === 'hello') {
      const declared = typeof msg.protocol === 'number' ? msg.protocol : 0
      const capabilities = Array.isArray(msg.capabilities)
        ? msg.capabilities.filter((c): c is string => typeof c === 'string')
        : undefined
      this.hello = {
        client: typeof msg.client === 'string' ? msg.client : 'unknown',
        version: typeof msg.version === 'string' ? msg.version : 'unknown',
        protocol: declared,
        browser: (msg.browser ?? { name: 'unknown', version: 'unknown', ua: '' }) as BridgeHello['browser'],
        ...(capabilities !== undefined ? { capabilities } : {}),
      }
      this.log(`hello: client=${this.hello.client} v${this.hello.version} protocol=v${declared || '?'} browser=${this.hello.browser.name} ${this.hello.browser.version}${capabilities ? ` capabilities=${capabilities.length}` : ''}`)
      const note = this.protocolNote
      if (note !== null) this.log(`protocol mismatch: ${note}`)
      return
    }
    if (msg.type === 'pong') return
    if (msg.type === 'result' && typeof msg.id === 'string') {
      const entry = this.pending.get(msg.id)
      if (entry === undefined) {
        this.logVerbose(`result for unknown id ${msg.id}`)
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok === true) entry.resolve(msg.result)
      else entry.reject(new Error(typeof msg.error === 'string' && msg.error.length > 0 ? msg.error : 'unknown extension error'))
    }
  }

  private closeClientSocket(code: number, reason: string): void {
    const socket = this.clientSocket
    if (socket === undefined) return
    this.clientSocket = undefined
    this.hello = undefined
    this.connectedAt = undefined
    this.failAllPending(new Error('the browser extension disconnected mid-command'))
    try {
      socket.write(encodeCloseFrame(code, reason))
      socket.end()
      setTimeout(() => socket.destroy(), 500).unref()
    } catch {
      socket.destroy()
    }
    if (reason.length > 0) this.log(`extension disconnected (${reason})`)
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private logVerbose(line: string): void {
    // Verbose chatter stays available under the same line logger; lifecycle logs matter most.
    this.options.log?.(line)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Constant-time token comparison; a length mismatch is the only thing leaked. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * `Host` must name the loopback address this server binds. Rejecting anything else is
 * what stops a rebinding setup (a public hostname resolving to 127.0.0.1) from reaching
 * the bridge through the browser.
 */
function isLoopbackHost(host: string): boolean {
  const withoutPort = host.replace(/:\d+$/, '')
  return withoutPort === '127.0.0.1' || withoutPort === 'localhost' || withoutPort === '[::1]' || withoutPort === '::1'
}

/**
 * An `Origin` of a web scheme means a page opened the socket — WebSocket handshakes are
 * not covered by CORS, so that has to be refused here. Extension schemes (`chrome-extension:`
 * etc.) and non-browser clients that send no Origin at all are accepted.
 */
function isTrustedUpgradeOrigin(origin: string): boolean {
  if (origin === '') return true
  if (/^(?:chrome|moz|ms|safari)-extension:\/\//.test(origin)) return true
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)
}

/** Minimal self-refreshing status page with the cleanup action. */
function statusPageHtml(port: number): string {
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
</script>
</body></html>`;
}
