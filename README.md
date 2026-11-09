<div align="center">

<img src="extension/icons/icon128.png" width="100" alt="DSH Browser Control">

# DSH Browser Control

**让 AI 用你自己的浏览器干活——已登录的账号、看得见的操作、本机的文件。**

[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.md) [![English](https://img.shields.io/badge/lang-English-blue.svg)](README.en.md)

[![npm version](https://img.shields.io/npm/v/@angelky7/dsh-browser-control?style=flat&label=version&color=2EA44F)](https://www.npmjs.com/package/@angelky7/dsh-browser-control)
[![downloads](https://img.shields.io/npm/dm/@angelky7/dsh-browser-control?style=flat&label=downloads&color=2EA44F)](https://www.npmjs.com/package/@angelky7/dsh-browser-control)
[![CI](https://github.com/angelky7/dsh-browser-control/actions/workflows/ci.yml/badge.svg)](https://github.com/angelky7/dsh-browser-control/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license](https://img.shields.io/badge/license-AGPL--3.0-2EA44F?style=flat)](LICENSE)

</div>

## 这是什么

一个 dsh 插件 + 一个 Chrome 扩展：扩展通过本机 loopback（默认 `127.0.0.1:9777`）连到 dsh，模型就能在**你日常用的浏览器**里导航、读页面、点击、输入、拖拽、上传、截图、导出 PDF/MHTML、读写 cookie、看性能指标。

不用起 headless，不用把登录态搬来搬去，也不需要 MCP——它驱动的就是你屏幕上那个已登录的 Chrome。

- 30 个 `browser_*` 工具，agent 说人话就能用
- 操作可见：agent 开的标签自动进 `DSH` 分组；扩展弹窗一键锁定
- 本机闸门：只读 / 禁脚本 / 上传白名单
- 有账可查：操作审计 + 跨重启 journal
- 扩展一次装好：常规功能更新只更插件（扩展侧安全/平台修复除外）

## 安装

### 1. Chrome 扩展

下载 [DSH-Browser-Control-v1.7.2.zip](https://github.com/angelky7/dsh-browser-control/releases/download/v1.7.2/DSH-Browser-Control-v1.7.2.zip)，解压到固定文件夹（别删），打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选那个文件夹。需要 Chrome 116+；图标绿点 = 已连接。

> 装过 v1.7.2 的不用重装：v1.7.3–v1.7.10 的功能更新都不需要动扩展。

### 2. dsh 插件

```bash
dsh plugin --profile web add @angelky7/dsh-browser-control
```

或从 GitHub tag：

```bash
dsh plugin --profile web add "github:angelky7/dsh-browser-control#v1.7.10"
```

离线包：[dsh-browser-control-plugin-v1.7.10.zip](https://github.com/angelky7/dsh-browser-control/releases/download/v1.7.10/dsh-browser-control-plugin-v1.7.10.zip)，解压后对含 `package.json` 的那一层执行 `dsh plugin --profile web add file:<那一层>`。

装完重启 dsh。桥默认开启，状态页 <http://127.0.0.1:9777/>。刚发布的版本装不上（镜像延迟 / 24 小时包龄闸门）见 [安装排障](docs/INSTALL.md)。

## 快速开始

装好后直接对 agent 说：

> 用 browser_snapshot 看看当前页，再按 ref 点登录按钮。

常用入口：`browser_snapshot` 先看页面，`browser_read` 读正文，`browser_click` / `browser_type` 按 ref 操作，`browser_screenshot` 截图。完整说明见 [工具清单](docs/TOOLS.md) 与 [行为契约](docs/BEHAVIOR.md)。

## 安全开关

在 profile 覆盖层（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`）里给 `browser-bridge` 配：

```yaml
config:
  readOnly: true          # 只读：拒绝一切改页面/浏览器状态的命令
  allowScript: false      # 关掉 browser_evaluate 的任意 JS
  allowUpload: true       # 默认关；开启后必须配 uploadDir
  uploadDir: C:\Users\me\uploads
```

被拦的命令**不会发给浏览器**（零副作用），错误码 `blocked_by_policy`。`browser_upload` 是唯一能把本机文件交给页面的工具：默认关闭，只允许 `uploadDir` 内的文件（符号链接按真实路径判断）。写法与宿主版本差异见 [dsh-config/README.md](dsh-config/README.md)。

## 工具清单（30 个）

按用途分组；每个工具的入参、回执与边界见 [完整工具清单](docs/TOOLS.md)。

- 页面：`browser_navigate` `browser_read` `browser_snapshot` `browser_find` `browser_click` `browser_type` `browser_press` `browser_scroll` `browser_wait` `browser_evaluate` `browser_drag` `browser_upload`
- 标签与窗口：`browser_tabs` `browser_windows` `browser_sessions`
- 浏览器状态：`browser_cookies` `browser_dialog` `browser_hold` `browser_emulate` `browser_metrics` `browser_console_log` `browser_network_log` `browser_network_clear`
- 文件：`browser_screenshot` `browser_pdf` `browser_archive` `browser_cleanup`
- 账本：`browser_audit` `browser_journal`
- 身份：`browser_info`

> `browser_upload` 随下一版插件发布；npm 当前最新 1.7.10 是 29 个工具。

## 更多文档

| 文档 | 内容 |
|---|---|
| [工具清单](docs/TOOLS.md) | 30 个工具的入参、回执与边界 |
| [行为契约](docs/BEHAVIOR.md) | 导航到达、快照、锁、浮层、拖拽、上传等细节 |
| [安装排障](docs/INSTALL.md) | 镜像延迟、24 小时包龄、离线包、本地调试 |
| [安全模型](SECURITY.md) | token、权限与威胁边界 |
| [验证台](verify/README.md) | 各台子覆盖与断言清单 |
| [更新日志](CHANGELOG.md) | 版本历史 |

## 兼容性

命令面只增不改：**插件 x + 扩展 x-n 不倒退**（`verify_compat_matrix` 用真实历史扩展逐格跑）。扩展 v1.7.2 配合最新插件仍然工作；多实例路由在后续版本。

## 许可

**AGPL-3.0**。个人 / 学术 / 非商业用途免费；企业闭源嵌入或做 SaaS 而不愿开源衍生代码的，需要单独商业许可。商业许可：GitHub Issues 或 caob2333@outlook.com。完整条款见 [LICENSE](LICENSE)。
