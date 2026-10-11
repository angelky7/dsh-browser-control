# Chrome 扩展能力面调研（2026-10-10）

目的：搞清楚 MV3 扩展能拿到哪些权限与 API，据此决定 DSH Browser Control 下一步挖什么能力。

## 数据来源与可信度标注

| 来源 | 拿到什么 | 可信度 |
|---|---|---|
| `@types/chrome` 0.3.5（npm，Chrome 官方 API 的类型定义） | 72 个 `chrome.*` 命名空间、83 个 `ManifestPermission` | 高（就是 Chrome 自己的定义） |
| BrowserSkill 本机扩展实物 `manifest.json`（v0.3.2） | 它实际申请的 11 项权限 + `<all_urls>` | 高（实物） |
| 我们的 `extension/manifest.json` | 5 项权限（`tabGroups` 刚加）、无 host 权限 | 高 |
| 我的既有知识（CDP 域、权限语义） | 下文标 ⚠️ 的条目 | **未在本机核实**，动手前要查官方文档 |

`developer.chrome.com`、`chromewebstore.google.com` 在这台机器直连均为 000（网络层阻断，不是 hosts 问题），所以官方逐条文档没能核对，凡"具体行为/限制"都请二次确认。

## 现状对比

```
我们：      debugger, tabs, tabGroups, storage, alarms            （host 权限：无）
BrowserSkill：alarms, activeTab, debugger, downloads, idle, notifications,
             scripting, tabs, storage, webNavigation, windows     （host：<all_urls>）
```

它比我们多 7 项命名权限 + host 权限。但**能力不等于权限**：我们靠 CDP 已经覆盖了 PDF、网络日志、console、视口模拟这些它没有的东西（见文末）。

## 第 1 层：不需要任何新权限，现在就能挖（全部走已有的 `chrome.debugger`）

这一层性价比最高——零权限增长、零商店审查成本、零用户信任成本。

| 能力 | CDP 域/方法 ⚠️ | 对 agent 的意义 |
|---|---|---|
| **语义快照** | `Accessibility.getFullAXTree` | 用 role + accessible name 定位元素（"提交按钮"），比 CSS 选择器稳得多，抗改版。BrowserSkill 的 VOM 语义树就是这条路 |
| **跨域 iframe** | `Target.attachToTarget` + `flatten: true`、`Page.getFrameTree` | 直接解掉我们文档里写明的限制"cross-origin iframe: same-origin only"（`extension/background.js:714`） |
| **请求拦截 / mock** | `Fetch.enable` + `Fetch.requestPaused` | 改包、挡掉第三方追踪、给页面喂假数据做测试。比 `Network.*` 强在能**改**而不只能看 |
| **Cookie 读写** | `Network.getCookies` / `setCookies` / `deleteCookies` | 复制登录态、清理站点状态、跨标签共享会话。BrowserSkill 明确没有 |
| **性能指标** | `Performance.getMetrics`、`Tracing.start` | FCP/LCP/CLS、CPU profile——"这页为什么卡"这类问题能直接答 |
| **拖拽** | `Input.dispatchDragEvent` | 我们和 BrowserSkill **都没有**；能自动化排序、文件拖放、画布操作 |
| **实时画面流** | `Page.startScreencast` | 连续 JPEG 帧 → 侧栏缩略图 / 操作录像 / 失败时给 agent 看"当时屏幕上是什么" |
| **弱网与 CPU 限速** | `Network.emulateNetworkConditions`、`Emulation.setCPUThrottlingRate` | 3G/离线/慢机器复现，配合已有 `browser_emulate` |
| **整页存档** | `Page.captureSnapshot`（MHTML） | 单文件离线证据，比截图可搜索、比 PDF 可还原 |
| **浏览器日志** | `Log.entryAdded` | 抓到 CSP 报错、证书问题这类不进 console 的东西 |
| **忽略证书错误** | `Security.setIgnoreCertificateErrors` | 自签内网站点可用。**危险项**，必须显式开关 + 状态页亮红标 |

## 第 2 层：加一项轻量命名权限就能拿到（商店审查成本小）

| 权限 | 换来什么 | 值不值 |
|---|---|---|
| `tabGroups` | 把 agent 开的标签自动归组、上色 → 用户一眼看清"哪些是 AI 干的"，误关风险↓ | ✅ **已落地**（main，未发布）：`DSH` 蓝色分组 + `browser_tabs group/ungroup`，实测台 23 项。折叠（collapsed）没做，Chrome 那个字段不在归组路径里 |
| `idle` | 检测到用户回到浏览器 → 自动让出控制权 / 暂停动作 | **很值**，这是安全特性不是便利特性 |
| `notifications` | 需要登录、验证码、付款确认时喊人（配合"人在环"） | 值 |
| `power` | 长任务期间阻止系统休眠 | 值，小 |
| `webNavigation` | 精确的导航开始/完成/重定向链事件，替掉现在轮询 `readyState` 的等待 | 值（和 `browser_wait` 配合） |
| `downloads` | 真正下载文件到磁盘并等完成（现在只能截图/PDF 落盘） | 值，但要防"agent 随意写盘" |
| `sessions` | 恢复被 agent 关错的标签 | 中等 |
| `sidePanel` | 侧栏实时面板（帧流 + 当前动作 + 一键接管） | 中等，工作量不小 |
| `history` / `bookmarks` / `readingList` / `topSites` | "我上周看过的某个页面"、归档、收藏 | 隐私敏感，建议做成**默认关**的可选能力 |
| `offscreen` | 长时后台任务（视频编码、大文件处理）不被 SW 回收打断 | 需要时再说 |
| `contextMenus` | 右键菜单把当前页/选区一键交给 agent | 便宜好用 |
| `system.*` / `geolocation` | 诊断信息；伪造定位 | 定位是真实需求（测试地理相关页面），其余低 |

## 第 3 层：要 host 权限（成本最高，谨慎）

`scripting` + `<all_urls>` 或 `activeTab` 才涉及这一层。

- **`activeTab`（推荐）**：用户点一下扩展图标，才把**当前那个标签**的权限给我们。商店审查轻、用户看得懂。
- **`<all_urls>`（BrowserSkill 选了它）**：能随时向任意页面注入内容脚本。代价是安装时那句"读取并更改您在所有网站上的所有数据"，以及审核周期。

拿到之后多出的能力：不挂 CDP 也能读写 DOM（内容脚本）、`userScripts`、`webRequest` 观察、`declarativeNetRequest` 屏蔽/改包。

**但有一条要先想清楚**：我们现在的核心卖点是"控制期间 Chrome 显示『正在被调试』横幅，所有操作实时可见"（`SECURITY.md`）。内容脚本路线**不显示这个横幅**，能力更强、可见性更弱。要不要为了能力牺牲这条承诺，是产品定位问题，不该顺手做。我的建议：**不引入 `<all_urls>`**；真需要内容脚本时走 `activeTab`，并且保留"横幅可见"作为默认路径。

## 我们本来就更强的地方（别妄自菲薄）

BrowserSkill 明确没有：PDF 导出、网络日志整体导出与过滤、console 抓取、弹窗 `dismiss`/自定义 prompt 应答、`browser_info` 这类自省工具、`SECURITY.md` 与私密漏洞报告渠道。第 1 层里的 cookie 读写、请求 mock、拖拽、MHTML 存档，它也都缺。

## 建议的下一版（1.1.0）

按"零权限增长优先 + 每步都有实测"排：

1. `browser_snapshot` 增加 AX 模式（`Accessibility.getFullAXTree`），并让 `browser_click` / `browser_type` 接受 `role+name` 定位 —— 抗改版，agent 成功率提升最明显
2. `Target.attachToTarget(flatten)` 打通跨域 iframe —— 解掉一个已知限制
3. `browser_cookies`（读/设/清）+ 明确写进 SECURITY.md —— 竞品没有的差异化能力
4. `webNavigation` 事件驱动的等待（替轮询），配合已有的 `browser_wait`
5. ~~`tabGroups`~~（已做完）+ `idle` + `notifications` —— "AI 在动哪个标签"已经能看见了；剩下"用户回来了就撒手"和"要验证码时喊人"
6. 请求拦截 `Fetch.*`（mock/屏蔽）—— 面向"用 agent 做前端自测"的新场景

第 1、2、3、6 全都不需要新权限；4、5 各加一项轻权限。第 5 项的前半（`tabGroups`）已经在 main 上。
