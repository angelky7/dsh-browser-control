/**
 * 工具调用失败时的结构化契约。
 *
 * Agent 拿到一句 `Error("...")` 文本时，其实无法决定下一步：该重试、该放弃、还是
 * 该先去确认页面状态？真正需要区分的是两件事——
 *
 *   1. `code`：失败的可分类原因（链路没起、扩展没连、超时、扩展报错……）
 *   2. `effectState`：这次调用的副作用**是否可能已经落到页面上**
 *
 * 第二条是重点：`click` 超时和"扩展中途断开"都属于**结果未知**——鼠标事件也许已经
 * 发出去了。这时让 agent 盲目重试，就会点两次、提交两次表单。所以对写操作，
 * 我们宁可报 `unknown` 并要求它先观察，也不假装"没发生"。
 *
 * 读操作（截图、读文本、查元素、列标签……）不改变页面，任何失败都是 `not_started`，
 * 重试安全。
 */

/** 失败原因分类。 */
export type BridgeErrorCode =
	| 'bridge_disabled'      // 桥接没在监听（配置里关掉了，或启动失败）
	| 'extension_offline'    // 桥在跑，但浏览器扩展没连上
	| 'command_timeout'      // 扩展在时限内没回结果
	| 'link_lost'            // 命令在途时扩展掉线/链路被换掉
	| 'cancelled'            // 调用方主动取消
	| 'not_configured'       // 还没拿到任何一份配置
	| 'command_failed';      // 扩展明确回了失败

/** 副作用状态。 */
export type EffectState =
	/** 确定没有副作用落到页面上，重试安全。 */
	| 'not_started'
	/** 无法判断（写操作超时、在途掉线、扩展中途报错），重试前应先观察。 */
	| 'unknown'
	/** 已确认执行完成（用于成功路径的显式标注，目前只在结果里出现）。 */
	| 'committed';

/**
 * 会改变页面或不可逆地改变浏览器状态的扩展命令；其余按只读处理。
 *
 * 判据是「重试会不会造成额外损害」，不是「有没有动到浏览器」。所以标签分组
 * （`tabs.group` / `tabs.ungroup`）不在这里：把已经在组里的标签再归一次是空操作，
 * 拆组失败后再拆一次也不会多拆坏东西，重试安全；而 `tabs.open` 重试会多出标签页、
 * `tabs.close` 重试可能关掉用户正在看的页面，必须报 unknown。
 */
const WRITE_COMMANDS = new Set<string>([
	'nav', 'click', 'input', 'press', 'scroll', 'eval', 'emulate',
	'tabs.open', 'tabs.close', 'tabs.activate', 'dialog',
]);

/** 该命令是否可能留下副作用。 */
export function isWriteCommand(command: string): boolean {
	return WRITE_COMMANDS.has(command)
}

/** 每个 code 对应的下一步建议（写给 agent，不是写给用户看的日志）。 */
const HINTS: Record<BridgeErrorCode, string> = {
	bridge_disabled: '桥接未启用：在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true 后重启 dsh；不要重试本命令。',
	extension_offline: '浏览器扩展没连上：让用户打开装了 DSH Browser Control 的那个浏览器（扩展图标应为绿色），确认端口与 Token 两边一致后再试。',
	command_timeout: '扩展超时未回应：先别重试。用 browser_find / browser_snapshot 看页面当前状态，判断动作是否其实已经生效。',
	link_lost: '命令在途时链路断了：动作可能已经落到页面上。先用只读工具确认页面状态，再决定是否重做。',
	cancelled: '调用被取消：按需重新发起，不必当作错误处理。',
	not_configured: '插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list）后再试。',
	command_failed: '扩展报回失败：按 error 文本处理，通常是选择器没命中、标签页已关闭或页面不允许该操作。',
};

/** 带分类的桥接错误；`message` 面向人，三个字段面向程序。 */
export class BridgeError extends Error {
	readonly code: BridgeErrorCode
	readonly effectState: EffectState
	readonly hint: string
	readonly command: string

	constructor(command: string, code: BridgeErrorCode, effectState: EffectState, message: string) {
		super(`[${code}] ${message}`)
		this.name = 'BridgeError'
		this.code = code
		this.effectState = effectState
		this.hint = HINTS[code]
		this.command = command
	}

	/** 给 HTTP 面用的扁平 JSON 形状。 */
	toJSON(): { ok: false; error: string; code: string; effectState: string; hint: string } {
		return {
			ok: false,
			error: this.message.replace(/^\[[a-z_]+\]\s*/, ''),
			code: this.code,
			effectState: this.effectState,
			hint: this.hint,
		}
	}
}

/**
 * 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
 * 保证多次包裹不会把 code 洗掉。
 */
export function classify(command: string, error: unknown): BridgeError {
	if (error instanceof BridgeError) return error
	const message = error instanceof Error ? error.message : String(error)
	// 写操作一旦超时或掉线，结果就是未知的；读操作永远可以安全重试。
	const unknownIsPossible = isWriteCommand(command)
	let code: BridgeErrorCode
	if (/no browser extension connected/.test(message)) code = 'extension_offline'
	else if (/disconnected mid-command|browser-bridge stopped/.test(message)) code = 'link_lost'
	else if (/timed out after/.test(message)) code = 'command_timeout'
	else if (/cancelled/.test(message)) code = 'cancelled'
	else if (/尚未加载配置|not configured yet/.test(message)) code = 'not_configured'
	else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message)) code = 'bridge_disabled'
	else code = 'command_failed'
	const effectState: EffectState = code === 'command_timeout' || code === 'link_lost'
		? (unknownIsPossible ? 'unknown' : 'not_started')
		: code === 'command_failed'
			? (unknownIsPossible ? 'unknown' : 'not_started')
			: 'not_started'
	return new BridgeError(command, code, effectState, message)
}
