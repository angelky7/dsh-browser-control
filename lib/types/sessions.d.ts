/**
 * 多 session 隔离（v1.7.6）：同一个插件实例、同一个浏览器，可能同时被好几个
 * dsh 会话（agent）驱动。以前它们都默认落到「浏览器当前活动标签页」——谁刚切了
 * 页，谁就把别人的上下文抢走。这一层给每个 agent 记住它自己的工作标签页：
 *
 *   - 省略 tabId 的工具调用默认落到**本会话的工作标签页**（先向扩展核对它还开着）；
 *   - 工作标签页被关掉 → 退回活动标签页，并改记新的；
 *   - 没带 agent 身份的调用（HTTP 面、测试、宿主老版本）完全维持旧行为。
 *
 * 这是**建议性隔离**，不是所有权锁：显式传 tabId 永远有效，跨会话交接不需要解锁。
 * 硬性归属（borrow/return + 用户仲裁）留给扩展侧那一版。
 */
export interface SessionInfo {
    sessionId: string;
    workingTabId?: number;
    /** epoch 毫秒 */
    lastActiveAt: number;
    calls: number;
}
export declare class SessionRegistry {
    private readonly sessions;
    /** 记一次活动（无论成败）。 */
    touch(sessionId: string): void;
    /** 把某个标签页记为这个会话的工作标签页。 */
    adopt(sessionId: string, tabId: number): void;
    /** 当前记录的工作标签页（不核对是否还开着——核对是控制器的事）。 */
    workingTab(sessionId: string): number | undefined;
    /** 清掉工作标签页；返回被清掉的 id。 */
    release(sessionId: string): number | undefined;
    /** 全部会话，最近活跃的在前。 */
    list(): SessionInfo[];
    size(): number;
}
