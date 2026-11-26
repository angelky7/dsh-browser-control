/**
 * 多 session 隔离（v1.7.6）：同一个插件实例、同一个浏览器，可能同时被好几个
 * dsh 会话（agent）驱动。以前它们都默认落到「浏览器当前活动标签页」——谁刚切了
 * 页，谁就把别人的上下文抢走。这一层给每个 agent 记住它自己的工作标签页：
 *
 *   - 省略 tabId 的工具调用默认落到**本会话的工作标签页**（先向扩展核对它还开着）；
 *   - 工作标签页被关掉 → 退回活动标签页，并改记新的；
 *   - 没带 agent 身份的调用（HTTP 面、测试、宿主老版本）完全维持旧行为。
 *
 * v1.8.0：工作标签页升级成 **(instance, tabId)** 这对。`tabId` 是**实例内**编号——
 * 浏览器 A 的第 5 个标签页和浏览器 B 的第 5 个标签页是两回事，只记 `tabId` 会让
 * 会话把别人的页当成自己的。`instance` 省略表示「当时只有一个浏览器」这一语境，
 * 所以只连了一个浏览器时行为与 v1.7.6 逐字一致。
 *
 * 这是**建议性隔离**，不是所有权锁：显式传 tabId 永远有效，跨会话交接不需要解锁。
 * 硬性归属（borrow/return + 用户仲裁）留给扩展侧那一版。
 */
export interface SessionTab {
	/** 实例键（instance id / `legacy`）；省略表示「没有指定实例的那一档」。 */
	instance?: string
	tabId: number
}

export interface SessionInfo {
	sessionId: string
	workingTab?: SessionTab
	/** epoch 毫秒 */
	lastActiveAt: number
	calls: number
}

interface SessionState {
	sessionId: string
	workingTab?: SessionTab
	lastActiveAt: number
	calls: number
}

export class SessionRegistry {
	private readonly sessions = new Map<string, SessionState>()

	/** 记一次活动（无论成败）。 */
	touch(sessionId: string): void {
		const now = Date.now()
		const existing = this.sessions.get(sessionId)
		if (existing === undefined) {
			this.sessions.set(sessionId, { sessionId, lastActiveAt: now, calls: 1 })
			return
		}
		existing.lastActiveAt = now
		existing.calls += 1
	}

	/** 把某个 (实例, 标签页) 记为这个会话的工作标签页。 */
	adopt(sessionId: string, tab: SessionTab): void {
		const state = this.sessions.get(sessionId)
		if (state === undefined) {
			this.sessions.set(sessionId, { sessionId, workingTab: { ...tab }, lastActiveAt: Date.now(), calls: 0 })
			return
		}
		state.workingTab = { ...tab }
		state.lastActiveAt = Date.now()
	}

	/** 当前记录的工作标签页（不核对是否还开着——核对是控制器的事）。 */
	workingTab(sessionId: string): SessionTab | undefined {
		const tab = this.sessions.get(sessionId)?.workingTab
		return tab === undefined ? undefined : { ...tab }
	}

	/** 清掉工作标签页；返回被清掉的。 */
	release(sessionId: string): SessionTab | undefined {
		const state = this.sessions.get(sessionId)
		if (state === undefined) return undefined
		const previous = state.workingTab
		state.workingTab = undefined
		return previous === undefined ? undefined : { ...previous }
	}

	/** 全部会话，最近活跃的在前。 */
	list(): SessionInfo[] {
		return [...this.sessions.values()]
			.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
			.map((s) => {
				const info: SessionInfo = { sessionId: s.sessionId, lastActiveAt: s.lastActiveAt, calls: s.calls }
				if (s.workingTab !== undefined) info.workingTab = { ...s.workingTab }
				return info
			})
	}

	size(): number {
		return this.sessions.size
	}
}
