/** 环形缓冲上限。200 条足够覆盖一次排障现场，又不至于让内存跟着会话长度涨。 */
export const AUDIT_MAX_ENTRIES = 200;
/** 单条参数摘要上限：审计要的是形状，不是全文。 */
const AUDIT_PARAMS_MAX_CHARS = 300;
/** 失败描述上限。 */
const AUDIT_ERROR_MAX_CHARS = 200;
/** eval 表达式只留前 120 字符：里面可能有凭据。 */
const AUDIT_EXPRESSION_MAX_CHARS = 120;
/** 参数里这些键的值一律打码（大小写不敏感）。 */
const SECRET_KEY = /^(token|authorization|password|passwd|secret|apikey|api_key|cookie)$/i;
/**
 * URL 里的秘密不能靠「截断」处理：`?token=…&code=…` 截到 120 字符照样是明文。
 * 审计的用途是「做了什么」，所以保留 scheme/host/path 与查询键名，**查询值一律打码**；
 * 片段（#）只在看起来像参数（含 `=` 或 token/secret 字样）时整体打码——SPA 路由
 * （`#/inbox`）要留住，OAuth 隐式流的 `#access_token=…` 不能留。
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
function redactUrlMatch(match) {
    // 错误文本里的 URL 常跟着标点（"...?token=x." / "...(https://…)")，先剥掉再原样接回。
    const trailing = match.match(/[).,;:!?]+$/);
    const core = trailing === null ? match : match.slice(0, -trailing[0].length);
    const tail = trailing === null ? '' : trailing[0];
    const queryAt = core.indexOf('?');
    const hashAt = core.indexOf('#');
    const base = queryAt >= 0 ? core.slice(0, queryAt) : (hashAt >= 0 ? core.slice(0, hashAt) : core);
    const query = queryAt >= 0 ? core.slice(queryAt + 1, hashAt >= 0 ? hashAt : undefined) : '';
    const hash = hashAt >= 0 ? core.slice(hashAt) : '';
    let changed = false;
    const redactedQuery = query.length === 0 ? '' : query.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0)
            return pair;
        const key = pair.slice(0, eq);
        let value = pair.slice(eq + 1);
        try {
            value = decodeURIComponent(value);
        }
        catch { /* 解码失败就按原文字符数 */ }
        changed = true;
        return `${key}=[redacted:${[...value].length} chars]`;
    }).join('&');
    let redactedHash = hash;
    if (hash.length > 1 && (/=/.test(hash) || /token|secret|access_token/i.test(hash))) {
        redactedHash = '#[redacted]';
        changed = true;
    }
    if (!changed)
        return core + tail;
    return `${base}${redactedQuery.length > 0 ? `?${redactedQuery}` : ''}${redactedHash}${tail}`;
}
/** 把一段文本里所有 URL 的查询值/敏感片段打码（用于参数摘要与错误文本）。 */
export function redactAuditText(text) {
    return text.replace(URL_PATTERN, redactUrlMatch);
}
/**
 * 哪个命令的 `value` 字段是敏感内容：`input` 是往页面里打的字（可能是密码），
 * `cookies.set` 直接写凭据。其余命令的 value 字段（如果有）不动。
 */
const VALUE_REDACTED_COMMANDS = new Set(['input', 'cookies.set']);
function redactValue(value) {
    const length = typeof value === 'string' ? [...value].length : 0;
    return `[redacted:${length} chars]`;
}
/**
 * 把一次调用的参数压成可审计的摘要：敏感键打码、特定命令的 value 打码、
 * 长表达式截断、整体限长。返回 JSON 文本——审计工具原样把它交给模型。
 */
export function summarizeAuditParams(command, params) {
    let text;
    try {
        text = JSON.stringify(params, (key, value) => {
            if (SECRET_KEY.test(key))
                return '[redacted]';
            if (key === 'value' && VALUE_REDACTED_COMMANDS.has(command))
                return redactValue(value);
            if (typeof value === 'string') {
                // URL query 与敏感片段先打码，再做表达式截断/整体限长：截断不是脱敏。
                const redacted = redactAuditText(value);
                if (key === 'expression' && [...redacted].length > AUDIT_EXPRESSION_MAX_CHARS) {
                    return `${[...redacted].slice(0, AUDIT_EXPRESSION_MAX_CHARS).join('')}…[+${[...redacted].length - AUDIT_EXPRESSION_MAX_CHARS} chars]`;
                }
                return redacted;
            }
            return value;
        }) ?? '{}';
    }
    catch {
        text = '[unserializable params]';
    }
    return [...text].length > AUDIT_PARAMS_MAX_CHARS
        ? `${[...text].slice(0, AUDIT_PARAMS_MAX_CHARS).join('')}…[+${[...text].length - AUDIT_PARAMS_MAX_CHARS} chars]`
        : text;
}
/** 记账器。一个桥（一个插件实例）一份；`record` 只追加，`list` 只读。 */
export class AuditLog {
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
            durationMs: Math.max(0, Math.round(input.durationMs)),
        };
        if (input.tabId !== undefined)
            entry.tabId = input.tabId;
        if (input.code !== undefined)
            entry.code = input.code;
        if (input.effectState !== undefined)
            entry.effectState = input.effectState;
        if (input.error !== undefined) {
            const redacted = redactAuditText(input.error);
            entry.error = [...redacted].length > AUDIT_ERROR_MAX_CHARS
                ? `${[...redacted].slice(0, AUDIT_ERROR_MAX_CHARS).join('')}…`
                : redacted;
        }
        this.entries.push(entry);
        // 环形缓冲：超出上限从最旧的一端丢。seq 不回收——调用方拿 seq 分页时
        // 「中间缺了号」本身就是「被挤掉了」的机器可读信号。
        if (this.entries.length > AUDIT_MAX_ENTRIES)
            this.entries.splice(0, this.entries.length - AUDIT_MAX_ENTRIES);
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
        if (filter.tabId !== undefined)
            matched = matched.filter((e) => e.tabId === filter.tabId);
        if (filter.command !== undefined && filter.command.length > 0) {
            const needle = filter.command.toLowerCase();
            matched = matched.filter((e) => e.command.toLowerCase().includes(needle));
        }
        if (filter.sinceSeq !== undefined) {
            const floor = filter.sinceSeq;
            matched = matched.filter((e) => e.seq > floor);
        }
        const limit = Math.min(AUDIT_MAX_ENTRIES, Math.max(1, Math.trunc(filter.limit ?? 50)));
        return matched.slice(Math.max(0, matched.length - limit));
    }
}
