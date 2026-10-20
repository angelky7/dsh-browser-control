# 行为契约（Behavior Contract）

Agent 和上层脚本可以依赖的确定性语义。违反这些契约视为 bug。

## 窗口几何不可侵犯

- 自动化**绝不**修改窗口尺寸、位置或状态（最大化/还原/最小化一律不动）。真实输入所需的窗口聚焦（`focused: true`）与标签页激活不改变任何几何属性。
- 浏览器窗口处于**最小化**状态时，视口为 0×0，真实键鼠事件无法送达。此时 `type` 模式 / `press` / `click` 返回结构化错误 `window_minimized`，提示用户手动还原窗口——绝不自动还原（自动还原会把最大化窗口压成小窗）。
- `fill` 模式、`eval`、`content`、`wait` 不需要窗口前台，最小化下照常工作。

## 自动等待

- `browser_navigate` / `tabs.open` 等待新文档落地（上限 15s，`timeoutMs` 可调）后才返回；15s 内没等到时结果带 `loadPending: true` 与 `pendingUrl`，`browser_navigate` 的文案会说「仍在加载」而不是「已显示」，模型不该把没落地的导航当成功。
- **不保证** SPA 路由或懒渲染内容就绪——导航返回后再用 `browser_wait` 显式等目标元素。
- 「压根没发生」的导航也不算到位：如果整个等待期间从没观察到 `loading`，宽限期后会拿标签**真正落到的 URL** 与请求的目标比对（忽略 hash 片段与末尾斜杠），不等就报 `loadPending`。所以「点了变成下载」「目标被 Chrome 拒载」不会 0ms 伪装成成功；而**导航到已经开着的那个地址**仍然算成功（不误报）。实测台：`verify/verify_nav_landing.mjs`。

## 原生弹窗（alert / confirm / prompt）

- v1.0.2+ 默认策略 `accept`：弹窗打开即自动按 OK，prompt 以 `defaultPrompt` 作为输入。
- 每次点击/输入结果带 `dialogsAnswered`（近 5 秒内该标签页被应答的弹窗数），可据此断言弹窗出现过。
- 全局策略可通过 `dialog` 命令改为 `dismiss` 或 `manual`；`manual` 下弹窗会阻塞页面线程直到工具超时。
- 近 10 条弹窗记录（类型、文本、应答方式）通过 `dialog {action:'get'}` 读取。

## 输入模式

- `browser_type` 默认 `fill`：直接设值 + input/change 事件。快，但绕过按键级逻辑。
- `mode: "type"`：逐字符真实键盘事件（**keyDown 带 `text` + keyUp，不发独立 `char`**）。用于 React 受控组件、带联想状态的搜索框、反爬表单。速度约每字符一次 CDP 往返，长文本慎用。
- **一次按键只许插入一次。** CDP 里 `keyDown` 带 `text` 时 Chrome 就已经插字符了；再补一个 `char` 事件会变成 `xx`，而 `Enter` 会把表单**提交两次**。`cmdInput` 早就按这条写了注释，`cmdPress` 却漏了同一个 `char` 分支，从 v0.2.0 一路留到 v1.0.15（issue #14，wangyuncai2024 报的，附了三组裸 CDP 对照）。现在两处一致，并由 `verify/verify_press_events.mjs` 按**派发次数**钉住：单字符 press、`Enter`、数字键、`type` 模式逐字符，插入型事件必须恰好一个；对修复前的 `background.js` 跑同一批断言会红 12 项。
- `browser_press` 现在支持组合键：`key: "Ctrl+A"` / `"Shift+ArrowRight"`，或等价的 `modifiers: ["ctrl"]`。`shift` 单独存在时照常打字，`ctrl`/`meta`/`alt` 抑制插入。
- **认不出来的键名一律抛错**，不再带着 `undefined` 的 keyCode/code 静默派发（以前 `browser_press {key:"Shift+ArrowRight"}` 在修复前既不报错也不选中文本）。合法清单在报错里给出；组合串里的未知修饰键同样报错。
- 合成赋值对百度/B站搜索框无效是已知案例（DOM 值正确但组件状态未同步）——这类站点用 `type` 模式。

## evaluate

- 返回值经 CDP `returnByValue` 序列化；不可序列化对象（DOM 节点、函数、代理）返回 `[type: not serializable — …]` 占位串而非空 `{}`。
- 页面在 Promise 挂起期间跳转 → 结构化错误 `context_destroyed: page navigated while evaluate was pending`，不会耗尽整个超时预算。
- `frameSelector` 参数支持同源 iframe（contentDocument 穿透）；跨源帧明确报错，不做静默降级。

## 截图与坐标

- 视口截图坐标为 CSS 像素；元素截图用 CDP `clip`，DPR 由 Chrome 内部处理，无需外部换算。
- 点击结果包含实际命中点 `clicked.x/y` 与 `hitVerified`（命中元素是否等于目标元素）。`hitVerified: false` 时附 `hitInstead` 字段指明实际命中的元素——典型场景是 sticky 头部/广告遮挡。

## 超时

- 所有涉及页面交互的命令接受 `timeoutMs`（毫秒）：navigate/tabs.open 默认 15000，wait 默认 15000 上限 120000，evaluate 默认 60000（桥接层上限 300000）。

## 后台标签页节流

Chrome 对非前台标签页的 `setTimeout` 强制钳制到 ≥1s。长任务注入在后台标签会显著变慢甚至超时——需要精确计时的注入先 `browser_tabs activate` 切到前台。

## 死站点检测

导航落到 `chrome-error://` 时，`browser_navigate` 结果携带 `siteUnreachable: {reason}`（dns/unreachable），且 `url` 回报为请求的目标 URL 而非内部协议地址。

## 快照的两种模式

- 默认 `mode:"dom"`：按固定选择器列表（`a[href]` / `button` / `input` / `[role=…]` / `[contenteditable]` / `[onclick]`）扫可交互元素。
- `mode:"ax"`：用 Chrome 的 `Accessibility.getFullAXTree`。`role` 和 `name` 是**浏览器自己算出来的可访问名**（aria-label、`<label>`、`alt`、可见文本的合成结果），比让 agent 猜 CSS 选择器抗改版。
- **两种模式的 ref 契约完全一样**：都往真实 DOM 元素上写 `data-dsh-ref`，所以 `browser_click` / `browser_type` 传 ref 的写法不变。
- 只收「可操作角色」白名单（button / link / textbox / searchbox / combobox / listbox / menuitem* / option / radio / checkbox / switch / slider / spinbutton / tab / treeitem / gridcell / columnheader / rowheader）。噪音角色 `GenericContainer` / `StaticText` / `InlineTextBox` 一律滤掉——否则文字多的页面会把 `limit` 全吃在文本节点上。
- 隐形元素（`getBoundingClientRect()` 宽高都是 0）**不占 ref 号也不写属性**；AX 树报了 `backendDOMNodeId` 但 DOM 里已经没有该节点时计入 `ax.unresolved` 并跳过。两种情况都在 `ax` 计数里分开回报。
- AX 快照**先清掉上一轮的 `data-dsh-ref` 再取树**：旧 ref 绝不能指向现在屏幕上的另一个元素。
- AX 域拿不到（老 Chrome、无障碍未就绪、页面拒绝）时自动降级回 DOM 模式，结果带 `mode:"dom"` 与 `axFallback:"<原因>"`，**不让整条命令失败**；agent 据此知道这次的名字来自 DOM 而不是 AX。
- **扩展比插件旧（扩展 < 1.0.11 根本没有 AX）也要说出来。** 本机真实实测：扩展 1.0.10 收到 `mode:"ax"` 时既不报错也不带 `mode`/`axFallback`，原样回一份 DOM 结果（两次请求的响应完全一样）。以前模型只看到 `(mode dom)`，读不出「我要的 ax 被旧扩展静默降级了」，会把标签名当成可访问名。现在插件自己比对**请求的模式 vs 回报的模式**（`mode==='ax'` 或带 `ax` 计数才算真走了 AX），不一致就补一句 `axFallback`，写明「下面的名字是标签名，不是可访问名；AX 需要扩展 v1.0.11+」。改在插件侧，**老扩展不用升级也能立刻受益**。
- 代价：AX 模式每条保留元素多两次 CDP 往返（`DOM.resolveNode` + `Runtime.callFunctionOn`），本地链路可接受，`limit`（默认 120，上限 200）是硬闸。

## agent 标签页归组

- `browser_tabs open` 新建的标签会自动收进**当前窗口**的 `DSH` 蓝色分组（每窗口一组），给人一眼分辨机器开的和自己开的。
- 归组结论只是附在结果里（`grouped` / `groupId` / `created` / `reason`），**归组失败绝不会让「打开标签页」失败**；`group: false` 可显式跳过，`browser_tabs group` 能把早就存在的散标签拉进来。
- 刚 `tabs.create` 就 `tabs.group` 会跟 Chrome 自己的标签簿记打架，所以最多打 4 枪（1 次 + 退避 50/150/400ms 三次），有上限、不无限重试。
- `groupId` 只缓存在内存。service worker 重启、或用户手动拆了组，就按标题 `DSH` 反查重建——**不会往已经失效的 groupId 上塞标签**（真 Chrome 对这种情况直接报错）。
- `browser_tabs ungroup`（可选 `windowId`）只解除归属，不关任何标签页。
- 拿不到 `tabGroups` 权限（Chrome < 89）时整条路径降级为 `{grouped:false, reason}`，其它功能不受影响；manifest 里漏声明该权限也会静默走这条降级，所以 `verify/verify_tab_groups.mjs` 直接断言 manifest 内容。
- 归组不算「写操作」：重复归组是空操作，错误契约（`src/errors.ts`）把它当重试安全，超时/掉线时报 `not_started` 而不是 `unknown`。

## 关闭标签页：每个 id 都要有去向

- `browser_tabs close` 收 `tabId`（一个）或 `tabIds`（一批）。一批在链路上是**一条命令**（扩展侧 `tabs.closeMany` → 一次 `chrome.tabs.remove([ids])`），不是 N 次往返中间掉线。
- 结果一律是 `{ requested, closed: [...], alreadyGone: [...], failed: [{tabId, error}] }`，**单数与批量同一个形状**，模型只需要学一种结果。以前的 `for (id of ids) await tabs.close(id)` 在第一个失败就抛出，会把已经真的关掉的标签藏起来 —— 模型于是以为什么都没发生，重放整批。
- **`alreadyGone` 是幂等成功，不是错误**：关一个已经不在的标签 = 目标已达成，直接重试是安全的。这条和 `src/errors.ts` 的 `effectState` 是同一件事的两半（那里管「失败该怎么报」，这里管「部分成功该怎么报」）。
- **不猜**：`chrome.tabs.remove` 之后逐个复查，「还在」的才进 `failed`；调用被拒但其中一个其实已经关掉，也会如实进 `closed`。
- 交给 Chrome 的只有「确认存在」的 id：真 Chrome 遇到无效 id 会拒绝**整批**，所以先自查存在性 —— 一个早已消失的标签不会连坐同批里还能关的标签。
- `verify/verify_tabs_close_many.mjs`：扩展侧 7 组场景（一次调用/数组形态、早已不存在、幂等重试、入参清洗、单数同形状、整批被拒、拒了但已关掉一个），宿主侧 5 条（分发到 `tabs.close` 还是 `tabs.closeMany`、重复 id 去重、结果过 schema、文本里读得到去向、缺参明确报错）。

## 模型可见内容契约

- 成功结果里，**模型看到的就是 `output.render(args, value)` 的返回值**（宿主实测：`@deepseek-ai/dsh-tools` `lib/index.js:3548-3551`，`content = snapshotProjection(render(...))`）。`value` 是 execution-local 的，"deliberately omitted from durable events"（`lib/types/index.d.ts:415`），`presentationMeta` 只喂 UI。**render 少写一个字段，模型就永远看不到那个字段。**
- 因此：`browser_read` 把页面正文放进 render（不再只报「N chars」），`browser_snapshot` 把 `[e13] button "Save"` 逐条列出来（不再只报「N interactive elements」），两条日志工具把条目本身列出来（不再只报计数）。
- 每类内容有自己的预算：页面正文每次 20 000 字符、快照列表 8 000、日志列表 6 000、其它 JSON 结果 4 000。
- 超预算时追加一行**机器可读**标记：`… [renderedTruncated omittedChars=N limitChars=L] narrow the query and call again to see the rest`。标记是在切片之后拼上去的，所以它一定活着。看到它的正确反应是缩小查询（`limit` / `pattern` / `urlPattern` / `offset`），不是假设页面就这么长。
- `browser_read` 用窗口读取：头部写 `chars 0-20000 of 43210; call again with offset=20000`，`value` 里带 `offset` / `totalChars`。**一次调用不会把整站灌进上下文**，长页面靠 `offset` 走。
- 日志列表的时间统一 UTC 秒（`HH:MM:SS`），`count < total` 时明说「只给了最新的 N 条」。`headers` / `responseHeaders` / `postData` 不进结果：它们到不了模型，只会把载荷变大。
- 封闭 `output.schema` 必须逐字段声明扩展真实回传的东西。宿主 `checkValue`（`lib/index.js:468-470`）对 `additionalProperties:false` 是**逐键判违规**，少声明一个字段等于这条工具每次调用都失败（`properties:{}` + `additionalProperties:false` = 任何键都违规——`browser_console_log` / `browser_network_log` 从 v1.0.7 到 v1.0.11 就一直栽在这)。
- **失败路径同理**：宿主把异常渲染成 `content` 时只取一句 `Error: ${message}`（`lib/index.js:3616-3623`），`code` / `effectState` / `hint` 只进 `error.info` 和 HTTP 面，**模型看不到**。所以 `BridgeError` 把这三件事写进 message 本身：`[command_timeout] browser command timed out after 800ms: click — effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态…不要直接重试。下一步：扩展超时未回应…`。写操作超时/在途掉线报 `unknown`，只读报 `not_started（重试安全）`——决定下一步的信息必须在模型读得到的那一行里。
- HTTP 面形状不跟着变长：`toJSON().error` 走新的 `detail` 字段（原始失败描述），`code` / `effectState` / `hint` 照旧各归其位，`hint` 不会在 `error` 里重复出现。`verify/verify_errors.mjs` 断言这两条。
- 宿主只对 `undefined` 放行，**对 `null` 会下钻判类型**（`checkValue` 的物体分支里是 `!hasOwn(value,key) || value[key] === void 0` 才跳过）。因此扩展回 `字段: null` 时，封闭 schema 这一侧必须把 null 剥掉或如实声明可用类型——`browser_emulate` 就是因为原样透传 `userAgent: null`（`background.js:719`，`desktop` 预设的 UA 是空串）从 v1.0.7 一路坏到 v1.0.13。审计台对 11 条封闭 schema 工具断言 `value` 里不得出现任何 null。
- 以上都由 `verify/verify_render_contract.mjs` 实测：真实 `BridgeServer` + 假扩展 + 宿主自己的 `validateJsonSchemaValue` 与 `valueSchemaSpecToJsonSchema`，逐条问「schema 过不过」「模型看到的文本里有没有这次调用真正要的数据」。**全部 20 条工具都在表里，不抽查**——因为抽查正是这两个缺陷活了 12 个 / 5 个版本的原因。

## 本地硬锁（扩展弹窗的「锁定」）

用户在扩展弹窗里单击「锁定」后，本机进入冻结状态，契约如下：

| 维度 | 行为 |
|---|---|
| 连接 | **保持**。WebSocket 不断、心跳照发，`hello` 照常上报；调用方看到的是「连得上但被冻结」 |
| 命令 | **全部拒绝**，包括只读命令（`content` / `snapshot` / `screenshot` / `tabs.list`……）。拒绝发生在 `runCommand` 的入口，任何 handler 都不会被调用，也就是**零 CDP 调用、零标签页改动** |
| 错误文案 | 点名被拦的命令，并写明「解锁只能由用户在浏览器工具栏的扩展弹窗里点『已锁定』完成」与「不要重试」 |
| 解锁通道 | 只有扩展弹窗的 `chrome.runtime` 消息（`lockSet`）。桥接侧没有解锁命令；`lockSet` 不在扩展的 `COMMANDS` 表里，所以模型塞一条同名命令帧只会被当作普通命令拦下 |
| 持久化 | 状态落在 `chrome.storage.local.hardLock`。MV3 回收 service worker 后重新读盘，**不会**因为内存标志丢失而解冻 |
| 徽标 | 冻结期间显示红色 `LOCK`；恢复后按连接状态显示 `ON` / `…` / `OFF` |
| 协议 | 不动 `PROTOCOL_VERSION`：冻结是本机开关，不是帧契约的一部分 |

之所以放在客户端而不是桥接侧：桥的唯一实际边界是回环地址 + token，而 token 明写在 profile 的
`cordis.patch.yml` 里——模型读得到、也改得动，还能重启桥。把「冻结」放进浏览器、只留一个人工通道，
才是模型够不到的那一层。
