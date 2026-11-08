export class SessionRegistry {
    sessions = new Map();
    /** 记一次活动（无论成败）。 */
    touch(sessionId) {
        const now = Date.now();
        const existing = this.sessions.get(sessionId);
        if (existing === undefined) {
            this.sessions.set(sessionId, { sessionId, lastActiveAt: now, calls: 1, createdAt: now });
            return;
        }
        existing.lastActiveAt = now;
        existing.calls += 1;
    }
    /** 把某个标签页记为这个会话的工作标签页。 */
    adopt(sessionId, tabId) {
        const state = this.sessions.get(sessionId);
        if (state === undefined) {
            this.sessions.set(sessionId, { sessionId, workingTabId: tabId, lastActiveAt: Date.now(), calls: 0, createdAt: Date.now() });
            return;
        }
        state.workingTabId = tabId;
        state.lastActiveAt = Date.now();
    }
    /** 当前记录的工作标签页（不核对是否还开着——核对是控制器的事）。 */
    workingTab(sessionId) {
        return this.sessions.get(sessionId)?.workingTabId;
    }
    /** 清掉工作标签页；返回被清掉的 id。 */
    release(sessionId) {
        const state = this.sessions.get(sessionId);
        if (state === undefined)
            return undefined;
        const previous = state.workingTabId;
        state.workingTabId = undefined;
        return previous;
    }
    /** 全部会话，最近活跃的在前。 */
    list() {
        return [...this.sessions.values()]
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
            .map((s) => {
            const info = { sessionId: s.sessionId, lastActiveAt: s.lastActiveAt, calls: s.calls };
            if (s.workingTabId !== undefined)
                info.workingTabId = s.workingTabId;
            return info;
        });
    }
    size() {
        return this.sessions.size;
    }
}
