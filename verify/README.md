# 实测台（verify/）

仓库里没有单测框架，这一批脚本就是「改完到底有没有修好」的唯一依据。每条 issue 的结论都来自它们的实际输出，不是读代码读出来的推断。

跑法：

```bash
npm run verify        # 依次跑完下面全部
node verify/verify_plugin.mjs new     # 单独跑一个
```

前提：`127.0.0.1:9777`、`9778`（错误契约）、`9779`（扩展端到端）、`9791`–`9795`（兼容矩阵，一个历史面一个端口）空闲（脚本会真的占用这些端口）；`verify_compat_matrix.mjs` 还需要在 git 仓库里跑（它用 `git show <tag>` 物化历史扩展代码），依赖已 `npm install`。`verify_tab_groups.mjs` 与 `verify_extension_e2e.mjs` 共用 `verify/ext_harness.mjs`（假 Chrome 的那台内存浏览器）。

| 脚本 | 证明什么 | 关联 |
|---|---|---|
| `verify_config_patch.mjs` | `Config({enabled:false})` 得到的是 `false`——即包内 `cordis.patch.yml` 的显式值压过 v1.0.6 的 schema 默认 `true`，这就是「装上后 9777 无人监听」的根因 | #4 |
| `verify_peers.mjs` | 用**宿主自己用的那个 semver**把同一条 peer 范围的两个读者各跑一遍：包管理器视角（默认语义——本地装的版本必须满足对外声明，且涉及预发布时必须有精确支当锚点）与宿主门禁视角（`includePrerelease:true`，拿 0.1.2-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 四代宿主版本逐个试），外加宿主包只能是 peer、产物裸 import 全有交代、`engines` 必须不存在。v1.0.8 那条宽范围在前者只解析到 0.1.0-rc.8、在后者全绿，就是这个台把它暴露出来的 | #13 |
| `verify_plugin.mjs [legacy\|conflict\|new]` | 用假 cordis 上下文跑真 `apply()`，三种宿主形状（有 `register` / `register` 抛错 / 根本没有 `register`）下都必须「回调不抛、端口监听、工具全部注册」；legacy 模式还额外回归「改 `enabled` 能实时关/开端口」 | #8、#4 |
| `verify_surface.mjs` | 四方对账：扩展 `COMMANDS` 表 ↔ 插件 `controller.execute()` 实际调用的命令 ↔ 两份 README 的工具表 ↔ 构建产物 `lib/index.js`。防「扩展实现了但 agent 调不到」「文档吹了不存在的工具」「npm 包比源码少工具」三类复发 | v1.0.7 11/16、`browser_wait` |
| `verify_tab_groups.mjs` | 在 node:vm 里加载扩展的 service worker，配一台**有状态**的假 `chrome.tabs`/`chrome.tabGroups`，断言建组 / 复用同组 / 退避重试（含「只多打一次」和「4 枪封顶」）/ 用户手动拆组后不往死 groupId 上塞 / 按标题找回 / 按窗口拆组 / 无权限降级，并直接检查 manifest 声明了 `tabGroups` | 标签可见化 |
| `verify_cdp_retry.mjs` | CDP 会话丢失护栏（跑真实扩展代码 + 有状态假 `chrome.debugger`）：S1 会话被 Chrome 抢走后能否恢复、S2 中途丢会话时一次 click 只派发 2 个鼠标事件（不许重放成 3 个）、S3 永久失败时重试有界（≤2 次）、S4 非会话类错误一律不重连重放、S5 单条 send 的读命令尝试次数有界、S6 假 debugger 的 `not attached` 文案与 tabId 要对得上。可传第二个参数换一份扩展代码来跑（评审外部补丁 / 合并预览），合并 PR #7 时把 `CDP_RETRY_FIXED=1` 一起加上，S1 会翻成「必须恢复」 | PR #7 / 重复派发 |
| `verify_snapshot_ax.mjs` | AX 语义快照：跑真实扩展代码，CDP 结果由假 debugger 供给，**扩展传进页面的那段 stamping 函数在另一个 vm 里真的被执行**（`this` 绑到假元素）。断言角色白名单过滤、ref 连续、隐形节点不占号也不写属性、AX 有节点而 DOM 没有时算 unresolved、`limit` 生效、取树前先清旧 ref、AX 域炸了降级回 DOM 并回报 `axFallback` | AX 快照 |
| `verify_nav_report.mjs`（PR #12 带进来的）| 用真 `BridgeServer` + 假扩展把 `browser_navigate` 的三种结果形状一路推到工具返回值与模型可见文案：正常落地不带新字段、`loadPending`/`pendingUrl` 到得了模型、`siteUnreachable` 的 `{reason}` 归一成 `true` | 导航诚实性 |
| `verify_press_events.mjs` | 真实 `background.js` + 有状态假 `chrome.debugger`，按**派发次数**测键盘：一次按键只许插入一次（issue #14 那个 `keyDown(text)+char` 双倍插入）、`Enter` 只提交一次、组合键解析、未知键名必须抛错且零派发。**第二个参数可以换一份 background.js 跑**——对修复前的版本，同一批断言红 12 项 | issue #14 键盘回归 |
| `verify_nav_landing.mjs` | 真实扩展代码 + 会演导航的假 `chrome.tabs`：正常加载 / 慢启动竞态（旧文档先 `complete` 400ms）/ 永不提交（必须报 `loadPending`，不许 0ms 或 1.2s 后假装成功）/ 导航到同一个地址仍算成功 / 新建标签出生在 `about:blank` 也要等到真 URL | PR #12 与其残留口子 |
| `verify_render_contract.mjs` | 真实 `BridgeServer` + 假扩展 + **宿主自己的** `validateJsonSchemaValue`/`valueSchemaSpecToJsonSchema`：把每条工具的真实返回值同时喂给它的输出 schema 与它的 `render`，逐条问「schema 过不过」「模型可见文本里有没有这次调用真正要的数据」「超预算时 [renderedTruncated] 的数字对不对」「封闭 schema 的 11 条工具里不许出现 null（宿主对 null 下钻判类型）」。**地面真相表铺满全部 20 条工具**（截图 / PDF / cleanup 用临时 `shotsDir`），共 126 项 | 模型可见内容契约 |
| `verify_hard_lock.mjs` | 本地硬锁（扩展弹窗「锁定」）：真实 `background.js` + 有状态假 `chrome.tabs`/`chrome.debugger`/`chrome.storage`，断言默认不锁、上锁后 `COMMANDS` **全部 26 条**逐条被拦且零 CDP 派发、拒绝文案点名命令并写明解锁只能由用户在弹窗里做、桥侧塞同名命令帧解不开、**service worker 重启后仍然锁着**（内存标志会丢，落盘的不会）、畸形消息 fail-closed、解锁后恢复执行；另核 popup.html/popup.js 的按钮位置与单击切换。可传第二个参数换一份 `background.js` 跑——对未修版本同一批断言红 16 项 | 本地硬锁 |
| `verify_hold.mjs` | 接管浮层（`hold`）：真 `background.js` + 假 `chrome.tabs/debugger/storage`，断言标题不可伪造、正文压平限长、状态落 `chrome.storage.session`（不落 local）、**真·service worker 重启后仍记得「中止着」**、中止后四条写命令零动作派发、页面导航后自动解除、`hold off` 恢复、错误页 `covered:false`、以及 `content`（含 html）/`find`/`snapshot` 对浮层子树的排除是**两向**的（不误伤同名 class）。覆盖不到的视觉/真页行为由 rig 验 | #17 |
| `verify_policy.mjs` | 本机策略闸门（`readOnly` / `allowScript`）：用假 cordis 上下文跑真 `apply()`，断言默认值不变、只读档下 7 个写工具全部 `blocked_by_policy`（零副作用）而 4 个读工具照常走到链路（报 `extension_offline`，证明闸门放行）、单独关脚本只拦 `browser_evaluate` 不牵连点击、两个都限制时拒因是更具体的那个，并把扩展 `COMMANDS` 表 **26 条**逐条对账（每条要么在只读白名单里、要么被拒；白名单不许有改名后的幽灵条目） | 只读档 / 脚本开关 |
| `verify_extension_e2e.mjs` | **端到端（只差真浏览器）**：起真的 `BridgeServer`，在 vm 里跑真的 `extension/background.js`，用 Node 自带的 `WebSocket` 真连 `ws://127.0.0.1:9779/ws`。断言 hello 带过来的 `protocol` 被桥认下、HTTP 命令面的 `tabs.open/group/list/ungroup` 确实走到扩展的 `COMMANDS` 表并原样返回、扩展抛的错变成 502 + `command_failed` + `effectState` | 帧契约 / 新命令可达性 |
| `verify_errors.mjs` | 错误分类表（超时/掉线/离线/取消…）与 `effectState`：写操作超时必须是 `unknown`（不许盲目重试），只读超时是 `not_started`；起真桥 + 不回话的假扩展，验证 HTTP 面的 503/504 与 `code`/`hint` 字段 | 错误契约 |
| `verify_protocol.mjs` | `hello` 帧的 `protocol` 握手：老扩展不声明或声明 0 视为兼容，扩展比桥新判不兼容并在 `/api/status` 给出说明 | 协议版本 |
| `verify_http.mjs` | 起真实 `BridgeServer` + 假扩展 WebSocket 客户端：所有响应无 `Access-Control-Allow-*`；无 token / 错 token 的 `/api/command`、`/api/cleanup` 一律 401；带 token 仍能真正驱动扩展；`Host` 非回环与网页 `Origin` 的升级握手被 403，扩展来源与无 Origin 的 101 | #3、#6 |
| `verify_server_hardening.mjs` | 桥接边界加固（专家评审 P1）：手工 RFC6455 帧驱动——分片消息按**字节**累积（多字节 UTF-8 跨片不碎）、被顶掉的旧连接再发 close 不许关掉新连接、HTTP 非对象 body（`null`/数组）回 400 且服务不崩、`/api/command` 与工具走同一道策略闸门与同一本审计账（只读档写命令 403 + 账本有记录） | 专家评审 P1 |
| `verify_text_safety.mjs` | UTF-16 截断安全（#26）：半个 emoji（孤立代理项）会让模型请求体整包 400 且随会话历史每轮重放。断言 `sliceWellFormed` 的边界（ASCII/恰好上限/完整 emoji/切点退格/limit 0/坏字符→U+FFFD）、工具 render 包装层把纯文本 render 修成 well-formed、4000 边界退一格且 `omittedChars` 与实际省略量一致（可见+省略=总长）、失败文本同样 well-formed；并从**真实扩展文件**里抽出 `pageClipWellFormed` 执行，核对评审列出的 7 处页面截断全部改走 clip | #26 |
| `verify_bundle_http.mjs` | 同样的鉴权，但跑的是 **发布产物 `lib/index.js`**（npm 用户实际拿到的那份），并确认默认 token 会在日志告警、`/api/status` 报 `insecureToken` | #3、#6、#8 |
| `verify_release_links.mjs` | README 里每个 `releases/download/...` 都对应一个真实存在的资产，防「文档指向 404 的包」复发（需先抓一份 releases JSON，脚本头部有命令） | #2 |
| `verify_nav_timeout.mjs` | `browser_navigate` 的 `timeoutMs` 真的在参数表里、真的传到扩展（默认 15000、显式优先、上限 120000），且**桥的命令超时 = 导航预算 + 2s**：预算 300ms 时桥在 2303ms 处超时（而不是撑到默认 60s），文案里带的是 2300ms；`browser_evaluate` 的同款旋钮也在这里对账（默认不带、显式钳到 [100,120000]、桥 +2s） | 超时文案里那句「raise timeoutMs」过去是空头承诺（参数表里没有这个键）；evaluate 的扩展侧竞速同理，工具面从不传 budget，等于死代码 |
| `verify_nav_waituntil.mjs` | #19 ② 三组：**同站重定向回同一地址**（`Page.frameNavigated` 事件桩驱动——判「地址变了」永远等不到，判事件 93ms 通过）、**预算分档**（commit 档默认 4s 上限不是 15s、显式 timeoutMs 优先、none 0 秒且零 debugger 附着、dcl 不等 load 事件）、**回执如实**（waitUntil/waitedMs/readyState 进 output schema 并透传）；另加轮询兜底回归闸（永不提交的导航仍 1.2s 报 loadPending）、tabs.open 两步创建、`wait:false`→none、桥余量（commit 档 6s 不是 60s）、两侧 NAV_TIERS 字面量逐字对账 | 「到达」过去只能表达「等整页」一档（轮询 tabs.status），commit/dcl 这两种更有用的时点表达不出来；事件的权威性正是 #19 里那次 4s 干等踩出来的 |
| `verify_archive.mjs` | `browser_archive` 三段：扩展侧 `Page.captureSnapshot` 逐字透传（假件按真 CDP 形状回 `{data}`，回空如实报错）、插件侧**逐字节落盘**（utf8 原样、bytes 是真实字节数、绝对 path 被尊重）、策略机制级断言（readOnly 拒 / 正常档放行 / 不进只读白名单） | 「整页存档」是截图/PDF 家族的最后一块：截图不可搜索、PDF 不可还原；MHTML 两个都是 |
| `verify_nav_headroom.mjs` | 导航后置探针的桥余量（#21）：真 `background.js` + 永不 resolve 的 `Runtime.evaluate` 演「探针卡死」。断言 `nav` 在 budget+700ms 内返回（旧实现 budget+4000ms）、`tabs.open` 同理（旧 +2000ms）；跳过的探针不带 `readyState`，但仍如实报 `loadPending`；正常落地时 `readyState` 照常带且不误报 `loadPending`。覆盖报告者的方案 B：探针共享命令死线 | #21 |
| `verify_windows.mjs` | `browser_windows` 两面：扩展侧契约（清单带 tabIds、开窗几何与 active 标签、**update 回执 = 实际几何**、`focused:true` 对最小化窗口「还原不压扁」、close 幂等 alreadyGone 且假成功逃不过复查、moveTab 逐个报告、最小化窗口输入报错指向恢复出口）、插件侧五 action 字面量分发 + 分类（`windows.open` 唯一写命令）+ 只读档（list 放行、其余拒） | 窗口控制是用户显式解禁的能力面；「请求值当成功回显」与「resolve 了 = 关掉了」两个坑都有专门断言 |
| `verify_silent.mjs` | 不抢前台（PR #25 适配版）：真 background.js + 焦点探针，断言 click / type(mode:type) / press 不再 `windows.update({focused:true})` / `tabs.update({active:true})`；tabs.open 默认仍前台（显式 `active:false` 才后台，尊重「开标签是显式动作」）；tabs.close 与 nav（非 none 档）先清 `window.onbeforeunload`；**`waitUntil:'none'` 仍零 debugger 附着**；最小化窗口输入仍报 `window_minimized` | PR #25 |
| `verify_history_nav.mjs` | `browser_tabs back/forward`（v1.7.0）：目的地从 `Page.getNavigationHistory` 读出（back/forward 落地、分叉后如实报边界、**历史尽头当场 `unchanged` 什么都没发射**、预算耗尽报 loadPending、历史读不到标 `historyUnknown` 退化成「任何提交都算」、none 档立即回报）；插件侧两条**字面量**分发 + 默认 load 档 + 非法 waitUntil 拒；截图回执尺寸来自 PNG IHDR、selector 的 rect 透传；分类（back/forward 是写命令）与只读档 | 目的地不猜才判得准：读出来的 targetUrl 让「历史尽头」「还在路上」「没动」三种状态分得清；截图光看字节数分不出「一张视口」还是「三张视口高」 |
| `verify_metrics_throttle.mjs` | `browser_metrics` + 弱网/CPU 节流（v1.7.1）：metrics 只透传已知指标名（假件故意混未知名字）、回空如实报错；emulate 的 network 预设走 `Network.emulateNetworkConditions` **逐字对上**（slow3g/fast3g/offline/reset 的数值、-1=不节流）、`cpuThrottlingRate` 超 1–20 报错、**device:"reset" 连节流一起清**、只过节流不动设备形状；插件侧 metrics 字面量分发 + render 带数字本身 + emulate render 写生效数值；分类（metrics 纯读进白名单、emulate 仍是写命令） | 「这页面很重」要有数字；节流的数值是本工具自己定的就写进描述，不冒充 DevTools 同名预设；reset 不清节流 = 模型以为回到真实环境而页面还在慢速网上爬 |

两处已知副作用：`verify_http.mjs` 会带 token 调一次 `/api/cleanup`，因此会在仓库根的 `dsh-browser-shots/` 建目录并清空它（该目录已进 `.gitignore`）；`verify_plugin.mjs legacy` 会短时关开一次 9777。

写这些脚本时踩到的坑，记在这里免得重来：

- `dsh-settings` 的导出面按版本不同：`0.1.2-rc.1` 有 `register`，`0.1.7-rc.2`/`0.2.0-rc.2` 只有 `SettingsForms`（`configure/describe/update/replace/mutate`）。想验证兼容性，不必装宿主，`npm pack @deepseek-ai/dsh-settings@<ver>` 解包 grep 就够了。
- 假 `chrome.storage.local` 的 `set` 必须真的落盘并广播 `onChanged`，否则「活过 service worker 重启」这类状态测不出来；`verify/ext_harness.mjs` 现在是这个语义。
- 假 cordis 上下文里 `apply()` 起的监听是**异步**的：不等端口真的在听，"放行"的命令会报 `bridge_disabled`（还没起）而不是 `extension_offline`（起了但没扩展连上），后者才是「闸门放行」的证据。
- schemastery 的 schema 本身就是校验函数：`Config(data)` 直接返回补齐默认值后的对象，没有 `.parse()`。
- cordis 的 `ctx.effect(execute, label)` 里，`execute` 的返回值才是 teardown 函数，所以注册 disposer 要写 `ctx.effect(() => dispose, 'label')`。
- 宿主 `latest` 已经是 dsh `0.2.0-rc.2`，插件 peer 上限写 `<0.2.0-0` 会让新宿主装不上；放宽前先把 0.2 的 `dsh-tools` 抓下来对比导出面（结论：`defineTool` 等完全一致）。
- 判断一个范围能不能匹配预发布版，别用心算，把解析器叫出来：`npm view "@deepseek-ai/dsh-settings@<范围>" version`。`@deepseek-ai` 全族都是预发布版，所以 `*` 这种"最宽松"的写法反而**一个版本都匹配不到**，而 `>=0.1.0-rc.1 <0.3.0-0` 只匹配 0.1.0 元组那批。
- 宿主的插件兼容规则不在文档里，在 `@deepseek-ai/dsh-app-boot/lib/index.js` 里（`npm pack` 解包 grep 就能看到）：它只检查 `@deepseek-ai/dsh*` 名字的 peer，用**宿主版本号**配 `includePrerelease:true` 去判，不通过就 throw 让整包被跳过。想装明白「我们的 package.json 会被怎么读」，读宿主的码比读自己的码更有效。
- 构建产物 `lib/` 是提交进仓库的，改完 `src/` 必须 `npm run build`，否则发布出去的包和源码不一致（1.0.7 已经栽过一次：npm 包只有 11 个工具，源码有 16 个）。
- 想在没有浏览器的机器上跑扩展代码：`node:vm` 建 context，`chrome` 给一个自动打桩的 Proxy 就够了。**只有顶层 `function` 声明能从 context 上取到**（`cmdTabsOpen`、`addToAgentGroup` 能调），`const`/`class` 取不到（`COMMANDS`、`agentGroupsByWindow` 直接 `undefined`），所以断言要写在能被调用的函数与看得见的假状态上。
- 打桩的 Proxy 会让 `typeof chrome.tabGroups.update === 'function'` **永远成立**，于是「能力探测 + 降级」这条路永远测不到。要么显式让该命名空间返回 `undefined`，要么像 `ext_harness.mjs` 那样把 `tabs`/`tabGroups` 换成有状态的假浏览器；换成立实现之后，**每个建模过的命名空间还要再套一层 fallback Proxy**，否则 `chrome.storage.onChanged.addListener` 这种没建模到的成员会直接 `undefined` 炸在加载期。
- **假 `chrome.runtime.lastError` 必须是 getter，不能是写死的 `undefined` 属性。** 扩展全靠「每次回调前读 `chrome.runtime.lastError`」来判断失败；写成静态属性的话所有错误都被吞掉，测试会一路假绿（S2/S3/S4 全过但什么都没测到）。同类陷阱：假 debugger 要自己维护 `attached` 集合，让「扩展缓存说附着着、Chrome 其实已经收回」真的表现为 `Debugger is not attached to the tab with id: N.`。
- 假 `chrome.storage.local.get` **不能把没配的键返回 `undefined`**：扩展里是 `cfg = {...DEFAULT_CONFIG, ...stored}`，`{port: undefined}` 会把默认端口洗掉，WS 就去了 `ws://127.0.0.1:undefined/ws`。只回真给得出值的键。
| `verify_compat_matrix.mjs` | **兼容矩阵（v1.7.2）**：把用户定的铁律钉成机器可查——**dsh 插件 x + 扩展 x-n ≥ dsh 插件 x-n + 扩展 x-n**。从 git 标签物化**真实历史扩展代码**（v1.2.0 / 1.5.0 / 1.6.0 / 1.7.0 / 1.7.1 / 1.7.2，不是模拟），当前插件对每面跑 33 个探针 + wait(fn:false) 真超时：当年就有的工具照常工作（≥ 当年组合）、比扩展新的必须报带重装指引的 extension-outdated、错误里绝不允许 unknown command 冒充契约性失败；`answered` 只认「真成功」或 `[command_failed]`（旧 `expect:any` 已收紧）；**每个成功探针的结果都要再过宿主 `validateJsonSchemaValue` + 自己的 render（真扩展输出→schema→render 全链）**；外加反向 append-only（历史命令面 ⊆ 当前命令面）。老 hello 无 capabilities ⇒ 版本映射兜底路径的实测也在台上；v1.7.2 面则实测 capabilities 精确握手路径。历史 manifest 由 harness 逐 boot 注入（模块级缓存会盖掉覆盖——修过一次）；假件默认提供截图/PDF/存档载荷，否则那三条探针只能算「管道通」 | v1.7.2 / capabilities 握手、v1.7.3 拖拽 |
| `verify_drag.mjs` | `browser_drag`（v1.7.3，**纯插件特性**——扩展代码零改动）：真 background.js + 真桥 + 假 chrome 下，cdp 通道把 `Input.dispatchMouseEvent` 序列逐条送到，断言事件顺序/坐标插值/按钮标志（少一个 `buttons:1` 页面就不认为在拖）；html5 合成函数在另一个 vm 里**真的被执行**（假 DOM + 假 DragEvent/DataTransfer），按浏览器规则断言「dragover 不 preventDefault 就没有 drop」「dragstart 被取消就整场不拖」；外加坐标端点零 DOM 查询、六种错误文案、只读档/allowScript 的工具级拒绝、旧扩展 extension-outdated；评审后补：目标滚动后**重测源坐标**、两端不同屏时拒绝且零鼠标事件、按住后失败补发 mouseReleased、省略 tabId 时用会话工作页而不是活动页 | v1.7.3 拖拽 |
| `verify_upload.mjs` | `browser_upload`（v1.8.0）：唯一能把本机文件交给页面的工具，默认关闭 + 目录白名单。断言 allowUpload=false / 缺 uploadDir 时零命令；相对路径、目录外、`..` 穿越、指向目录外的符号链接（按 realpath）全部拒绝且零命令；正常路径按 `tabs.list → DOM.getDocument → DOM.querySelector → DOM.setFileInputFiles` 顺序、同一 tabId、files/nodeId 逐字对上、回执真实字节数与 render；selector 未命中不发 setFileInputFiles；显式 tabId 不走 tabs.list；只读档与老扩展（无 cdp）零命令 | #24 安全版 |
| `verify_audit.mjs` | 操作审计（v1.7.4，纯插件）：账本单元（脱敏/截断/环形缓冲 200 条 seq 不回收/tabId·命令·sinceSeq·limit 过滤）+ 真实链路（成功/失败/本地 cleanup 按序上账、失败条目带 code/effectState、输入值打码后明文不出现、审计工具不给自己上账）+ 策略（只读档拒绝的写命令也上账、只读档下审计照常可查、旧扩展预检拒绝记 extension_outdated） | v1.7.4 操作审计 |
| `verify_journal.mjs` | 会话恢复（v1.7.5，纯插件）：journal 单元（追加/读回/坏行跳过/启动裁剪 1000 行/run 编号/过滤）+ **跨重启恢复**（实例 A 跑命令后销毁，同 stateDir 起实例 B：journal 读得回 A 的条目且 run 分组正确，audit 只报 B 自己）+ 扩展离线可读 + 失败命令也落盘 + 只读档可查 + stateDir 默认主目录 | v1.7.5 会话恢复 |
| `verify_sessions.mjs` | 多 session 隔离（v1.7.6，纯插件）：两个 agent 各自的工作标签页互不串（省略 tabId 落到自己的、不是活动页）；无 agent 身份不注入（旧行为）；tabs.open 结果被收养、工作页被关掉后退回活动页并改记；tabs.list 不参与注入；list/release 语义与 render「你」标记；只读档可查 | v1.7.6 多 session 隔离 |
| `verify_snapshot_page.mjs` | 快照分页（v1.7.7，纯插件）：每次向扩展要 200 窗口再插件侧切片；默认页 1–120/total 300/next 120、中间页、窗口尾页（不再给 nextOffset）、越界空页、clamp、total 缺失退化、AX 透传；render 区间/下一页/窗口上限文案 | v1.7.7 快照分页 |
