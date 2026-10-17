# 更新日志

## Unreleased

**这一版改了 `src/`，`lib/` 已重新构建并一起提交（`npm run check` 通过）。**

- **新增两个本机策略闸门：`readOnly`（只读档）与 `allowScript`（是否允许执行任意页面脚本）。**
  动机：默认配置对模型是「什么都能做」，而用户想要「只能看、不能点」时没有开关；更麻烦的是，
  单靠「只让读工具可用」并不够——`browser_evaluate` 能在页面里跑任意 JS，等于把点击、输入、
  改页面全都绕过去，所以它必须是独立的一项。
  - 闸门只有一个位置：`BridgeController.execute()`，在命令**发给扩展之前**。被拒的命令零副作用，
    错误码新增 `blocked_by_policy`（`effectState=not_started`），文案写明改哪个字段、并劝退原地重试。
  - 只读白名单是「读页面 + 读扩展缓冲」的 11 条，其余**默认拒绝**：扩展以后新增命令不会自动放行。
  - 默认值保持老行为（`readOnly: false`、`allowScript: true`）；两项都进 `Config` schema，宿主 0.1.7+
    的设置页会自动列出。
  - 与 `WRITE_COMMANDS`（`effectState` 用的写/读分类）**是两张故意不同的表**：那张判「重试会不会多造成
    一次副作用」，所以 `tabs.group` / `tabs.ungroup` 算只读；这张判「会不会改变页面或浏览器状态」，
    所以它们不算只读。理由写在 `src/policy.ts` 顶部，避免以后被「顺手合并」。
- **新增 `verify/verify_policy.mjs`（29 项）**：用假 cordis 上下文跑真 `apply()`，7 个写工具在只读档下
  全部 `blocked_by_policy`、4 个读工具照常走到链路（报 `extension_offline`，正是「闸门放行」的证据），
  单独关脚本只拦 `browser_evaluate`、两个都限制时拒因取更具体的那个，另有扩展 `COMMANDS` **26 条逐条对账**
  （每条要么在白名单、要么被拒；白名单不许留下改名后的幽灵条目）。`npm run verify` 385 → **414 项，exit 0**。

## v1.0.17 (2026-10-12)

- **`tabs.closeMany` 登记为写操作，并给写/读分类表加一条与扩展 `COMMANDS` 表的对账。** 合并 PR #11 后扩展多了这条批量关闭命令，而 `effectState` 是按命令名判写/读的：漏登记会让批量关闭超时时报「`not_started`：这次调用没有动到页面，重试安全」，实际可能已经关掉了一半标签——同一类不诚实，这次出现在我刚合并进来的代码上。护栏要求 26 条命令每条要么在写清单里、要么显式登记为读/幂等并写理由；对护栏本身做过变异测试（临时摘掉登记 → 两条断言点名该命令变红）。`npm run verify` 381 → **385 项 exit 0**。
- **关于 1.0.16：它只在 npm 上存在，没打 tag、没建 Release、没被任何地方推荐安装。** 原因是发布过程中（npm publish 之后、建 Release 之前）合并 PR #11 的分类缺口被发现，而 npm 的版本不可改写。做法是把 1.0.16 与本次修正合并成**一次公告**（本版），并对 `1.0.16` 下 npm 弃用提示指向本版，避免有人按确切版本号装到那个半修好的版本。

## v1.0.16 (2026-10-12)

**这一版改了 `extension/`，扩展必须重装**（插件侧也要更新到新版本号）。

- **修掉 issue #14（wangyuncai2024 报）：`browser_press` 每按一个字符插入两次，`Enter` 把表单提交两次。** `cmdPress` 在 `keyDown` 已经带 `text`（Chrome 据此就已插字符）的情况下，**又补发了一个独立的 `char` 事件**。同一个仓库里这个坑早在 `cmdInput` 的 `type` 模式修过，注释就写着「an explicit char event duplicates the input」，CHANGELOG v1.0.2 也记了一笔——只有 `cmdPress` 没跟上，从 v0.2.0（`be6c302`）留到 v1.0.15。`browser_type` 的 `submit:true` 走同一条通道，所以提交类操作会做两遍。修法取报告方的方案 B（删掉 `char` 分支，与 `cmdInput` 一致）；他给的方案 A（`keyDown`→`rawKeyDown` 保留 `char`）实测等价，但会让仓库里存在两种写法。
- **顺带修掉报告方在同一函数里指出的两件事**：① 组合键现在真能用——`browser_press` 接受 `"Ctrl+A"` / `"Shift+ArrowRight"` 这种写法，也接受 `modifiers:["ctrl"]`（以前扩展层支持 `modifiers` 但工具层没暴露，`"Shift+ArrowRight"` 只会静默无效）；② **认不出的键名改成抛错**，不再带着 `undefined` 的 keyCode/code 照样派发、然后回一句 `pressed:true` 让调用方以为成功了。
- **新增 `verify/verify_press_events.mjs`（19 项）：第一次按「派发次数」测键盘。** 单字符 / `Enter` / 数字键 / `type` 模式逐字符各断言「插入型事件恰好一个、不得有 `char` 事件」，外加组合键解析、未知键名零派发、`shift` 与 `ctrl` 的插入语义。台子支持传入另一份 `background.js` 来跑：对**修复前**的版本，同一批断言红 12 项（报出 `keyDown,char,keyUp`），所以它不是跟着新代码写的空断言。
- 报告方关于「为什么测试没拦住」的判断是对的：`verify/` 以前对 `browser_press` 只断言模型可见文本（`verify_render_contract.mjs` 里那一条），**整个仓库没有任何一条真实按键事件计数**。这条缺口现在补上了。
- **合并 PR #11（long-arm-ape）：`browser_tabs close` 支持一次关一批，且每个 id 都有交代。** 第二版按评审要求改到位了：一批只发**一条命令**（扩展侧新增 `tabs.closeMany` → 一次 `chrome.tabs.remove([ids])`），不再 N 次往返中间掉线；结果统一成 `{requested, closed, alreadyGone, failed:[{tabId,error}]}`，**单数与批量同一个形状**。以前 `for (id of ids) await tabs.close(id)` 第一个失败就抛出，会把已经真的关掉的标签藏起来，模型于是以为什么都没发生、重放整批——这跟 `effectState` 契约直接冲突，也是当时没合的原因。`alreadyGone`（早就没了）算幂等成功、重试安全；并且**不猜**：`remove` 之后逐个复查，「还在」的才进 `failed`，被拒但其实已关掉的会如实进 `closed`。
- 附带一个他们顺手挖出来的**我自己的**对账缺陷：`verify_surface.mjs` 里那条命令名正则 `[a-z_.]+` 会把 `tabs.closeMany` 截成 `tabs.close`（大小写敏感 → 新命令名进不了对账），已放宽。
- `npm run verify` 从 331 项 → 350 项（键盘台）→ **381 项，exit 0**（PR #11 自带 31 项：扩展侧 7 组场景 + 宿主侧 5 条）。合并后 ubuntu 与 windows-latest 两个 job 在 `54d6aee` 上都 success。

## v1.0.15 (2026-10-12)

**第一次把真实宿主和真实浏览器接进验证链。** 用本机已安装的 dsh（`@deepseek-ai/dsh` 全家 `0.2.0-rc.2`，从 `app.asar` 里读出来的）在**隔离 `DSH_HOME`** 里创建 profile、装上 1.0.14、让 `--dump-config` 组装，再让真实 Chrome 扩展连上桥，把只读工具跑在真实代码路径上：

- 组装结果：`- id: browser-bridge / name: '@caob23/dsh-browser-control' / config: {enabled: true, port: 9777, token: dsh-local}` —— issue #4 那条「装上即监听」第一次在真宿主里被证实，而不是靠假上下文推断。
- 顺手回答了一条含糊的 profile 配置：只写 `- id: browser-bridge` + `disabled: true`（不带 `name`）**就足以关掉本插件**，宿主的合并是按 `id` 认的。这一点以前只能猜，现在用 `--patch` 在隔离 profile 里实测过。
- 真实 Chrome 153 + 扩展 1.0.10 下 9 条只读工具全过（`browser_read` 交出 1341 字符真实正文、`browser_snapshot` 交出 14 条带 ref 的清单、输出 schema 零违规）。**这也证明 1.0.12 那两个修复在真实链路上确实生效**——以前只有假扩展的证据。

**真实链路立刻挖出一个假台子永远发现不了的缺陷：旧扩展静默忽略 `mode:"ax"`。** 扩展 1.0.10（早于 1.0.11 的 AX 快照）收到 `mode:"ax"` 时不报错、回一份 DOM 结果，且**既不带 `mode` 也不带 `axFallback`**，模型于是以为拿到的是可访问名，其实那是标签名。修法是插件侧比对「请求的模式 vs 回报的模式」，不一致就自己写 `axFallback`（写明「以下是标签名，AX 需要扩展 v1.0.11+」）——**扩展不用升级也立刻受益**。同时补了三种形状的断言：静默降级 / 真走了 AX 不许凭空报降级 / 扩展自带降级原因时以它为准。

`npm run verify` 327 → **331 项断言，exit 0**。

## v1.0.14 (2026-10-12)

- **`browser_emulate` 只要不覆盖 UA 就必然失败（v1.0.7 起）。** 扩展在无覆盖时回的是**显式** `userAgent: null`（`extension/background.js:719` `userAgent: userAgent || null`，而 `desktop` 预设的 UA 就是空串），我们这边 `output.schema` 声明的是 `userAgent: {type:'string'}`。宿主 `checkValue` 只对 `undefined` 放行、**对 null 下钻判类型**，于是 `device:"desktop"` 与任何「只给宽高、不给 UA」的调用都抛 `ToolOutputError`。用宿主校验器直接实测：旧行为 `["\"value.userAgent\" must be a string"]`，归一化后 `[]`。改法是插件侧把 null 与空串一并剥掉（**扩展不用改**），UA 真的被覆盖时则把 `UA="…"` 写进给模型的那句话（以前 UA 只待在进不了模型的 `value` 里）。
- 审计台补了这类缺陷的**通用护栏**：封闭 schema 的 11 条工具，其 `value` 里出现任何 null 直接判失败（`hasNull` 递归检查），另加 `desktop` 预设 / 自定义宽高 / 带 UA / `reset` 四种形状各一条。`verify_render_contract.mjs` 110 → 126 项，`npm run verify` 311 → **327 项，exit 0**。
- **CI 加了 `windows-latest` 一道门**（这个插件的实际宿主平台是 Windows，以前 CI 只有 ubuntu）：安装 → 类型检查 → 重新构建 → 「产物必须与源码同步」→ publint → 327 项实测台，首跑十步全 success。配套补了 `.gitattributes` 把仓库锁成 LF——不换行的话那道同步门在 Windows runner 上必然假红（本机 `core.autocrlf=true` 长期刷的「LF will be replaced by CRLF」是同一个根因；加完 `git status` 只有一个新文件，说明索引里本来就是 LF）。

## v1.0.13 (2026-10-12)

- **错误契约补上最后一环：`effectState` 与 `hint` 现在写进 `message` 本身。** 宿主把异常渲染成模型可见内容时只取一句 `Error: ${message}`（`@deepseek-ai/dsh-tools` `lib/index.js:3616-3623`），`code` / `effectState` / `hint` 只进 `error.info` 与 HTTP 面——也就是说 v1.0.9 设计「不许盲目重试」这个信号时，接收方（模型）其实一个字都没收到，只能凭 `Error: browser command timed out after 800ms: click` 猜该不该重试。现在失败文案长这样：
  `[command_timeout] browser command timed out after 800ms: click — effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态，再决定要不要重做，不要直接重试。下一步：扩展超时未回应：先别重试…`
  HTTP 面不受影响：新增 `detail` 字段承载原始描述，`toJSON().error` 仍是它，`hint` 不会重复出现。
- `verify/verify_render_contract.mjs` 从 9 条工具扩到**全部 20 条**：新增一张「扩展真实载荷 → 宿主 `validateJsonSchemaValue` → 模型可见文本必须含指定片段」的地面真相表（截图 / PDF / `browser_cleanup` 走临时 `shotsDir`，不污染仓库）。**这一轮没有再挖出新缺陷**——剩下 11 条本来就合格；价值在于这条线从「抽查 9 条」变成「一条都漏不掉」：以后谁再写一句摘要式 render、或封闭 schema 少声明一个字段，CI 当场红，而不是等 12 个版本。
- `npm run verify` 从 242 项涨到 **311 项断言，exit 0**。本节改了 `src/`（失败文案），所以要装到 1.0.13 才生效；**`extension/` 仍无改动**（manifest 只是版本戳），已经在 1.0.12 扩展上的人不用重装。

## v1.0.12 (2026-10-12)

这一批只动 `src/`+`lib/`（插件侧），**`extension/` 的代码一个字没改**（`manifest.json` 只有版本戳跟着走）—— 已经装好的扩展不用重装也能配合新插件，协议仍是 `protocol: 1`。

- **修掉一个自 v1.0.0 就存在的功能缺陷：数据型工具的 render 把数据本身丢掉了。** 宿主的规则是「模型可见内容 = `output.render(args, value)` 的返回值」（`@deepseek-ai/dsh-tools` `lib/index.js:3548-3551`），`value` 是 execution-local、"deliberately omitted from durable events"（`lib/types/index.d.ts:415`），`presentationMeta` 只喂 UI。而这几条工具的 render 一直只交出一句统计：
  - `browser_read` → `Title (url) — 4321 chars`：页面正文一个字符都没给过模型；
  - `browser_snapshot` → `12 interactive elements …; click or fill them by ref.`：**一个 ref 都没给**，而系统提示词写的正是「先快照、再按 ref 点击」；
  - `browser_console_log` / `browser_network_log` → 只有 `20 of 140 entries` 这样的计数。
  现在正文/条目/ref 全在模型可见文本里。`browser_read` 改成窗口读取（`offset`/`limit`，默认与上限 20 000 字符，`value` 加 `offset`/`totalChars`，头部直接写「call again with offset=N」）；顺带把我评审 PR #9 时担心的「一次灌 120 000 字符」消掉——旧上限只作用在模型看不见的 `value` 上。快照按 `[e13] button "Save" -> /path` 逐条列，8 000 字符预算，AX 回退原因也一并写出来。
- **修掉一个必然失败：两条日志工具只要有条目就抛 `ToolOutputError`。** 它们的 `items` 声明是 `{type:'object', additionalProperties:false, properties:{}}`，而宿主 `checkValue`（`lib/index.js:468-470`）对 `additionalProperties:false` 是**逐键判违规**——`properties` 为空就是任何键都违规。用宿主自己的 `valueSchemaSpecToJsonSchema` 实测编译后该 items 原样保留，所以 `count>=1` 的每一次调用都会失败；没被发现是因为空日志恰好是常测到的那条路径，它反而是合法的。改法：按扩展真实回传的字段声明行形状，`execute` 归一化（时间统一 UTC 秒、长文本压一行），`headers`/`responseHeaders`/`postData` 不再进结果（它们到不了模型，只会放大载荷）。与 PR #12 修的 `siteUnreachable` 是同一类缺陷，只是藏在数组项里。
- **补掉 PR #10 漏掉的三处定长硬切片**：`browser_wait` / `browser_find` / `browser_dialog` 还在 `JSON.stringify(value).slice(0, 200|600|1200)`，也就是仍会把 JSON 从 token 中间切断。现在与其余工具同走 `clampRendered`。
- **截断信号改成机器可读**（我在 PR #10 评审里答应自己补的那步）：超预算时在切片**之后**追加 `… [renderedTruncated omittedChars=N limitChars=L] narrow the query and call again to see the rest`，数字实测对齐（12 000 字符载荷 → `omittedChars=8036`）。标记一定活着，因为它在切片之后拼上。
- 新增 `verify/verify_render_contract.mjs`（51 项）：真实 `BridgeServer` + 假扩展 + **宿主自己的** `validateJsonSchemaValue`，把每条工具的真实返回值同时喂给它的 schema 和它的 render，逐条问「过不过」与「模型看到的文本里有没有这次调用真正要的数据」。这一层以前**没有任何测试覆盖**，所以两类缺陷分别活了 **12 个**（v1.0.0–v1.0.11，`browser_read` / `browser_snapshot`）与 **5 个**（v1.0.7–v1.0.11，两条日志）已发布版本。`npm run verify` 从 191 项涨到 **242 项，exit 0**。
- CI：`文档里的 release 下载链接不得为死链` 改为带 `secrets.GITHUB_TOKEN` 并重试三次（run#15 那次红是匿名配额 60 次/小时被 runner 共用出口 IP 限到 403、`curl -f` exit 22，不是死链）；三次都拉不到时明确报「审计没有执行」而不是放绿。run#16（`bedf15e`）10 步全 success。

## v1.0.11 (2026-10-12)

- **合并 PR #10（long-arm-ape）：模型可见内容不再被定长切片砍掉。** `render()` 的返回值就是模型看到的全部内容（宿主注释：`ToolResult.content` = “final model-facing content”，而完整 `value` “deliberately omitted from durable events”），此前 `JSON.stringify(value).slice(0, 300/400)` 交给模型的是一段**在 token 中间断掉、语法都不完整的 JSON**，而且没有任何提示。现在统一走 `clampRendered`（上限 4000，超了明确说「还剩 N 字符被截，缩小查询再看」）。
  还欠一步（我在评审里提了，不阻塞合并）：截断信号目前只在文案里，应该再给一个机器可读字段（如 `renderedTruncated` / `renderedOmittedChars`），让 agent 能程序化决定要不要换个更窄的查询 —— 这本来就是我们待办清单里「结果截断要显式回报」那条。
- **合并 PR #12（long-arm-ape）：导航没到位不再报成功。** 三个实测确认的缺陷一起修掉：① waiter 挂在 `tabs.update` 之后 → 旧文档还停在 `status:'complete'` 就被当成新文档完成（本机复现：0ms 返回、`url` 是旧页面）；② `location.href` 探针无界等待（导航未 commit 时 CDP 不答话）→ 实测挂死 >8s，而命令自己的预算只有 15s，现在两个探针都有预算；③ `browser_navigate` 的 `output.schema` 是封闭的却没声明 `siteUnreachable`，而扩展发的是对象 `{reason}` —— 拿宿主自己的 `validateJsonSchemaValue` 实测得到 `"value.siteUnreachable" is not a declared property (additionalProperties: false)`，也就是**已发布的 1.0.10 里，导航到不可达站点时模型收到的是一条输出校验错误，而不是「站点不可达」**。
- 补掉 #12 留的最后一个口子：它「1.2 秒内没看到 `loading` 就认 `complete`」，而「导航压根没发生」（链接变成下载、目标被 Chrome 拒载）也长这样——实测合并前那版等满 1243ms 仍把旧文档 URL 当成功返回。现在宽限期后比对**落到的 URL vs 要去的那个**（忽略 hash 片段与末尾斜杠），不等就报 `loadPending`；同时两个不误报的方向都保住了：导航到已经开着的同一个地址仍算成功，真重定向因能看到 `loading` 走不到这个分支。新增 `verify/verify_nav_landing.mjs`（10 项）钉住这四条。
- **合并 PR #7（BeiWay1145）：DevTools 抢走 CDP 会话后能重连了。** `onDetach` 无条件失效缓存 + `clearAttachment`，重放限定「闭包第一次 send 就失败」。合并前对当前 main 复测：会话被抢走后 attach `1 → 2` 并成功（我们这版此后每条命令都失败）、一次 click 仍然只派发 2 个 `Input.dispatchMouseEvent`（不重复点击）、永久失败 2 次封顶。合并时把 `verify_cdp_retry.mjs` 的 `FIXED_ON_MAIN` 翻成 `true`，S1 从此要求「必须重连」。
- 合并流程记录：他们的分支带着旧 `lib/` 和我们已删的 `engines`，冲突按「保留我们的 + 追加他们的」解决，`lib/` 一律 `npm run build` 重新生成；`verify_nav_report.mjs` 从 9779 挪到 9781（9779 已被扩展端到端台占用）。

- 新增 `browser_snapshot` 的 **AX 语义模式**（`docs/CAPABILITIES.md` 排第一的那项，零新增权限）：`mode:"ax"` 走 Chrome 的 `Accessibility.getFullAXTree`，元素的名字与角色由浏览器算（aria-label / `<label>` / `alt` / 可见文本的合成结果），比让 agent 猜 CSS 选择器抗改版。**ref 契约一点没变**：AX 节点经 `DOM.resolveNode` + `Runtime.callFunctionOn` 找到真实元素后，写的还是同一个 `data-dsh-ref`，所以 `browser_click` / `browser_type` 的 `ref` 用法完全照旧，DOM 模式也仍是默认。
- AX 模式的四条硬规则（都有实测台兜着）：只收「可操作角色」白名单，`GenericContainer`/`StaticText`/`InlineTextBox` 这些噪音角色一律滤掉（否则文字多的页面会把 `limit` 吃在文本节点上）；隐形元素不占 ref 号也不写属性；AX 报了 `backendDOMNodeId` 而 DOM 里已无该节点时计入 `ax.unresolved` 并跳过；取树**之前**先清掉上一轮的 `data-dsh-ref`，旧 ref 不会指向现在屏幕上的另一个元素。
- 降级不硬撑：AX 域拿不到（老 Chrome / 无障碍未就绪 / 页面拒绝）时自动回落 DOM 模式，结果里带 `mode:"dom"` 与 `axFallback:"<原因>"`，整条命令不失败，agent 也知道这次的名字不是来自 AX。
- 输出面：`browser_snapshot` 的结果项新增 `role`，顶层新增 `mode` / `axFallback`（都是可选字段，老调用方不受影响）。
- 新增 `verify/verify_snapshot_ax.mjs`（18 项，已串进 `npm run verify`，现在共 **169 项断言 exit 0**）：扩展传进页面里执行的那段 stamping 函数是真的被 `node:vm` 跑一遍（`this` 绑到假元素），所以能断言「`data-dsh-ref` 确实写到了元素上」而不是只信返回值。
- 测试台顺手补了两处会致假绿的坑：假 `getBoundingClientRect()` 必须同时给 `x/y/width/height` 和 `left/top/right/bottom`（页面函数读 `left/top`，缺了会得到 `NaN`，第一版就把尺寸悄悄测成了 `null`）；AX 节点与「真实存在的 DOM 元素」必须能分开设，否则构造不出「AX 报了节点但 DOM 已经没有了」这条真实路径。
- `verify/ext_harness.mjs` 的假 debugger 升级成会**演 CDP 结果**：`Runtime.evaluate` 按表达式回 title/url、`DOM.resolveNode` 按 `backendNodeId` 找 objectId、`Runtime.callFunctionOn` 执行页面函数、`Accessibility.getFullAXTree` 回登记的树，`model.dbg.results[method]` 可逐个覆盖，`model.dbg.log` 记录调用顺序（用来断言「先清 ref 再取树」）。


- 新增 `verify/verify_cdp_retry.mjs`（已串进 `npm run verify`）：把 PR #7 的两个面都变成护栏——**核心修复该做的事**（会话被 Chrome 抢走后要能恢复）和**它第一版犯的错**（重放整个闭包导致 `Input.dispatchMouseEvent` 从 2 次变 3 次、`mode:'type'` 重复输入）。跑法是真的加载 `extension/background.js`，配一台**有状态的假 `chrome.debugger`**：它自己维护 `attached` 集合，所以「扩展缓存还说附着着、Chrome 早就收回了」会如实表现为 `Debugger is not attached to the tab with id: N.`。六个场景 S1~S6，其中 S3 断言重试有界（≤2 次）、S4 断言非会话类错误一次都不许多打。
  - **同一条命令可以换代码跑**：`node verify/verify_cdp_retry.mjs <相对路径>` + `CDP_RETRY_FIXED=1`。实测两份文件都能全绿且**能区分**：仓库当前版 S1 =「失败：Debugger is not attached…attach 次数 1（不重连）」，把 PR #7 三方合并到当前 main 的预览文件（`git merge-file`，零冲突）则是「成功｜attach 次数 2」，S3 从 1 次尝试变 2 次仍然有界，S2 两边都只派发 2 个鼠标事件。合并 PR #7 时把 `CDP_RETRY_FIXED=1` 一起改进调用，S1 的断言方向随之翻正——不留永远绿的空断言。
  - 顺带修掉一个会让整类测试**假绿**的坑：`ext_harness.mjs` 里假 `chrome.runtime.lastError` 原来是静态 `undefined` 属性，而扩展全靠读它来判失败——所有错误都被吞掉，S2/S3/S4 当时全过但什么都没测到。改成 getter 之后才暴露出真实行为。
- 顺带核对过 PR #7 的现状（未合并，等用户决定）：作者已按评审把重放收紧成「闭包第一次 send 就失败才重放」（`sends > started + 1` 直接抛），base 是 `cffb884`（v1.0.9），与当前 main 的标签分组代码不冲突；合并要动 `extension/` → 需要重打扩展 zip 并重发 npm（即 1.0.11）。

- 发布流程纠正（中英 `CONTRIBUTING.md`）：检查表顺序改成 **先 `npm publish` → 确认镜像也同步到该版本、`dist-tags.latest` 跟上 → 再打 tag / 建 Release / 宣布**。v1.0.10 就是按老顺序先把 Release 发出去了，结果维护者自己在本机 `dsh plugin add` 立刻撞到 `ERR_PNPM_NO_MATCHING_VERSION`——宿主把依赖钉成确切版本号，而 pnpm 用的是用户配置的源（这台机器是 `registry.npmmirror.com`，当时官方源已有 1.0.10、镜像 `latest` 还停在 1.0.8）。
- 文档新增一类「看着像包坏了」的安装失败：README（中英）安装节 + `dsh-config/README.md` 都写清镜像滞后的判断方法与三条解法（这一次显式 `--registry=https://registry.npmjs.org/`；改用 Release 里的离线包 `add file:<解压目录>`；等镜像同步后重试原命令）。
- issue #13 的机制定位（仍未定案）：本机等价复现出的失败路径「目录/宿主钉版本 → 用户源还没这个版本 → `ERR_PNPM_NO_MATCHING_VERSION`」比之前怀疑的 peer 范围更能解释报告者的现象——而且 hub 的失败分类表里没有这个错误码的分支，会一路落到兜底标签给插件仓库提 issue。已在 #13 里向报告者说明并给出可试的绕法。

## v1.0.10 (2026-10-11)

- 修复 #13（插件市场装机失败）里**我们这一侧能负责的部分**。同一条 peer 范围有两个读法完全不同的消费者，v1.0.8 只满足了其中一个：
  - 宿主的兼容门禁 `@deepseek-ai/dsh-app-boot/lib/index.js:294-300`（实测读法，不是猜）：只检查名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer，拿**宿主版本号**去做 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；不通过就 `throw`（`:931`），整个插件 bundle 被跳过，得 `dsh plugin allow-version` 才救得回来。旧范围 `">=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.3.0-0"` 在门禁这一关**全过**（0.1.2-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 实测都 true），所以从宿主侧完全看不出问题。
  - 包管理器（pnpm / npm 默认语义，不带 `includePrerelease`）：semver 对预发布版的规则是「范围里必须有**同 `[major,minor,patch]` 元组**且也带预发布的比较符」，而 `@deepseek-ai/dsh-*` 全族没有任何稳定版，于是 `maxSatisfying` 只给得到 **0.1.0-rc.8**。实测凭据：`npm view "@deepseek-ai/dsh-settings@>=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.3.0-0" version` 只吐 0.1.0-rc.*，`semver.maxSatisfying(全部已发布版本, 旧范围) = 0.1.0-rc.8`。本机后果有两处：仓库自己的 `pnpm-lock.yaml` 把 `dsh-settings`/`dsh-invariants` 钉在 0.1.0-rc.8，**历次 `npm run typecheck` 校的都是半年前的宿主 API**；pnpm 默认 `auto-install-peers=true`，干净目录里安装发布包会真拉一整棵 0.1.0 时代的依赖树（19 个包，含 `dsh-agent@0.1.0-*`、`dsh-llm@0.1.0-*`）。
  - 反过来**只钉精确版**（`"0.2.0-rc.2"`）会死在门禁那一关：实测 dsh 0.1.7-rc.2 与 0.2.1-alpha.2 宿主都被判不兼容、bundle 直接跳过。我们中途真的这么改过，是 `verify_peers.mjs` 把它拦下来的。
  - 最终写法 **`0.2.0-rc.2 || >=0.1.0-rc.1 <0.3.0-0`**：精确支给包管理器当锚点，宽支让宿主门禁放行。两关实测都过——干净目录 `pnpm add` 现在解析到 `dsh-settings@0.2.0-rc.2` / `dsh-tools@0.2.0-rc.2` / `cordis@4.0.4`（`pnpm why` 输出），门禁对四代宿主全 true。`@deepseek-ai/cordis` 不在门禁的名字筛选里、而且有稳定版，保持 `~4.0.4`；`@deepseek-ai/schemastery` 按官方插件的实测约定放回 `dependencies: ~3.18.4`。
- 兼容性不变：运行时仍然靠特性探测支持 dsh 0.1.x（`settings.register` 有没有、`configure` 在不在），见 `docs/BEHAVIOR.md` 与 v1.0.8 的 #8 条目；这次的宽支就是为了不把这份兼容从安装期削掉。
- #13 **尚未定案的部分**（如实记录）：旧范围并不会让 pnpm 直接报错——`maxSatisfying` 有解，本机安装已发布的 1.0.8 实测 `exit 0`，所以**不能断言它就是报告者那台机器上的失败原因**。报告标题与「Cause: plugin-side install failure」都是 dsh-plugin-hub `classifyFailure()` 的**默认兜底标签**（`src/client/logic/urls.ts:64,107`：任何没匹配上的失败一律按 repo/plugin-side 提 issue），宿主侧的 `LOG_KINDS` 分类表也没有能对上这条报告的分支；而且 `dsh plugin add` 用 `execution:'cli'` 继承 stdio，pnpm 自己的输出**不会**被 tee 进 `pnpm.log`，所以报告正文里那句 `dsh: plugin command failed` 已经是我们能拿到的全部信息。定案需要报告者的 `pnpm.log` 与他的 registry 配置。
- 更正一条本会话里先说错的结论：我曾判定「npm 上从来没有 1.0.9」。那是**读错了源**——这台机器 `npm config get registry` 是 `registry.npmmirror.com`，而它滞后（实测镜像文档只到 1.0.8，`dist-tags.latest=1.0.8`）。直接查官方源 `https://registry.npmjs.org/@caob23%2Fdsh-browser-control`：**1.0.9 确实存在，发布于 `2026-10-10T13:42:43Z`**（比 GitHub Release 晚 8 分钟），市场目录里的 `vr:"v1.0.9"` 与之一致，没有所谓「差一整代」。真正成立的问题是：**1.0.9 带的那条 peer 范围就是上面那条坏范围**（官方源文档实测 `@deepseek-ai/dsh-tools":">=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.3.0-0`），所以报告者当时装到的 1.0.9 也带着它。教训写进 `verify/README.md`：**看 npm 事实必须显式 `--registry=https://registry.npmjs.org/` 或直接 curl 官方源**，本机默认源是只读镜像。
- 删掉 `package.json` 的 `engines.node`（原来是 `^22.19.0 || >=24.0.0`）。说清楚它**不是** #13 的原因：宿主门禁根本不读 engines（实测 `evaluatePluginCompatibility` 只看 `peerDependencies`），报告者的 Node v24.18.1 本来就满足原声明。删它的理由是——实测 `@deepseek-ai/dsh-persona` / `dsh-skill` / `dsh-tool-fs` / `cordis-plugin-timer` 一个都没声明 engines，Node 版本是宿主的事，而我们留着它等于在 `engine-strict` 的用户面前多摆一个会拒绝安装的自找开关。产物运行时也不需要它：桥是 `node:http` + 自己实现的 RFC 6455 帧解析（`src/ws.ts`）。
- 新增 `verify/verify_peers.mjs`（34 项，已串进 `npm run verify`）：直接用**宿主自己用的那个 semver** 把两关都跑一遍——①涉及预发布的范围必须有一条精确支当锚点②包管理器视角：本地装的版本要满足我们对外声明的范围③宿主门禁视角：`SUPPORTED_HOSTS` 四代宿主对每个 `@deepseek-ai/dsh-*` peer 都要判兼容④宿主包只能是 peer、不得同时是 dependency⑤`lib/` 产物里每个裸 import 都有声明（实测产物运行时只 import `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools`）⑥`schemastery` 用 `~`⑦`engines` 必须不存在。把两种历史错误分别注入 `package.json` 实测：旧宽范围触发 6 项 FAIL，纯精确钉版触发 9 项 FAIL。
- 修 `src/index.ts` 的 `JsonValue`：它原来从 `@deepseek-ai/dsh-tools` 导入，而 0.2 已把这个类型挪到传递依赖 `@deepseek-ai/dsh-util-values` 里、不再从 `dsh-tools` 导出——**只有把 devDependencies 修到真实宿主版本之后，`tsc` 才第一次报出这个错**（`TS2614: Module '"@deepseek-ai/dsh-tools"' has no exported member 'JsonValue'`）。改成本地声明该类型，避免把插件绑死在某一代宿主上。

- 扩展：agent 新建的标签页现在自动收进**当前窗口**的 `DSH` 蓝色标签分组，用户扫一眼就能分辨哪些页面是机器开的、事后也能一把拆掉。新增 `tabs.group` / `tabs.ungroup` 两个扩展命令，并暴露成 `browser_tabs` 的 `group` / `ungroup` 动作（`ungroup` 可选 `windowId`，只拆本窗口；`open` 传 `group: false` 可跳过归组）。
- 归组的三个硬约束（都是实测出来的坑）：刚 `tabs.create` 立刻 `tabs.group` 会跟 Chrome 自己的标签簿记打架，所以按 50/150/400ms 退避、**最多 4 枪**封顶；`groupId` 只存内存，service worker 重启或用户手动拆组后按标题 `DSH` 反查重建，绝不往已失效的 id 上塞标签；**归组失败绝不让「打开标签」失败**，只在结果里附 `grouped:false` 与原因。`tabGroups` 接口不可用时整条路径静默降级。
- manifest 增加 `tabGroups` 权限（Chrome ≥ 89 的具名权限，不涉及网页内容读取）。**没有**顺手加 `host_permissions`——保持「扩展只在地址栏显示被调试提示、不预抓任意站点」这条边界，见 `docs/CAPABILITIES.md`。
- `browser_tabs` 工具面：`action` 增加 `group` / `ungroup`，参数增加 `group`（open 时是否归组）与 `windowId`（拆组范围）。
- `src/errors.ts`：把写操作判据讲明白——归组**不进** `WRITE_COMMANDS`。判据是「重试会不会造成额外损害」而不是「有没有动到浏览器」：重复归组是空操作，所以按重试安全处理；`tabs.open` 重试会多出标签页、`tabs.close` 可能关掉用户正在看的页面，才需要报 `unknown`。
- 新增 `verify/verify_extension_e2e.mjs`（已串进 `npm run verify`）：**端到端，只差一个真浏览器**。起真实 `BridgeServer`，在 node:vm 里加载真实 `extension/background.js`，用 Node 自带的 `WebSocket` 真的连 `ws://127.0.0.1:9779/ws`——以前 `verify_http.mjs`/`verify_errors.mjs` 用的是手写假 WS 客户端，只能证明「桥认识帧格式」，这条证明的是**扩展里那段真代码**连上之后，HTTP 命令面的 `tabs.open` / `tabs.group` / `tabs.list` / `tabs.ungroup` 真的落到 `COMMANDS` 表、结果原样回来（`grouped/groupId/created` 一个字段都没被桥改写）、扩展抛的错变成 502 + `command_failed` + `effectState`，以及 `hello` 带过来的 `protocol: 1` 被桥认下。归组这类新命令最容易死在「扩展实现了、桥不认识、插件调不到」的中间地带，现在这一段有人守。
- 假 Chrome 测试台从 `verify_tab_groups.mjs` 抽成共享模块 `verify/ext_harness.mjs`（两个脚本共用同一台内存浏览器），并记两个坑：建模过的命名空间必须再套一层 fallback Proxy，否则 `chrome.storage.onChanged` 这类没建模的成员在加载期就 `undefined` 炸；假 `storage.get` 不能把未配置的键返回 `undefined`
- 文档与测试台纠偏：`llms.txt` 里「16 个 `browser_*` 工具」改回实际的 20，并把这条数量核对并进 `verify_surface.mjs`（它此前只对账两份 README 的工具表，没管 llms.txt——同一类漂移的第三个藏身处）；`ext_harness.mjs` 不再自带写死的 `1.0.9-test` 版本号，改为读真的 `extension/manifest.json`，`verify_extension_e2e.mjs` 据此断言「扩展上报给桥的版本号确实来自 manifest」。，因为扩展是 `cfg = {...DEFAULT_CONFIG, ...stored}`，`{port: undefined}` 会把默认端口洗掉。

- 新增 `verify/verify_tab_groups.mjs`（已串进 `npm run verify`）：`node:vm` 里加载扩展真实的 service worker，配一台**有状态**的假 `chrome.tabs` / `chrome.tabGroups`，23 项断言覆盖建组、复用同组、退避重试（含「只多打一次」和「4 枪封顶」）、脏缓存重建、按标题找回、按窗口拆组、无权限降级，以及「manifest 确实声明了 `tabGroups`」和「没有多要 `host_permissions`」。**未在真实 Chrome 里重跑**——分组的视觉效果（颜色、标题、折叠）仍需实机确认。
- 文档：README（中英）新增「agent 开的标签长什么样」一节并更新工具表、可见性对比行与「已验证」；`docs/BEHAVIOR.md` 新增「agent 标签页归组」行为契约；`verify/README.md` 补上此前漏记的 `verify_surface` / `verify_errors` / `verify_protocol` 三行，并把已经过期的「16 个工具」改成实际断言内容。

## v1.0.9 (2026-10-10)

- 新增 4 个工具，`browser_*` 从 16 个到 **20 个**：`browser_wait`（等元素/等文本/等页面条件，最长 120 秒）、`browser_find`（按选择器查元素，返回数量与视口矩形）、`browser_dialog`（读改原生弹窗应答策略并回最近弹窗记录）、`browser_info`（报告实际连上的浏览器与扩展版本）。四个都是**扩展里早就实现好、但一直没注册成工具**的能力，agent 之前调不到；`browser_wait` 尤其离谱——README 和 `docs/BEHAVIOR.md` 一直在宣传它，代码里根本没有。
- 新增 `controller.execute(..., timeoutMs)`：桥接侧的超时预算可以按命令单独给。`browser_wait` 用它把预算设成「页面等待上限 + 10 秒」，保证先由页面侧报「等不到」，而不是被桥接掐断——后者会让 agent 分不清"页面慢"和"链路死"。
- 新增 `verify/verify_surface.mjs`：四方对账（扩展 `COMMANDS` 表 ↔ 插件实际调用的命令 ↔ 两份 README 的工具表 ↔ 构建产物 `lib/index.js`），已串进 `npm run verify`。上面那四类漂移以后会在提交时暴露，而不是等用户提 issue。
- 修正 `extension/background.js` 里 `dialog` 命令的注释：它写着 `{action:'get'|'set'}`，实现看的其实是 `policy` 字段，按注释传参会静默无效。
- 新增协议版本握手：`hello` 帧现在带 `protocol`（与包版本号解耦，只在帧契约变化时递增）。桥记录双方版本并在 `/api/status` 与状态页暴露 `bridgeProtocol` / `extensionProtocol` / `protocolCompatible` / `protocolNote`；扩展比桥新 → 判不兼容并提示升级插件，扩展不声明或声明 0（v1.0.9 以前的老扩展）→ 按兼容处理，不为一个装饰性字段打断能正常工作的安装。这类"某些命令莫名失败"的成因（版本错位）以前只能靠猜，现在状态页一行就能看出来。
- 文档：README（中英）工具表补上 `browser_wait` / `browser_find` / `browser_dialog` / `browser_info`，以及此前漏列的 `browser_network_clear`。

## v1.0.8 (2026-10-10)

- 发布资产修了两处（自查）：v1.0.7 的 `dsh-browser-control-plugin-v1.0.7.zip` 和扩展包一样带 multipart 前言（实测头 4 字节 `2d2d2d2d`，不是 `PK\x03\x04`，资源管理器拒展开——#2 里「压缩包还是有问题」的另一半原因），并且**缺 `cordis.patch.yml`**，而 `package.json` 的 `dsh.bundle.patch` 正指向它，从这份离线包安装等于没挂载插件。本版两份资产都重新打包并附 `.sha256`。
- 兼容提示（**行为变更，升级前先看**）：`/api/command`、`/api/cleanup` 现在必须带 Token，任何脚本化调用都要改；`Access-Control-Allow-Origin: *` 全部移除。

- 修复 #5：文档不再承诺 npm bundle 一定有「设置 → 插件」卡片。README（中英）与 `dsh-config/README.md` 改为按宿主版本分述：dsh 0.1.7+/0.2.x（dsh-settings 0.1.7-rc.2 起）由宿主按插件自身 `Config` schema 自动投影出设置节，看得到也改得动；0.1.2 及更早没有客户端半区认领命名空间，卡片不渲染，配置只能走 profile 覆盖层。桥接未启用时工具报错的文案也不再指向可能不存在的设置入口（`src/index.ts`）。
- 新增 `verify/`：五个纯 node 实测台（配置解析、三种宿主形状的 `apply()`、HTTP 鉴权与升级来源、发布产物行为、README 资产死链），`npm run verify` 一条命令跑完，用法与副作用记在 `verify/README.md`。顺带纠正 README「已验证」里那条早已不存在的「单元测试 29/29」（`tests/` 在 v1.0.4 就删了），并把历史浏览器场景与本版实测分开标注。
- 文档：`llms.txt` 里的路径还停在 v1.0.2 的 `plugin/src/...` 布局、工具数写的 11，已改为当前 `src/` + `lib/` + `verify/` 结构与 16 个工具，并补上「Token 才是边界」一节。`CONTRIBUTING.md` / `docs/en/CONTRIBUTING.en.md` 整体重写（旧内容让贡献者去 clone deepseek-harness、复制并不存在的 `plugin/`、跑已被删除的 29 个 vitest 用例），换成 `npm run check` / `npm run verify` 的真实流程，并记下扩展 zip 必须是 `PK` 头 + 正斜杠条目（issue #2 的教训）与宿主 API 的版本坑。
- 扩展：`extension/popup.js` 未连接时的提示不再指向「dsh 设置 → 插件」（老宿主没这个入口）。**副作用**：仓库 `extension/` 与已发布的 v1.0.7 扩展资产不再逐字节一致，下次发布必须重新打一份扩展 zip。
- chore：`.gitignore` 增加 `dsh-browser-shots/`（实测台会在仓库根建它）。

- 修复 #3 / #6 第二步（鉴权，**行为变更**）：`/api/command`、`/api/cleanup` 现在要求 Token，形式与 WS 同一个凭据——`Authorization: Bearer <token>`、`X-Token: <token>` 或 `?token=<token>`，缺失或不对一律 401；比较改成常数时间（`timingSafeEqual`）。WebSocket 升级另加 `Host` 必须是回环地址（挡 DNS 重绑定，403）与 `Origin` 校验：拒绝任何网页来源，放行 `*-extension://` 与不发 Origin 的本机客户端。`/` 与 `/api/status` 保持免鉴权只读（状态页要用）。实测 19 项全过：无 token 的命令面从「200 且真的驱动扩展」变为 401，带 token 的 `nav` 仍然正常执行，`evil.example` Host 与 `https://evil.example` Origin 均 403，扩展来源与常规握手仍 101。
- 状态页：清理按钮改为索取 Token（只存 sessionStorage，不写盘），并新增「令牌强度」一行；Token 仍是默认的 `dsh-local` 或短于 16 字符时，桥接启动即在日志里告警。**这里刻意没有采纳报告者「拒绝启动」的建议**——那会让所有现存配对当场断连，改成告警 + 页面标红；要硬拒绝可以再说。
- 文档纠偏：`SECURITY.md` / `docs/en/SECURITY.en.md` 重写「安全边界 / 已知限制」，明确回环绑定不是隔离边界、Token 才是，同机任意知道 Token 的进程仍可驱动浏览器；并撤回 v1.0.6 里那句「`allowEval` 默认 false」——全仓库从未实现过该开关（grep 只在 CHANGELOG 出现），`eval` 一直可用。README 增加脚本直连 HTTP 的 Token 用法与 401 说明。

- 修复 #3 / #6 第一步（CORS）：HTTP 面不再出现任何 `Access-Control-Allow-Origin`。原先 `handleHttp()` 的 OPTIONS 预检与 `respondJson()`（所有 JSON 响应的公共出口）都回 `*`，等于把「本机任意网页可读走桥响应」变成默认。状态页与自身 `fetch` 同源、扩展只走 WebSocket，因此直接去掉通配而不是换成白名单。实测（起真实 `BridgeServer` + 假扩展客户端）：`/api/status`、`/api/command`、`OPTIONS` 三类响应头均无 ACAO/Allow-Methods，状态页 200 正常，且同一请求确实驱动扩展执行了 `nav`（证明这是真实可达面，不是空转）。

- 修复 #8：settings 接线改为特性探测。`sctx.settings.register` 只存在于 dsh-settings 0.1.2-rc.1 及更早（实测 `0.1.2-rc.1` 的 `lib/index.js:281` 有 `register`，`0.1.7-rc.2` 与 `0.2.0-rc.2` 只导出 `SettingsForms`，方法为 `configure/describe/update/replace/mutate`）。原代码在注入回调里直接调用它，新宿主上抛 `TypeError`，回调后半段的 `controller.reconcile()` 与 `scope.watch()` 一起被跳过。现在：没有 `register` 就走 profile 配置并把设置页交给宿主的自动投影（`configure({auto:true})`），`register` 抛错也有兜底，两条路径都保证桥接收敛。三种宿主形状实测（假 settings 服务）：legacy / register-throws / no-register 全部「回调不抛、9777 监听、16 个工具注册」，且 legacy 路径的实时开关回归仍成立（改 false 端口关闭、改回 true 重开）。
- 兼容：`package.json` 的 peer/devDependencies 上界从 `<0.2.0-0` 放宽到 `<0.3.0-0`。dsh 的 `latest` 已经是 `0.2.0-rc.2`，旧上界会让新宿主装插件时 peer 解析不到；实测 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 的导出面与 0.1.0-rc.8 完全一致（含 `defineTool`），放宽无运行时风险。
- 修复（无人报告，自查发现）：`lib/` 构建产物落后于 `src/`。`0e0696c` 加完 v1.0.7 的 4 类新工具后没有重新打包，仓库里提交的 bundle 与 **npm 已发布的 `@caob23/dsh-browser-control@1.0.7` 都只注册 11 个 `browser_*` 工具**，而 README 工具表写的是 16 个——npm 安装的用户实际缺 `browser_console_log`、`browser_network_log`、`browser_network_clear`、`browser_pdf`、`browser_emulate`。已按 `src/` 重新构建，实测 `apply()` 注册满 16 个。
- 修复 #2 收尾：README（中英）的扩展下载链接指向 release 上真实存在的 `DSH-Browser-Control-v1.0.7.zip`。原链接 `DSH-Browser-Control-1.0.7.zip` 已不存在（实测 404），用户只能拿到那份带 multipart 前缀的坏资产（头 4 字节 `2d2d2d2d`，`PK` 在第 162 字节），资源管理器因此拒绝展开。现链接的包实测：头 `504b0304`、全正斜杠条目、CRC 全过、sha256 `1836b20ea9b5d85291606fde2b3a809d87f88c60edd27922cc9c92e243694ad7`，内容与仓库 `extension/` 逐字节一致。
- 修复 #4：`cordis.patch.yml` 里写死的 `enabled: false` 覆盖了 v1.0.6 的 schema 默认值 `true`，导致 `dsh plugin add` 装完后 9777 无人监听、扩展报 `ERR_CONNECTION_REFUSED`。包内 patch 改为 `enabled: true`，实测（`Config({enabled:false,…}) → false`、`Config({enabled:true,…}) → true`）确认显式值优先于默认值，即该字段就是根因。
- 文档：`README.md` / `README.en.md` / `SECURITY.md` / `docs/en/SECURITY.en.md` / `dsh-config/README.md` 里「默认关闭、设置页手动开启」的旧口径统一为「默认开启」；关开关的正确写法改为 profile 覆盖层按 `id` 覆盖 config（原文的 `~/.dsh/settings.yml` 与 `- merge:` 均非实际生效路径）。

## v1.0.7 (2026-09-04)

- 新增：`browser_console_log` — 抓取页面 console.log/info/warn/error/debug；可按 level + regex 过滤，可 `clear:true` 清空。CDP 域 `Runtime.enable` 已在 attach 时常驻，不再 lazy。
- 新增：`browser_network_log` — 抓取 HTTP 请求/响应完整生命周期（`requestWillBeSent` → `responseReceived` → `loadingFinished`/`loadingFailed`）。可按 methodPattern/urlPattern/status 过滤；`includeStatic:true` 包含图片/字体/样式/脚本（默认过滤掉）。`browser_network_clear` 单独清空。
- 新增：`browser_pdf` — 调用 `Page.printToPDF` 导出 PDF 到 `path`（绝对路径）或 shotsDir（默认）。可选 landscape / paperWidth / paperHeight / scale / pageRanges / printBackground。PDF 文字可选中可搜索，比 screenshot 更适合长文 article。
- 新增：`browser_emulate` — 切换视口到 `desktop` / `mobile-iphone-13` / `mobile-pixel-7` / `tablet-ipad` 预设，或自定义 width/height/deviceScaleFactor/isMobile/hasTouch/userAgent。`device:"reset"` 还原。
- 内部：extension/background.js 增强 `chrome.debugger.onEvent` 监听器同时处理 `Page.javascriptDialogOpening` + `Runtime.consoleAPICalled` + 4 个 `Network.*` 事件，按 `tabId` 隔离缓冲；attach 时常驻 `Runtime.enable` + `Network.enable`。
- 资源：每 tab console 缓冲上限 500 条，network 上限 500 条（LRU）；POST body 截断 64KB；请求过滤默认排除 `Image/Font/Stylesheet/Script/Favicon/Manifest`。
- 文档：README 工具清单加入 4 个新工具

## v1.0.6 (2026-09-03)

- 变更：`Config.enabled` schema 默认值从 `false` 改为 `true`，装上即默认启动桥接（issue #1 反馈：之前需要手动在 setting 文件加 `enabled: true` 才能用）
- 安全：`allowEval` 默认仍为 `false`，启用 eval 仍需显式配置 —— **此条有误，该开关从未实现过**，更正见 Unreleased
- 配套：CHANGELOG/README 同步更新启用行为说明

## v1.0.5 (2026-09-03)

- 修复：在新版 `@deepseek-ai/dsh-settings`（0.1.2-alpha.* 起）下插件加载失败（issue #1）
  - 原因：旧版源码对 dsh-settings 的 `installSettingsSection` 与 `settingsNamespace` 两个 helper 有静态 import；新版本里这两个 helper 已被改造成 `SettingsProvider.installSection` 方法 + 字符串字面量类型，对应能力保留但 helper 移除 → 旧插件 ESM 解析时找不到 export，整个插件加载 throw
  - 修复：绕开 helper，直接调底层 `sctx.settings.register(ns, schema, { base, validate })` API（该方法在 dsh-settings 所有发布版本上都存在），`BROWSER_BRIDGE_SETTINGS_NAMESPACE` 改为普通字符串字面量
  - 升级：`pnpm update @caob23/dsh-browser-control` 或重装 `@caob23/dsh-browser-control@^1.0.5`

## v1.0.4 (2026-08-23)

- 变更：许可证 MIT → **AGPL-3.0**。个人/学术/非商业免费；企业闭源商用需商业许可（联系：GitHub Issues 或 caob2333@outlook.com）
- 文档：SECURITY.md 允许非可利用问题直接提 Issue（中英双语）
- 文档：dsh-config/README.md 重写为配置项参考（patch 字段、默认值、用户层覆盖示例）
- 清理：移除 tests/、fixtures/ 与未使用的 icon-svg.ts；英文文档归档到 docs/en/
- 安装方式与 v1.0.3 一致：npm / GitHub / 本地 file: 三种来源

## v1.0.3 (2026-08-23)

- 新增：插件按 dsh Profile Bundle 规范打包，一条命令安装
  `dsh plugin --profile web add github:caob23/dsh-browser-control#v1.0.3`
  （npm 发布后也可 `dsh plugin --profile web add @caob23/dsh-browser-control`）
- 变更：npm 包名从 in-tree 的 `@deepseek-ai/dsh-browser-bridge` 改为用户 scope 的 `@caob23/dsh-browser-control`
- 变更：插件源码上移到仓库根，独立于 harness 工作区构建（tsc + tsdown），构建产物 `lib/` 随仓库提交，GitHub 安装零编译
- 旧「复制进 harness 源码树」方式保留在 v1.0.2 tag；迁移时删除旧副本避免 browser-bridge id 重复挂载

## v1.0.2 (2026-08-23)

16 项验收意见修复，另加饱和回归中新发现并修复的 10 个缺陷。

弹窗与交互：

- 新增 `dialog` 命令：全局自动应答策略（accept / dismiss / manual）读取与切换，含最近 50 条弹窗日志
- MV3 service worker 常驻监听 `Page.javascriptDialogOpening`，alert/confirm/prompt/beforeunload 全类型自动应答，prompt 支持自定义应答文本
- 连续链式弹窗（一次点击多个 prompt）逐个依次应答
- 输入新增 `mode:'type'` 真实键盘通道：逐字符 keyDown/keyUp，回车映射 Enter；默认 fill 模式保持直写

键盘与焦点健壮性：

- 键盘/鼠标事件前自动聚焦目标窗口并激活标签页；**绝不修改窗口尺寸、位置或状态**（含最大化状态），最小化窗口返回结构化 `window_minimized` 错误而非擅自还原
- 非 ASCII 字符（中文/emoji）改走 `Input.insertText` 真实插入通道，不再被协议损坏成 `?`
- 移除多余的 char 事件，修复 ASCII 字符被插入两次
- Enter 事件携带 `text:'\r'`，表单隐式提交恢复正常

求值与序列化：

- 页面导航中断求值时返回结构化 `context_destroyed` 错误（覆盖 -32000 "Inspected target navigated or closed" 变体），不再挂满超时
- 序列化重写为两步架构：先取 RemoteObject 元数据分类，再经 `callFunctionOn` 按值转移；DOM 节点、函数、Map/Set 等不可转移值诚实报错，杜绝静默 `{}`（新版 Chrome returnByValue 行为变更）
- `eval` 支持 `timeoutMs` 竞速超时，慢 Promise 不再拖满桥接默认 60s
- `eval` 支持 `frameSelector` 同源 iframe 求值，document/window 经参数影子化重绑定（修复 TDZ 报错）；`argNames`+`args` 参数化注入

导航与等待：

- 死站点导航返回结构化 `siteUnreachable:{reason:dns|unreachable}`，经页面内 location.href 探测 chrome-error 页，中英文错误文案均可分类
- 新增 `wait` 命令：selector / text / fn 三种条件 50ms 轮询等待，fn 同时接受谓词函数与布尔表达式，timeoutMs 上限 120s

工具输出：

- `click` 返回命中校验（hitVerified）、点击坐标、元素信息及连带应答的弹窗数
- `screenshot` 支持 selector 元素裁剪截图并返回 elementRect
- `tabs.list` 精简为紧凑结构（id/url/title/active 等）
- snapshot 增加 total 计数与每项 type/value/rect 字段

## v1.0.1 (2026-08-23)

- 修复：已连接时圆点显示为绿色呼吸动画（此前因 CSS 类名错位误显示红色）
- 新增：弹窗一键「断开连接」；断开后不再自动重连，点「立即连接」恢复
- 文档：新增鲸鱼插画横幅，README / CONTRIBUTING / SECURITY 中英双语（中文默认）
- 文档：版本号和 License 徽章改为动态读取，徽章换成经典塑料风格

## v1.0.0 (2026-08-22)

- 扩展、弹窗、状态页统一鲸鱼图标
- 状态页内嵌 SVG logo
- 持久 debugger 附着（控制期间 Chrome 横幅稳定显示）
- 配置简化为端口模式（替代完整 URL）
- 状态页暗色卡片样式 + 连接信息展示

## v0.2.0 (2026-08-22)

- 持久 debugger 附着
- 桥接端口配置输入
- 状态页美化
- 29/29 单元测试通过

## v0.1.0 (2026-08-22)

- 首个发布版本
