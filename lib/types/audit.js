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
            if (key === 'expression' && typeof value === 'string' && [...value].length > AUDIT_EXPRESSION_MAX_CHARS) {
                return `${[...value].slice(0, AUDIT_EXPRESSION_MAX_CHARS).join('')}…[+${[...value].length - AUDIT_EXPRESSION_MAX_CHARS} chars]`;
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
            entry.error = [...input.error].length > AUDIT_ERROR_MAX_CHARS
                ? `${[...input.error].slice(0, AUDIT_ERROR_MAX_CHARS).join('')}…`
                : input.error;
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
