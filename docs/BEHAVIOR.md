# 行为契约（Behavior Contract）

Agent 和上层脚本可以依赖的确定性语义。违反这些契约视为 bug。

## 窗口几何不可侵犯

- 自动化**绝不**修改窗口尺寸、位置或状态（最大化/还原/最小化一律不动）。真实输入所需的窗口聚焦（`focused: true`）与标签页激活不改变任何几何属性。
- 浏览器窗口处于**最小化**状态时，视口为 0×0，真实键鼠事件无法送达。此时 `type` 模式 / `press` / `click` 返回结构化错误 `window_minimized`，并指向 `browser_windows` 的恢复出口（`focused:true` 还原不压扁）——输入路径绝不自己改窗口。
- `fill` 模式、`eval`、`content`、`wait` 不需要窗口前台，最小化下照常工作。

## 自动等待

- `browser_navigate` 的「到达」按 `waitUntil` 四档判定：`load`（默认，等整页 load 事件，预算 15s）、`domcontentloaded`（DOM 解析完即回，预算 4s——异步组件可能还没挂上，缺元素时接 `browser_wait`）、`commit`（新文档地址落地即回，预算 4s）、`none`（不等待不判定，立即返回，附 `pendingUrl` 说明去向；此刻连错误页探针都不跑——评估的还是旧文档）。显式 `timeoutMs` 永远优先（钳制 [100,120000]）。
- **到达是事件判定的**：`Page.frameNavigated`（仅主框架）= 提交、`Page.domContentEventFired` / `Page.loadEventFired` = 相应时点。**「地址变了」不能当判据**——同站往返（www.bing.com → cn.bing.com → 回原地址）会让「变了」永远为假，只能干等满预算；事件没有这个盲区。dcl/load 事件必须发生在已认领的 commit 之后才算数（旧文档迟到的 load 不是新文档完成）；`tabs.open` 先把标签生在 about:blank、attach 完成后再发起真正的导航（否则快页的 commit 事件在 attach 前就没了），出生那次提交发生在发起标志置真之前，冒领不了。
- 轮询兜底只兜事件看不见的两种情况：**压根不会提交**的导航（链接变成下载、目标被 Chrome 拒载——宽限 1.2s 后拿标签**真正落到的 URL** 与请求的目标比对（忽略 hash 片段与末尾斜杠），不等就报 `loadPending`，不许 0ms 伪装成成功）；和本来就停在目的地的同文档跳转（hash 变化走 `navigatedWithinDocument` 事件，以 sameDocument 到达）。**导航到已经开着的那个地址**仍然算成功（不误报）。
- 预算耗尽时结果带 `loadPending: true` 与 `pendingUrl`，文案会说「仍在加载」而不是「已显示」，模型不该把没落地的导航当成功；回执 `waitUntil` / `waitedMs` / `readyState` 如实回报（探测失败就不带 readyState——宁可少说也不猜）。
- **等待结束后的探针也吃同一条死线**（#21）：`location.href`、错误页正文、`readyState` 共享导航预算，等待已用完预算时直接跳过（缺 `readyState` 是诚实的），不再各自加 2s 越过桥的 `budget + 2s` 余量、把准备好的 `loadPending` 换成 `command_timeout/unknown`。`tabs.open` 的 `readyState` 同理。实测：`verify_nav_headroom.mjs`。
- `tabs.open` 走**同一份**到达等待器；旧开关 `wait:false` 等价 `waitUntil:'none'`。等待期间 debugger 会附着到该标签（「正受控制」横幅出现）——事件判定的代价，`none` 档不附着。
- **不保证** SPA 路由或懒渲染内容就绪——导航返回后再用 `browser_wait` 显式等目标元素。实测台：`verify/verify_nav_landing.mjs`（落地诚实性）+ `verify/verify_nav_waituntil.mjs`（分档/事件/回执）。
- `browser_wait` 的 `fn` 参数是**在页面里执行任意 JS**，因此按脚本调用管：`allowScript:false` 拒，`readOnly:true` 时也拒（只放行 `selector` / `text` 两种纯查询）。失败分类同样按写调用对待：超时/取消报 `effectState=unknown`（谓词可能已经跑过），而不是「重试安全」。扩展侧的轮询条件由 `(fn)()` 求值，函数与裸布尔表达式都接受。

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

- **窗口控制（`browser_windows`）**：窗口几何与状态的改变**只**发生在这个工具里——其它一切工具（含输入路径）只聚焦、永不缩放，用户看到的每一次窗口变化都对应一次显式调用。`list` 读清单（几何/状态/tabIds，只读白名单）；`open`/`update`/`close`/`moveTab` 改窗口。
- `open` 是唯一**非幂等**动作：超时/掉线报 unknown（重试可能开出第二个窗口），出口是先 `action:"list"` 对账再决定。`update`/`close`/`moveTab` 幂等（重设同一几何是空操作、关已关的窗报 `alreadyGone`、挪到同一位置是空操作）⇒ 算读；但它们改浏览器状态，只读档照拒，只有 `list` 放行。
- `update` 的回执带 Chrome 给出的**实际**结果：超界几何会被钳到屏幕，请求值不是回执。`focused:true` 对最小化窗口是「还原到最小化前状态」，不会把最大化窗口压成小窗（`state:"normal"` 会）。`close` 关整窗（所有标签一起走）：关前问一次在不在、关后复查一次真的没了。实测台：`verify/verify_windows.mjs`。

- 视口截图坐标为 CSS 像素；元素截图用 CDP `clip`，DPR 由 Chrome 内部处理，无需外部换算。**截图回执带真实像素尺寸**（v1.7.0 起：从 PNG IHDR 解出，不是猜的——fullPage 一张能有三五个视口高，光看字节数分不出来）；`selector` 只截一个元素，回执带元素 rect。`fullPage` 截整个可滚动页（sticky/fixed 元素可能重复出现）。
- **整页存档（`browser_archive`）**：`Page.captureSnapshot(MHTML)`，正文/图片/样式全内联成单文件，扩展回原始载荷、插件写 `.mhtml`（`path` 可指定绝对路径，否则落 shotsDir，与 pdf/screenshot 同约定）。**它是快照，不是活页**：内嵌脚本不会运行、存档之后的页面变化不反映；可以当文本 grep。只读档拒绝（写本地文件，与 pdf/screenshot 同类）。实测台：`verify/verify_archive.mjs`。
- 点击结果包含实际命中点 `clicked.x/y` 与 `hitVerified`（命中元素是否等于目标元素）。`hitVerified: false` 时附 `hitInstead` 字段指明实际命中的元素——典型场景是 sticky 头部/广告遮挡。
- **历史导航（`browser_tabs action:"back"/"forward"`，v1.7.0）**：目的地从 `Page.getNavigationHistory` **读**出来，不猜——到达判据与 navigate 同一套（`frameNavigated` 提交 + dcl/load 在认领之后才算 + 1.2s 宽限期比落点）。三种「没动」分得清楚：历史尽头当场回 `unchanged:true` + 原因（什么都不发射，不浪费预算）；历史读不到时退化成「任何提交都算」并标 `historyUnknown:true`；预算耗尽报 `loadPending:true`。回执带 `targetUrl`（这次去的是哪条）。**重试会多跳一条历史** ⇒ 写命令（与 nav 同族），只读档拒；接管浮层中止态同样拦（`HOLD_BLOCKED_COMMANDS`）。实测台：`verify/verify_history_nav.mjs`。
- **弱网 / CPU 限速（`browser_emulate` 的 `network` / `cpuThrottlingRate`，v1.7.1）**：`network` 预设 slow3g（400ms RTT，双向 ~50KB/s）/ fast3g（150ms，~200KB/s 下 / ~94KB/s 上）/ offline / reset——数值是本工具自己定的（对齐 DevTools/Lighthouse 数量级，不冒充其同名预设），写进工具描述。`cpuThrottlingRate` 1–20（1 = 不限）。**回执报生效数值**（latency/吞吐/倍率），render 也写——模型只看那句话。节流挂在 debugger 会话上：扩展 detach 即失效；`device:"reset"` 是「全部还原」，连节流一起清（只清设备形状会让模型以为回到了真实环境）。emulate 整体仍是写命令（节流改页面加载行为）。
- **性能指标（`browser_metrics`，v1.7.1）**：`Performance.getMetrics`，只读（重试只是再读一遍计数器），进只读白名单。指标名是 CDP 固定那批，扩展**只透传已知名字**（CDP 新增指标不会打穿封闭 schema），回空如实报错。回执与 render 带数字本身（nodes / heap（MB）/ layouts / script / tasks）。实测台：`verify/verify_metrics_throttle.mjs`。

## 超时

- 所有涉及页面交互的命令接受 `timeoutMs`（毫秒）：`browser_navigate` 预算按 `waitUntil` 档位（load 15000 / commit·domcontentloaded 4000 / none 0），显式值优先、上限 120000（桥侧另加 2s 余量，保证「导航超时」先于「桥超时」发生——前者没动过页面，后者结果未知，处置不同），wait 默认 15000 上限 120000（桥侧余量 10s），evaluate 默认 60000、显式上限 120000（桥侧余量 2s；不传时由桥接默认 60s 兜底，桥接层硬上限 300000）；`tabs.open` 的预算同 `browser_navigate` 档位，在同一份等待器里生效。

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
- **截断不许切半个代理对**（issue #26）：页面文本/render 文本按码元 `slice` 会留下孤立代理项，`JSON.stringify` 后是裸 `\ud83d`，模型的 JSON 解析器会拒收**整个请求体**，坏字符还会随会话历史每轮重放。插件侧所有截断走 `sliceWellFormed`（切点落高位代理项时退一格），`defineTool` 包装层再把每条 render 文本与错误文本修成 well-formed（兜住页面自带的坏字符，U+FFFD）；扩展侧页面截断用注入的 `pageClipWellFormed`。实测：`verify_text_safety.mjs`。
- `browser_read` 用窗口读取：头部写 `chars 0-20000 of 43210; call again with offset=20000`，`value` 里带 `offset` / `totalChars`。**一次调用不会把整站灌进上下文**，长页面靠 `offset` 走。
- 日志列表的时间统一 UTC 秒（`HH:MM:SS`），`count < total` 时明说「只给了最新的 N 条」。`headers` / `responseHeaders` / `postData` 不进结果：它们到不了模型，只会把载荷变大。
- 封闭 `output.schema` 必须逐字段声明扩展真实回传的东西。宿主 `checkValue`（`lib/index.js:468-470`）对 `additionalProperties:false` 是**逐键判违规**，少声明一个字段等于这条工具每次调用都失败（`properties:{}` + `additionalProperties:false` = 任何键都违规——`browser_console_log` / `browser_network_log` 从 v1.0.7 到 v1.0.11 就一直栽在这)。
- **失败路径同理**：宿主把异常渲染成 `content` 时只取一句 `Error: ${message}`（`lib/index.js:3616-3623`），`code` / `effectState` / `hint` 只进 `error.info` 和 HTTP 面，**模型看不到**。所以 `BridgeError` 把这三件事写进 message 本身：`[command_timeout] browser command timed out after 800ms: click — effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态…不要直接重试。下一步：扩展超时未回应…`。写操作超时/在途掉线报 `unknown`，只读报 `not_started（重试安全）`——决定下一步的信息必须在模型读得到的那一行里。
- HTTP 面形状不跟着变长：`toJSON().error` 走新的 `detail` 字段（原始失败描述），`code` / `effectState` / `hint` 照旧各归其位，`hint` 不会在 `error` 里重复出现。`verify/verify_errors.mjs` 断言这两条。
- 宿主只对 `undefined` 放行，**对 `null` 会下钻判类型**（`checkValue` 的物体分支里是 `!hasOwn(value,key) || value[key] === void 0` 才跳过）。因此扩展回 `字段: null` 时，封闭 schema 这一侧必须把 null 剥掉或如实声明可用类型——`browser_emulate` 就是因为原样透传 `userAgent: null`（`background.js:719`，`desktop` 预设的 UA 是空串）从 v1.0.7 一路坏到 v1.0.13。审计台对 11 条封闭 schema 工具断言 `value` 里不得出现任何 null。
- 以上都由 `verify/verify_render_contract.mjs` 实测：真实 `BridgeServer` + 假扩展 + 宿主自己的 `validateJsonSchemaValue` 与 `valueSchemaSpecToJsonSchema`，逐条问「schema 过不过」「模型看到的文本里有没有这次调用真正要的数据」。**全部 20 条工具都在表里，不抽查**——因为抽查正是这两个缺陷活了 12 个 / 5 个版本的原因。

## 接管浮层（`browser_hold`）

在某个标签页上加一层可撤销的浮层：页面变暗、中间一张卡片写明模型在做什么，用户双击页面任意处
（或连按两下 Esc、或按住 Esc 约 0.6 秒）就能关掉。**它是软层，不是安全边界** —— 桥的 token 模型
读得到也改得动，所以任何长在插件侧/扩展侧的开关都只是策略；真正能冻住浏览器的只有弹窗里的本地锁。

| 维度 | 行为 |
|---|---|
| 命令 | 扩展 `COMMANDS` 里只有一条 `hold`，参数 `action: 'on' \| 'off' \| 'status'`；工具面是 `browser_hold`，参数 `action` / `note` / `tabId` |
| 标题 | **由扩展写死**（`DSH Browser Control`）。调用方只能提供 `note`（正文），且正文压平换行、截到 400 字符 —— 否则模型能写一句系统口吻的话冒充提示 |
| 状态 | 放 `chrome.storage.session`、按 `tabId` 记。活过 service worker 回收（MV3 会回收 worker，内存标志 30 秒就丢——那正是浮层「以为挡着、其实没挡」的失败方式），不落盘，浏览器关掉即清。页面里另留一份只读的 `window.__dshHold`（谁撤的、什么时候撤的），**不参与决策** |
| 关掉浮层 | 双击任意处 / 连按两下 Esc / 按住 Esc ≈0.6 秒。这是**接管**，不是中止：模型照常可以继续操作这一页 |
| 中止 | 卡片上的「中止模型操作」要两次点击确认（点一次变「再点一次确认」，3 秒不点还原）。中止之后 `click` / `input` / `press` / `nav` 被扩展在 `runCommand` 入口拒绝，**零 CDP 调用**；模型要恢复得先与用户确认，再调 `browser_hold action=off`（这一步等于确认继续）。**中止期间 `hold on` 也会被拒**——否则模型有一条不询问用户就能继续的旁路：被拦一次 → 再挂一层（旧实现会顺手把中止清掉）→ 照常点 |
| 模型自己的点击 | 浮层是全屏的，坐标派发本来会先命中它：模型一挂浮层，自己的 `click` 就全部落在浮层上（页面什么都没发生，结果还只轻描淡写一句 `hitVerified:false`），而且同一坐标连点两下会被浮层当成「双击」、以用户的名义关掉。所以 `click` 命中到的是**自己这层浮层**时，扩展临时把宿主设成 `pointer-events:none`、重测命中点、派发完再恢复；结果里带 `bypassedOwnOverlay:true`。它挡的是人，不是模型 |
| 模型看到的错误 | 结果帧只有一个 `error` 字符串，所以扩展在文本最前面写 `browser-hold-aborted:`，`classify()` 认前缀 ⇒ `code=held_by_user`、`effectState=not_started`（拦截在 handler 之前，这是可以确定的真相），标记从给模型的那句话里剥掉。两边字面量由 `verify_errors` 对账 |
| 页面换了就没了 | 导航/刷新会把浮层带走。此时命令直接放行，并把存储里那条顺手清掉，`status` 如实报 `active:false` —— 不许假装还挡着 |
| 覆盖范围 | **可观测的失败**：盖不住时 `browser_hold` 回 `covered:false` 且带 `reason`（`error-page` / `browser-page` / `devtools` / `inject-failed`）。已知盖不住的有：严格 CSP、全屏、跨源 iframe、PDF 阅读器、原生弹窗挡在上面 —— 这些时候状态里能看出来，而不是只在文档里认怂 |
| 只读档 | `readOnly: true` 时 `hold` 的 `on` / `off` 被拒（往页面里插/删宿主元素 = 改页面 DOM），拒因专门写清这一点；**`action=status` 放行**——它只读状态（session 条目 + 探一下页面上那层还在不在），只读档不该连看一眼都不让。闸门因此按**动作**判，不只按命令名 |
| 观察面 | 浮层是**注入物**，所以 `content`（含 html 模式）/ `find` / `snapshot`（DOM 与 **AX** 两种模式）都排除带 `data-dsh-hold` 的子树；AX 模式下它不占 ref、也不计入 `total`。`verify_hold` / `verify_snapshot_ax` 两向断言（浮层文字与「中止模型操作」按钮不出现在模型可见文本里 + 页面上同名 class 的正常元素不被误伤） |
| 失败分类 | `hold` 算写操作：超时/在途掉线报 `unknown`（重试可能多留一层），不许报「没动到页面，重试安全」 |

## Cookie（`browser_cookies`，凭据面）

| 维度 | 行为 |
|---|---|
| 命令 | 三条：`cookies.get` / `cookies.set` / `cookies.remove`。拆三条而不是一条带 `action`，是因为写/读分类与只读闸门都按命令名判——三条各有名字，对账台才盯得住 |
| get | `Network.getCookies(urls:[tab.url])`：只回这一页可见域的 cookie（`count === total`）；`domain` 参数做子串过滤、大小写不敏感。**值原样进模型可见文本**——这是工具的定义（复制登录态靠它），不是副作用；cookie 值 = 凭据，见 SECURITY.md |
| set | 需要 `url` 或 `domain` 锚点（都缺直接报错，一次 CDP 都不发）；`sameSite` 只收 Strict/Lax/None；`expires` 是 Unix 秒、省略即会话 cookie。浏览器拒绝（`success:false`）时如实报错并给常见原因，不假装成功 |
| remove | CDP 的 deleteCookies 不回执删没删到：按同一片可见范围复查一次，`remaining` 如实报（>0 时 `left` 列出还剩哪颗在哪个域）；复查失败报 `remainingChecked:false`，不假装删干净 |
| effectState | set/remove 都是幂等的（重设同一颗、重复删同一颗，结果不变），按「重试会不会造成额外损害」的判据算只读；但它们**改浏览器状态**，只读档拒——两张表各管各的语义 |
| 只读档 | `cookies.get` 放行；`set` / `remove` 默认拒（不在白名单里，拒因走通用文案） |

## 本地硬锁（扩展弹窗的「锁定」）

用户在扩展弹窗里单击「锁定」后，本机进入冻结状态，契约如下：

| 维度 | 行为 |
|---|---|
| 连接 | **保持**。WebSocket 不断、心跳照发，`hello` 照常上报；调用方看到的是「连得上但被冻结」 |
| 命令 | **全部拒绝**，包括只读命令（`content` / `snapshot` / `screenshot` / `tabs.list`……）。拒绝发生在 `runCommand` 的入口，任何 handler 都不会被调用，也就是**零 CDP 调用、零标签页改动** |
| 错误文案 | 点名被拦的命令，并写明「解锁只能由用户在浏览器工具栏的扩展弹窗里点『已锁定』完成」与「不要重试」 |
| 解锁通道 | 只有扩展弹窗的 `chrome.runtime` 消息（`lockSet`）。桥接侧没有解锁命令；`lockSet` 不在扩展的 `COMMANDS` 表里，所以模型塞一条同名命令帧只会被当作普通命令拦下 |
| 持久化 | 状态落在 `chrome.storage.local.hardLock`。MV3 回收 service worker 后重新读盘，**不会**因为内存标志丢失而解冻 |
| 读盘失败 | **按锁定处理**（fail-closed）。panic switch 唯一不能有的失败方式是「以为锁着其实没锁」，所以读不出状态时宁可拒绝；此时拒绝文案与 `bridgeStatus.lockReason` 都写「读不出锁状态」而不是「已被用户锁定」，不冤枉用户，也不误导模型。下一次调用会重读，存储恢复后自动放行。用户仍能从弹窗解锁——那条通道走内存里的 `setHardLock`，不依赖这次失败的读 |
| 徽标 | 冻结期间显示红色 `LOCK`；恢复后按连接状态显示 `ON` / `…` / `OFF`。`init()` 会**先读锁再连接**，所以 service worker 刚唤醒、一条命令都还没跑的时候图标就是 `LOCK`，而不是让人误判健康的绿色 `ON` |
| 模型看到的错误 | 结果帧只有一个 `error` 字符串可以带信息，所以扩展把 `browser-locked-by-user:` / `browser-lock-unreadable:` 写在文本最前面，`classify()` 认前缀：`code=locked_by_user` 或 `lock_unreadable`，`effectState=not_started`（**写操作也是**，因为拦截发生在 handler 之前，这是可以确定的真相），标记本身从给模型的那句话里剥掉。认不出前缀就退成 `command_failed` + 写操作 `unknown` + 「通常是选择器没命中」那种误导 hint，所以 `verify_errors` 对账两侧字面量逐字一致 |
| 协议 | 不动 `PROTOCOL_VERSION`：冻结是本机开关，不是帧契约的一部分。老扩展不会发这两个前缀，因此不存在「静默降级读不到」的版本错位——它压根没有锁 |

之所以放在客户端而不是桥接侧：桥的唯一实际边界是回环地址 + token，而 token 明写在 profile 的
`cordis.patch.yml` 里——模型读得到、也改得动，还能重启桥。把「冻结」放进浏览器、只留一个人工通道，
才是模型够不到的那一层。

## 拖拽（`browser_drag`，v1.7.3）

纯插件实现：没有新扩展命令，全部经 v1.7.2 预埋的 `cdp` 通道驱动——这也是「扩展一次交付」之后的第一个纯插件特性。

| 维度 | 行为 |
|---|---|
| mouse 模式 | 真实输入序列：悬停源中心 → 左键按下（buttons=1）→ N 步线性插值移动（全程按住）→ 靶中心抬起 → 落定移动。滑杆、画布、SortableJS 这类按指针事件工作的组件用它 |
| html5 模式 | 在页面里合成浏览器顺序的事件：dragstart(源) → dragenter/dragover(靶) → drop(靶) → dragend(源)，共用一个 DataTransfer。**drop 只在 dragover 被 preventDefault 时派发**（浏览器规则）；dragstart 被页面取消就整场不拖。回执分别报 `startCancelled` / `overPrevented` / `dropFired` / `dropPrevented`，不装成功。合成事件是 untrusted——页面若检查 `isTrusted` 会忽略，工具描述里写明 |
| auto | 源元素带 `draggable="true"` → html5，否则 mouse。检测走 CDP `DOM.getAttributes`，不执行页面 JS |
| 端点 | 选择器（仅顶层文档）或视口坐标；选择器端点先 `DOM.scrollIntoViewIfNeeded` 再 `DOM.getBoxModel` 取中心，全程零页面 JS ⇒ `allowScript:false` 下 mouse 模式照常可用 |
| 滚动后的坐标 | 目标端点也会 `scrollIntoViewIfNeeded`，可能把源滚出视口。两端都是选择器时，派发前按当前几何**重测**两端（`DOM.getBoxModel` 不滚动）；只要有一端不在 CSS 视口内就拒绝并说明（不盲发一组越界/过期坐标） |
| 会话 | 省略 `tabId` 时与其它工具一致：用**本会话的工作标签页**（先核验还开着），不是浏览器的活动页；回执里的 `tabId` 是实际落点 |
| 失败清扫 | `mousePressed` 之后任何一步失败（取消/超时/CDP 报错）都会尽力补发一次 `mouseReleased`（独立信号），页面不会停在「左键按住」状态；原始错误照常抛出 |
| 分类 | 改页面状态 ⇒ 写命令族；只读档工具级拒绝；hold 中止态经 `cdp` 被拦；html5 需要页面脚本，`allowScript:false` 时给「改用 mouse」的指引 |
| 缺扩展 | `requireExtensionCommand('cdp','1.7.2')` 预检：老扩展拿到 extension-outdated + 重装指引，绝不裸 unknown command |

## 操作审计（`browser_audit`，v1.7.4）

插件这一侧的**命令层**账本，回答「刚才谁动了这个页面」。纯本地（不碰扩展），是后面「会话恢复」的地基。

| 维度 | 行为 |
|---|---|
| 记什么 | 每条经 `controller.execute()` 的命令：seq / 时间 / 命令名 / tabId / 参数摘要 / ok / code / effectState / 失败描述 / 耗时。**成功、失败、被策略拒绝、被旧扩展闸门预检拒绝，全都上账**；`browser_cleanup` 这种不走 execute() 的本地命令自己记账。模型看不到的内部重试与 browser_drag 一次拖拽打出的 N 次 cdp 往返都在账上，不美化 |
| 脱敏 | `input` 的 value（往页面里打的字，可能是密码）与 `cookies.set` 的 value 一律 `[redacted:N chars]`；token/authorization/password/secret/apikey/cookie 这些键的值打码；**URL 的查询值一律打码**（保留 scheme/host/path 与参数名；`#/inbox` 这类路由片段保留，含 `=` 或 token 字样的片段整体打码）；**错误文本里的 URL 同样按此规则打码**——截断不是脱敏；eval 表达式只留前 120 字符；单条摘要限 300 字符 |
| 边界 | 内存环形缓冲 **200 条**，dsh 重启即清（持久化是「会话恢复」那一版的事）；seq 不回收——分页时中间缺号本身就是「被挤掉了」的机器可读信号 |
| 查询 | `browser_audit`：按 tabId / 命令子串 / sinceSeq 过滤，limit 1–200（默认 50，取最新）。纯本地读 ⇒ **只读档下照常可用**；它自己不给自己上账 |
| 落盘状态 | 回执带 `journal: {enabled, error?}`：`enabled:false` 表示本次 journal 打不开（默认状态或坏 `stateDir`），账本只在内存里；render 末尾追加 `Journal write: disabled — … this run is memory-only`。降级不再只藏在一行日志里 |
| 与信任层的关系 | 审计不是安全边界，是事后可查；冻结/锁定/策略的**执行**仍在原处，审计只保证「做过什么有账」 |

## 会话恢复（`browser_journal`，v1.7.5）

审计账本落盘，dsh 重启后还查得到上一个会话做过什么。纯本地（扩展离线也能查），是「重启后我在哪个标签页干活」的恢复入口。

| 维度 | 行为 |
|---|---|
| 存哪 | `<stateDir>/journal.jsonl`，一条命令一行 JSON；`stateDir` 默认 `~/.dsh-browser-control`（与 dsh 的启动目录无关），可在 profile 的 browser-bridge 配置里改 |
| 写什么 | 与 `browser_audit` 同一条目（同一套脱敏：输入值/cookie 值打码、令牌类键打码、URL 查询值与敏感片段打码、错误文本里的 URL 打码、eval 表达式截断、摘要 300 字符）+ `run`（本次插件启动时刻，跨运行分组靠它）。写盘是排队异步追加，**写失败不阻塞命令**，只告警一次 |
| 上限 | 1000 行，**启动时**裁掉最旧的（运行中纯追加）；坏行（截断/手改坏）读到就跳过，一本账不会因一行烂掉全废 |
| 查询 | `browser_journal`：按 tabId / 命令子串过滤，limit 1–500（默认 50，取最新），按 run 分组显示；纯本地读 ⇒ 只读档可用。回执同样带 `journal: {enabled, error?}`——false 时看到的是**更早运行**留下的账，本次命令只进了内存 |
| 与 audit 的分工 | `browser_audit` = **本次运行**的内存账本；`browser_journal` = **跨运行**的磁盘账本。两者内容同源（同一条记录同时进内存与磁盘），查询口径不同 |

## 多 session 隔离（`browser_sessions`，v1.7.6）

同一个插件实例、同一个浏览器可能同时被多个 dsh 会话驱动。以前省略 `tabId` 的调用都落到浏览器**活动标签页**——谁切了页谁就抢走别人的上下文。这一版给每个 agent 记住自己的工作标签页：

| 维度 | 行为 |
|---|---|
| 会话身份 | 取自工具执行上下文里的 `exec.agent.id`（宿主注入）。没有身份的调用（HTTP 面、老宿主、测试）**完全维持旧行为**，不登记、不注入 |
| 默认解析 | 省略 `tabId` 且命令是页面/标签相关的 ⇒ 先在 `tabs.list` 里核验本会话的工作标签页还开着，再注入；命令显式给的 tabId 永远优先 |
| 回退 | 工作标签页被关掉 ⇒ 忘掉它、退回活动页（不注入），拿到结果后把活动页改记为自己的新工作页——**绝不因陈旧 id 让原本能用的调用失败** |
| 收养 | 命令结果的 `tabId`（nav / screenshot / tabs.open …）自动记为该会话的工作页；`tabs.list` 这类结构性命令不参与注入也不收养 |
| 边界 | 这是**建议性隔离**，不是所有权锁：跨会话看同一页显式传 tabId 即可，无需解锁。硬性归属（borrow/return + 用户仲裁）留给扩展侧那一版 |
| 查询 | `browser_sessions` list 列出全部会话（最近活跃在前）与工作标签页、调用数；release 清掉自己的。纯本地 ⇒ 只读档可用 |

## 快照分页（`browser_snapshot`，v1.7.7）

大页面元素多，一条快照塞不进模型预算。分页在**插件侧**完成——扩展的快照命令一直没有 offset 参数，但回执里一直带 `total`：

| 维度 | 行为 |
|---|---|
| 窗口 | 每次向扩展要最大窗口（200 条），插件按 `offset`/`limit` 切片；`limit` 默认 120、上限 200，`offset` 负数归零 |
| 回执 | `offset`（本次起点）、`total`（页面可操作元素总数，扩展报什么记什么）、`returned`（窗口里实际有多少条）、`nextOffset`（窗口内还有下一批时才给）、`hasMore` |
| 页面窗口上限 | `total > returned` 表示页面比扩展给的窗口大：页头如实写「this extension returns at most N-item windows」并指向 `browser_find`/`browser_read`；不假装分页能翻到底 |
| 越界 | `offset` 越过窗口：空页、不报错，页头点名 offset；窗口耗尽时不再给 `nextOffset`（避免模型原地打转） |
| ref 的作用域 | ref 是**本次调用**的快照编号：翻页拿到的 ref 直接用于 click/type 有效；两次调用之间页面变了，旧 ref 可能失效——要稳定引用就一次调用里拿到再操作 |
| total 缺失 | 更老的扩展不报 `total` ⇒ 回执省略该字段，页头写「N available」，不编造页总数 |

## 兼容契约（插件升级 × 旧扩展）

铁律：**dsh 插件 x + 扩展 x-n 的体验 ≥ dsh 插件 x-n + 扩展 x-n**——升级插件永远不许比「那个年代的配套组合」差，逐条功能比。实现与验证：

| 维度 | 行为 |
|---|---|
| capabilities 握手 | v1.7.2+ 扩展的 hello 帧带 `capabilities`（扩展 `COMMANDS` 表的键列表）。桥原样收下，插件按这份清单**精确**判断「这条命令扩展有没有」 |
| 版本映射兜底 | 老扩展的 hello 不带 capabilities ⇒ 插件按 `EXTENSION_COMMANDS_BY_VERSION`（1.5.0 起的逐版命令增量）从报上来的版本推算命令面。不在表里的命令按基线假定在场；比所有条目都新的版本假定什么都有。方向性依据：扩展从不删命令（矩阵台的 append-only 断言守着），乐观放行只会撞上真实的 unknown command，不会冤枉好命令 |
| extension_outdated | 插件比扩展新时，9 条闸门（`requireExtensionCommand`）在命令发出**之前**拦下：`code=extension_outdated`，点名缺的命令、引入版本、以及一条可执行的重装指引（releases/latest → 解压 → chrome://extensions 替换旧目录）。绝不发出去吃裸 `unknown command`，更不静默假成功 |
| 矩阵台 | `verify_compat_matrix.mjs` 从 git 标签物化**真实的历史扩展代码**（v1.2.0 / 1.5.0 / 1.6.0 / 1.7.0 / 1.7.1），当前插件对每面跑 27 个探针：旧工具照常工作（≥ 当年组合）、新工具必须报带指引的 outdated、错误里绝不允许 unknown command 冒充契约性失败、命令面 append-only。老 hello 无 capabilities ⇒ 版本映射兜底路径的实测也在这张台上 |
| 扩展预埋 `cdp` | 1.7.2 起扩展带一条 `cdp` 透传（`Domain.method` 直达 CDP，**不进模型工具面**）。这是「以后只更插件」的机械基础：插件侧新功能经这条预埋通道驱动扩展里已有的 CDP 会话；CDP 层的新能力（拖拽 / mock / iframe / screencast……）从此只发插件。走 `cdp` 的新功能对老扩展（<1.7.2）同样被闸门拦下并给重装指引 |
