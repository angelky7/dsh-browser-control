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
/**
 * Wire protocol revision this bridge speaks. Kept separate from the package
 * version: an extension that is one patch newer still works, an extension that
 * speaks a different frame contract does not, and only the second case should
 * light up.
 */
export declare const BRIDGE_PROTOCOL_VERSION = 1;
/** Per-command ceiling when the caller passes none. */
export declare const DEFAULT_COMMAND_TIMEOUT_MS = 60000;
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
export declare const MAX_COMMAND_TIMEOUT_MS = 300000;
/** Identity the extension announces right after the handshake completes. */
export interface BridgeHello {
    readonly client: string;
    readonly version: string;
    /** Frame-contract revision the extension declared; 0 when it predates versioning. */
    readonly protocol: number;
    readonly browser: {
        readonly name: string;
        readonly version: string;
        readonly ua: string;
    };
    /**
     * Command names the extension implements (v1.7.2+). Absent when the extension
     * predates the capability handshake — callers fall back to a version map.
     */
    readonly capabilities?: readonly string[];
    /**
     * Stable browser-profile identity (extension v1.8.0+). `id` survives restarts and
     * extension reloads; `label` is whatever the user typed in the popup and may be
     * empty. Absent on older extensions — those land in the `legacy` slot, which keeps
     * the pre-1.8.0 "a newer connection replaces the older one" semantics, because two
     * anonymous browsers cannot be told apart and silently keeping both would make
     * "which browser did this click hit" unanswerable.
     */
    readonly instance?: {
        readonly id: string;
        readonly label?: string;
    };
}
/** One connected browser, as reported on `/api/status`. */
export interface BridgeInstanceSummary {
    /** Routing key. The instance id, or the literal `legacy` for a pre-1.8.0 extension. */
    readonly key: string;
    /** The full instance id; absent for a legacy link (there is none to show). */
    readonly id?: string;
    readonly label?: string;
    /** True when this connection carries no instance identity at all. */
    readonly legacy: boolean;
    readonly client: string;
    readonly version: string;
    readonly browser: {
        readonly name: string;
        readonly version: string;
        readonly ua: string;
    };
    readonly protocol: number;
    readonly connectedAt: string;
    readonly capabilities?: readonly string[];
}
/** Snapshot of the link and in-flight work, served verbatim on `/api/status`. */
export interface BridgeServerStatus {
    readonly listening: boolean;
    readonly port: number | undefined;
    readonly extensionConnected: boolean;
    readonly connectedAt: string | undefined;
    readonly hello: BridgeHello | undefined;
    /** Protocol revision this bridge speaks. */
    readonly bridgeProtocol: number;
    /** Protocol revision the extension declared; absent/0 when it predates versioning. */
    readonly extensionProtocol: number;
    /** False when the two sides cannot agree on the frame contract, with the reason. */
    readonly protocolCompatible: boolean;
    readonly protocolNote: string | null;
    readonly pendingCommands: number;
    /**
     * Every connected browser, in connection order. Always present (empty when none).
     *
     * `hello` / `connectedAt` / `extensionProtocol` above stay filled **only while
     * exactly one browser is attached**, so callers written before multi-instance see
     * byte-identical output; with two or more those fields go undefined and this list
     * is the only truthful answer (two different hellos cannot share one field).
     */
    readonly instances: readonly BridgeInstanceSummary[];
    readonly lastError: string | undefined;
    /** True when the active token is the published default or too short to be a secret. */
    readonly insecureToken: boolean;
}
/** Caller controls for one {@link BridgeServer.execute} round-trip. */
export interface BridgeExecuteOptions {
    /** Fail the command after this many milliseconds; defaults to 60s, capped to 300s. */
    readonly timeoutMs?: number;
    /** Cancellation from the tool execution; aborting fails the in-flight command. */
    readonly signal?: AbortSignal;
    /**
     * Which connected browser to send to (v1.8.0). Accepts the full instance id, the
     * user's label (case-insensitive), `legacy`, or a unique id prefix. Omitted is
     * only allowed while at most one browser is attached; with several it fails
     * closed as `instance_required` with **zero dispatch** — guessing which account
     * a click lands on is not a mistake this bridge is willing to make.
     */
    readonly instance?: string;
}
/** What {@link BridgeServer.cleanup} removed. */
export interface CleanupResult {
    /** Files deleted directly inside the screenshots directory. */
    readonly shotsRemoved: number;
    /** Scratch files deleted (agent temp scripts/artifacts matched by convention). */
    readonly scratchRemoved: readonly string[];
}
/**
 * Routing key for a browser that predates instance identity. Two anonymous browsers
 * cannot be told apart, so they share this one slot with the pre-1.8.0 semantics: a
 * newer connection replaces the older. It can coexist with named instances and be
 * addressed explicitly with `instance: "legacy"`.
 */
export declare const LEGACY_INSTANCE_KEY = "legacy";
export interface BridgeServerOptions {
    readonly port: number;
    readonly token: string;
    /** Directory whose direct contents `cleanup()` clears; created on demand. */
    readonly shotsDir: string;
    /** Directory scanned for agent scratch files by `cleanup()`; defaults to the process working directory. */
    readonly scratchDir?: string;
    /** Optional line logger for lifecycle diagnostics. */
    readonly log?: (line: string) => void;
    /**
     * Executor for the HTTP command face. The plugin passes its controller so
     * `/api/command` goes through the same policy gate and audit trail as tools;
     * without it (bare BridgeServer users, tests) the face stays raw.
     */
    readonly httpCommand?: (command: string, params: Record<string, unknown>, options: BridgeExecuteOptions) => Promise<unknown>;
}
/**
 * Clear the screenshots directory and delete agent scratch files. Only the
 * top level of each location is touched; nested trees stay untouched.
 * @param options - `shotsDir` is cleared of direct file children; `scratchDir`
 *   defaults to the process working directory and loses only scratch-named files.
 * @returns counts and names of what was removed.
 */
export declare function cleanupArtifacts(options: {
    shotsDir: string;
    scratchDir?: string;
}): Promise<CleanupResult>;
/**
 * One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
 * a fresh listener is built per start so a changed config reuses the class
 * without re-allocation concerns.
 *
 * Several extension links are held at once (v1.8.0). Each named instance owns its
 * own socket: a reconnect with the same id replaces only that browser. Anonymous
 * (pre-instance) extensions share the single `legacy` slot and keep the old
 * replace-the-previous behaviour.
 */
export declare class BridgeServer {
    private readonly options;
    private httpServer;
    /** Every live link, by socket. */
    private readonly links;
    /** Routing table: instance key → socket. The same socket also appears in `links`. */
    private readonly keyed;
    private lastError;
    constructor(options: BridgeServerOptions);
    /** Current link state, also served verbatim as `/api/status`. */
    get status(): BridgeServerStatus;
    private summarize;
    private get insecureToken();
    /** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
    start(): Promise<void>;
    /** Close the extension link, fail every pending command, and release the port. Idempotent. */
    stop(): Promise<void>;
    /**
     * Pick the browser a command goes to.
     *
     * Fail-closed by contract: with zero links this is the offline error, with one
     * link an omitted `instance` silently means "the only browser" (1.7.x behaviour),
     * and with several links an omitted `instance` throws `instance_required` **before
     * anything is written to any socket**.
     */
    private resolveLink;
    /**
     * Resolve `query` to a single instance **without throwing**, for the capability
     * gate. Undefined means "cannot say" — no browser, or several browsers and no
     * query — and callers fall back to their permissive path rather than inventing an
     * answer. Routing itself still fails closed in {@link resolveLink}.
     */
    peekInstance(query: string | undefined): BridgeInstanceSummary | undefined;
    /** Human-and-model readable one-liner for error text and the status page. */
    private describe;
    /**
     * Send one command to a connected extension and await its result.
     * Throws while no extension is linked; the rejection message names the fix.
     */
    execute(command: string, params: Record<string, unknown>, options?: BridgeExecuteOptions): Promise<unknown>;
    /**
     * Delete generated screenshots and agent scratch files via
     * {@link cleanupArtifacts} using this server's configured directories.
     */
    cleanup(): Promise<CleanupResult>;
    private log;
    /**
     * Mismatch description for one link, or null when the two sides can talk. An older
     * extension that declares nothing is treated as v1-compatible: it still answers
     * every command this bridge has ever sent, so failing the link would break working
     * installs for a cosmetic gap.
     */
    private protocolNoteFor;
    /**
     * Whether a request carries the bridge token, the same credential the WebSocket
     * upgrade checks. Accepted forms: `Authorization: Bearer <token>`, `X-Token: <token>`
     * and `?token=<token>` (the query form exists for curl and for the status page).
     */
    private authorized;
    private rejectUnauthenticated;
    private handleHttp;
    private respondJson;
    private handleCommandRequest;
    private handleUpgrade;
    private handleFrame;
    private handleText;
    /**
     * Give a link its routing key and evict the previous owner of that key.
     *
     * Named instances replace only themselves (two profiles stay connected side by
     * side). `legacy` keeps the old single-slot behaviour on purpose: the bridge
     * cannot tell two anonymous browsers apart, so keeping both would make
     * "which browser did this land on" unanswerable.
     */
    private registerKey;
    private closeLink;
    /** Fail only the in-flight commands of the link that went away; other browsers keep working. */
    private failPending;
    private logVerbose;
}
