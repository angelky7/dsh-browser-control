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
export type BridgeErrorCode = 'bridge_disabled' | 'extension_offline' | 'command_timeout' | 'link_lost' | 'cancelled' | 'not_configured' | 'blocked_by_policy' | 'command_failed';
/** 副作用状态。 */
export type EffectState = 
/** 确定没有副作用落到页面上，重试安全。 */
'not_started'
/** 无法判断（写操作超时、在途掉线、扩展中途报错），重试前应先观察。 */
 | 'unknown'
/** 已确认执行完成（用于成功路径的显式标注，目前只在结果里出现）。 */
 | 'committed';
/** 该命令是否可能留下副作用。 */
export declare function isWriteCommand(command: string): boolean;
/** 带分类的桥接错误；`message` 面向模型，`toJSON()` 面向程序。 */
export declare class BridgeError extends Error {
    readonly code: BridgeErrorCode;
    readonly effectState: EffectState;
    readonly hint: string;
    readonly command: string;
    /** 原始失败描述：HTTP 面的 `error` 字段就是它，不含我们追加的契约文案。 */
    readonly detail: string;
    constructor(command: string, code: BridgeErrorCode, effectState: EffectState, message: string);
    /** 给 HTTP 面用的扁平 JSON 形状。 */
    toJSON(): {
        ok: false;
        error: string;
        code: string;
        effectState: string;
        hint: string;
    };
}
/**
 * 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
 * 保证多次包裹不会把 code 洗掉。
 */
export declare function classify(command: string, error: unknown): BridgeError;
