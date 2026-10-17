# 实测台（verify/）

仓库里没有单测框架，这一批脚本就是「改完到底有没有修好」的唯一依据。每条 issue 的结论都来自它们的实际输出，不是读代码读出来的推断。

跑法：

```bash
npm run verify        # 依次跑完下面全部
node verify/verify_plugin.mjs new     # 单独跑一个
```

前提：`127.0.0.1:9777`、`9778`（错误契约）、`9779`（扩展端到端）空闲（脚本会真的占用这些端口），依赖已 `npm install`。`verify_tab_groups.mjs` 与 `verify_extension_e2e.mjs` 共用 `verify/ext_harness.mjs`（假 Chrome 的那台内存浏览器）。

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
| `verify_policy.mjs` | 本机策略闸门（`readOnly` / `allowScript`）：用假 cordis 上下文跑真 `apply()`，断言默认值不变、只读档下 7 个写工具全部 `blocked_by_policy`（零副作用）而 4 个读工具照常走到链路（报 `extension_offline`，证明闸门放行）、单独关脚本只拦 `browser_evaluate` 不牵连点击、两个都限制时拒因是更具体的那个，并把扩展 `COMMANDS` 表 **26 条**逐条对账（每条要么在只读白名单里、要么被拒；白名单不许有改名后的幽灵条目） | 只读档 / 脚本开关 |
| `verify_extension_e2e.mjs` | **端到端（只差真浏览器）**：起真的 `BridgeServer`，在 vm 里跑真的 `extension/background.js`，用 Node 自带的 `WebSocket` 真连 `ws://127.0.0.1:9779/ws`。断言 hello 带过来的 `protocol` 被桥认下、HTTP 命令面的 `tabs.open/group/list/ungroup` 确实走到扩展的 `COMMANDS` 表并原样返回、扩展抛的错变成 502 + `command_failed` + `effectState` | 帧契约 / 新命令可达性 |
| `verify_errors.mjs` | 错误分类表（超时/掉线/离线/取消…）与 `effectState`：写操作超时必须是 `unknown`（不许盲目重试），只读超时是 `not_started`；起真桥 + 不回话的假扩展，验证 HTTP 面的 503/504 与 `code`/`hint` 字段 | 错误契约 |
| `verify_protocol.mjs` | `hello` 帧的 `protocol` 握手：老扩展不声明或声明 0 视为兼容，扩展比桥新判不兼容并在 `/api/status` 给出说明 | 协议版本 |
| `verify_http.mjs` | 起真实 `BridgeServer` + 假扩展 WebSocket 客户端：所有响应无 `Access-Control-Allow-*`；无 token / 错 token 的 `/api/command`、`/api/cleanup` 一律 401；带 token 仍能真正驱动扩展；`Host` 非回环与网页 `Origin` 的升级握手被 403，扩展来源与无 Origin 的 101 | #3、#6 |
| `verify_bundle_http.mjs` | 同样的鉴权，但跑的是 **发布产物 `lib/index.js`**（npm 用户实际拿到的那份），并确认默认 token 会在日志告警、`/api/status` 报 `insecureToken` | #3、#6、#8 |
| `verify_release_links.mjs` | README 里每个 `releases/download/...` 都对应一个真实存在的资产，防「文档指向 404 的包」复发（需先抓一份 releases JSON，脚本头部有命令） | #2 |

两处已知副作用：`verify_http.mjs` 会带 token 调一次 `/api/cleanup`，因此会在仓库根的 `dsh-browser-shots/` 建目录并清空它（该目录已进 `.gitignore`）；`verify_plugin.mjs legacy` 会短时关开一次 9777。

写这些脚本时踩到的坑，记在这里免得重来：

- `dsh-settings` 的导出面按版本不同：`0.1.2-rc.1` 有 `register`，`0.1.7-rc.2`/`0.2.0-rc.2` 只有 `SettingsForms`（`configure/describe/update/replace/mutate`）。想验证兼容性，不必装宿主，`npm pack @deepseek-ai/dsh-settings@<ver>` 解包 grep 就够了。
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
