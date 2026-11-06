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
/**
 * Stable identity one Chrome profile's extension announces in its hello frame
 * (v1.8.0+). One profile runs one extension, so one id maps to exactly one
 * browser instance — that is what lets the bridge hold several at once and
 * route a command to a named one instead of whoever connected last.
 *
 * Extensions that predate this field (v1.7.2 and earlier) announce nothing and
 * share the single `legacy` slot, exactly as before: the old "newer connection
 * replaces the older one" behaviour survives only on that path.
 */
export interface BridgeInstanceIdentity {
    /** Stable per-profile id; the extension generates it once and keeps it in chrome.storage.local. */
    readonly id: string;
    /** Human-readable name the user typed into the extension popup; empty when unnamed. */
    readonly label?: string;
}
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
    /** Instance identity (v1.8.0+); absent/undefined for older extensions. */
    readonly instance?: BridgeInstanceIdentity;
}
/** One connected extension link, listed on `/api/status` and by `browser_info`. */
export interface BridgeInstanceStatus {
    /** Targeting key: the instance id, or `legacy` for an extension without instance identity. */
    readonly id: string;
    /** User-set name, when the extension announced one. */
    readonly label: string | undefined;
    readonly connectedAt: string;
    readonly hello: BridgeHello;
}
/** Snapshot of the link and in-flight work, served verbatim on `/api/status`. */
export interface BridgeServerStatus {
    readonly listening: boolean;
    readonly port: number | undefined;
    readonly extensionConnected: boolean;
    readonly connectedAt: string | undefined;
    readonly hello: BridgeHello | undefined;
    /**
     * Every live link that finished its handshake, one entry per connected
     * extension (v1.8.0+; several entries when multiple browsers are connected).
     * `hello` / `connectedAt` above stay as the single-instance view for older
     * callers: they are only populated while exactly one instance is connected.
     */
    readonly instances: readonly BridgeInstanceStatus[];
    /** Protocol revision this bridge speaks. */
    readonly bridgeProtocol: number;
    /** Protocol revision the extension declared; absent/0 when it predates versioning. */
    readonly extensionProtocol: number;
    /** False when the two sides cannot agree on the frame contract, with the reason. */
    readonly protocolCompatible: boolean;
    readonly protocolNote: string | null;
    readonly pendingCommands: number;
    readonly lastError: string | undefined;
    /** True when the active token is the published default or too short to be a secret. */
    readonly insecureToken: boolean;
}
/** Caller controls for one {@link BridgeServer.execute} round-trip. */
export interface BridgeExecuteOptions {
    /** Fail the command after this many milliseconds; defaults to 60s, capped at 300s. */
    readonly timeoutMs?: number;
    /** Cancellation from the tool execution; aborting fails the in-flight command. */
    readonly signal?: AbortSignal;
    /**
     * Target instance: its id, its exact label, or a unique prefix of either.
     * Optional while a single extension is connected; required as soon as two
     * are, so a command can never silently land in the wrong browser.
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
 * Targeting key of a link whose extension announced no instance identity
 * (v1.7.2 and earlier). Such links keep the historical single-slot behaviour:
 * a newer connection replaces the older one, because the bridge has nothing to
 * tell them apart and silently multiplexing two anonymous browsers would make
 * "which one did that click land in" unanswerable.
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
 * Several extension links may be live at once (v1.8.0+): each Chrome profile
 * announces a stable instance id, so the bridge can hold one browser per
 * logged-in account and route each command to the instance the caller names.
 * Links from extensions that announce no id share a single `legacy` slot and
 * keep the historical replace-on-reconnect behaviour.
 */
export declare class BridgeServer {
    private readonly options;
    private httpServer;
    /** Every live link, keyed by socket (live from upgrade until close). */
    private readonly links;
    /** Targetable links: instance id (or `legacy`) → socket. */
    private readonly keyed;
    private readonly pending;
    private lastError;
    constructor(options: BridgeServerOptions);
    /** Current link state, also served verbatim as `/api/status`. */
    get status(): BridgeServerStatus;
    /** Every link that finished its handshake, in connection order. */
    private instances;
    /**
     * Hello of the link that would serve `instance`, or undefined when no link
     * can be resolved (offline, ambiguous reference, or several instances and
     * none named). Never throws: capability decisions call this, and "unknown"
     * there must not become a hard failure — `execute` is the place that refuses.
     */
    helloFor(instance?: string): BridgeHello | undefined;
    private get insecureToken();
    /** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
    start(): Promise<void>;
    /** Close every extension link, fail all pending commands, and release the port. Idempotent. */
    stop(): Promise<void>;
    /**
     * Send one command to an extension and await its result.
     *
     * The target is resolved first: an explicit `instance` (id, label, or unique
     * prefix), else the only connected instance. With several connected and none
     * named this refuses with `instance_required` instead of picking one — a
     * click that lands in the wrong browser cannot be undone.
     */
    execute(command: string, params: Record<string, unknown>, options?: BridgeExecuteOptions): Promise<unknown>;
    /**
     * Pick the link that should run `command`.
     *
     * `instance` must resolve to exactly one link: exact id, exact label, or a
     * unique prefix of either (case-insensitive). Without it the command goes to
     * the only connected instance; two or more connected without a name is
     * refused, never guessed.
     */
    private resolveLink;
    /** `label (id-prefix)` list for error copy; never throws. */
    private describeInstances;
    /**
     * Delete generated screenshots and agent scratch files via
     * {@link cleanupArtifacts} using this server's configured directories.
     */
    cleanup(): Promise<CleanupResult>;
    private log;
    /**
     * Mismatch description, or null when the two sides can talk. An older
     * extension that declares nothing is treated as v1-compatible: it still
     * answers every command this bridge has ever sent, so failing the link would
     * break working installs for a cosmetic gap.
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
     * Give a link its targeting key once its hello names the instance, keeping
     * one live socket per key. A reconnect of the SAME instance (browser
     * restart, extension reload) replaces the stale socket; a different instance
     * joins as its own link — that is what multi-instance support is for.
     */
    private bindKey;
    private closeSocket;
    /** Fail only the commands that were sent over `socket`; other instances keep theirs. */
    private failPendingFor;
    private failAllPending;
    private logVerbose;
}
