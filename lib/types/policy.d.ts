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
 */
/** 只读档允许的命令：读页面、读扩展自己的缓冲、或者把页面**内容**落到本机文件。 */
export declare const READ_ONLY_ALLOWED: ReadonlySet<string>;
/**
 * 会执行**任意页面脚本**的扩展命令。这条与只读档分开管，因为用户可能想「可以读、
 * 也可以点，但别在我页面里跑任意 JS」——`browser_evaluate` 能绕开其他所有工具做的事。
 */
export declare const SCRIPT_COMMANDS: ReadonlySet<string>;
/** 两个闸门的当前值。取自插件配置，热更新即生效（改完重启 dsh 也一样）。 */
export interface PolicyFlags {
    /** 只读档：true 时拒绝一切会改变页面/浏览器状态的命令。 */
    readOnly: boolean;
    /** 允许在页面里执行任意脚本（`browser_evaluate`）。 */
    allowScript: boolean;
}
/**
 * 判断一条扩展命令是否被本机策略拦下。
 * @param command - 扩展命令名（`click` / `eval` / `tabs.close` …）。
 * @param flags - 当前的两个闸门值。
 * @returns 拒绝时写给 agent 的整句理由；放行时 `undefined`。
 */
export declare function policyRefusal(command: string, flags: PolicyFlags): string | undefined;
