/**
 * 本机策略闸门：只读档（`readOnly`）与脚本开关（`allowScript`）。
 *
 * 这两张表与 `errors.ts` 里的 `WRITE_COMMANDS` **故意不是同一张**，别合并：
 *
 *   - `WRITE_COMMANDS` 回答「超时或掉线之后重试，会不会多留一次副作用」，那是
 *     `effectState` 的语义。所以 `tabs.group` / `tabs.ungroup` 在那里**刻意算只读**：
 *     重复把标签归进同一个组是空操作，重试安全。
 *   - 这里回答的是「这条命令会不会改变页面、文件或浏览器状态」，用户开只读档时想要的
 *     正是这个。所以 `tabs.group` / `tabs.ungroup` / `tabs.activate` / `emulate` /
 *     `dialog` / `network.clear` 都不在白名单里。
 *
 * 白名单是**默认拒绝**：扩展以后新增一条命令，它自动被只读档拦下，等人判断完再放进来。
 * `verify/verify_policy.mjs` 会把扩展 `COMMANDS` 表逐条对账，让这个判断无法被跳过。
 *
 * 第三张表 `LOCAL_DESTRUCTIVE_COMMANDS` 是给**不经过扩展**的插件本地命令的：闸门如果只长在
 * `execute()` 上，这类调用就整个绕开只读档（`browser_cleanup` 合并进来时正是这样）。
 */

/** 只读档允许的命令：读页面、读扩展自己的缓冲、或者把页面**内容**落到本机文件。 */
export const READ_ONLY_ALLOWED: ReadonlySet<string> = new Set([
	// 身份与链路探测
	'ping', 'browser.info',
	// 读页面
	'content', 'find', 'snapshot', 'screenshot', 'pdf', 'wait',
	// 读扩展采集到的缓冲
	'tabs.list', 'console.log', 'network.log',
])

/**
 * 会执行**任意页面脚本**的扩展命令。这条与只读档分开管，因为用户可能想「可以读、
 * 也可以点，但别在我页面里跑任意 JS」——`browser_evaluate` 能绕开其他所有工具做的事。
 */
export const SCRIPT_COMMANDS: ReadonlySet<string> = new Set(['eval'])

/**
 * 不经过扩展、直接在插件进程里改动本机文件的命令名。
 *
 * `browser_cleanup` 走 `BridgeController.cleanup()`，**不经过 `execute()`**，所以它天然
 * 绕开了上面两张表管的那条路。只读档下仍然能删掉用户的整个截图目录，这正是「只读」
 * 最不该允许的动作，所以单独列一张表，并且由 `cleanup()` 自己调闸门。
 */
export const LOCAL_DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set(['cleanup'])

/**
 * 明确登记「会改页面 DOM」的命令 —— 只读档里必须拒，理由写在名字旁边。
 *
 * 现在只有 `hold`（接管浮层）：它往页面 `<html>` 下插一个宿主元素。默认拒绝其实已经
 * 盖住它（不在 `READ_ONLY_ALLOWED` 里），但「默认拒绝是对的」不等于「不需要解释」：
 * 这一条要的不是安全性，是**拒绝理由**——告诉模型为什么一个「只是提示用户」的动作
 * 在只读档里也算写操作。
 *
 * 注意 `hold` 是一条命令带 `action`（on/off/status），而闸门只看命令名 ⇒ 只读档下
 * `status` 也会被拒。这是有意的（读状态需要一条可用的桥，而只读档用户不需要浮层），
 * 在 `docs/BEHAVIOR.md` 里写明。
 */
export const PAGE_MUTATING_COMMANDS: ReadonlySet<string> = new Set(['hold'])

/** 两个闸门的当前值。取自插件配置，热更新即生效（改完重启 dsh 也一样）。 */
export interface PolicyFlags {
	/** 只读档：true 时拒绝一切会改变页面/浏览器状态的命令。 */
	readOnly: boolean
	/** 允许在页面里执行任意脚本（`browser_evaluate`）。 */
	allowScript: boolean
}

const CONFIG_HINT = '开关在 profile 的 cordis.patch.yml 里（browser-bridge 的 config），改完重启 dsh；'
	+ 'dsh 0.1.7+ 的宿主也会在「设置 → 插件」里直接列出这两项'

/**
 * 判断一条命令是否被本机策略拦下。
 * @param command - 扩展命令名（`click` / `eval` / `tabs.close` …），或 `LOCAL_DESTRUCTIVE_COMMANDS` 里的插件本地命令名。
 * @param flags - 当前的两个闸门值。
 * @returns 拒绝时写给 agent 的整句理由；放行时 `undefined`。
 */
export function policyRefusal(command: string, flags: PolicyFlags): string | undefined {
	if (!flags.allowScript && SCRIPT_COMMANDS.has(command)) {
		return `在页面里执行任意脚本已被关闭（allowScript: false）：命令 ${command} 被拒绝，没有向浏览器发出任何操作。`
			+ `要读页面内容请改用 browser_read / browser_snapshot / browser_find；确实需要执行脚本时，${CONFIG_HINT}之后再说。`
	}
	if (flags.readOnly && LOCAL_DESTRUCTIVE_COMMANDS.has(command)) {
		return `只读模式已开启（readOnly: true）：命令 ${command} 会删除本机保存的截图与临时文件，删除不可逆，所以已被拒绝，没有任何文件被删除。`
			+ `只读档的含义是「什么都不要改」，清理属于改动；要释放磁盘请由用户自己关掉 readOnly，${CONFIG_HINT}。不要原地重试本命令。`
	}
	if (flags.readOnly && PAGE_MUTATING_COMMANDS.has(command)) {
		return `只读模式已开启（readOnly: true）：命令 ${command} 会往页面里插入一层接管浮层（改页面 DOM），已被拒绝，没有向浏览器发出任何操作。`
			+ `浮层是给用户看的提示层，不是安全边界；只读档里连这种「只是提示」的改动也一并拒绝。要开浮层请由用户关掉 readOnly，${CONFIG_HINT}不要原地重试本命令。`
	}
	if (flags.readOnly && !READ_ONLY_ALLOWED.has(command)) {
		return `只读模式已开启（readOnly: true）：命令 ${command} 会改变页面或浏览器状态，已被拒绝，没有向浏览器发出任何操作。`
			+ `只读模式下可用的工具是读页面与读日志那几类；要放开写操作，${CONFIG_HINT}不要原地重试本命令。`
	}
	return undefined
}
