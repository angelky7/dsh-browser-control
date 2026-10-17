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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BridgeServer, cleanupArtifacts } from "./server.js";
import { BridgeError, classify } from "./errors.js";
import { policyRefusal } from "./policy.js";
// Re-exported so the policy tables stay testable from the published bundle
// (verify/verify_policy.mjs reconciles them against the extension's COMMANDS).
export { READ_ONLY_ALLOWED, SCRIPT_COMMANDS, policyRefusal } from "./policy.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge';
/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt'];
/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge';
export const Config = z.object({
    enabled: z.boolean().default(true),
    port: z.number().step(1).min(1024).max(65_535).default(9777),
    token: z.string().default('dsh-local'),
    shotsDir: z.string().default('dsh-browser-shots'),
    readOnly: z.boolean().default(false),
    allowScript: z.boolean().default(true),
});
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
/** One `browser_read` window, in characters of page text. Longer pages are paged
 *  with `offset`, so no single call can put a whole site into the transcript. */
const READ_WINDOW_MAX_CHARS = 20_000;
/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
class BridgeController {
    log;
    server;
    serverKey = '';
    lastError;
    chain = Promise.resolve();
    current;
    constructor(log) {
        this.log = log;
    }
    /** Resolved directory screenshots land in; defined once any config arrived. */
    get shotsDir() {
        return this.current === undefined ? undefined : path.resolve(this.current.shotsDir);
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
        this.chain = run.catch(() => { });
        if (options.throwOnError === true) {
            return run.catch((error) => {
                throw error instanceof Error ? error : new Error(String(error));
            });
        }
        return Promise.resolve();
    }
    async reconcileNow(config) {
        const shotsDir = path.resolve(config.shotsDir);
        const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : '';
        if (key === this.serverKey)
            return;
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        await previous?.stop();
        if (!config.enabled) {
            this.lastError = undefined;
            return;
        }
        const server = new BridgeServer({ port: config.port, token: config.token, shotsDir, log: this.log });
        try {
            await server.start();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
            this.log(this.lastError);
            throw error instanceof Error ? error : new Error(message);
        }
        this.server = server;
        this.serverKey = key;
        this.lastError = undefined;
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
        // The policy gate sits above the link, not inside it: a refused command must
        // never reach the extension, so it cannot leave a side effect behind. Reading
        // `current` on every call is what makes a settings edit take effect live.
        const refusal = policyRefusal(command, {
            readOnly: this.current?.readOnly === true,
            allowScript: this.current?.allowScript !== false,
        });
        if (refusal !== undefined)
            throw new BridgeError(command, 'blocked_by_policy', 'not_started', refusal);
        const server = this.server;
        if (server === undefined) {
            throw classify(command, new Error(this.lastError ?? '浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）'));
        }
        return server.execute(command, params, timeoutMs === undefined ? { signal } : { signal, timeoutMs });
    }
    /**
     * Delete generated artifacts using the currently resolved directories;
     * works while the bridge is stopped because it never touches the socket.
     * @returns counts and names of what was removed.
     */
    async cleanup() {
        const dir = this.shotsDir;
        if (dir === undefined)
            throw classify('cleanup', new Error('browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录'));
        return cleanupArtifacts({ shotsDir: dir });
    }
    /** Stop the listener; safe to call repeatedly and during teardown. */
    stop() {
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        return previous?.stop() ?? Promise.resolve();
    }
}
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
const MAX_RENDERED_CHARS = 4_000;
function clampRendered(text, maxChars = MAX_RENDERED_CHARS) {
    if (text.length <= maxChars)
        return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n… [renderedTruncated omittedChars=${omitted} limitChars=${maxChars}] narrow the query and call again to see the rest`;
}
/** Model-facing budget for one snapshot listing; `limit` narrows the listing. */
const SNAPSHOT_RENDER_MAX_CHARS = 8_000;
/** Model-facing budget for one console/network log listing. */
const LOG_RENDER_MAX_CHARS = 6_000;
/** Collapse one page-supplied field to a single line inside a rendered listing. */
function flattenOneLine(value, maxChars) {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
/** `HH:MM:SS` in UTC from an epoch-milliseconds stamp. */
function formatClock(epochMs) {
    return new Date(epochMs).toISOString().slice(11, 19);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Reduce one captured network row to the fields this tool declares. The buffer
 * also carries request/response header maps and POST bodies; those stay out of
 * the value, because the value never reaches the model and the header dump is
 * what would blow the transcript.
 */
function networkRow(row) {
    const out = {
        method: typeof row.method === 'string' ? row.method : 'GET',
        url: flattenOneLine(typeof row.url === 'string' ? row.url : '', 200),
    };
    if (typeof row.resourceType === 'string')
        out.resourceType = row.resourceType;
    if (typeof row.status === 'number')
        out.status = row.status;
    if (typeof row.statusText === 'string' && row.statusText.length > 0)
        out.statusText = flattenOneLine(row.statusText, 60);
    if (typeof row.mimeType === 'string')
        out.mimeType = row.mimeType;
    if (typeof row.encodedDataLength === 'number')
        out.bytes = row.encodedDataLength;
    // CDP `wallTime` is a Timestamp in seconds, not milliseconds.
    if (typeof row.wallTime === 'number')
        out.time = formatClock(row.wallTime * 1000);
    if (row.finished === true)
        out.finished = true;
    if (row.failed === true)
        out.failed = true;
    if (row.canceled === true)
        out.canceled = true;
    if (typeof row.errorText === 'string' && row.errorText.length > 0)
        out.errorText = flattenOneLine(row.errorText, 120);
    return out;
}
/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args) {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
        throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)');
    }
    if (hasRef) {
        const ref = args.ref;
        if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref))
            throw new Error(`invalid ref: ${ref}`);
        return `[data-dsh-ref="${ref}"]`;
    }
    return args.selector;
}
function requireTabId(args, action) {
    if (typeof args.tabId !== 'number')
        throw new Error(`${action} requires tabId`);
    return args.tabId;
}
/**
 * Every tab the caller asked to close. `tabId` and `tabIds` are both accepted
 * (a batch call that repeats one id, or passes both, must not close it twice),
 * and the ids are deduplicated and normalised before they leave the host.
 */
function closeTabIds(args) {
    const asked = [
        ...(Array.isArray(args.tabIds) ? args.tabIds : []),
        ...(typeof args.tabId === 'number' ? [args.tabId] : []),
    ];
    const ids = [...new Set(asked.map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0)
        throw new Error('close requires tabId or tabIds');
    return ids;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 6);
    const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        title: payload.tabTitle,
        url: payload.tabUrl,
    };
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    let file;
    if (requestedPath && path.isAbsolute(requestedPath)) {
        file = requestedPath;
        await mkdir(path.dirname(file), { recursive: true });
    }
    else {
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = Math.random().toString(36).slice(2, 6);
        const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
        file = path.join(dir, name);
    }
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        ...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
        ...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
    };
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller) {
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
    });
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
                    pendingUrl: { type: 'string' },
                    loadPending: { type: 'boolean' },
                    siteUnreachable: { type: 'boolean' },
                },
            },
            render: (_args, value) => {
                const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ');
                const shows = label.length > 0 ? label : '(untitled)';
                // Nothing was navigated to: say that instead of "now shows <the URL you asked for>".
                if (value.siteUnreachable === true) {
                    return [{ type: 'text', text: `Tab ${value.tabId} could not load ${String(value.url ?? '')} — the browser landed on its own error page (DNS failure or no connection), so browser_read/browser_snapshot return that error page, not the site.` }];
                }
                // The wait budget ran out before the new document settled: the tab may still
                // be showing the previous page, so do not call it loaded.
                if (value.loadPending === true) {
                    const to = typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0 ? value.pendingUrl : 'the requested URL';
                    return [{ type: 'text', text: `Tab ${value.tabId} is still loading ${to} — the load had not settled when the wait budget ran out, so the tab may still be showing ${shows}. Re-check with browser_read before acting on it (or raise timeoutMs).` }];
                }
                if (typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0) {
                    return [{ type: 'text', text: `Tab ${value.tabId} shows ${shows} and is navigating to ${value.pendingUrl}` }];
                }
                return [{ type: 'text', text: `Tab ${value.tabId} now shows ${shows}` }];
            },
        },
        isConcurrencySafe: () => false,
        presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { url: args.url };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const raw = await controller.execute('nav', params, exec.signal);
            // The declared schema is closed, so the fields describing a navigation that did
            // not arrive have to be carried over on purpose. The old shape check
            // (`siteUnreachable === true`) also missed the object the extension really
            // sends, so an unreachable target came back as a plain success.
            const out = { tabId: raw.tabId };
            if (typeof raw.url === 'string')
                out.url = raw.url;
            if (typeof raw.title === 'string')
                out.title = raw.title;
            if (typeof raw.pendingUrl === 'string')
                out.pendingUrl = raw.pendingUrl;
            if (raw.loadPending === true)
                out.loadPending = true;
            const unreachable = raw.siteUnreachable === true
                || (typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null);
            if (unreachable)
                out.siteUnreachable = true;
            return out;
        },
    }));
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
                const end = value.offset + value.content.length;
                const head = `${value.title} (${value.url}) — ${value.mode} chars ${value.offset}-${end} of ${value.totalChars}`
                    + (value.truncated ? `; call again with offset=${end} to continue` : '');
                return [{ type: 'text', text: `${head}\n\n${value.content}` }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' }),
        async execute(args, exec) {
            const mode = args.mode === 'html' ? 'html' : 'text';
            const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
            const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS));
            const raw = await controller.execute('content', args.tabId === undefined ? { mode } : { mode, tabId: args.tabId }, exec.signal);
            const full = raw.content ?? '';
            const content = full.slice(offset, offset + limit);
            return {
                tabId: raw.tabId,
                mode,
                title: raw.title ?? '',
                url: raw.url ?? '',
                content,
                truncated: offset + content.length < full.length,
                offset,
                totalChars: full.length,
            };
        },
    }));
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
            render: (_args, value) => {
                const head = `${value.items.length} interactive elements on ${value.title}`
                    + ` (mode ${value.mode ?? 'dom'}); click or fill them by ref:`
                    + (value.axFallback === undefined ? '' : `\n(mode ax fell back to dom: ${value.axFallback})`);
                const lines = value.items.map(item => {
                    const name = item.name === undefined ? '' : ` "${flattenOneLine(item.name, 80)}"`;
                    const href = item.href === undefined ? '' : ` -> ${flattenOneLine(item.href, 100)}`;
                    return `[${item.ref}] ${item.role ?? item.tag}${name}${href}`;
                });
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), SNAPSHOT_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' }),
        async execute(args, exec) {
            const limit = Math.min(200, Math.max(1, args.limit ?? 120));
            const params = { limit };
            if (typeof args.tabId === 'number')
                params.tabId = args.tabId;
            if (typeof args.mode === 'string')
                params.mode = args.mode;
            const raw = await controller.execute('snapshot', params, exec.signal);
            // 版本错位必须说出来：v1.0.10 及更早的扩展没有 AX 快照（1.0.11 才加的），
            // 它会照单收下 mode:"ax" 然后回一份 DOM 结果，既不带 mode 也不带 axFallback
            // （本机实测：扩展 1.0.10，两次请求的响应完全一样）。那时模型只看到「(mode dom)」，
            // 读不出「我要的 ax 被旧扩展静默降级了」，会把标签名当成可访问名。
            // 按「请求的模式 vs 回报的模式」比对，不一致就自己写 axFallback——扩展不用改，老扩展立刻受益。
            const requestedAx = args.mode === 'ax';
            const gotAx = raw.mode === 'ax' || raw.ax !== undefined;
            const axFallback = typeof raw.axFallback === 'string' && raw.axFallback.length > 0
                ? raw.axFallback
                : (requestedAx && !gotAx
                    ? 'this extension ignored mode:"ax" and returned CSS-DOM matches (AX mode needs DSH Browser Control extension v1.0.11 or newer) — the names below are tag names, not accessible names'
                    : undefined);
            return {
                tabId: raw.tabId,
                title: raw.title ?? '',
                url: raw.url ?? '',
                ...(raw.mode === undefined ? {} : { mode: raw.mode }),
                ...(axFallback === undefined ? {} : { axFallback }),
                items: (raw.items ?? []).map(item => ({
                    ref: item.ref,
                    tag: item.tag,
                    ...(item.role === undefined ? {} : { role: item.role }),
                    ...(item.name === undefined ? {} : { name: item.name }),
                    ...(item.href === undefined ? {} : { href: item.href }),
                })),
            };
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args) };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.doubleClick !== undefined)
                params.doubleClick = args.doubleClick;
            return await controller.execute('click', params, exec.signal);
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args), value: args.value };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const filled = await controller.execute('input', params, exec.signal);
            if (args.submit === true) {
                await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal);
            }
            return filled;
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { key: args.key };
            if (Array.isArray(args.modifiers))
                params.modifiers = args.modifiers;
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('press', params, exec.signal);
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' }),
        async execute(args, exec) {
            const params = { x: args.x ?? 0, y: args.y ?? 0 };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('scroll', params, exec.signal);
        },
    }));
    /** Page-side ceiling of `cmdWait`; the bridge budget adds slack on top. */
    const WAIT_MAX_MS = 120_000;
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
        presentCall: args => ({ card: 'generic', title: `Wait for ${args.selector ?? args.text ?? 'page condition'}`, kind: 'other' }),
        async execute(args, exec) {
            const given = ['selector', 'text', 'fn'].filter(k => args[k] !== undefined && String(args[k]).length > 0);
            if (given.length === 0)
                throw new Error('browser_wait needs exactly one of selector, text, fn — otherwise there is nothing to wait for');
            if (given.length > 1)
                throw new Error(`browser_wait takes one condition, got ${given.join(' + ')} — pick the one you actually mean`);
            const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.timeoutMs ?? 15_000)));
            const params = { [given[0]]: args[given[0]], timeoutMs };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            // Slack so the page-side timeout always reports before the bridge gives up.
            return await controller.execute('wait', params, exec.signal, timeoutMs + 10_000);
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Find ${args.selector}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: args.selector };
            if (args.limit !== undefined)
                params.limit = args.limit;
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('find', params, exec.signal);
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: args.policy ? `Dialog policy → ${args.policy}` : 'Read dialog policy', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.policy !== undefined)
                params.policy = args.policy;
            return await controller.execute('dialog', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_info',
        description: 'Report which browser and which extension build is actually attached. Run it first when behaviour looks wrong — a stale extension or the wrong browser profile explains most of it.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Browser identity', kind: 'other' }),
        async execute(_args, exec) {
            return await controller.execute('browser.info', {}, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_tabs',
        description: 'List tabs, or open/close/activate/group/ungroup. `close` takes one tab (`tabId`) or several (`tabIds`); the result accounts for every id, so a retry is safe.',
        parameters: {
            action: { type: 'string', required: true, description: 'One of: list, open, close, activate, group, ungroup.' },
            url: { type: 'string', description: 'URL for the open action.' },
            tabId: { type: 'number', description: 'Target tab for close/activate/group.' },
            tabIds: { type: 'array', items: { type: 'number' }, description: 'For close: every tab to close in one call. The result reports each id (closed / alreadyGone / failed) instead of stopping at the first failure.' },
            active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
            group: { type: 'boolean', description: 'For open: put the new tab in the DSH tab group. Defaults to true; pass false to keep it loose.' },
            windowId: { type: 'number', description: 'For ungroup: only dissolve that window’s DSH group; omit to clear every window.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            switch (args.action) {
                case 'list':
                    return await controller.execute('tabs.list', {}, exec.signal);
                case 'open': {
                    if (typeof args.url !== 'string' || args.url.length === 0)
                        throw new Error('open requires url');
                    const params = { url: args.url };
                    if (args.active !== undefined)
                        params.active = args.active;
                    if (args.group !== undefined)
                        params.group = args.group;
                    return await controller.execute('tabs.open', params, exec.signal);
                }
                case 'close': {
                    const ids = closeTabIds(args);
                    // One id keeps the single-tab command; several go out as ONE command
                    // (`tabs.closeMany`) instead of N round-trips that can die in between.
                    return ids.length === 1
                        ? await controller.execute('tabs.close', { tabId: ids[0] }, exec.signal)
                        : await controller.execute('tabs.closeMany', { tabIds: ids }, exec.signal);
                }
                case 'activate':
                    return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal);
                case 'group':
                    return await controller.execute('tabs.group', { tabId: requireTabId(args, 'group') }, exec.signal);
                case 'ungroup': {
                    const params = {};
                    if (typeof args.windowId === 'number')
                        params.windowId = args.windowId;
                    return await controller.execute('tabs.ungroup', params, exec.signal);
                }
                default:
                    throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`);
            }
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: clampRendered(value.json) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' }),
        async execute(args, exec) {
            const raw = await controller.execute('eval', args.tabId === undefined ? { expression: args.expression } : { expression: args.expression, tabId: args.tabId }, exec.signal);
            let json;
            try {
                json = JSON.stringify(raw.value) ?? String(raw.value);
            }
            catch {
                json = String(raw.value);
            }
            return { tabId: raw.tabId, json };
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' }),
        async execute(args, exec) {
            const format = args.format === 'jpeg' ? 'jpeg' : 'png';
            const params = { format };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.fullPage !== undefined)
                params.fullPage = args.fullPage;
            const payload = await controller.execute('screenshot', params, exec.signal);
            return saveScreenshot(controller, payload);
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' }),
        async execute() {
            const result = await controller.cleanup();
            return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) };
        },
    }));
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
                    + ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit to see more` : ''}:`;
                const lines = value.entries.map((entry, index) => `${index + 1}. [${entry.time ?? '?'}] ${entry.level}${entry.location === undefined ? '' : ` @${entry.location}`} — ${entry.text}`);
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (Array.isArray(args.levels))
                params.levels = args.levels;
            if (typeof args.pattern === 'string')
                params.pattern = args.pattern;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            const raw = await controller.execute('console.log', params, exec.signal);
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
            };
        },
    }));
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
                    + ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit or filter by urlPattern/status` : ''}:`;
                const lines = value.requests.map((row, index) => {
                    const outcome = row.failed === true
                        ? `FAILED ${row.errorText ?? ''}`.trim()
                        : row.status === undefined ? 'PENDING' : `${row.status} ${row.statusText ?? ''}`.trim();
                    const size = row.bytes === undefined ? '' : ` ${formatBytes(row.bytes)}`;
                    const type = row.resourceType === undefined ? '' : ` ${row.resourceType}`;
                    return `${index + 1}. [${row.time ?? '?'}] ${row.method} ${outcome}${type}${size} ${row.url}`;
                });
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.includeStatic === true)
                params.includeStatic = true;
            if (typeof args.methodPattern === 'string')
                params.methodPattern = args.methodPattern;
            if (typeof args.urlPattern === 'string')
                params.urlPattern = args.urlPattern;
            if (typeof args.status === 'string')
                params.status = args.status;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            const raw = await controller.execute('network.log', params, exec.signal);
            return {
                tabId: raw.tabId,
                count: raw.count,
                total: raw.total,
                requests: (raw.requests ?? []).map(row => networkRow(row)),
            };
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('network.clear', params, exec.signal);
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.landscape === true)
                params.landscape = true;
            if (args.printBackground === false)
                params.printBackground = false;
            if (typeof args.paperWidth === 'number')
                params.paperWidth = args.paperWidth;
            if (typeof args.paperHeight === 'number')
                params.paperHeight = args.paperHeight;
            if (typeof args.scale === 'number')
                params.scale = args.scale;
            if (typeof args.pageRanges === 'string')
                params.pageRanges = args.pageRanges;
            const payload = await controller.execute('pdf', params, exec.signal);
            return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined);
        },
    }));
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
                if (value.reset)
                    return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default` }];
                // 覆盖生效的是哪个 UA 必须写出来：模型只看这句，看不见 value 里的字段。
                const ua = value.userAgent === undefined ? '' : ` UA="${flattenOneLine(value.userAgent, 80)}"`;
                return [{
                        type: 'text',
                        text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}${ua}`,
                    }];
            },
        },
        presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (typeof args.device === 'string')
                params.device = args.device;
            if (typeof args.width === 'number')
                params.width = args.width;
            if (typeof args.height === 'number')
                params.height = args.height;
            if (typeof args.deviceScaleFactor === 'number')
                params.deviceScaleFactor = args.deviceScaleFactor;
            if (typeof args.isMobile === 'boolean')
                params.isMobile = args.isMobile;
            if (typeof args.hasTouch === 'boolean')
                params.hasTouch = args.hasTouch;
            if (typeof args.userAgent === 'string')
                params.userAgent = args.userAgent;
            const raw = await controller.execute('emulate', params, exec.signal);
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
            };
        },
    }));
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx, config) {
    const resolved = config;
    if (resolved.enabled && resolved.token.trim().length === 0) {
        throw new Error('browser-bridge: token must be a non-empty string when enabled');
    }
    const controller = new BridgeController(line => ctx.logger.info(line));
    let current = () => resolved;
    // Settings wiring, feature-detected. `sctx.settings.register` exists on
    // dsh-settings up to 0.1.2-rc.1; 0.1.7-rc.2 and 0.2.x export `SettingsForms`
    // instead, whose surface is configure/describe/update/replace/mutate — calling
    // `register` there throws a TypeError in the middle of this callback and used to
    // skip the reconcile/watch below (issue #8).
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        /** Converge without a namespace: the profile config stays authoritative. */
        const withoutNamespace = (why) => {
            current = () => resolved;
            ctx.logger.info(`browser-bridge: settings integration skipped (${why})`);
            // A failed start is recorded on the controller so every tool call reports it,
            // instead of throwing out of a callback the host never awaits.
            void controller.reconcile(current());
        };
        const register = settings.register;
        if (typeof register !== 'function') {
            // dsh-settings 0.1.7+ / 0.2.x: the host projects this plugin's own `Config`
            // schema into an auto settings page, and editing that page re-applies the
            // entry, so the `config` handed to apply() is already the live value.
            const configure = settings.configure;
            if (typeof configure === 'function') {
                try {
                    ctx.effect(() => configure({ auto: true }), 'browser-bridge: settings presentation');
                }
                catch (error) {
                    ctx.logger.info(`browser-bridge: settings presentation skipped: ${errorMessage(error)}`);
                }
            }
            withoutNamespace('no settings.register on this dsh-settings build');
            return;
        }
        let scope;
        try {
            scope = register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
                base: config,
                validate: (value) => {
                    if (value.enabled && (value.token ?? '').trim().length === 0) {
                        throw new Error('browser-bridge: token must be a non-empty string when enabled');
                    }
                },
            });
        }
        catch (error) {
            ctx.logger.info(`browser-bridge: settings namespace failed: ${errorMessage(error)}`);
            withoutNamespace('register threw');
            return;
        }
        current = () => scope.get();
        ctx.effect(() => () => {
            // Mirror `isUnloading` from dsh-settings (private): the fiber's own
            // unload path runs the disposer too, and there re-applying the
            // composition entry and firing `onChange` would re-register routes
            // against a fiber whose resources are being released.
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            current = () => resolved;
            void controller.reconcile(current());
        }, 'browser-bridge: settings cleanup');
        void controller.reconcile(current());
        scope.watch(() => {
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            void controller.reconcile(current());
        });
    });
    // Activation converges loudly so a bad port fails the plugin at load;
    // later settings commits degrade to recorded errors instead.
    controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
        throw new Error(`browser-bridge: ${errorMessage(error)}`);
    });
    applyBrowserTools(ctx, controller);
    ctx.effect(() => () => {
        void controller.stop();
    }, 'browser-bridge: server lifecycle');
}
