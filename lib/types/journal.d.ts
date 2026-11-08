import type { AuditEntry } from './audit.ts';
/** 磁盘上最多保留的条数（启动时裁剪）。 */
export declare const JOURNAL_MAX_LINES = 1000;
/** 一行 = 一次运行的编号 + 审计条目。 */
export interface JournalEntry extends AuditEntry {
    /** 这次插件运行的身份（启动时刻，ISO 秒）。跨运行恢复靠它分组。 */
    run: string;
}
export interface JournalFilter {
    tabId?: number;
    command?: string;
    limit?: number;
}
/**
 * 打开（并按需裁剪）一个 journal 目录。
 * @param stateDir - 目录（不存在会创建）；journal 文件是 `<stateDir>/journal.jsonl`。
 * @param log - 一行式日志；打开/裁剪的结论写进去。
 * @returns 带 run 编号的追加器；`close()` 等所有在途写入落盘。
 */
export declare class Journal {
    /** 这次运行的编号：启动时刻（毫秒精度；秒级精度下两次启动同秒会撞号）。 */
    readonly runId: string;
    private readonly file;
    private readonly log;
    private chain;
    private warned;
    private constructor();
    static open(stateDir: string, log: (line: string) => void): Promise<Journal>;
    /**
     * 追加一条（异步、排队写；失败只告警一次，绝不阻塞命令路径）。
     * @param entry - AuditLog 刚记下的条目（参数已脱敏）。
     */
    append(entry: AuditEntry): void;
    /** 等在途写入落盘（teardown / 测试用）。 */
    close(): Promise<void>;
}
/**
 * 读 journal 的尾部（不要求 Journal 实例——读在线程外也能工作，扩展离线也行）。
 * @param stateDir - journal 所在目录。
 * @param filter - tabId / 命令子串 / 条数（默认 50，最大 500；取最新）。
 */
export declare function readJournal(stateDir: string, filter?: JournalFilter): Promise<{
    total: number;
    entries: JournalEntry[];
}>;
