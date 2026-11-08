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
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** 磁盘上最多保留的条数（启动时裁剪）。 */
export const JOURNAL_MAX_LINES = 1000;
/** 防御性上限：正常文件远小于它；超过就只读尾巴，别为了一本账吃掉内存。 */
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
function isEntry(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.run === 'string'
        && typeof v.command === 'string'
        && typeof v.seq === 'number'
        && typeof v.t === 'number'
        && typeof v.params === 'string'
        && typeof v.ok === 'boolean'
        && typeof v.durationMs === 'number';
}
/** 拆行并解析；坏行（截断、手改坏）跳过——一本账不能因为一行烂掉就全废。 */
function parseLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (line.trim().length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (isEntry(parsed))
                out.push(parsed);
        }
        catch { /* 坏行跳过 */ }
    }
    return out;
}
/**
 * 打开（并按需裁剪）一个 journal 目录。
 * @param stateDir - 目录（不存在会创建）；journal 文件是 `<stateDir>/journal.jsonl`。
 * @param log - 一行式日志；打开/裁剪的结论写进去。
 * @returns 带 run 编号的追加器；`close()` 等所有在途写入落盘。
 */
export class Journal {
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
        const file = path.join(stateDir, 'journal.jsonl');
        let existing = [];
        try {
            const text = await readFile(file, 'utf8');
            existing = parseLines(text.length > JOURNAL_MAX_BYTES ? text.slice(-JOURNAL_MAX_BYTES) : text);
        }
        catch { /* 首次运行没有文件 */ }
        if (existing.length > JOURNAL_MAX_LINES) {
            const kept = existing.slice(existing.length - JOURNAL_MAX_LINES);
            const tmp = `${file}.tmp`;
            await writeFile(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
            await rename(tmp, file);
            log(`journal: pruned ${existing.length - kept.length} old entries (${JOURNAL_MAX_LINES} kept)`);
        }
        else if (existing.length > 0) {
            const last = existing[existing.length - 1];
            log(`journal: restored context — ${existing.length} entries on disk, last from run ${last.run} (#${last.seq} ${last.command})`);
        }
        return new Journal(file, new Date().toISOString().slice(0, 23).replace('T', ' '), log);
    }
    /**
     * 追加一条（异步、排队写；失败只告警一次，绝不阻塞命令路径）。
     * @param entry - AuditLog 刚记下的条目（参数已脱敏）。
     */
    append(entry) {
        const line = `${JSON.stringify({ run: this.runId, ...entry })}\n`;
        this.chain = this.chain.then(() => appendFile(this.file, line, 'utf8')).catch((error) => {
            // 账本写不进去不是命令失败的理由：告警一次，继续跑。
            if (!this.warned) {
                this.warned = true;
                this.log(`journal: write failed — ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    /** 等在途写入落盘（teardown / 测试用）。 */
    async close() {
        await this.chain.catch(() => { });
    }
}
/**
 * 读 journal 的尾部（不要求 Journal 实例——读在线程外也能工作，扩展离线也行）。
 * @param stateDir - journal 所在目录。
 * @param filter - tabId / 命令子串 / 条数（默认 50，最大 500；取最新）。
 */
export async function readJournal(stateDir, filter = {}) {
    let text;
    try {
        text = await readFile(path.join(stateDir, 'journal.jsonl'), 'utf8');
    }
    catch {
        return { total: 0, entries: [] };
    }
    if (text.length > JOURNAL_MAX_BYTES)
        text = text.slice(-JOURNAL_MAX_BYTES);
    let matched = parseLines(text);
    if (filter.tabId !== undefined)
        matched = matched.filter((e) => e.tabId === filter.tabId);
    if (filter.command !== undefined && filter.command.length > 0) {
        const needle = filter.command.toLowerCase();
        matched = matched.filter((e) => e.command.toLowerCase().includes(needle));
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 50)));
    return { total: matched.length, entries: matched.slice(Math.max(0, matched.length - limit)) };
}
