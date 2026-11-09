# 工具清单（30 个）

按用途分组的完整表；入参与回执的边界见 [BEHAVIOR.md](BEHAVIOR.md)。

| 工具 | 功能 |
|---|---|
| `browser_navigate` | 导航到 URL |
| `browser_read` | 读取页面文本/HTML，正文直接给模型（`offset`/`limit` 窗口，长文分页） |
| `browser_snapshot` | 页面快照 → 逐条列出 ref 的交互树（`mode:"ax"` 走 Chrome 无障碍树，拿 role + 可访问名）；v1.7.7 起支持 `offset` **分页**：页头写明「第几到第几 / 页面总数 / 下一页 offset」，超出扩展 200 条窗口的部分如实说明用 find/read 补齐 |
| `browser_click` | 点击元素（by ref / selector） |
| `browser_type` | 在输入框填入文本 |
| `browser_press` | 模拟键盘按键（回车、Tab、方向键，以及 "Ctrl+A" / "Shift+ArrowRight" 这类组合键；一次按键只插入一次） |
| `browser_scroll` | 滚动页面 |
| `browser_wait` | 等元素出现 / 等文本出现 / 等条件为真（最长 120 秒，v1.0.9+） |
| `browser_find` | 按 CSS 选择器查元素，返回数量与位置尺寸（只读，v1.0.9+） |
| `browser_dialog` | 读改原生弹窗应答策略 accept/dismiss/manual，并回最近弹窗记录（v1.0.9+） |
| `browser_hold` | 在某个标签页上加/撤一层可取消的接管浮层（告知用户 + 防误触）；`covered:false` 时说明盖不住的原因。软层，不是安全边界 |
| `browser_cookies` | 读/设/删某标签页可见的 cookie（`action: get/set/remove`；get 带 `domain` 过滤，set/remove 需要 `url` 或 `domain` 锚点，remove 复查并回报 `remaining`）。**cookie 的值是凭据**，get 会把值完整放进模型可见文本——见 SECURITY.md |
| `browser_tabs` | 标签页管理（列表/新建/关闭/切换/归组/拆组；v1.7.0 起支持历史 back/forward——落地判据与 navigate 同一套，历史尽头如实报 unchanged） |
| `browser_evaluate` | 执行任意 JS |
| `browser_screenshot` | 截取页面截图（v1.7.0 起回执带**真实像素尺寸**；fullPage 一张截全页、selector 只截一个元素） |
| `browser_console_log` | 抓取页面 console 日志并逐条给出正文（v1.0.7+） |
| `browser_network_log` | 抓取 HTTP 请求/响应并逐条给出方法/状态/URL（v1.0.7+） |
| `browser_network_clear` | 单独清空网络日志缓冲（v1.0.7+） |
| `browser_pdf` | 当前页导出 PDF（v1.0.7+） |
| `browser_archive` | 整页存成单文件 MHTML（正文/图片/样式全内联，可当文本 grep 的离线证据；是快照，内嵌脚本不会跑，v1.5.0+） |
| `browser_emulate` | 切设备视口（移动 / 桌面 / 自定义，v1.0.7+）；v1.7.1 起还能限速：`network` slow3g/fast3g/offline/reset + `cpuThrottlingRate`（1–20），回执写明生效数值，`device:"reset"` 一并还原 |
| `browser_metrics` | 读性能计数器（DOM 节点数 / JS 堆 / 布局与脚本耗时，Performance.getMetrics，只读；让「这页面很重」有数字说话，v1.7.1+） |
| `browser_drag` | 拖拽：from/to 用选择器或视口坐标；`auto` 对 `draggable="true"` 的源走 html5 事件合成（dragstart→dragover→drop，未接受就不 drop），其余走真实鼠标输入（按下→插值移动→抬起，滑杆/画布/排序组件用这个）。**纯插件实现**（经 v1.7.2 预埋的 cdp 通道），v1.7.3+ |
| `browser_upload` | 把本机文件设到页面的 file input（走 CDP `DOM.setFileInputFiles`，不弹原生选择器）。**默认关闭**：需在 browser-bridge 配置里设 `allowUpload: true` + `uploadDir`（绝对目录），只允许该目录内的文件（符号链接按解析后的真实路径判断）；回执带每个文件的真实字节数。下一版 |
| `browser_audit` | 读本次插件会话的内存审计账本：发过/被拒的每条命令（参数脱敏、`code`/`effectState`、耗时），最多 200 条、dsh 重启即清；输入的文字与 cookie 值打码、URL 查询值与敏感片段打码、错误文本里的 URL 同样打码、eval 表达式截断。回执里的 `journal` 说明本次是否在写盘（`enabled:false` + `error` = 仅内存）。纯本地读，只读档下照常可用（v1.7.4+） |
| `browser_journal` | 读**跨 dsh 重启**的持久命令账本（`<stateDir>/journal.jsonl`，最多 1000 条，按运行分组）——重启后先问它「上个会话在哪个标签页干了什么」；同样的脱敏规则；`journal.enabled` 说明**本次**运行是否在写盘（false 时你看到的是更早的运行）。纯本地磁盘读，**扩展离线也能用**（v1.7.5+） |
| `browser_sessions` | 多 session 隔离：列出共用这个浏览器的 dsh 会话与各自的**工作标签页**；`action:"release"` 释放自己的。省略 tabId 的调用默认落到**本会话**的工作标签页（先核验还开着），并发会话不再互相抢活动页；显式 tabId 永远有效。纯本地，v1.7.6+ |
| `browser_windows` | 窗口控制：清单/开窗/改状态与几何/关整窗/跨窗挪标签（唯一能碰窗口几何的工具，v1.6.0+） |
| `browser_cleanup` | 清理临时文件 |
| `browser_info` | 报告实际连上的浏览器与扩展版本（排障先跑它，v1.0.9+） |


