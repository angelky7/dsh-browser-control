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

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool as defineHostTool, type DefineToolOptions, type ParameterSchemaSpec, type ToolRunContext, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-settings'
import { BridgeServer, cleanupArtifacts } from './server.ts'
import { BridgeError, classify } from './errors.ts'
import { policyRefusal } from './policy.ts'
import { AUDIT_MAX_ENTRIES, AuditLog, summarizeAuditParams, type AuditEntry } from './audit.ts'
import { Journal, readJournal } from './journal.ts'
import { SessionRegistry } from './sessions.ts'

/** Navigation wait ceiling (same as browser_wait); the bridge gets this plus BRIDGE_MARGIN_MS. */
const NAV_MAX_MS = 120_000
/**
 * Same tier table as the extension's NAV_TIERS (extension/background.js). Both
 * literals must stay in lockstep — verify_nav_waituntil.mjs extracts the
 * extension's by regex and asserts the two agree (cross-side literals are wire
 * protocol: a value only one side knows is a lie on the other).
 */
const NAV_TIERS: Record<string, number> = { none: 0, commit: 4_000, domcontentloaded: 4_000, load: 15_000 }

/**
 * Commands whose params carry no meaningful single tab: link probes, tab
 * management, window management and the global dialog policy. Everything else
 * defaults to the calling session's working tab when tabId is omitted
 * (v1.7.6 isolation). New tab-scoped commands need no registration here —
 * they inherit the default, which is the safe direction.
 */
const NO_TAB_DEFAULT_COMMANDS: ReadonlySet<string> = new Set([
	'ping', 'browser.info',
	'tabs.list', 'tabs.open', 'tabs.group', 'tabs.ungroup',
	'windows.list', 'windows.open', 'windows.update', 'windows.close', 'windows.moveTab',
	'dialog',
])
/**
 * Extra time handed to the bridge on top of the navigation budget. Without it a
 * caller-requested budget longer than the bridge default (60s) would be beaten by
 * the bridge, and the model would get `command_timeout` (effect unknown) instead
 * of a navigation timeout (nothing was touched) - two very different next steps.
 */
const BRIDGE_MARGIN_MS = 2_000

/**
 * 每个工具体都跑在调用方 agent 的会话上下文里（exec.agent.id）。控制器用它
 * 解析「这个会话的工作标签页」。没有 agent 身份的调用（HTTP 面、测试、老宿主）
 * store 是 undefined，行为与以前完全一致。
 */
const TOOL_SESSION = new AsyncLocalStorage<string | undefined>()

/**
 * 包一层宿主的 defineTool：注册处全部走这里，工具体自动带上会话上下文。
 * 这是 v1.7.6 多 session 隔离能集中实现、而不用改二十多处 execute 的原因。
 */
function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>) {
	// The body is typed through ToolRunContext and cast at both boundaries: letting
	// TS deep-compare the generic option shape through a spread blows its recursion
	// budget ("excessive stack depth comparing InferObject").
	const inner = options.execute as unknown as (args: unknown, exec: ToolRunContext) => Promise<unknown>
	const execute = ((args: unknown, exec: ToolRunContext) => {
		const agent = (exec as { agent?: { id?: unknown } }).agent
		const sessionId = typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
		return TOOL_SESSION.run(sessionId, () => inner(args, exec))
	}) as unknown as DefineToolOptions<S, O>['execute']
	// Call the host helper through a non-generic point: re-instantiating its
	// recursive InferObject types from inside a generic wrapper is what TS chokes on.
	const hostDefine = defineHostTool as unknown as (o: DefineToolOptions<S, O>) => ReturnType<typeof defineHostTool>
	return hostDefine({ ...options, execute } as DefineToolOptions<S, O>)
}

// Re-exported so the policy tables stay testable from the published bundle
// (verify/verify_policy.mjs reconciles them against the extension's COMMANDS).
export { LOCAL_DESTRUCTIVE_COMMANDS, PAGE_MUTATING_COMMANDS, READ_ONLY_ALLOWED, SCRIPT_COMMANDS, policyRefusal } from './policy.ts'

/**
 * Tool results are plain JSON. Declared locally rather than imported: dsh-tools
 * 0.1 re-exported this type while 0.2 moved it into a transitive package the
 * plugin must not name, so importing it would pin us to one host generation.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Namespace handle as returned by `sctx.settings.register` on dsh-settings up to
 * 0.1.2-rc.1. Declared structurally instead of imported: 0.1.7+ dropped both
 * `register` and the `SettingsScope` type, and the plugin must still typecheck
 * against those builds.
 */
interface LegacySettingsScope<T> {
	get(): T
	watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge'

/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt']

/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge'

export interface Config {
	/**
	 * Whether the local bridge listens. Defaults to true so the plugin is
	 * usable immediately after install; set false to keep the tools mounted but
	 * every call reports how to enable the bridge, so the opt-out stays explicit.
	 */
	enabled?: boolean
	/** Loopback port the extension dials; the HTTP face shares it. */
	port?: number
	/** Shared secret the extension presents on the WebSocket upgrade query. */
	token?: string
	/**
	 * Directory screenshots are written to and `cleanup` clears. Relative paths
	 * resolve against the process working directory at resolve time.
	 */
	shotsDir?: string
	/**
	 * Directory the command journal is written to (v1.7.5 session recovery).
	 * Defaults to `~/.dsh-browser-control` — stable across restarts regardless
	 * of the process working directory.
	 */
	stateDir?: string
	/**
	 * Read-only mode: refuse every command that would change the page or the
	 * browser (click / input / press / nav / scroll / tabs.* / emulate / dialog /
	 * network.clear …) while reads keep working. Off by default. Takes effect
	 * live — the gate reads the current settings on every call.
	 */
	readOnly?: boolean
	/**
	 * Allow running arbitrary page scripts (`browser_evaluate`). On by default,
	 * because that tool is the escape hatch when no dedicated command fits. Set
	 * false to keep clicks and reads while forbidding arbitrary JS in the page:
	 * `browser_evaluate` can do everything the other tools can, so "read-only"
	 * alone does not take arbitrary code off the table.
	 */
	allowScript?: boolean
}

export const Config: z<Config> = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65_535).default(9777),
	token: z.string().default('dsh-local'),
	shotsDir: z.string().default('dsh-browser-shots'),
	// 审计账本落盘目录（v1.7.5 会话恢复）。默认放用户主目录，跟 dsh 的启动目录无关。
	stateDir: z.string().default(path.join(homedir(), '.dsh-browser-control')),
	readOnly: z.boolean().default(false),
	allowScript: z.boolean().default(true),
})

interface ResolvedConfig {
	enabled: boolean
	port: number
	token: string
	shotsDir: string
	stateDir: string
	readOnly: boolean
	allowScript: boolean
}

const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/
/** One `browser_read` window, in characters of page text. Longer pages are paged
 *  with `offset`, so no single call can put a whole site into the transcript. */
const READ_WINDOW_MAX_CHARS = 20_000

/**
 * Extension command surface, as deltas over the pre-1.5 baseline. Used when a
 * connected extension predates the capability handshake (no `capabilities` in
 * its hello frame): the plugin maps its reported version to the commands it
 * must have. Anything not listed here exists since the baseline and is assumed
 * present; a version newer than every entry is assumed to have everything
 * (forward compatible — an extension never removes commands).
 */
const EXTENSION_COMMANDS_BY_VERSION: ReadonlyArray<{ readonly since: string, readonly commands: readonly string[] }> = [
	{ since: '1.5.0', commands: ['archive'] },
	{ since: '1.6.0', commands: ['windows.list', 'windows.open', 'windows.update', 'windows.close', 'windows.moveTab'] },
	{ since: '1.7.0', commands: ['tabs.back', 'tabs.forward'] },
	{ since: '1.7.1', commands: ['metrics'] },
	{ since: '1.7.2', commands: ['cdp'] },
]

/** Compare two `x.y.z` version strings numerically; unparseable input sorts lowest. */
function compareVersions(a: string, b: string): number {
	const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) ?? []).slice(1).map(Number)
	const [pa, pb] = [parse(a), parse(b)]
	if (pa.length === 0 || pb.length === 0) return pa.length === pb.length ? 0 : (pa.length === 0 ? -1 : 1)
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
	}
	return 0
}

/**
 * The plugin updated, the extension did not: the invariant is that this combo is
 * never WORSE than the matched pair from the extension's era — existing tools
 * behave identically, and tools that need commands the old extension lacks fail
 * with an actionable upgrade pointer instead of a raw "unknown command".
 */
function extensionOutdatedError(have: string | undefined, command: string, since: string): Error {
	const message = 'extension-outdated: the connected browser extension'
		+ (have === undefined ? '' : ` (v${have})`)
		+ ` does not have the "${command}" command this action needs (added in extension v${since}).`
		+ ' One-time fix: download DSH-Browser-Control.zip from https://github.com/angelky7/dsh-browser-control/releases/latest, unzip, then chrome://extensions → Developer mode → replace the loaded folder (remove the old one first).'
		+ ' That update makes the extension compatible with all future plugin updates — CDP-level features ship plugin-side from v1.7.2 on.'
	const error = new Error(message)
	;(error as Error & { code?: string }).code = 'extension_outdated'
	return error
}

/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
class BridgeController {
	private server: BridgeServer | undefined
	private serverKey = ''
	private lastError: string | undefined
	private chain: Promise<void> = Promise.resolve()
	private current: ResolvedConfig | undefined
	private journal: Journal | undefined
	private journalKey = ''
	/** 操作审计账本（内存环形缓冲，200 条；命令层记录，见 audit.ts 顶部注释）。 */
	readonly audit = new AuditLog()
	/** 多 session 隔离：每个 dsh 会话的工作标签页（见 sessions.ts）。 */
	readonly sessions = new SessionRegistry()

	constructor(private readonly log: (line: string) => void) {}

	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.shotsDir)
	}

	/** 审计账本落盘目录；配置到达之前是 undefined。 */
	get stateDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.stateDir)
	}

	/**
	 * Record one audit entry in memory and, when the journal is open, on disk.
	 * Journal appends are queued and never block the command path.
	 */
	private recordAudit(input: Parameters<AuditLog['record']>[0]): void {
		this.journal?.append(this.audit.record(input))
	}

	/**
	 * Current policy flags. Tools that compose several commands (browser_drag
	 * runs `cdp`/`eval`) read this to refuse with a tool-level message; the
	 * per-command gate in execute() stays as the enforcement backstop.
	 */
	get policy(): { readOnly: boolean; allowScript: boolean } {
		return { readOnly: this.current?.readOnly === true, allowScript: this.current?.allowScript !== false }
	}

	/** Version the connected extension reported in its hello frame, if any. */
	extensionVersion(): string | undefined {
		return this.server?.status.hello?.version
	}

	/**
	 * Whether the connected extension implements `command`. Exact when the hello
	 * carries a capabilities list (v1.7.2+); otherwise derived from the reported
	 * version via the surface-delta map. No connection ⇒ true: the not-enabled
	 * error from execute is the right failure there, not a capability complaint.
	 */
	hasExtensionCommand(command: string): boolean {
		const hello = this.server?.status.hello
		if (hello?.capabilities !== undefined) return hello.capabilities.includes(command)
		const version = hello?.version
		if (version === undefined || version === 'unknown') return true
		const entry = EXTENSION_COMMANDS_BY_VERSION.find((e) => e.commands.includes(command))
		if (entry === undefined) return true
		return compareVersions(version, entry.since) >= 0
	}

	/**
	 * Pre-flight capability gate: throw the actionable upgrade error before the
	 * command is sent, so an old extension answers with a what-to-do, never with
	 * a bare "unknown command" the model cannot act on.
	 */
	requireExtensionCommand(command: string, since: string): void {
		if (this.hasExtensionCommand(command)) return
		// 预检拒绝也要上账：这是「升级插件后模型发现功能不可用」的最常见现场。
		this.recordAudit({
			command,
			params: '',
			ok: false,
			code: 'extension_outdated',
			effectState: 'not_started',
			error: `connected extension v${this.extensionVersion() ?? '?'} lacks ${command} (added in ${since})`,
			durationMs: 0,
		})
		throw extensionOutdatedError(this.extensionVersion(), command, since)
	}

	/**
	 * Converge the live server onto `config`. With `throwOnError`, an initial
	 * start failure rejects (fail-loud activation); later changes record the
	 * failure instead, so a bad port cannot tear down an otherwise running session.
	 * @param config - the freshly resolved settings snapshot.
	 * @param options - set `throwOnError` only for the activation-time call.
	 * @returns a promise settling once the convergence attempt finished.
	 */
	reconcile(config: ResolvedConfig, options: { throwOnError?: boolean } = {}): Promise<void> {
		this.current = config
		const run = this.chain.then(() => this.reconcileNow(config))
		this.chain = run.catch(() => {})
		if (options.throwOnError === true) {
			return run.catch((error) => {
				throw error instanceof Error ? error : new Error(String(error))
			})
		}
		return Promise.resolve()
	}

	private async reconcileNow(config: ResolvedConfig): Promise<void> {
		const shotsDir = path.resolve(config.shotsDir)
		const stateDir = path.resolve(config.stateDir)
		if (stateDir !== this.journalKey) {
			const previousJournal = this.journal
			this.journal = undefined
			this.journalKey = stateDir
			await previousJournal?.close()
			try {
				this.journal = await Journal.open(stateDir, this.log)
			} catch (error) {
				// 账本打不开不是让桥起不来的理由：降级为纯内存审计。
				this.log(`journal: disabled — ${errorMessage(error)}`)
			}
		}
		const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : ''
		if (key === this.serverKey) return
		const previous = this.server
		this.server = undefined
		this.serverKey = ''
		await previous?.stop()
		if (!config.enabled) {
			this.lastError = undefined
			return
		}
		const server = new BridgeServer({ port: config.port, token: config.token, shotsDir, log: this.log })
		try {
			await server.start()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`
			this.log(this.lastError!)
			throw error instanceof Error ? error : new Error(message)
		}
		this.server = server
		this.serverKey = key
		this.lastError = undefined
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
	async execute(command: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number): Promise<unknown> {
		const started = Date.now()
		const sessionId = TOOL_SESSION.getStore()
		const resolved = sessionId === undefined ? params : await this.isolateParams(command, params, sessionId, signal)
		const summary = summarizeAuditParams(command, resolved)
		const tabId = typeof resolved.tabId === 'number' ? resolved.tabId : undefined
		try {
			this.policyGate(command, resolved)
			const server = this.server
			if (server === undefined) {
				throw classify(command, new Error(
					this.lastError ?? '浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）',
				))
			}
			const result = await server.execute(command, resolved, timeoutMs === undefined ? { signal } : { signal, timeoutMs })
			if (sessionId !== undefined) this.noteSession(sessionId, resolved, result)
			this.recordAudit({ command, tabId, params: summary, ok: true, durationMs: Date.now() - started })
			return result
		} catch (error) {
			if (sessionId !== undefined) this.sessions.touch(sessionId)
			const code = (error as { code?: unknown }).code
			const effectState = (error as { effectState?: unknown }).effectState
			this.recordAudit({
				command,
				tabId,
				params: summary,
				ok: false,
				code: typeof code === 'string' ? code : undefined,
				effectState: typeof effectState === 'string' ? effectState : undefined,
				error: errorMessage(error),
				durationMs: Date.now() - started,
			})
			throw error
		}
	}

	/**
	 * Apply per-session tab isolation: when a call omits `tabId`, default it to
	 * the calling session's working tab — but only after asking the extension
	 * whether that tab is still open. A stale id must never fail a call that used
	 * to work; when it is gone we forget it and let the browser's active tab
	 * answer, exactly like before this feature existed.
	 */
	private async isolateParams(command: string, params: Record<string, unknown>, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		if (typeof params.tabId === 'number' || NO_TAB_DEFAULT_COMMANDS.has(command)) return params
		const recorded = this.sessions.workingTab(sessionId)
		if (recorded === undefined) return params
		const server = this.server
		if (server !== undefined) {
			try {
				const listing = await server.execute('tabs.list', {}, { signal }) as { tabs?: { id?: unknown }[] }
				const live = Array.isArray(listing?.tabs) && listing.tabs.some((tab) => tab?.id === recorded)
				if (!live) {
					this.sessions.release(sessionId)
					return params
				}
			} catch { /* 列不出来就按旧行为走活动标签页 */ }
		}
		return { ...params, tabId: recorded }
	}

	/** Record the call and adopt the tab it actually touched (params or result). */
	private noteSession(sessionId: string, params: Record<string, unknown>, result: unknown): void {
		this.sessions.touch(sessionId)
		if (typeof params.tabId === 'number') this.sessions.adopt(sessionId, params.tabId)
		const resultTab = (result as { tabId?: unknown } | null | undefined)?.tabId
		if (typeof resultTab === 'number') this.sessions.adopt(sessionId, resultTab)
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
	private policyGate(command: string, params?: Record<string, unknown>): void {
		const refusal = policyRefusal(command, {
			readOnly: this.current?.readOnly === true,
			allowScript: this.current?.allowScript !== false,
		}, params)
		if (refusal !== undefined) throw new BridgeError(command, 'blocked_by_policy', 'not_started', refusal)
	}

	/**
	 * Delete generated artifacts using the currently resolved directories;
	 * works while the bridge is stopped because it never touches the socket.
	 * @returns counts and names of what was removed.
	 */
	async cleanup(): Promise<{ shotsRemoved: number; scratchRemoved: readonly string[] }> {
		const started = Date.now()
		try {
			// cleanup() 不经过 execute()，所以它必须自己站一次闸门：否则只读档下
			// 模型仍能用 browser_cleanup 删掉用户的整个截图目录。
			this.policyGate('cleanup')
			const dir = this.shotsDir
			if (dir === undefined) throw classify('cleanup', new Error('browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录'))
			try {
				const result = await cleanupArtifacts({ shotsDir: dir })
				this.recordAudit({ command: 'cleanup', params: '{}', ok: true, durationMs: Date.now() - started })
				return result
			} catch (error) {
				// 删除是逐条进行的，中途失败时前面的文件已经没了；不包一层分类，
				// 模型拿到的就是一句没有 code / effectState 的裸 fs 错误。
				throw classify('cleanup', error)
			}
		} catch (error) {
			const code = (error as { code?: unknown }).code
			const effectState = (error as { effectState?: unknown }).effectState
			this.recordAudit({
				command: 'cleanup',
				params: '{}',
				ok: false,
				code: typeof code === 'string' ? code : undefined,
				effectState: typeof effectState === 'string' ? effectState : undefined,
				error: errorMessage(error),
				durationMs: Date.now() - started,
			})
			throw error
		}
	}

	/** Stop the listener; safe to call repeatedly and during teardown. */
	async stop(): Promise<void> {
		const previous = this.server
		this.server = undefined
		this.serverKey = ''
		await (previous?.stop() ?? Promise.resolve())
		const journal = this.journal
		this.journal = undefined
		this.journalKey = ''
		await journal?.close()
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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
const MAX_RENDERED_CHARS = 4_000
function clampRendered(text: string, maxChars = MAX_RENDERED_CHARS): string {
	if (text.length <= maxChars) return text
	const omitted = text.length - maxChars
	return `${text.slice(0, maxChars)}\n… [renderedTruncated omittedChars=${omitted} limitChars=${maxChars}] narrow the query and call again to see the rest`
}

/** Model-facing budget for one snapshot listing; `limit` narrows the listing. */
const SNAPSHOT_RENDER_MAX_CHARS = 8_000
/** Model-facing budget for one console/network log listing. */
const LOG_RENDER_MAX_CHARS = 6_000

/** Collapse one page-supplied field to a single line inside a rendered listing. */
function flattenOneLine(value: string, maxChars: number): string {
	const flat = value.replace(/\s+/g, ' ').trim()
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`
}

/** `HH:MM:SS` in UTC from an epoch-milliseconds stamp. */
function formatClock(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(11, 19)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One rendered network row: the declared subset of the extension's capture. */
interface NetworkRow {
	method: string
	url: string
	resourceType?: string
	status?: number
	statusText?: string
	mimeType?: string
	bytes?: number
	time?: string
	finished?: boolean
	failed?: boolean
	canceled?: boolean
	errorText?: string
}

/**
 * Reduce one captured network row to the fields this tool declares. The buffer
 * also carries request/response header maps and POST bodies; those stay out of
 * the value, because the value never reaches the model and the header dump is
 * what would blow the transcript.
 */
function networkRow(row: Record<string, unknown>): NetworkRow {
	const out: NetworkRow = {
		method: typeof row.method === 'string' ? row.method : 'GET',
		url: flattenOneLine(typeof row.url === 'string' ? row.url : '', 200),
	}
	if (typeof row.resourceType === 'string') out.resourceType = row.resourceType
	if (typeof row.status === 'number') out.status = row.status
	if (typeof row.statusText === 'string' && row.statusText.length > 0) out.statusText = flattenOneLine(row.statusText, 60)
	if (typeof row.mimeType === 'string') out.mimeType = row.mimeType
	if (typeof row.encodedDataLength === 'number') out.bytes = row.encodedDataLength
	// CDP `wallTime` is a Timestamp in seconds, not milliseconds.
	if (typeof row.wallTime === 'number') out.time = formatClock(row.wallTime * 1000)
	if (row.finished === true) out.finished = true
	if (row.failed === true) out.failed = true
	if (row.canceled === true) out.canceled = true
	if (typeof row.errorText === 'string' && row.errorText.length > 0) out.errorText = flattenOneLine(row.errorText, 120)
	return out
}

/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args: { selector?: string; ref?: string }): string {
	const hasSelector = typeof args.selector === 'string' && args.selector.length > 0
	const hasRef = typeof args.ref === 'string' && args.ref.length > 0
	if (hasSelector === hasRef) {
		throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)')
	}
	if (hasRef) {
		const ref = args.ref!
		if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`)
		return `[data-dsh-ref="${ref}"]`
	}
	return args.selector!
}

function requireTabId(args: { tabId?: number }, action: string): number {
	if (typeof args.tabId !== 'number') throw new Error(`${action} requires tabId`)
	return args.tabId
}

function requireWindowId(args: { windowId?: number }, action: string): number {
	if (typeof args.windowId !== 'number') throw new Error(`${action} requires windowId`)
	return args.windowId
}

/**
 * Every tab the caller asked to close. `tabId` and `tabIds` are both accepted
 * (a batch call that repeats one id, or passes both, must not close it twice),
 * and the ids are deduplicated and normalised before they leave the host.
 */
function closeTabIds(args: { tabId?: number; tabIds?: number[] }): number[] {
	const asked = [
		...(Array.isArray(args.tabIds) ? args.tabIds : []),
		...(typeof args.tabId === 'number' ? [args.tabId] : []),
	]
	const ids = [...new Set(asked.map(Number).filter(id => Number.isInteger(id) && id > 0))]
	if (ids.length === 0) throw new Error('close requires tabId or tabIds')
	return ids
}

interface MetricsPayload {
	tabId: number
	metrics: {
		Timestamp?: number
		Documents?: number
		Frames?: number
		JSEventListeners?: number
		Nodes?: number
		LayoutCount?: number
		RecalcStyleCount?: number
		LayoutDuration?: number
		RecalcStyleDuration?: number
		ScriptDuration?: number
		TaskDuration?: number
		JSHeapUsedSize?: number
		JSHeapTotalSize?: number
	}
}

interface ScreenshotPayload {
	tabId: number
	format: 'png' | 'jpeg'
	base64: string
	tabTitle?: string
	tabUrl?: string
	elementRect?: { x: number, y: number, w: number, h: number }
}

interface ScreenshotResult {
	file: string
	bytes: number
	tabId: number
	title?: string
	url?: string
	width?: number
	height?: number
	elementRect?: { x: number, y: number, w: number, h: number }
}

/** Actual pixel dimensions straight from the PNG's IHDR chunk (width/height are
 *  big-endian at offsets 16/20 after the 8-byte signature + 4-byte length + 4-byte
 *  type). The receipt should say how big the picture IS — fullPage captures are
 *  often 3-5 viewports tall and the model cannot tell from the byte count. */
function pngDimensions(buffer: Buffer): { width?: number, height?: number } {
	if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') return {}
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller: BridgeController, payload: ScreenshotPayload): Promise<ScreenshotResult> {
	const dir = controller.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	await mkdir(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const random = Math.random().toString(36).slice(2, 6)
	const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`)
	const buffer = Buffer.from(payload.base64, 'base64')
	await writeFile(file, buffer)
	const dims = payload.format === 'png' ? pngDimensions(buffer) : {}
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl,
		...dims,
		...(payload.elementRect === undefined ? {} : { elementRect: payload.elementRect }),
	}
}

/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(
	controller: BridgeController,
	payload: { base64: string; tabId: number; tabTitle?: string; tabUrl?: string },
	requestedPath?: string,
): Promise<{ file: string; bytes: number; tabId: number; title?: string; url?: string }> {
	const dir = controller.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	let file: string
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath
		await mkdir(path.dirname(file), { recursive: true })
	} else {
		await mkdir(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const random = Math.random().toString(36).slice(2, 6)
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`
		file = path.join(dir, name)
	}
	const buffer = Buffer.from(payload.base64, 'base64')
	await writeFile(file, buffer)
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
		...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
	}
}

/** Write one MHTML archive payload to `path` (absolute or under `controller.shotsDir`).
 *  Mirrors savePdf's contract; MHTML is text, so it is written verbatim as UTF-8. */
async function saveMhtml(
	controller: BridgeController,
	payload: { mhtml: string; tabId: number },
	requestedPath?: string,
): Promise<{ file: string; bytes: number; tabId: number }> {
	const dir = controller.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	let file: string
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath
		await mkdir(path.dirname(file), { recursive: true })
	} else {
		await mkdir(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const random = Math.random().toString(36).slice(2, 6)
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.mhtml`
		file = path.join(dir, name)
	}
	const buffer = Buffer.from(payload.mhtml, 'utf8')
	await writeFile(file, buffer)
	return { file, bytes: buffer.length, tabId: payload.tabId }
}

/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx: Context, controller: BridgeController): void {
	ctx.systemPrompt.section({
		name: 'tool:browser',
		order: 112,
		text: 'The browser_* tools drive the user\'s real, logged-in browser through the DSH '
			+ 'Browser Control extension; they act on the active tab unless a tabId is passed. '
			+ 'Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, '
			+ 'and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. '
			+ 'browser_read extracts page text in a window (offset/limit) and reports how much text is '
			+ 'left, browser_screenshot saves a PNG/JPEG and returns its file '
			+ 'path (view it with an image tool). Calls fail with actionable copy while the bridge is '
			+ 'disabled or no browser is connected. When a result is cut to bound token cost it is '
			+ 'marked "[renderedTruncated omittedChars=N limitChars=L]" — re-issue a narrower query '
			+ '(smaller limit, a pattern filter, or browser_read\'s offset) instead of assuming the '
			+ 'page is shorter than it is.',
	})

	ctx.tools.register(defineTool({
		name: 'browser_navigate',
		description: 'Navigate a browser tab to a URL and wait for the page load to settle.',
		parameters: {
			url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			waitUntil: { type: 'string', description: 'When the navigation counts as arrived: "load" (default) waits for the page load event (15s budget), "domcontentloaded" returns once the DOM is parsed (async components may still be mounting — follow with browser_wait if an element is missing), "commit" once the new document\'s address lands, "none" returns immediately with no arrival check at all.' },
			timeoutMs: { type: 'number', description: `How long to wait for the page load to settle: defaults to the waitUntil tier (load 15000, commit/domcontentloaded 4000), capped at ${NAV_MAX_MS}. An explicit value always wins over the tier.` },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					url: { type: 'string' },
					title: { type: 'string' },
					pendingUrl: { type: 'string' },
					loadPending: { type: 'boolean' },
					siteUnreachable: { type: 'boolean' },
					waitUntil: { type: 'string' },
					waitedMs: { type: 'number' },
					readyState: { type: 'string' },
				},
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
				const shows = label.length > 0 ? label : '(untitled)'
				// Nothing was navigated to: say that instead of "now shows <the URL you asked for>".
				if (value.siteUnreachable === true) {
					return [{ type: 'text', text: `Tab ${value.tabId} could not load ${String(value.url ?? '')} — the browser landed on its own error page (DNS failure or no connection), so browser_read/browser_snapshot return that error page, not the site.` }]
				}
				// The wait budget ran out before the new document settled: the tab may still
				// be showing the previous page, so do not call it loaded.
				if (value.loadPending === true) {
					const to = typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0 ? value.pendingUrl : 'the requested URL'
					return [{ type: 'text', text: `Tab ${value.tabId} is still loading ${to} — the load had not settled when the wait budget ran out, so the tab may still be showing ${shows}. Re-check with browser_read before acting on it (or raise timeoutMs).` }]
				}
				if (typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0) {
					return [{ type: 'text', text: `Tab ${value.tabId} shows ${shows} and is navigating to ${value.pendingUrl}` }]
				}
				return [{ type: 'text', text: `Tab ${value.tabId} now shows ${shows}` }]
			},
		},
		isConcurrencySafe: () => false,
		presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' as const }),
		async execute(args, exec) {
			const waitUntil = args.waitUntil === undefined ? 'load' : String(args.waitUntil)
			if (!(waitUntil in NAV_TIERS)) {
				throw new Error(`browser_navigate: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`)
			}
			const params: Record<string, unknown> = { url: args.url, waitUntil }
			if (args.tabId !== undefined) params.tabId = args.tabId
			// Explicit timeoutMs always wins over the tier; 'none' waits 0 and sends
			// no budget at all. The bridge gets budget+2s so the extension's own
			// "navigation did not arrive" always reports before the bridge's ceiling.
			let budgetMs = NAV_TIERS[waitUntil]
			if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
				budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)))
			}
			if (waitUntil !== 'none') params.timeoutMs = budgetMs
			const raw = await controller.execute('nav', params, exec.signal,
				waitUntil === 'none' ? undefined : budgetMs + BRIDGE_MARGIN_MS) as {
				tabId: number
				title?: string
				url?: string
				pendingUrl?: string
				loadPending?: boolean
				/** `true`, or `{ reason: 'dns' | 'unreachable' }` as the extension actually sends it. */
				siteUnreachable?: boolean | { reason?: string }
				waitUntil?: string
				waitedMs?: number
				readyState?: string
			}
			// The declared schema is closed, so the fields describing a navigation that did
			// not arrive have to be carried over on purpose. The old shape check
			// (`siteUnreachable === true`) also missed the object the extension really
			// sends, so an unreachable target came back as a plain success.
			const out: { tabId: number; url?: string; title?: string; pendingUrl?: string; loadPending?: boolean; siteUnreachable?: boolean; waitUntil?: string; waitedMs?: number; readyState?: string } = { tabId: raw.tabId }
			if (typeof raw.url === 'string') out.url = raw.url
			if (typeof raw.title === 'string') out.title = raw.title
			if (typeof raw.pendingUrl === 'string') out.pendingUrl = raw.pendingUrl
			if (raw.loadPending === true) out.loadPending = true
			const unreachable = raw.siteUnreachable === true
				|| (typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null)
			if (unreachable) out.siteUnreachable = true
			if (typeof raw.waitUntil === 'string') out.waitUntil = raw.waitUntil
			if (typeof raw.waitedMs === 'number') out.waitedMs = raw.waitedMs
			if (typeof raw.readyState === 'string' && raw.readyState.length > 0) out.readyState = raw.readyState
			return out
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_read',
		description: 'Read the current page: title, URL and the page text itself (or full HTML) in a window you control with offset/limit. The returned text is what you see — no separate fetch step is needed.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
			offset: { type: 'number', description: `Character index the window starts at; default 0. Use the "call again with offset=" value the previous result reported.` },
			limit: { type: 'number', description: `Characters to return; default and cap ${READ_WINDOW_MAX_CHARS}.` },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					mode: { type: 'string', required: true },
					title: { type: 'string', required: true },
					url: { type: 'string', required: true },
					content: { type: 'string', required: true },
					truncated: { type: 'boolean', required: true },
					offset: { type: 'number', required: true },
					totalChars: { type: 'number', required: true },
				},
			},
			render: (_args, value) => {
				const end = value.offset + value.content.length
				const head = `${value.title} (${value.url}) — ${value.mode} chars ${value.offset}-${end} of ${value.totalChars}`
					+ (value.truncated ? `; call again with offset=${end} to continue` : '')
				return [{ type: 'text', text: `${head}\n\n${value.content}` }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' as const }),
		async execute(args, exec) {
			const mode = args.mode === 'html' ? 'html' : 'text'
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0)
			const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS))
			const raw = await controller.execute(
				'content',
				args.tabId === undefined ? { mode } : { mode, tabId: args.tabId },
				exec.signal,
			) as { tabId: number; title?: string; url?: string; content?: string }
			const full = raw.content ?? ''
			const content = full.slice(offset, offset + limit)
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? '',
				url: raw.url ?? '',
				content,
				truncated: offset + content.length < full.length,
				offset,
				totalChars: full.length,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_snapshot',
		description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:"ax" numbers them by Chrome\'s accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			offset: { type: 'number', description: 'Skip this many items into the inventory (paging); default 0. Refs are valid for THIS call only — take the next page in the same breath if you need stable refs.' },
			limit: { type: 'number', description: 'Page size: max items returned by this call; defaults to 120. The extension supplies up to a 200-item window per call.' },
			mode: { type: 'string', description: '"ax" for the accessibility tree, "dom" (default) for the selector list. "ax" falls back to "dom" with axFallback set if the page gives no a11y tree.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					title: { type: 'string', required: true },
					url: { type: 'string', required: true },
					mode: { type: 'string' },
					axFallback: { type: 'string' },
					offset: { type: 'number', required: true },
					total: { type: 'number' },
					returned: { type: 'number' },
					nextOffset: { type: 'number' },
					hasMore: { type: 'boolean', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								ref: { type: 'string', required: true },
								tag: { type: 'string', required: true },
								role: { type: 'string' },
								name: { type: 'string' },
								href: { type: 'string' },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const shown = value.items.length
				const start = value.offset + 1
				const end = value.offset + shown
				const totalText = value.total === undefined ? `${value.returned ?? shown} available` : `${value.total} on the page`
				const range = shown === 0 ? `no items at offset ${value.offset}` : `items ${start}–${end} of ${totalText}`
				const capped = value.total !== undefined && value.returned !== undefined && value.total > value.returned
					? ` (this extension returns at most ${value.returned}-item windows — use browser_find/browser_read to reach the rest)`
					: ''
				const next = value.nextOffset === undefined ? '' : `; next page: offset ${value.nextOffset}`
				const head = `${range}${capped}${next}`
					+ ` (mode ${value.mode ?? 'dom'}); click or fill them by ref:`
					+ (value.axFallback === undefined ? '' : `\n(mode ax fell back to dom: ${value.axFallback})`)
				const lines = value.items.map(item => {
					const name = item.name === undefined ? '' : ` "${flattenOneLine(item.name, 80)}"`
					const href = item.href === undefined ? '' : ` -> ${flattenOneLine(item.href, 100)}`
					return `[${item.ref}] ${item.role ?? item.tag}${name}${href}`
				})
				return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), SNAPSHOT_RENDER_MAX_CHARS) }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' as const }),
		async execute(args, exec) {
			const offset = Math.max(0, Math.trunc(typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0))
			const limit = Math.min(200, Math.max(1, typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 120))
			// Ask for the largest window the extension offers (200) and page in the
			// plugin: older surfaces never learned an offset parameter, and they do
			// report `total`, so paging stays plugin-side (v1.7.7).
			const params: Record<string, unknown> = { limit: 200 }
			if (typeof args.tabId === 'number') params.tabId = args.tabId
			if (typeof args.mode === 'string') params.mode = args.mode
			const raw = await controller.execute('snapshot', params, exec.signal) as {
				tabId: number
				title?: string
				url?: string
				mode?: string
				axFallback?: string
				ax?: unknown
				total?: unknown
				items?: Array<{ ref: string; tag: string; role?: string; name?: string; href?: string }>
			}
			// 版本错位必须说出来：v1.0.10 及更早的扩展没有 AX 快照（1.0.11 才加的），
			// 它会照单收下 mode:"ax" 然后回一份 DOM 结果，既不带 mode 也不带 axFallback
			// （本机实测：扩展 1.0.10，两次请求的响应完全一样）。那时模型只看到「(mode dom)」，
			// 读不出「我要的 ax 被旧扩展静默降级了」，会把标签名当成可访问名。
			// 按「请求的模式 vs 回报的模式」比对，不一致就自己写 axFallback——扩展不用改，老扩展立刻受益。
			const requestedAx = args.mode === 'ax'
			const gotAx = raw.mode === 'ax' || raw.ax !== undefined
			const axFallback = typeof raw.axFallback === 'string' && raw.axFallback.length > 0
				? raw.axFallback
				: (requestedAx && !gotAx
					? 'this extension ignored mode:"ax" and returned CSS-DOM matches (AX mode needs DSH Browser Control extension v1.0.11 or newer) — the names below are tag names, not accessible names'
					: undefined)
			const window = Array.isArray(raw.items) ? raw.items : []
			const returned = window.length
			const reportedTotal = typeof raw.total === 'number' && Number.isFinite(raw.total) ? Math.trunc(raw.total) : undefined
			const total = reportedTotal === undefined ? undefined : Math.max(returned, reportedTotal)
			const page = window.slice(offset, offset + limit)
			const hasMore = offset + page.length < returned
			const receipt: {
				tabId: number
				title: string
				url: string
				mode?: string
				axFallback?: string
				offset: number
				total?: number
				returned: number
				nextOffset?: number
				hasMore: boolean
				items: Array<{ ref: string; tag: string; role?: string; name?: string; href?: string }>
			} = {
				tabId: raw.tabId,
				title: raw.title ?? '',
				url: raw.url ?? '',
				...(raw.mode === undefined ? {} : { mode: raw.mode }),
				...(axFallback === undefined ? {} : { axFallback }),
				offset,
				...(total === undefined ? {} : { total }),
				returned,
				hasMore,
				...(hasMore ? { nextOffset: offset + page.length } : {}),
				items: page.map(item => ({
					ref: item.ref,
					tag: item.tag,
					...(item.role === undefined ? {} : { role: item.role }),
					...(item.name === undefined ? {} : { name: item.name }),
					...(item.href === undefined ? {} : { href: item.href }),
				})),
			}
			return receipt
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_click',
		description: 'Click a page element with real mouse events; target it by snapshot ref or CSS selector.',
		parameters: {
			ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3"); wins over selector.' },
			selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			doubleClick: { type: 'boolean', description: 'Send a double click instead.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { selector: targetSelector(args) }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.doubleClick !== undefined) params.doubleClick = args.doubleClick
			return await controller.execute('click', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_type',
		description: 'Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.',
		parameters: {
			value: { type: 'string', required: true, description: 'Text to put into the element.' },
			ref: { type: 'string', description: 'Element ref from browser_snapshot; wins over selector.' },
			selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			submit: { type: 'boolean', description: 'Press Enter after filling.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { selector: targetSelector(args), value: args.value }
			if (args.tabId !== undefined) params.tabId = args.tabId
			const filled = await controller.execute('input', params, exec.signal) as Record<string, JsonValue>
			if (args.submit === true) {
				await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal)
			}
			return filled
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_press',
		description: 'Send a real keyboard event to the page: a named key (Enter, Tab, Escape, ArrowDown…), a single character, or a combination such as "Ctrl+A" / "Shift+ArrowRight".',
		parameters: {
			key: { type: 'string', required: true, description: 'Named key, a single character, or "Modifier+Key" (alt, ctrl/control, meta/command, shift). Unknown names now fail loudly instead of doing nothing.' },
			modifiers: { type: 'array', items: { type: 'string' }, description: 'Alternative to the "Ctrl+A" spelling: ["ctrl", "shift"]. Shift alone still lets the character be typed; ctrl/meta suppress insertion.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { key: args.key }
			if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('press', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_scroll',
		description: 'Scroll the page viewport by a delta and report the resulting position.',
		parameters: {
			x: { type: 'number', description: 'Horizontal delta in pixels; defaults to 0.' },
			y: { type: 'number', description: 'Vertical delta in pixels; positive scrolls down.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { x: args.x ?? 0, y: args.y ?? 0 }
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('scroll', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	/** Page-side ceiling of `cmdWait`; the bridge budget adds slack on top. */
	const WAIT_MAX_MS = 120_000

	ctx.tools.register(defineTool({
		name: 'browser_wait',
		description: 'Block until a selector appears, some text shows up in the body, or a page-side predicate turns true. Use it after navigation for SPA routes and lazy-rendered content, which browser_navigate does not wait for.',
		parameters: {
			selector: { type: 'string', description: 'CSS selector that must exist in the document.' },
			text: { type: 'string', description: 'Literal substring that must appear in document.body.innerText.' },
			fn: { type: 'string', description: 'JS predicate evaluated in the page: an expression ("window.x === 3") or a function body ("() => !!document.querySelector(\'.row\')").' },
			timeoutMs: { type: 'number', description: `Give up after this many milliseconds; defaults to 15000, capped at ${WAIT_MAX_MS}.` },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Wait for ${args.selector ?? args.text ?? 'page condition'}`, kind: 'other' as const }),
		async execute(args, exec) {
			const given = (['selector', 'text', 'fn'] as const).filter(k => args[k] !== undefined && String(args[k]).length > 0)
			if (given.length === 0) throw new Error('browser_wait needs exactly one of selector, text, fn — otherwise there is nothing to wait for')
			if (given.length > 1) throw new Error(`browser_wait takes one condition, got ${given.join(' + ')} — pick the one you actually mean`)
			const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.timeoutMs ?? 15_000)))
			const params: Record<string, unknown> = { [given[0]]: args[given[0]], timeoutMs }
			if (args.tabId !== undefined) params.tabId = args.tabId
			// Slack so the page-side timeout always reports before the bridge gives up.
			return await controller.execute('wait', params, exec.signal, timeoutMs + 10_000) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_find',
		description: 'Describe the elements matching a CSS selector — count, tag, id, class, text, href and viewport rect. Read-only; use it to decide what to click and to verify the page state.',
		parameters: {
			selector: { type: 'string', required: true, description: 'CSS selector to query.' },
			limit: { type: 'number', description: 'Maximum items to describe; defaults to 10, capped at 50 (count is always the full total).' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Find ${args.selector}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { selector: args.selector }
			if (args.limit !== undefined) params.limit = args.limit
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('find', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_hold',
		description: 'Put a cancellable take-over overlay on a tab so the user can see that you are working on this page and cannot mis-click. The card title is fixed by the extension; your `note` is the body text only (≤400 chars, newlines flattened). The user double-clicks the page (or presses Escape twice, or holds Escape) to close it — you can keep working. Pressing the card\'s abort button blocks your click/input/press/nav on that tab until you call action="off" (which counts as confirming you continue). This is a soft layer, not a security boundary: the popup lock is the thing that actually freezes the browser. Returns `covered:false` with a `reason` when the page cannot be covered (browser pages, error pages, CSP-strict frames, PDF viewer, an open native dialog).',
		parameters: {
			action: { type: 'string', enum: ['on', 'off', 'status'], required: true, description: '"on" shows the overlay, "off" removes it (and clears the abort state), "status" reports what is actually on the page.' },
			note: { type: 'string', description: 'on: body text — say what you are doing (e.g. "正在把「局域网」档改成放行"). The title cannot be set.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Overlay ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			const action = String(args.action)
			if (!['on', 'off', 'status'].includes(action)) throw new Error('browser_hold action must be on, off or status')
			const params: Record<string, unknown> = { action }
			if (args.action === 'on' && args.note !== undefined) params.note = args.note
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('hold', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_cookies',
		description: 'Read, set or remove cookies of a tab (CDP Network.*, no new permission). Cookie values are credentials — a get returns them in full and they land in the model-visible text, so filter by domain and do not point this at a page whose cookies you do not actually need. set/remove need an anchor: url, or domain (with optional path).',
		parameters: {
			action: { type: 'string', enum: ['get', 'set', 'remove'], required: true, description: '"get" lists cookies visible to the tab (domain filter optional); "set" writes one; "remove" deletes one and reports whether it is still visible afterwards.' },
			name: { type: 'string', description: 'set/remove: cookie name (required).' },
			value: { type: 'string', description: 'set: cookie value (required; pass an empty string to clear the content).' },
			domain: { type: 'string', description: 'get: only cookies whose domain contains this substring. set/remove: anchor — the cookie domain.' },
			url: { type: 'string', description: 'set/remove: alternative anchor — Chrome derives origin/secure defaults from it.' },
			path: { type: 'string', description: 'set/remove: cookie path.' },
			secure: { type: 'boolean', description: 'set: https-only cookie.' },
			httpOnly: { type: 'boolean', description: 'set: hide the cookie from page scripts.' },
			sameSite: { type: 'string', description: 'set: Strict | Lax | None.' },
			expires: { type: 'number', description: 'set: Unix seconds; omit for a session cookie.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Cookies ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			// 三条命令各写一个字面量调用点：verify_surface 对账的是
			// `controller.execute('命令名')` 的字面量，动态拼名字会让
			// 「扩展实现了但 agent 拿不到」那条断言瞎掉。
			const command = args.action === 'get' ? 'cookies.get'
				: args.action === 'set' ? 'cookies.set'
					: args.action === 'remove' ? 'cookies.remove'
						: null
			if (command === null) throw new Error('browser_cookies action must be get, set or remove')
			const params: Record<string, unknown> = {}
			if (args.name !== undefined) params.name = args.name
			if (args.value !== undefined) params.value = args.value
			if (args.domain !== undefined) params.domain = args.domain
			if (args.url !== undefined) params.url = args.url
			if (args.path !== undefined) params.path = args.path
			if (args.secure !== undefined) params.secure = args.secure
			if (args.httpOnly !== undefined) params.httpOnly = args.httpOnly
			if (args.sameSite !== undefined) params.sameSite = args.sameSite
			if (args.expires !== undefined) params.expires = args.expires
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (command === 'cookies.get') return await controller.execute('cookies.get', params, exec.signal) as Record<string, JsonValue>
			if (command === 'cookies.set') return await controller.execute('cookies.set', params, exec.signal) as Record<string, JsonValue>
			return await controller.execute('cookies.remove', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_dialog',
		description: 'Read or change how native alert/confirm/prompt dialogs are answered (accept, dismiss, or manual), and get the recent dialog log so you can prove one appeared.',
		parameters: {
			policy: { type: 'string', enum: ['accept', 'dismiss', 'manual'], description: 'Set this policy; omit to only read the current one.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: args.policy ? `Dialog policy → ${args.policy}` : 'Read dialog policy', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.policy !== undefined) params.policy = args.policy
			return await controller.execute('dialog', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_info',
		description: 'Report which browser and which extension build is actually attached. Run it first when behaviour looks wrong — a stale extension or the wrong browser profile explains most of it.',
		parameters: {},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Browser identity', kind: 'other' as const }),
		async execute(_args, exec) {
			return await controller.execute('browser.info', {}, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_tabs',
		description: 'List tabs, or open/close/activate/group/ungroup, or go back/forward in the tab\'s history. `close` takes one tab (`tabId`) or several (`tabIds`); the result accounts for every id, so a retry is safe.',
		parameters: {
			action: { type: 'string', required: true, description: 'One of: list, open, close, activate, group, ungroup, back, forward.' },
			url: { type: 'string', description: 'URL for the open action.' },
			tabId: { type: 'number', description: 'Target tab for close/activate/group/back/forward; defaults to the active tab for back/forward.' },
			tabIds: { type: 'array', items: { type: 'number' }, description: 'For close: every tab to close in one call. The result reports each id (closed / alreadyGone / failed) instead of stopping at the first failure.' },
			active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
			group: { type: 'boolean', description: 'For open: put the new tab in the DSH tab group. Defaults to true; pass false to keep it loose.' },
			waitUntil: { type: 'string', description: 'For open/back/forward: when the navigation counts as arrived — same tiers as browser_navigate (load default / domcontentloaded / commit / none). back/forward report unchanged:true + a reason when the tab is already at the oldest/newest history entry.' },
			timeoutMs: { type: 'number', description: 'For open/back/forward: wait budget, overriding the waitUntil tier (load 15000, commit/domcontentloaded 4000).' },
			windowId: { type: 'number', description: 'For ungroup: only dissolve that window’s DSH group; omit to clear every window.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			switch (args.action) {
				case 'list':
					return await controller.execute('tabs.list', {}, exec.signal) as Record<string, JsonValue>
				case 'open': {
					if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('open requires url')
					const waitUntil = args.waitUntil === undefined ? 'load' : String(args.waitUntil)
					if (!(waitUntil in NAV_TIERS)) {
						throw new Error(`browser_tabs open: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`)
					}
					const params: Record<string, unknown> = { url: args.url, waitUntil }
					if (args.active !== undefined) params.active = args.active
					if (args.group !== undefined) params.group = args.group
					if (waitUntil === 'none') {
						return await controller.execute('tabs.open', params, exec.signal) as Record<string, JsonValue>
					}
					let budgetMs = NAV_TIERS[waitUntil]
					if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
						budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)))
					}
					params.timeoutMs = budgetMs
					return await controller.execute('tabs.open', params, exec.signal, budgetMs + BRIDGE_MARGIN_MS) as Record<string, JsonValue>
				}
				case 'close': {
					const ids = closeTabIds(args)
					// One id keeps the single-tab command; several go out as ONE command
					// (`tabs.closeMany`) instead of N round-trips that can die in between.
					return ids.length === 1
						? await controller.execute('tabs.close', { tabId: ids[0] }, exec.signal) as Record<string, JsonValue>
						: await controller.execute('tabs.closeMany', { tabIds: ids }, exec.signal) as Record<string, JsonValue>
				}
				case 'activate':
					return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal) as Record<string, JsonValue>
				case 'back':
				case 'forward': {
					// Same wait-shape as open: tier default load, explicit budget, bridge
					// margin so the reply can outlive the tier without the bridge timing out.
					// 两条各写一个字面量调用点（surface 台对账 execute 字面量，拼名字会瞎）。
					const waitUntil = args.waitUntil === undefined ? 'load' : String(args.waitUntil)
					if (!(waitUntil in NAV_TIERS)) {
						throw new Error(`browser_tabs ${args.action}: waitUntil must be one of none, commit, domcontentloaded, load — got "${waitUntil}"`)
					}
					const params: Record<string, unknown> = { waitUntil }
					if (args.tabId !== undefined) params.tabId = args.tabId
					let budgetMs = NAV_TIERS[waitUntil]
					if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
						budgetMs = Math.min(NAV_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)))
					}
					params.timeoutMs = budgetMs
					if (args.action === 'back') {
						controller.requireExtensionCommand('tabs.back', '1.7.0')
						return await controller.execute('tabs.back', params, exec.signal, budgetMs + BRIDGE_MARGIN_MS) as Record<string, JsonValue>
					}
					controller.requireExtensionCommand('tabs.forward', '1.7.0')
						return await controller.execute('tabs.forward', params, exec.signal, budgetMs + BRIDGE_MARGIN_MS) as Record<string, JsonValue>
				}
				case 'group':
					return await controller.execute('tabs.group', { tabId: requireTabId(args, 'group') }, exec.signal) as Record<string, JsonValue>
				case 'ungroup': {
					const params: Record<string, unknown> = {}
					if (typeof args.windowId === 'number') params.windowId = args.windowId
					return await controller.execute('tabs.ungroup', params, exec.signal) as Record<string, JsonValue>
				}
				default:
					throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`)
			}
		},
	}))

	// Window control is an explicit, opt-in surface: no other tool ever touches
	// window geometry or state (the input path only focuses), so everything the
	// model does to the user's windows is visible as a browser_windows call.
	ctx.tools.register(defineTool({
		name: 'browser_windows',
		description: 'Inspect and control browser windows: list windows with geometry and state, open a new window (optionally positioned/sized), update state (minimize / maximize / fullscreen / focus) or geometry, close a whole window (all its tabs go too), or move tabs between windows. Geometry and state changes happen only through this tool. open is the only non-idempotent action: if it times out, run action:"list" first — the window may already exist.',
		parameters: {
			action: { type: 'string', required: true, description: 'One of: list, open, update, close, moveTab.' },
			windowId: { type: 'number', description: 'Target window for update/close/moveTab.' },
			url: { type: 'string', description: 'For open: a URL or an array of URLs (one tab each); defaults to about:blank.' },
			state: { type: 'string', description: 'For open/update: normal | minimized | maximized | fullscreen.' },
			left: { type: 'number', description: 'For open/update: window left edge in screen pixels.' },
			top: { type: 'number', description: 'For open/update: window top edge in screen pixels.' },
			width: { type: 'number', description: 'For open/update: window width in screen pixels.' },
			height: { type: 'number', description: 'For open/update: window height in screen pixels.' },
			focused: { type: 'boolean', description: 'For open/update: focus the window. focused:true on a minimized window restores it WITHOUT un-maximizing (state:"normal" would un-maximize).' },
			alwaysOnTop: { type: 'boolean', description: 'For update: keep the window above others.' },
			drawAttention: { type: 'boolean', description: 'For update: flash the taskbar entry to get the user\'s attention without stealing focus.' },
			incognito: { type: 'boolean', description: 'For open: open in incognito. Fails honestly when the extension is not allowed in incognito.' },
			tabId: { type: 'number', description: 'For moveTab: one tab to move.' },
			tabIds: { type: 'array', items: { type: 'number' }, description: 'For moveTab: several tabs to move in order; each is reported individually.' },
			index: { type: 'number', description: 'For moveTab: target position in the destination window; omit for the end.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
		},
		presentCall: args => ({ card: 'generic', title: `Browser windows: ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			switch (args.action) {
				case 'list':
					controller.requireExtensionCommand('windows.list', '1.6.0')
					return await controller.execute('windows.list', {}, exec.signal) as Record<string, JsonValue>
				case 'open': {
					const params: Record<string, unknown> = {}
					if (args.url !== undefined) params.url = args.url
					if (args.state !== undefined) params.state = args.state
					if (args.incognito === true) params.incognito = true
					for (const k of ['left', 'top', 'width', 'height'] as const) {
						if (typeof args[k] === 'number') params[k] = args[k]
					}
					if (args.focused !== undefined) params.focused = args.focused
					controller.requireExtensionCommand('windows.open', '1.6.0')
					return await controller.execute('windows.open', params, exec.signal) as Record<string, JsonValue>
				}
				case 'update': {
					const params: Record<string, unknown> = { windowId: requireWindowId(args, 'update') }
					if (args.state !== undefined) params.state = args.state
					for (const k of ['left', 'top', 'width', 'height'] as const) {
						if (typeof args[k] === 'number') params[k] = args[k]
					}
					if (args.focused !== undefined) params.focused = args.focused
					if (args.alwaysOnTop !== undefined) params.alwaysOnTop = args.alwaysOnTop
					if (args.drawAttention === true) params.drawAttention = true
					controller.requireExtensionCommand('windows.update', '1.6.0')
					return await controller.execute('windows.update', params, exec.signal) as Record<string, JsonValue>
				}
				case 'close':
					controller.requireExtensionCommand('windows.close', '1.6.0')
					return await controller.execute('windows.close', { windowId: requireWindowId(args, 'close') }, exec.signal) as Record<string, JsonValue>
				case 'moveTab': {
					if (args.tabId === undefined && args.tabIds === undefined) throw new Error('moveTab requires tabId or tabIds')
					const params: Record<string, unknown> = { windowId: requireWindowId(args, 'moveTab') }
					if (args.tabId !== undefined) params.tabId = args.tabId
					if (args.tabIds !== undefined) params.tabIds = args.tabIds
					if (args.index !== undefined) params.index = args.index
					controller.requireExtensionCommand('windows.moveTab', '1.6.0')
					return await controller.execute('windows.moveTab', params, exec.signal) as Record<string, JsonValue>
				}
				default:
					throw new Error(`unknown windows action: ${String(args.action)} (use list|open|update|close|moveTab)`)
			}
		},
	}))

	/** Page-side ceiling of the eval race in the extension; the bridge budget adds slack on top. */
	const EVAL_MAX_MS = 120_000

	ctx.tools.register(defineTool({
		name: 'browser_evaluate',
		description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.',
		parameters: {
			expression: { type: 'string', required: true, description: 'JavaScript expression or statement sequence; awaited like a promise body.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			timeoutMs: { type: 'number', description: `Give up after this many milliseconds; defaults to 60000, capped at ${EVAL_MAX_MS}.` },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: clampRendered(value.json) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { expression: args.expression }
			if (args.tabId !== undefined) params.tabId = args.tabId
			// The extension races the evaluation at this budget; give the bridge 2s of
			// slack so the page-side timeout reports first. Omitted → send nothing and
			// let the bridge default (60s) govern, exactly as before the knob existed.
			let bridgeCeiling: number | undefined
			if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
				const evalBudget = Math.min(EVAL_MAX_MS, Math.max(100, Math.trunc(args.timeoutMs)))
				params.timeoutMs = evalBudget
				bridgeCeiling = evalBudget + 2_000
			}
			const raw = await controller.execute(
				'eval',
				params,
				exec.signal,
				bridgeCeiling,
			) as { tabId: number; value: unknown }
			let json: string
			try {
				json = JSON.stringify(raw.value) ?? String(raw.value)
			} catch {
				json = String(raw.value)
			}
			return { tabId: raw.tabId, json }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_screenshot',
		description: 'Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path plus the image\'s real pixel size. fullPage captures the whole scrollable page in one shot (sticky/fixed headers may repeat); selector captures one element.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			fullPage: { type: 'boolean', description: 'Capture the entire scrollable page instead of just the viewport. The receipt\'s width/height show the real size.' },
			selector: { type: 'string', description: 'CSS selector: capture just that element (scrolled into view); the receipt carries its rect.' },
			format: { type: 'string', description: '"png" (default) or "jpeg".' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					tabId: { type: 'number', required: true },
					title: { type: 'string' },
					url: { type: 'string' },
					width: { type: 'number' },
					height: { type: 'number' },
					elementRect: {
						type: 'object',
						additionalProperties: false,
						properties: {
							x: { type: 'number', required: true },
							y: { type: 'number', required: true },
							w: { type: 'number', required: true },
							h: { type: 'number', required: true },
						},
					},
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Saved ${value.file} (${value.bytes} bytes${value.width !== undefined && value.height !== undefined ? `, ${value.width}×${value.height}` : ''}${value.elementRect !== undefined ? `, element at ${value.elementRect.x},${value.elementRect.y} size ${value.elementRect.w}×${value.elementRect.h}` : ''})`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' as const }),
		async execute(args, exec) {
			const format = args.format === 'jpeg' ? 'jpeg' : 'png'
			const params: Record<string, unknown> = { format }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.fullPage !== undefined) params.fullPage = args.fullPage
			if (args.selector !== undefined) params.selector = args.selector
			const payload = await controller.execute('screenshot', params, exec.signal) as ScreenshotPayload
			return saveScreenshot(controller, payload)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_cleanup',
		description: 'Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					shotsRemoved: { type: 'number', required: true },
					scratchRemoved: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' as const }),
		async execute() {
			const result = await controller.cleanup()
			return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) }
		},
	}))

	// v1.0.7: console + network capture, PDF export, device emulation.

	ctx.tools.register(defineTool({
		name: 'browser_console_log',
		description: 'Read the captured `console.log/info/warn/error` entries for a tab, with the entry text itself. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for "what did the page log after I clicked submit".',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			levels: { type: 'array', items: { type: 'string' }, description: 'Filter to one or more of: log, info, warn, error, debug.' },
			pattern: { type: 'string', description: 'Regex (case-insensitive) matched against the formatted text.' },
			limit: { type: 'number', description: 'Maximum entries to return; default 100, capped at 500.' },
			clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					count: { type: 'number', required: true },
					total: { type: 'number', required: true },
					entries: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								level: { type: 'string', required: true },
								text: { type: 'string', required: true },
								time: { type: 'string' },
								location: { type: 'string' },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const head = `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`
					+ ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit to see more` : ''}:`
				const lines = value.entries.map((entry, index) =>
					`${index + 1}. [${entry.time ?? '?'}] ${entry.level}${entry.location === undefined ? '' : ` @${entry.location}`} — ${entry.text}`)
				return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (Array.isArray(args.levels)) params.levels = args.levels
			if (typeof args.pattern === 'string') params.pattern = args.pattern
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			const raw = await controller.execute('console.log', params, exec.signal) as {
				tabId: number
				count: number
				total: number
				entries?: Array<{ level?: string; text?: string; t?: number; location?: string }>
			}
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				entries: (raw.entries ?? []).map(entry => ({
					level: entry.level ?? 'log',
					text: flattenOneLine(entry.text ?? '', 400),
					...(entry.t === undefined ? {} : { time: formatClock(entry.t) }),
					...(entry.location === undefined ? {} : { location: entry.location }),
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_log',
		description: 'Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			includeStatic: { type: 'boolean', description: 'Include images / fonts / stylesheets / scripts. Default false.' },
			methodPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the HTTP method.' },
			urlPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the URL.' },
			status: { type: 'string', description: 'One of: 2xx, 3xx, 4xx, 5xx, failed, pending.' },
			limit: { type: 'number', description: 'Maximum entries to return; default 200, capped at 1000.' },
			clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					count: { type: 'number', required: true },
					total: { type: 'number', required: true },
					requests: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								method: { type: 'string', required: true },
								url: { type: 'string', required: true },
								resourceType: { type: 'string' },
								status: { type: 'number' },
								statusText: { type: 'string' },
								mimeType: { type: 'string' },
								bytes: { type: 'number' },
								time: { type: 'string' },
								finished: { type: 'boolean' },
								failed: { type: 'boolean' },
								canceled: { type: 'boolean' },
								errorText: { type: 'string' },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const head = `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`
					+ ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit or filter by urlPattern/status` : ''}:`
				const lines = value.requests.map((row, index) => {
					const outcome = row.failed === true
						? `FAILED ${row.errorText ?? ''}`.trim()
						: row.status === undefined ? 'PENDING' : `${row.status} ${row.statusText ?? ''}`.trim()
					const size = row.bytes === undefined ? '' : ` ${formatBytes(row.bytes)}`
					const type = row.resourceType === undefined ? '' : ` ${row.resourceType}`
					return `${index + 1}. [${row.time ?? '?'}] ${row.method} ${outcome}${type}${size} ${row.url}`
				})
				return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.includeStatic === true) params.includeStatic = true
			if (typeof args.methodPattern === 'string') params.methodPattern = args.methodPattern
			if (typeof args.urlPattern === 'string') params.urlPattern = args.urlPattern
			if (typeof args.status === 'string') params.status = args.status
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			const raw = await controller.execute('network.log', params, exec.signal) as {
				tabId: number
				count: number
				total: number
				requests?: Array<Record<string, unknown>>
			}
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				requests: (raw.requests ?? []).map(row => networkRow(row)),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_clear',
		description: 'Empty the per-tab network capture buffer without returning the rows.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					cleared: { type: 'boolean', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `Tab ${value.tabId}: network log cleared` }],
		},
		presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('network.clear', params, exec.signal) as { tabId: number; cleared: boolean }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_pdf',
		description: 'Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			path: { type: 'string', description: 'Absolute path. Omit to save under the configured shotsDir with a timestamped name.' },
			landscape: { type: 'boolean', description: 'Use landscape orientation.' },
			printBackground: { type: 'boolean', description: 'Render CSS backgrounds. Default true.' },
			paperWidth: { type: 'number', description: 'Paper width in inches.' },
			paperHeight: { type: 'number', description: 'Paper height in inches.' },
			scale: { type: 'number', description: 'Page scale (0.1–2.0).' },
			pageRanges: { type: 'string', description: 'Sub-range, e.g. "1-3" or "1,4-6".' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					tabId: { type: 'number', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`,
			}],
		},
		presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.landscape === true) params.landscape = true
			if (args.printBackground === false) params.printBackground = false
			if (typeof args.paperWidth === 'number') params.paperWidth = args.paperWidth
			if (typeof args.paperHeight === 'number') params.paperHeight = args.paperHeight
			if (typeof args.scale === 'number') params.scale = args.scale
			if (typeof args.pageRanges === 'string') params.pageRanges = args.pageRanges
			const payload = await controller.execute('pdf', params, exec.signal) as { base64: string; tabId: number }
			return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_archive',
		description: 'Save the whole page as a single-file MHTML archive (text, images and styles inline; no network needed to reopen it). Returns the absolute path. The archive is a snapshot of when it was taken — scripts inside do not run and later page changes are not reflected; read it back with file tools or grep it like text.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			path: { type: 'string', description: 'Absolute path. Omit to save under the configured shotsDir with a timestamped .mhtml name.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					tabId: { type: 'number', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `MHTML archive written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`,
			}],
		},
		presentCall: args => ({ card: 'generic', title: `Save page archive${args.path ? ' → ' + args.path : ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			controller.requireExtensionCommand('archive', '1.5.0')
			const payload = await controller.execute('archive', params, exec.signal) as { mhtml: string; tabId: number }
			return await saveMhtml(controller, payload, typeof args.path === 'string' ? args.path : undefined)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_emulate',
		description: 'Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing, and throttle the network or CPU to test slow conditions. `device:"reset"` restores the user\'s actual viewport and clears all throttling. `network` presets (this tool\'s own numbers): slow3g = 400ms RTT + ~50KB/s both ways, fast3g = 150ms + ~200KB/s down / ~94KB/s up, offline, reset to clear. `cpuThrottlingRate` multiplies CPU cost (1 = off, up to 20). Throttling lives in the debugger session — it is gone when the extension detaches, and device:"reset" clears it too. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			device: { type: 'string', description: 'Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below.' },
			network: { type: 'string', description: 'slow3g | fast3g | offline | reset. The receipt reports the applied latency/throughput in bytes per second.' },
			cpuThrottlingRate: { type: 'number', description: 'CPU slowdown multiplier: 1 = none (default), 4 = mid-range phone, up to 20.' },
			width: { type: 'number', description: 'Custom viewport width in CSS px.' },
			height: { type: 'number', description: 'Custom viewport height in CSS px.' },
			deviceScaleFactor: { type: 'number', description: 'Custom DPR (1 = standard, 2 = retina, 3 = super-retina).' },
			isMobile: { type: 'boolean', description: 'Pass as mobile to the page (affects responsive meta).' },
			hasTouch: { type: 'boolean', description: 'Enable touch event dispatch.' },
			userAgent: { type: 'string', description: 'Custom User-Agent string. Empty string clears.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					reset: { type: 'boolean' },
					width: { type: 'number' },
					height: { type: 'number' },
					deviceScaleFactor: { type: 'number' },
					isMobile: { type: 'boolean' },
					hasTouch: { type: 'boolean' },
					userAgent: { type: 'string' },
					network: { type: 'string' },
					latency: { type: 'number' },
					downloadThroughput: { type: 'number' },
					uploadThroughput: { type: 'number' },
					cpuThrottlingRate: { type: 'number' },
				},
			},
			render: (_args, value) => {
				if (value.reset) return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default (network unthrottled, CPU rate 1)` }]
				// 覆盖生效的是哪个 UA / 哪档节流必须写出来：模型只看这句，看不见 value 里的字段。
				const ua = value.userAgent === undefined ? '' : ` UA="${flattenOneLine(value.userAgent, 80)}"`
				const net = value.network === undefined ? '' : ` network=${value.network}(${value.latency}ms↓${value.downloadThroughput}B/s↑${value.uploadThroughput}B/s)`
				const cpu = value.cpuThrottlingRate === undefined ? '' : ` cpu×${value.cpuThrottlingRate}`
				return [{
					type: 'text',
					text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}${ua}${net}${cpu}`,
				}]
			},
		},
		presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ''}${args.network ? ' ' + args.network : ''}${args.cpuThrottlingRate ? ' cpu×' + args.cpuThrottlingRate : ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (typeof args.device === 'string') params.device = args.device
			if (typeof args.network === 'string') params.network = args.network
			if (typeof args.cpuThrottlingRate === 'number') params.cpuThrottlingRate = args.cpuThrottlingRate
			if (typeof args.width === 'number') params.width = args.width
			if (typeof args.height === 'number') params.height = args.height
			if (typeof args.deviceScaleFactor === 'number') params.deviceScaleFactor = args.deviceScaleFactor
			if (typeof args.isMobile === 'boolean') params.isMobile = args.isMobile
			if (typeof args.hasTouch === 'boolean') params.hasTouch = args.hasTouch
			if (typeof args.userAgent === 'string') params.userAgent = args.userAgent
			const raw = await controller.execute('emulate', params, exec.signal) as {
				tabId: number
				reset?: boolean | null
				width?: number | null
				height?: number | null
				deviceScaleFactor?: number | null
				isMobile?: boolean | null
				hasTouch?: boolean | null
				userAgent?: string | null
				network?: string | null
				latency?: number | null
				downloadThroughput?: number | null
				uploadThroughput?: number | null
				cpuThrottlingRate?: number | null
			}
			// 扩展在无覆盖时回的是显式 `userAgent: null`（background.js:719），而宿主的
			// 校验器对 null **会下钻判类型**（只跳过 undefined）。原样透传时
			// `device:"desktop"` 或自定义宽高的每次调用都会抛 ToolOutputError。
			return {
				tabId: raw.tabId,
				...(raw.reset === true ? { reset: true } : {}),
				...(typeof raw.width === 'number' ? { width: raw.width } : {}),
				...(typeof raw.height === 'number' ? { height: raw.height } : {}),
				...(typeof raw.deviceScaleFactor === 'number' ? { deviceScaleFactor: raw.deviceScaleFactor } : {}),
				...(typeof raw.isMobile === 'boolean' ? { isMobile: raw.isMobile } : {}),
				...(typeof raw.hasTouch === 'boolean' ? { hasTouch: raw.hasTouch } : {}),
				...(typeof raw.userAgent === 'string' && raw.userAgent.length > 0 ? { userAgent: raw.userAgent } : {}),
				...(typeof raw.network === 'string' ? { network: raw.network } : {}),
				...(typeof raw.latency === 'number' ? { latency: raw.latency } : {}),
				...(typeof raw.downloadThroughput === 'number' ? { downloadThroughput: raw.downloadThroughput } : {}),
				...(typeof raw.uploadThroughput === 'number' ? { uploadThroughput: raw.uploadThroughput } : {}),
				...(typeof raw.cpuThrottlingRate === 'number' ? { cpuThrottlingRate: raw.cpuThrottlingRate } : {}),
			}
		},
	}))

	// Performance metrics: a pure read of CDP counters — whitelisted under
	// readOnly, no effect on the page, and the numbers ARE the content.
	ctx.tools.register(defineTool({
		name: 'browser_metrics',
		description: 'Read the tab\'s performance counters (Performance.getMetrics): DOM node count, JS heap usage, layout/style recalc counts, script/task durations. Use it to back "this page is heavy" with numbers, before and after an action. Read-only.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					metrics: {
						type: 'object',
						required: true,
						additionalProperties: false,
						properties: {
							Timestamp: { type: 'number' },
							Documents: { type: 'number' },
							Frames: { type: 'number' },
							JSEventListeners: { type: 'number' },
							Nodes: { type: 'number' },
							LayoutCount: { type: 'number' },
							RecalcStyleCount: { type: 'number' },
							LayoutDuration: { type: 'number' },
							RecalcStyleDuration: { type: 'number' },
							ScriptDuration: { type: 'number' },
							TaskDuration: { type: 'number' },
							JSHeapUsedSize: { type: 'number' },
							JSHeapTotalSize: { type: 'number' },
						},
					},
				},
			},
			render: (_args, value) => {
				const m = (value.metrics ?? {}) as Record<string, number | undefined>
				// 数字本身就是产出：关键几项原样进模型可见文本，heap 顺手换算成 MB。
				const parts: string[] = []
				if (m.Nodes !== undefined) parts.push(`nodes=${m.Nodes}`)
				if (m.JSHeapUsedSize !== undefined) {
					const total = m.JSHeapTotalSize !== undefined ? `/${(m.JSHeapTotalSize / 1_048_576).toFixed(1)}MB` : ''
					parts.push(`heap=${(m.JSHeapUsedSize / 1_048_576).toFixed(1)}${total}`)
				}
				if (m.LayoutCount !== undefined) parts.push(`layouts=${m.LayoutCount}`)
				if (m.ScriptDuration !== undefined) parts.push(`script=${Number(m.ScriptDuration).toFixed(2)}s`)
				if (m.TaskDuration !== undefined) parts.push(`tasks=${Number(m.TaskDuration).toFixed(2)}s`)
				return [{ type: 'text', text: `Tab ${value.tabId}: ${parts.join(' ') || JSON.stringify(value.metrics)}` }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Browser metrics', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			controller.requireExtensionCommand('metrics', '1.7.1')
			return await controller.execute('metrics', params, exec.signal) as MetricsPayload
		},
	}))

	registerDragTool(ctx, controller)
	registerAuditTool(ctx, controller)
	registerJournalTool(ctx, controller)
	registerSessionsTool(ctx, controller)
}

/* ------------------- browser_drag: composed plugin-side over the cdp channel ------------------- */

/** One CDP round-trip over the embedded `cdp` passthrough (extension v1.7.2+). */
async function cdpCall<T>(
	ctrl: BridgeController,
	tabId: number,
	method: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
): Promise<T> {
	return await ctrl.execute('cdp', { method, params, tabId }, signal) as T
}

interface DragTargetArgs {
	selector?: string
	x?: number
	y?: number
}

interface ResolvedDragPoint {
	selector?: string
	x: number
	y: number
	width?: number
	height?: number
	nodeId?: number
}

function dragTargetArgs(selector: string | undefined, x: number | undefined, y: number | undefined, side: 'from' | 'to'): DragTargetArgs {
	const hasSel = typeof selector === 'string' && selector.length > 0
	const hasX = typeof x === 'number' && Number.isFinite(x)
	const hasY = typeof y === 'number' && Number.isFinite(y)
	if (hasSel && (hasX || hasY)) throw new Error(`${side}: give either "${side}" (CSS selector) or "${side}X"/"${side}Y" coordinates, not both`)
	if (!hasSel && !(hasX && hasY)) throw new Error(`${side}: needs a CSS selector ("${side}") or both "${side}X" and "${side}Y" coordinates`)
	if (hasSel) return { selector }
	return { x, y }
}

/**
 * Resolve a drag endpoint. Selector endpoints become viewport coordinates via
 * the CDP DOM domain — no page JavaScript, so mouse mode also works with
 * `allowScript: false`. Top document only; cross-origin iframes are a later
 * iteration.
 */
async function resolveDragPoint(ctrl: BridgeController, tabId: number, target: DragTargetArgs, signal: AbortSignal): Promise<ResolvedDragPoint> {
	if (target.selector === undefined) return { x: target.x as number, y: target.y as number }
	const selector = target.selector
	const doc = await cdpCall<{ root?: { nodeId?: number } }>(ctrl, tabId, 'DOM.getDocument', { depth: 0 }, signal)
	const rootId = doc?.root?.nodeId
	if (typeof rootId !== 'number') throw new Error('DOM.getDocument returned no root node')
	const found = await cdpCall<{ nodeId?: number }>(ctrl, tabId, 'DOM.querySelector', { nodeId: rootId, selector }, signal)
	const nodeId = found?.nodeId ?? 0
	if (nodeId === 0) throw new Error(`no element matches selector ${JSON.stringify(selector)} (top document only)`)
	await cdpCall<unknown>(ctrl, tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId }, signal)
	let box: { model?: { content?: number[]; width?: number; height?: number } } | undefined
	try {
		box = await cdpCall<{ model?: { content?: number[]; width?: number; height?: number } }>(ctrl, tabId, 'DOM.getBoxModel', { nodeId }, signal)
	} catch (error) {
		throw new Error(`cannot measure ${JSON.stringify(selector)} — hidden, zero-size or detached? (${error instanceof Error ? error.message : String(error)})`)
	}
	const q = box?.model?.content
	if (!Array.isArray(q) || q.length < 8) throw new Error(`DOM.getBoxModel returned no quad for ${JSON.stringify(selector)}`)
	const x = (q[0] + q[2] + q[4] + q[6]) / 4
	const y = (q[1] + q[3] + q[5] + q[7]) / 4
	const width = typeof box?.model?.width === 'number' ? box.model.width : Math.hypot(q[2] - q[0], q[3] - q[1])
	const height = typeof box?.model?.height === 'number' ? box.model.height : Math.hypot(q[4] - q[2], q[5] - q[3])
	return { selector, x, y, width, height, nodeId }
}

/** Whether the source declares the native HTML5 `draggable` attribute. */
async function sourceIsDraggable(ctrl: BridgeController, tabId: number, nodeId: number, signal: AbortSignal): Promise<boolean> {
	const attrs = await cdpCall<{ attributes?: unknown }>(ctrl, tabId, 'DOM.getAttributes', { nodeId }, signal)
	const list = Array.isArray(attrs?.attributes) ? attrs.attributes.map(String) : []
	const at = list.indexOf('draggable')
	return at >= 0 && list[at + 1] === 'true'
}

/**
 * Synthesize a native-order HTML5 drag in the page: dragstart on the source,
 * dragenter/dragover on the target, drop only when dragover was prevented
 * (the browser's own rule), dragend on the source, all sharing one DataTransfer.
 * Untrusted events — pages that gate on `event.isTrusted` will ignore them,
 * which the tool description states instead of pretending otherwise.
 */
function html5DragExpression(fromSelector: string, to: DragTargetArgs): string {
	const toExpr = to.selector !== undefined
		? `document.querySelector(${JSON.stringify(to.selector)})`
		: `document.elementFromPoint(${to.x}, ${to.y})`
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
})()`
}

function roundDragPoint(p: ResolvedDragPoint): { selector?: string; x?: number; y?: number; width?: number; height?: number } {
	const out: { selector?: string; x?: number; y?: number; width?: number; height?: number } = {
		x: Math.round(p.x * 100) / 100,
		y: Math.round(p.y * 100) / 100,
	}
	if (p.selector !== undefined) out.selector = p.selector
	if (p.width !== undefined) out.width = Math.round(p.width * 100) / 100
	if (p.height !== undefined) out.height = Math.round(p.height * 100) / 100
	return out
}

interface DragReceipt {
	tabId: number
	mode: 'mouse' | 'html5'
	from: { selector?: string; x?: number; y?: number; width?: number; height?: number }
	to: { selector?: string; x?: number; y?: number; width?: number; height?: number }
	steps?: number
	dispatched?: number
	startCancelled?: boolean
	dragenterDefaultPrevented?: boolean
	overPrevented?: boolean
	dropFired?: boolean
	dropPrevented?: boolean
	events?: number
	elapsedMs: number
}

function registerDragTool(ctx: Context, controller: BridgeController): void {
	ctx.tools.register(defineTool({
	name: 'browser_drag',
	description: 'Drag a page element or point onto another with real input. mode "mouse" sends trusted press→moves→release input via CDP (canvas, sliders, sortable widgets); mode "html5" synthesizes dragstart/dragover/drop in the page for [draggable] elements and needs page scripting; "auto" (default) picks html5 only when the source declares draggable="true". Endpoints are CSS selectors (top document) or fromX/fromY + toX/toY viewport coordinates. Needs browser extension v1.7.2+ (embedded cdp channel).',
	parameters: {
		from: { type: 'string', description: 'CSS selector of the drag source; use fromX/fromY instead for raw coordinates.' },
		to: { type: 'string', description: 'CSS selector of the drop target; use toX/toY instead for raw coordinates.' },
		fromX: { type: 'number', description: 'Viewport x of the drag start point (with fromY).' },
		fromY: { type: 'number', description: 'Viewport y of the drag start point (with fromX).' },
		toX: { type: 'number', description: 'Viewport x of the drop point (with toY).' },
		toY: { type: 'number', description: 'Viewport y of the drop point (with toX).' },
		tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		mode: { type: 'string', description: '"auto" (default), "mouse" or "html5" — see the tool description.' },
		steps: { type: 'number', description: 'Intermediate mouse moves in mouse mode, 1–50 (default 12).' },
	},
	output: {
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				tabId: { type: 'number', required: true },
				mode: { type: 'string', required: true },
				from: {
					type: 'object',
					additionalProperties: false,
					properties: {
						selector: { type: 'string' },
						x: { type: 'number' },
						y: { type: 'number' },
						width: { type: 'number' },
						height: { type: 'number' },
					},
				},
				to: {
					type: 'object',
					additionalProperties: false,
					properties: {
						selector: { type: 'string' },
						x: { type: 'number' },
						y: { type: 'number' },
						width: { type: 'number' },
						height: { type: 'number' },
					},
				},
				steps: { type: 'number' },
				dispatched: { type: 'number' },
				startCancelled: { type: 'boolean' },
				dragenterDefaultPrevented: { type: 'boolean' },
				overPrevented: { type: 'boolean' },
				dropFired: { type: 'boolean' },
				dropPrevented: { type: 'boolean' },
				events: { type: 'number' },
				elapsedMs: { type: 'number', required: true },
			},
		},
		render: (_args, value) => {
			const v = value as unknown as DragReceipt
			const d = (p: { selector?: string; x?: number; y?: number } | undefined) =>
				p?.selector !== undefined ? p.selector : `(${p?.x ?? '?'},${p?.y ?? '?'})`
			if (v.mode === 'mouse') {
				return [{ type: 'text', text: `Tab ${v.tabId}: dragged ${d(v.from)} → ${d(v.to)} with mouse input (${v.steps} steps, ${v.dispatched} dispatches, ${v.elapsedMs}ms)` }]
			}
			const verdict = v.startCancelled === true
				? 'dragstart was cancelled by the page — nothing dropped'
				: v.overPrevented === true
					? (v.dropPrevented === true ? 'drop fired and was handled' : 'drop fired but no drop handler ran')
					: 'target did not accept the drop (no dragover preventDefault)'
			return [{ type: 'text', text: `Tab ${v.tabId}: dragged ${d(v.from)} → ${d(v.to)} with html5 events (${v.events} events, ${v.elapsedMs}ms) — ${verdict}` }]
		},
	},
	presentCall: args => ({
		card: 'generic',
		title: `Drag ${args.from ?? `(${args.fromX},${args.fromY})`} → ${args.to ?? `(${args.toX},${args.toY})`}`,
		kind: 'other' as const,
	}),
	async execute(args, exec) {
		const mode = args.mode === undefined ? 'auto' : args.mode
		if (mode !== 'auto' && mode !== 'mouse' && mode !== 'html5') throw new Error(`mode must be "auto", "mouse" or "html5" — got ${JSON.stringify(mode)}`)
		const from = dragTargetArgs(args.from, args.fromX, args.fromY, 'from')
		const to = dragTargetArgs(args.to, args.toX, args.toY, 'to')
		controller.requireExtensionCommand('cdp', '1.7.2')
		if (controller.policy.readOnly) throw new Error('browser_drag changes page state and read-only mode is on — turn readOnly off in the browser-bridge config to drag')
		let tabId = args.tabId
		if (tabId === undefined) {
			const listing = await controller.execute('tabs.list', {}, exec.signal) as { activeTabId?: number }
			if (typeof listing?.activeTabId !== 'number') throw new Error('could not resolve the active tab — pass tabId explicitly')
			tabId = listing.activeTabId
		}
		const started = Date.now()
		let resolvedMode: 'mouse' | 'html5' = mode === 'auto' ? 'mouse' : mode
		let source: ResolvedDragPoint | undefined
		if (mode !== 'html5') source = await resolveDragPoint(controller, tabId, from, exec.signal)
		if (mode === 'auto' && source?.nodeId !== undefined && await sourceIsDraggable(controller, tabId, source.nodeId, exec.signal)) {
			resolvedMode = 'html5'
		}
		if (resolvedMode === 'mouse') {
			const target = await resolveDragPoint(controller, tabId, to, exec.signal)
			const steps = Math.min(50, Math.max(1, Math.trunc(typeof args.steps === 'number' ? args.steps : 12)))
			const sx = source!.x, sy = source!.y, tx = target.x, ty = target.y
			const dispatch = async (params: Record<string, unknown>): Promise<void> => {
				await cdpCall<unknown>(controller, tabId, 'Input.dispatchMouseEvent', params, exec.signal)
			}
			await dispatch({ type: 'mouseMoved', x: sx, y: sy, button: 'none', buttons: 0 })
			await dispatch({ type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 })
			for (let i = 1; i <= steps; i++) {
				const f = i / steps
				await dispatch({ type: 'mouseMoved', x: sx + (tx - sx) * f, y: sy + (ty - sy) * f, button: 'left', buttons: 1 })
			}
			await dispatch({ type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1 })
			await dispatch({ type: 'mouseMoved', x: tx, y: ty, button: 'none', buttons: 0 })
			const receipt: DragReceipt = {
				tabId,
				mode: 'mouse',
				from: roundDragPoint(source!),
				to: roundDragPoint(target),
				steps,
				dispatched: steps + 4,
				elapsedMs: Date.now() - started,
			}
			return receipt
		}
		if (from.selector === undefined) throw new Error('html5 mode needs a CSS selector for "from" (a point has no draggable element)')
		if (!controller.policy.allowScript) throw new Error('html5 drag synthesizes DOM events and needs page scripting — allowScript is off; use mode:"mouse" or re-enable the script switch')
		const raw = await controller.execute('eval', { expression: html5DragExpression(from.selector, to), tabId }, exec.signal) as { tabId?: number; value?: unknown }
		const outcome = raw?.value as {
			error?: string
			startCancelled?: boolean
			dragenterDefaultPrevented?: boolean
			overPrevented?: boolean
			dropFired?: boolean
			dropPrevented?: boolean
			events?: number
		} | undefined
		if (outcome === undefined || typeof outcome !== 'object') throw new Error('html5 drag expression returned no outcome — page may have navigated mid-drag')
		if (typeof outcome.error === 'string') throw new Error(outcome.error)
		const receipt: DragReceipt = {
			tabId: typeof raw?.tabId === 'number' ? raw.tabId : tabId,
			mode: 'html5',
			from: from.selector !== undefined ? { selector: from.selector } : roundDragPoint(from as unknown as ResolvedDragPoint),
			to: to.selector !== undefined ? { selector: to.selector } : { x: to.x, y: to.y },
			startCancelled: outcome.startCancelled === true,
			dragenterDefaultPrevented: outcome.dragenterDefaultPrevented === true,
			overPrevented: outcome.overPrevented === true,
			dropFired: outcome.dropFired === true,
			dropPrevented: outcome.dropPrevented === true,
			events: typeof outcome.events === 'number' ? outcome.events : 0,
			elapsedMs: Date.now() - started,
		}
		return receipt
	},
	}))
}

function registerAuditTool(ctx: Context, controller: BridgeController): void {
	ctx.tools.register(defineTool({
		name: 'browser_audit',
		description: 'Read this plugin session\'s in-memory audit trail: every command sent to the browser extension (and every policy/gate refusal), with redacted params, outcome code and duration. Newest last; capped at 200 entries and wiped when dsh restarts. Values typed into pages and cookie values are redacted; eval expressions are truncated. Plugin-local read — works in read-only mode.',
		parameters: {
			command: { type: 'string', description: 'Only entries whose command contains this substring (e.g. "nav", "cookies", "tabs").' },
			tabId: { type: 'number', description: 'Only entries that carried this tabId.' },
			sinceSeq: { type: 'number', description: 'Only entries with seq greater than this (paging).' },
			limit: { type: 'number', description: `Max entries to return (newest last), 1–${AUDIT_MAX_ENTRIES}; default 50.` },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					total: { type: 'number', required: true },
					shown: { type: 'number', required: true },
					entries: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								seq: { type: 'number', required: true },
								t: { type: 'number', required: true },
								command: { type: 'string', required: true },
								tabId: { type: 'number' },
								params: { type: 'string', required: true },
								ok: { type: 'boolean', required: true },
								code: { type: 'string' },
								effectState: { type: 'string' },
								error: { type: 'string' },
								durationMs: { type: 'number', required: true },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const v = value as unknown as { total: number; shown: number; entries: AuditEntry[] }
				if (v.entries.length === 0) {
					return [{ type: 'text', text: `Audit: ${v.total} entries, none match — the trail starts when a command is executed.` }]
				}
				const lines = v.entries.map((e) => {
					const tab = e.tabId === undefined ? '' : ` tab ${e.tabId}`
					const outcome = e.ok ? 'ok' : `FAIL ${e.code ?? 'error'}${e.effectState ? `/${e.effectState}` : ''}`
					const err = e.ok || e.error === undefined ? '' : ` — ${e.error}`
					return `#${e.seq} ${formatClock(e.t)} ${e.command}${tab} ${outcome} ${e.durationMs}ms ${e.params}${err}`
				})
				return [{ type: 'text', text: clampRendered(`Audit: ${v.total} entries (showing ${v.shown})\n${lines.join('\n')}`) }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Browser audit', kind: 'other' as const }),
		async execute(args) {
			const entries = controller.audit.list({
				tabId: args.tabId,
				command: args.command,
				sinceSeq: args.sinceSeq,
				limit: args.limit,
			})
			return { total: controller.audit.size(), shown: entries.length, entries }
		},
	}))
}

function registerJournalTool(ctx: Context, controller: BridgeController): void {
	ctx.tools.register(defineTool({
		name: 'browser_journal',
		description: 'Read the persistent command journal across dsh restarts: every command from previous runs of this plugin (written to <stateDir>/journal.jsonl, last 1000 entries), grouped by run. Same redaction as browser_audit. Plugin-local disk read — works with the extension offline and in read-only mode, so it is the way to recover "what was I doing" after a restart.',
		parameters: {
			command: { type: 'string', description: 'Only entries whose command contains this substring.' },
			tabId: { type: 'number', description: 'Only entries that carried this tabId.' },
			limit: { type: 'number', description: 'Max entries to return (newest last), 1–500; default 50.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					total: { type: 'number', required: true },
					shown: { type: 'number', required: true },
					runs: { type: 'number', required: true },
					entries: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								run: { type: 'string', required: true },
								seq: { type: 'number', required: true },
								t: { type: 'number', required: true },
								command: { type: 'string', required: true },
								tabId: { type: 'number' },
								params: { type: 'string', required: true },
								ok: { type: 'boolean', required: true },
								code: { type: 'string' },
								effectState: { type: 'string' },
								error: { type: 'string' },
								durationMs: { type: 'number', required: true },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const v = value as unknown as { total: number; shown: number; runs: number; entries: (AuditEntry & { run: string })[] }
				if (v.entries.length === 0) {
					return [{ type: 'text', text: `Journal: ${v.total} entries on disk, none match — nothing recorded across runs yet.` }]
				}
				const lines: string[] = []
				let run = ''
				for (const e of v.entries) {
					if (e.run !== run) {
						run = e.run
						lines.push(`── run ${run}`)
					}
					const tab = e.tabId === undefined ? '' : ` tab ${e.tabId}`
					const outcome = e.ok ? 'ok' : `FAIL ${e.code ?? 'error'}`
					lines.push(`#${e.seq} ${formatClock(e.t)} ${e.command}${tab} ${outcome} ${e.durationMs}ms ${e.params}`)
				}
				return [{ type: 'text', text: clampRendered(`Journal: ${v.total} entries in ${v.runs} run(s) (showing ${v.shown})\n${lines.join('\n')}`) }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Browser journal', kind: 'other' as const }),
		async execute(args) {
			const dir = controller.stateDir
			if (dir === undefined) throw new Error('browser-bridge is not configured yet — the journal has no stateDir to read')
			const { total, entries } = await readJournal(dir, { command: args.command, tabId: args.tabId, limit: args.limit })
			return { total, shown: entries.length, runs: new Set(entries.map((e) => e.run)).size, entries }
		},
	}))
}

function registerSessionsTool(ctx: Context, controller: BridgeController): void {
	ctx.tools.register(defineTool({
		name: 'browser_sessions',
		description: 'List the dsh agent sessions sharing this browser and each one\'s working tab, or release your own working tab ("release"). Isolation: when a browser tool omits tabId, it defaults to THIS session\'s working tab (verified live against the extension) instead of the browser\'s active tab — concurrent sessions stop fighting over whatever tab is active. Explicit tabId always wins. Plugin-local; works read-only.',
		parameters: {
			action: { type: 'string', description: '"list" (default) or "release" (forget your working tab).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					current: { type: 'string' },
					sessions: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								sessionId: { type: 'string', required: true },
								workingTabId: { type: 'number' },
								lastActiveAt: { type: 'number', required: true },
								calls: { type: 'number', required: true },
							},
						},
					},
					releasedTabId: { type: 'number' },
				},
			},
			render: (_args, value) => {
				const v = value as unknown as { current?: string; sessions: { sessionId: string; workingTabId?: number; lastActiveAt: number; calls: number }[]; releasedTabId?: number }
				const short = (id: string) => (id.length <= 18 ? id : `${id.slice(0, 16)}…`)
				if (v.releasedTabId !== undefined) {
					return [{ type: 'text', text: `Sessions: released your working tab ${v.releasedTabId} — later calls without tabId follow the browser's active tab again.` }]
				}
				if (v.sessions.length === 0) {
					return [{ type: 'text', text: 'Sessions: 0 — no agent-scoped tool calls yet (calls without an agent identity keep the old active-tab behaviour).' }]
				}
				const lines = v.sessions.map((s) => {
					const me = s.sessionId === v.current ? '* ' : '  '
					const tab = s.workingTabId === undefined ? 'no working tab' : `tab ${s.workingTabId}`
					return `${me}${short(s.sessionId)} — ${tab}, ${s.calls} calls, last ${formatClock(s.lastActiveAt)}`
				})
				return [{ type: 'text', text: clampRendered(`Sessions: ${v.sessions.length}${v.current === undefined ? '' : ` (you: ${short(v.current)})`}\n${lines.join('\n')}`) }]
			},
		},
		presentCall: args => ({ card: 'generic', title: args.action === 'release' ? 'Release session tab' : 'Browser sessions', kind: 'other' as const }),
		async execute(args) {
			const current = TOOL_SESSION.getStore()
			if (args.action === 'release') {
				const sessions = controller.sessions.list()
				if (current === undefined) return { sessions }
				const released = controller.sessions.release(current)
				const payload: { current: string; sessions: ReturnType<SessionRegistry['list']>; releasedTabId?: number } = { current, sessions }
				if (released !== undefined) payload.releasedTabId = released
				return payload
			}
			if (args.action !== undefined && args.action !== 'list') throw new Error(`action must be "list" or "release" — got ${JSON.stringify(args.action)}`)
			const payload: { current?: string; sessions: ReturnType<SessionRegistry['list']> } = { sessions: controller.sessions.list() }
			if (current !== undefined) payload.current = current
			return payload
		},
	}))
}

/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx: Context, config: Config): void {
	const resolved = config as Required<Config>
	if (resolved.enabled && resolved.token.trim().length === 0) {
		throw new Error('browser-bridge: token must be a non-empty string when enabled')
	}
	const controller = new BridgeController(line => ctx.logger.info(line))

	let current: () => ResolvedConfig = () => resolved
	// Settings wiring, feature-detected. `sctx.settings.register` exists on
	// dsh-settings up to 0.1.2-rc.1; 0.1.7-rc.2 and 0.2.x export `SettingsForms`
	// instead, whose surface is configure/describe/update/replace/mutate — calling
	// `register` there throws a TypeError in the middle of this callback and used to
	// skip the reconcile/watch below (issue #8).
	ctx.inject(['settings'], (sctx) => {
		const settings = sctx.settings as unknown as {
			register?: (
				ns: string,
				schema: typeof Config,
				options: { base: Config; validate?: (value: Config) => void },
			) => LegacySettingsScope<Config>
			configure?: (presentation: { auto?: boolean }) => () => void
		}
		/** Converge without a namespace: the profile config stays authoritative. */
		const withoutNamespace = (why: string): void => {
			current = () => resolved
			ctx.logger.info(`browser-bridge: settings integration skipped (${why})`)
			// A failed start is recorded on the controller so every tool call reports it,
			// instead of throwing out of a callback the host never awaits.
			void controller.reconcile(current())
		}
		const register = settings.register
		if (typeof register !== 'function') {
			// dsh-settings 0.1.7+ / 0.2.x: the host projects this plugin's own `Config`
			// schema into an auto settings page, and editing that page re-applies the
			// entry, so the `config` handed to apply() is already the live value.
			const configure = settings.configure
			if (typeof configure === 'function') {
				try {
					ctx.effect(() => configure({ auto: true }), 'browser-bridge: settings presentation')
				} catch (error) {
					ctx.logger.info(`browser-bridge: settings presentation skipped: ${errorMessage(error)}`)
				}
			}
			withoutNamespace('no settings.register on this dsh-settings build')
			return
		}
		let scope: LegacySettingsScope<Config>
		try {
			scope = register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
				base: config,
				validate: (value) => {
					if (value.enabled && (value.token ?? '').trim().length === 0) {
						throw new Error('browser-bridge: token must be a non-empty string when enabled')
					}
				},
			})
		} catch (error) {
			ctx.logger.info(`browser-bridge: settings namespace failed: ${errorMessage(error)}`)
			withoutNamespace('register threw')
			return
		}
		current = () => scope.get() as ResolvedConfig
		ctx.effect(() => () => {
			// Mirror `isUnloading` from dsh-settings (private): the fiber's own
			// unload path runs the disposer too, and there re-applying the
			// composition entry and firing `onChange` would re-register routes
			// against a fiber whose resources are being released.
			if (ctx.fiber.state === FiberState.DISPOSED || ctx.fiber.state === FiberState.UNLOADING) return
			current = () => resolved
			void controller.reconcile(current())
		}, 'browser-bridge: settings cleanup')
		void controller.reconcile(current())
		scope.watch(() => {
			if (ctx.fiber.state === FiberState.DISPOSED || ctx.fiber.state === FiberState.UNLOADING) return
			void controller.reconcile(current())
		})
	})

	// Activation converges loudly so a bad port fails the plugin at load;
	// later settings commits degrade to recorded errors instead.
	controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
		throw new Error(`browser-bridge: ${errorMessage(error)}`)
	})

	applyBrowserTools(ctx, controller)
	ctx.effect(() => () => {
		void controller.stop()
	}, 'browser-bridge: server lifecycle')
}
