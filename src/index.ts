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

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-settings'
import { BridgeServer, cleanupArtifacts } from './server.ts'
import { classify } from './errors.ts'

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
	 */	shotsDir?: string
}

export const Config: z<Config> = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65_535).default(9777),
	token: z.string().default('dsh-local'),
	shotsDir: z.string().default('dsh-browser-shots'),
})

interface ResolvedConfig {
	enabled: boolean
	port: number
	token: string
	shotsDir: string
}

const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/
const READ_CONTENT_MAX_CHARS = 120_000

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

	constructor(private readonly log: (line: string) => void) {}

	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.shotsDir)
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
		const server = this.server
		if (server === undefined) {
			throw classify(command, new Error(
				this.lastError ?? '浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）',
			))
		}
		return server.execute(command, params, timeoutMs === undefined ? { signal } : { signal, timeoutMs })
	}

	/**
	 * Delete generated artifacts using the currently resolved directories;
	 * works while the bridge is stopped because it never touches the socket.
	 * @returns counts and names of what was removed.
	 */
	async cleanup(): Promise<{ shotsRemoved: number; scratchRemoved: readonly string[] }> {
		const dir = this.shotsDir
		if (dir === undefined) throw classify('cleanup', new Error('browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录'))
		return cleanupArtifacts({ shotsDir: dir })
	}

	/** Stop the listener; safe to call repeatedly and during teardown. */
	stop(): Promise<void> {
		const previous = this.server
		this.server = undefined
		this.serverKey = ''
		return previous?.stop() ?? Promise.resolve()
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value: string, maxChars: number): { content: string; truncated: boolean } {
	return value.length <= maxChars
		? { content: value, truncated: false }
		: { content: value.slice(0, maxChars), truncated: true }
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

interface ScreenshotPayload {
	tabId: number
	format: 'png' | 'jpeg'
	base64: string
	tabTitle?: string
	tabUrl?: string
}

interface ScreenshotResult {
	file: string
	bytes: number
	tabId: number
	title?: string
	url?: string
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
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl,
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

/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx: Context, controller: BridgeController): void {
	ctx.systemPrompt.section({
		name: 'tool:browser',
		order: 112,
		text: 'The browser_* tools drive the user\'s real, logged-in browser through the DSH '
			+ 'Browser Control extension; they act on the active tab unless a tabId is passed. '
			+ 'Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, '
			+ 'and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. '
			+ 'browser_read extracts page text, browser_screenshot saves a PNG/JPEG and returns its file '
			+ 'path (view it with an image tool). Calls fail with actionable copy while the bridge is '
			+ 'disabled or no browser is connected.',
	})

	ctx.tools.register(defineTool({
		name: 'browser_navigate',
		description: 'Navigate a browser tab to a URL and wait for the page load to settle.',
		parameters: {
			url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					url: { type: 'string' },
					title: { type: 'string' },
				},
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
				return [{ type: 'text', text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : '(untitled)'}` }]
			},
		},
		isConcurrencySafe: () => false,
		presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { url: args.url }
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('nav', params, exec.signal) as { tabId: number; title?: string; url?: string }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_read',
		description: 'Read the current page: title, URL, ready state, and body text (or full HTML).',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
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
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.title} (${value.url}) — ${value.content.length} chars${value.truncated ? ', truncated' : ''}`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' as const }),
		async execute(args, exec) {
			const mode = args.mode === 'html' ? 'html' : 'text'
			const raw = await controller.execute(
				'content',
				args.tabId === undefined ? { mode } : { mode, tabId: args.tabId },
				exec.signal,
			) as { tabId: number; title?: string; url?: string; content?: string }
			const clamped = clampText(raw.content ?? '', READ_CONTENT_MAX_CHARS)
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? '',
				url: raw.url ?? '',
				content: clamped.content,
				truncated: clamped.truncated,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_snapshot',
		description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:"ax" numbers them by Chrome\'s accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			limit: { type: 'number', description: 'Max elements returned; defaults to 120, capped at 200.' },
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
			render: (_args, value) => [{
				type: 'text',
				text: `${value.items.length} interactive elements on ${value.title}`
					+ ` (mode ${value.mode ?? 'dom'}); click or fill them by ref.`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' as const }),
		async execute(args, exec) {
			const limit = Math.min(200, Math.max(1, args.limit ?? 120))
			const params: Record<string, unknown> = { limit }
			if (typeof args.tabId === 'number') params.tabId = args.tabId
			if (typeof args.mode === 'string') params.mode = args.mode
			const raw = await controller.execute('snapshot', params, exec.signal) as {
				tabId: number
				title?: string
				url?: string
				mode?: string
				axFallback?: string
				items?: Array<{ ref: string; tag: string; role?: string; name?: string; href?: string }>
			}
			return {
				tabId: raw.tabId,
				title: raw.title ?? '',
				url: raw.url ?? '',
				...(raw.mode === undefined ? {} : { mode: raw.mode }),
				...(raw.axFallback === undefined ? {} : { axFallback: raw.axFallback }),
				items: (raw.items ?? []).map(item => ({
					ref: item.ref,
					tag: item.tag,
					...(item.role === undefined ? {} : { role: item.role }),
					...(item.name === undefined ? {} : { name: item.name }),
					...(item.href === undefined ? {} : { href: item.href }),
				})),
			}
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
		description: 'Send a real keyboard event to the page (Enter, Tab, Escape, arrows, or a single character).',
		parameters: {
			key: { type: 'string', required: true, description: 'Named key (Enter, Escape, ArrowDown…) or a single character.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
		},
		presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = { key: args.key }
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 200) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 1200) }],
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
		name: 'browser_dialog',
		description: 'Read or change how native alert/confirm/prompt dialogs are answered (accept, dismiss, or manual), and get the recent dialog log so you can prove one appeared.',
		parameters: {
			policy: { type: 'string', enum: ['accept', 'dismiss', 'manual'], description: 'Set this policy; omit to only read the current one.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 600) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 400) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Browser identity', kind: 'other' as const }),
		async execute(_args, exec) {
			return await controller.execute('browser.info', {}, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_tabs',
		description: 'List tabs, or open/close/activate/group/ungroup one. Actions act on real browser windows.',
		parameters: {
			action: { type: 'string', required: true, description: 'One of: list, open, close, activate, group, ungroup.' },
			url: { type: 'string', description: 'URL for the open action.' },
			tabId: { type: 'number', description: 'Target tab for close/activate/group.' },
			active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
			group: { type: 'boolean', description: 'For open: put the new tab in the DSH tab group. Defaults to true; pass false to keep it loose.' },
			windowId: { type: 'number', description: 'For ungroup: only dissolve that window’s DSH group; omit to clear every window.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 400) }],
		},
		presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			switch (args.action) {
				case 'list':
					return await controller.execute('tabs.list', {}, exec.signal) as Record<string, JsonValue>
				case 'open': {
					if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('open requires url')
					const params: Record<string, unknown> = { url: args.url }
					if (args.active !== undefined) params.active = args.active
					if (args.group !== undefined) params.group = args.group
					return await controller.execute('tabs.open', params, exec.signal) as Record<string, JsonValue>
				}
				case 'close':
					return await controller.execute('tabs.close', { tabId: requireTabId(args, 'close') }, exec.signal) as Record<string, JsonValue>
				case 'activate':
					return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal) as Record<string, JsonValue>
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

	ctx.tools.register(defineTool({
		name: 'browser_evaluate',
		description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.',
		parameters: {
			expression: { type: 'string', required: true, description: 'JavaScript expression or statement sequence; awaited like a promise body.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
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
			render: (_args, value) => [{ type: 'text', text: value.json.slice(0, 300) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' as const }),
		async execute(args, exec) {
			const raw = await controller.execute(
				'eval',
				args.tabId === undefined ? { expression: args.expression } : { expression: args.expression, tabId: args.tabId },
				exec.signal,
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
		description: 'Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
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
				},
			},
			render: (_args, value) => [{ type: 'text', text: `Saved ${value.file} (${value.bytes} bytes)` }],
		},
		presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' as const }),
		async execute(args, exec) {
			const format = args.format === 'jpeg' ? 'jpeg' : 'png'
			const params: Record<string, unknown> = { format }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.fullPage !== undefined) params.fullPage = args.fullPage
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
		description: 'Read the captured `console.log/info/warn/error` entries for a tab. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for "what did the page log after I clicked submit".',
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
					entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (Array.isArray(args.levels)) params.levels = args.levels
			if (typeof args.pattern === 'string') params.pattern = args.pattern
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			return await controller.execute('console.log', params, exec.signal) as { tabId: number; count: number; total: number; entries: Array<Record<string, unknown>> }
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
					requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`,
			}],
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
			return await controller.execute('network.log', params, exec.signal) as { tabId: number; count: number; total: number; requests: Array<Record<string, unknown>> }
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
		name: 'browser_emulate',
		description: 'Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:"reset"` restores the user\'s actual viewport. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			device: { type: 'string', description: 'Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below.' },
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
				},
			},
			render: (_args, value) => {
				if (value.reset) return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default` }]
				return [{
					type: 'text',
					text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`,
				}]
			},
		},
		presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (typeof args.device === 'string') params.device = args.device
			if (typeof args.width === 'number') params.width = args.width
			if (typeof args.height === 'number') params.height = args.height
			if (typeof args.deviceScaleFactor === 'number') params.deviceScaleFactor = args.deviceScaleFactor
			if (typeof args.isMobile === 'boolean') params.isMobile = args.isMobile
			if (typeof args.hasTouch === 'boolean') params.hasTouch = args.hasTouch
			if (typeof args.userAgent === 'string') params.userAgent = args.userAgent
			return await controller.execute('emulate', params, exec.signal) as { tabId: number; reset?: boolean; width?: number; height?: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; userAgent?: string }
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
