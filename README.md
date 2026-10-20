# DSH Browser Control

<p align="center">
  <img src="extension/icons/icon128.png" width="100" alt="DSH Browser Control">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/caob23/dsh-browser-control/releases"><img src="https://img.shields.io/github/v/release/caob23/dsh-browser-control" alt="release"></a>
  <a href="https://github.com/caob23/dsh-browser-control/blob/main/LICENSE"><img src="https://img.shields.io/github/license/caob23/dsh-browser-control" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin"></a>
  <a href="https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline"><img src="https://img.shields.io/badge/Chrome-MV3-yellow" alt="chrome mv3"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-purple" alt="dsh plugin"></a>
  <img src="https://img.shields.io/badge/CDP-powered-orange" alt="cdp">
  <img src="https://img.shields.io/badge/tools-11-red" alt="11 browser tools">
  <img src="https://img.shields.io/badge/tests-29%2F29-brightgreen" alt="tests">
</p>

Chrome 浏览器扩展 + DeepSeek Harness 插件，让 AI Agent 像人一样操控你的真实浏览器。

<p align="center">
  <img src="assets/banner.png" width="480" alt="DSH Browser Control — a whale searching Google with a mouse">
</p>

## 这是什么

不是无头浏览器，不是 Puppeteer——是你的**真实 Chrome**，带着你的登录态、你的 cookies。AI 通过 Chrome DevTools Protocol 驱动标签页，你可以在屏幕上看到每一步操作。

```
你对 AI 说一句话
      ↓
Agent 调用 browser_* 工具
      ↓
DSH 插件（WebSocket 桥）
      ↓
Chrome 扩展（CDP 驱动）
      ↓
你的真实浏览器执行操作
      ↓
结果返回给 Agent
```

## 和 MCP 浏览器方案的区别

市面上已经有 Playwright MCP、Puppeteer MCP、browser-use 等，它们的共同点：启动一个**自己下载的全新浏览器实例**。本项目走的是另一条路：

| | 本项目 | Playwright / Puppeteer MCP |
|---|---|---|
| 浏览器 | 你正在用的真实 Chrome | 自动下载的独立实例 |
| 登录态 / Cookies | ✅ 全部继承，无需重新登录 | ❌ 每次全新 profile |
| 过验证码 / 扫码登录 | 你的会话已经登录，基本不遇到 | 经常卡在登录墙 |
| 可见性 | 屏幕上实时可见，agent 新建的标签自动归进 `DSH` 分组，随时鼠标接管 | 无头运行或独立窗口 |
| 环境依赖 | 无需 Node / npx / Python | 需要 npx 或 uvx 运行时 |
| 接入方式 | 加载扩展 + 设置页开关 | 编辑 MCP 客户端 JSON 配置 |
| 磁盘占用 | 复用现有 Chrome，零新增 | 额外下载数百 MB 浏览器 |
| 集成深度 | dsh 原生插件（状态页 / 清理按钮；设置页卡片由宿主版本决定，见下） | 通用 MCP server |

一句话：**要 AI 用"你自己的"浏览器干活（已登录的 B 站、知乎、淘宝后台），用本项目；要做跨浏览器、跨应用的通用自动化测试，用 MCP。**

## 下载

| 文件 | 说明 |
|---|---|
| [DSH-Browser-Control-v1.0.17.zip](https://github.com/caob23/dsh-browser-control/releases/download/v1.0.17/DSH-Browser-Control-v1.0.17.zip) | Chrome 扩展（解压后加载；标准 zip 头，资源管理器可直接展开） |
| [dsh-browser-control-plugin-v1.0.17.zip](https://github.com/caob23/dsh-browser-control/releases/download/v1.0.17/dsh-browser-control-plugin-v1.0.17.zip) | dsh 插件（离线兜底，在线装直接用方式 A/B） |

## 安装 Chrome 扩展（30 秒）

下载 zip → 解压到固定文件夹（别删）→ Chrome 打开 `chrome://extensions` → 开启「开发者模式」→ 点「加载已解压的扩展程序」→ 选解压后的文件夹。

工具栏出现鲸鱼图标 → 绿点呼吸 = 已连接。需要 Chrome 116+。

## 安装 dsh 插件

📦 本包是 bundle 包（package.json 中 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。`dsh plugin` 安装成功后会自动把它加入 profile 的 `dsh.profile.bundles`，重启即加载。

前置：`dsh plugin` 转发给 pnpm，需要 pnpm 在 PATH 上；首次使用会自动初始化目标 profile。

### 方式 A：从 npm 安装（推荐）

```bash
# 通过 dsh plugin 从 npm registry 安装并自动注册到 profile
dsh plugin --profile web add @caob23/dsh-browser-control
```

如果自行管理 profile 的 node_modules，也可以在对应目录中直接使用 npm 安装：

```bash
npm install @caob23/dsh-browser-control
```

> **刚发布的新版本可能一时装不上，那不是插件坏了。** `dsh plugin add` 会把依赖钉成**确切版本号**，而 pnpm 用的是**你自己配置的源**——国内默认常常是 `registry.npmmirror.com`，它同步官方源有延迟（实测 1.0.10 在官方源已发布时，镜像的 `latest` 还停在 1.0.8）。撞上 `ERR_PNPM_NO_MATCHING_VERSION ... while fetching it from https://registry.npmmirror.com/` 时有三条路：
>
> 1. 这一次显式走官方源：`dsh plugin --profile web add @caob23/dsh-browser-control@<版本> --registry=https://registry.npmjs.org/`
> 2. 用 Release 里的离线包 `dsh-browser-control-plugin-v<版本>.zip`，解压后 `dsh plugin --profile web add file:<解压目录>`
> 3. 等镜像同步后重试原命令：`curl -s https://registry.npmmirror.com/@caob23%2Fdsh-browser-control`，看到该版本、且 `dist-tags.latest` 也跟上即可
>
> **另一种装不上长得像、原因完全不同，别改 registry。** dsh 的 profile 自带 24 小时「包龄」供应链闸门（`node_modules/.pnpm-workspace-state-v1.json` 里的 `minimumReleaseAge: 1440`）。发布未满 24 小时的版本被它拦下时报的是 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，而且报文里会直接写 `was published at …, within the minimumReleaseAge cutoff (…)`——版本是**存在**的，只是太新。这种只有等满 cutoff 时刻这一条路（改 registry、离线包都不必）。两个码的判据：`NO_MATCHING_VERSION` = 你配置的源里没有这个版本；`NO_MATURE_MATCHING_VERSION` = 有，但没满 24 小时。

### 方式 B：从 GitHub 或本地目录安装

```bash
# 直接从 GitHub 安装
dsh plugin --profile web add "github:caob23/dsh-browser-control#v1.0.17"

# 本地目录调试（注意：必须显式 file: 前缀）
dsh plugin --profile web add "file:D:\path\to\dsh-browser-control"
```

重启 DSH 后生效。卸载：

```bash
dsh plugin --profile web remove @caob23/dsh-browser-control
```

> ⚠️ 本地目录请用 `file:` 前缀。裸路径 / 相对路径会被 pnpm 当作 `link:` 协议，
> 在 hoisted 布局下不会物化到 node_modules 顶层，导致启动时无法解析该包。

安装并重启后，桥接默认开启（v1.0.6+），不需要再去设置里手动启用。状态页 http://127.0.0.1:9777/ 可看到服务已监听。

> 想关掉默认开启：在你的 profile 覆盖层 `$DSH_HOME/profiles/<名字>/cordis.patch.yml` 里写
> `- id: browser-bridge` + `config: { enabled: false }` 即可（写法见 [dsh-config/README.md](dsh-config/README.md)）。
> 注意包内 `cordis.patch.yml` 里那份 `enabled: true` 不要改回 false —— 那会盖掉 schema 默认值，
> 表现为装上后 9777 无人监听（issue #4）。

### 方式 C：复制进 harness 源码树（旧方式，v1.0.2 及以前）

```bash
git clone https://github.com/caob23/dsh-browser-control.git
cd dsh-browser-control
git checkout v1.0.2   # 旧布局在 v1.0.2 tag
./install.sh /你的路径/deepseek-harness
```

脚本只负责把插件文件复制到位，**完成后仍需手动改三处配置**，改完重启 dsh 才会生效：

下载 [`dsh-browser-bridge-plugin-v1.0.2.zip`](https://github.com/caob23/dsh-browser-control/releases/download/v1.0.2/dsh-browser-bridge-plugin-v1.0.2.zip)，解压到 deepseek-harness 的 `packages/web/browser-bridge/`。

然后补充三处配置：

1. `packages/bundle/base/package.json` 的 dependencies 加：

```json
"@deepseek-ai/dsh-browser-bridge": "workspace:^"
```

2. `cordis.patch.yml` 的 plugins 列表加：

```yaml
- id: browser-bridge
  name: '@deepseek-ai/dsh-browser-bridge'
  config:
    enabled: false
```

3. `tsconfig.host.json` 的 references 加：

```json
{ "path": "./packages/web/browser-bridge" }
```

重启 dsh。详细说明见 [dsh-config/README.md](dsh-config/README.md)（注意这一条路径针对 v1.0.2 及以前的旧布局，当时的默认就是 `enabled: false`）。

## 使用

1. 装好即默认开启（v1.0.6+），不需要手动启用
2. Chrome 扩展自动连接（端口 9777，Token 默认 dsh-local）
3. 对话说自然语言，Agent 自动操控浏览器

### 「设置 → 插件」里有没有这张卡片，取决于宿主版本（issue #5）

npm 发布的 bundle 只含宿主侧 `lib/index.js`，没有浏览器端模块，所以卡片不是插件自己画的：

| 宿主 | 设置页 | 改配置的办法 |
|---|---|---|
| dsh 0.1.7+ / 0.2.x（dsh-settings 0.1.7-rc.2 起） | 有——宿主按插件自身 `Config` schema 自动投影出这一节 | 设置页，或 profile 覆盖层 |
| dsh 0.1.2 及更早 | 没有条目（没有客户端半区认领命名空间，宿主就不渲染） | 只能改 profile 覆盖层 `$DSH_HOME/profiles/<名字>/cordis.patch.yml` |

两边都能改的就是配置文件，写法见 [dsh-config/README.md](dsh-config/README.md)。

访问 `http://127.0.0.1:9777/` 查看连接状态。

### agent 开的标签长什么样（自动归进 DSH 分组）

Agent **新建**的标签页会自动收进当前窗口的一个 `DSH` 蓝色标签分组里（每个窗口一组），所以你扫一眼就知道哪些页面是机器开的、哪些是自己开的，事后也能一把清掉：

- `browser_tabs` `action: "ungroup"` 拆掉本窗口的组（带 `windowId` 只拆那一个窗口，不带则所有窗口）——只拆标签归属，不关标签。
- `browser_tabs` `action: "open"` 加 `group: false` 可以显式让新标签留在组外；`action: "group"` 能把早就存在的散标签拉进来。
- 归组是锦上添花：Chrome 版本太旧、权限没给、或刚建标签就被用户拖动导致失败时，**开标签本身照常成功**，结果里带 `grouped: false` 和原因。分组动作不改页面内容，重试安全。
- `browser_tabs` `action: "close"` 一次可以关一个（`tabId`）或一批（`tabIds`）；一批在链路上只发**一条命令**。结果把每个 id 的去向都写出来：`closed` / `alreadyGone`（早就没了＝幂等成功，重试安全）/ `failed`（带原因）——部分失败不会被吞掉，单数与批量同一个形状。

### 一键冻结：扩展弹窗里的「锁定」

点扩展图标，按钮行中间那个「锁定」，**单击即生效**：此后扩展对模型**拒绝一切浏览器操作**
（点击、输入、按键、导航、执行脚本全拦），而 WebSocket 连接照常——调用方看到的是
「连得上但被冻结」，不是掉线，所以不会误当作网络问题去重试。

- 解锁只有一条路：**在同一个弹窗里点「已锁定」**。桥接侧没有任何解锁命令，模型的工具面里也没有。
- 冻结状态落在 `chrome.storage.local`，所以 MV3 把 service worker 回收掉也不会「自己解冻」。
- 图标徽标在上锁期间显示红色 `LOCK`，不会继续显示绿色的 `ON` 骗人。
- 为什么客户端而不是桥接侧管这件事：桥的 token 就写在 profile 的 `cordis.patch.yml` 里，模型读得到也改得动；
  把「冻结」放在浏览器里、且只留一个人工通道，才真的挡得住。

### 用脚本直连 HTTP（curl 等）

`/api/command` 与 `/api/cleanup` 现在要求 Token，用的就是扩展连 WS 时那个值：

```bash
curl -X POST http://127.0.0.1:9777/api/command \
  -H 'Authorization: Bearer <你的 token>' \
  -H 'Content-Type: application/json' \
  -d '{"command":"nav","params":{"url":"https://example.com"}}'
```

也可以写 `?token=<你的 token>` 或 `X-Token: <你的 token>`。不带、或带错，一律 401；`/` 与 `/api/status` 仍是免鉴权的只读信息。之前「不带 Token 也能调通命令面」的行为已经失效（issue #3 / #6）。状态页上的清理按钮会要求你把 Token 输一次，只记在浏览器会话里。

## 工具清单

| 工具 | 功能 |
|---|---|
| `browser_navigate` | 导航到 URL |
| `browser_read` | 读取页面文本/HTML，正文直接给模型（`offset`/`limit` 窗口，长文分页） |
| `browser_snapshot` | 页面快照 → 逐条列出 ref 的交互树（`mode:"ax"` 走 Chrome 无障碍树，拿 role + 可访问名） |
| `browser_click` | 点击元素（by ref / selector） |
| `browser_type` | 在输入框填入文本 |
| `browser_press` | 模拟键盘按键（回车、Tab、方向键，以及 "Ctrl+A" / "Shift+ArrowRight" 这类组合键；一次按键只插入一次） |
| `browser_scroll` | 滚动页面 |
| `browser_wait` | 等元素出现 / 等文本出现 / 等条件为真（最长 120 秒，v1.0.9+） |
| `browser_find` | 按 CSS 选择器查元素，返回数量与位置尺寸（只读，v1.0.9+） |
| `browser_dialog` | 读改原生弹窗应答策略 accept/dismiss/manual，并回最近弹窗记录（v1.0.9+） |
| `browser_tabs` | 标签页管理（列表/新建/关闭/切换/归组/拆组；见「agent 开的标签长什么样」） |
| `browser_evaluate` | 执行任意 JS |
| `browser_screenshot` | 截取页面截图 |
| `browser_console_log` | 抓取页面 console 日志并逐条给出正文（v1.0.7+） |
| `browser_network_log` | 抓取 HTTP 请求/响应并逐条给出方法/状态/URL（v1.0.7+） |
| `browser_network_clear` | 单独清空网络日志缓冲（v1.0.7+） |
| `browser_pdf` | 当前页导出 PDF（v1.0.7+） |
| `browser_emulate` | 切设备视口（移动 / 桌面 / 自定义，v1.0.7+） |
| `browser_cleanup` | 清理临时文件 |
| `browser_info` | 报告实际连上的浏览器与扩展版本（排障先跑它，v1.0.9+） |

共 20 个工具。`browser_wait` / `browser_find` / `browser_dialog` / `browser_info` 在 v1.0.8 及以前是「扩展里已实现、但没注册成工具」，agent 调不到；`browser_network_clear` 则是代码里有、这张表漏了。这四条现在由 `verify/verify_surface.mjs` 做三方对账（扩展命令表 ↔ 插件调用 ↔ 文档表 ↔ 构建产物），漂移会直接让 `npm run verify` 失败。

## 架构

```
Chrome 浏览器
  └─ DSH Browser Control 扩展 (MV3)
       └─ chrome.debugger (CDP)
            └─ WebSocket ──────→ DSH 插件 (browser-bridge)
                                      └─ browser_* 工具 → Agent
```

**关键设计：**
- 扩展主动外连桥（不需要 native messaging host）
- 默认开启（v1.0.6+），装上即监听，不需要手动启用
- 持久 debugger 附着——控制期间横幅始终显示
- 仅监听 127.0.0.1；命令面（WS 与 HTTP）共用同一个 Token，跨源一律不放行
- 协议版本独立于版本号：帧契约变了才升，不匹配时状态页直接写出该升级哪一侧

## 已验证

| 场景 | 结果 |
|---|---|
| 百度搜索 → 提取结果标题 | ✅（1.0.x 时期实机） |
| B 站搜索用户 → 发私信 | ✅（1.0.x 时期实机） |
| B 站搜索 → 统计视频卡片 + 截图 | ✅（1.0.x 时期实机） |
| 实测台 `npm run verify`：配置解析、三种宿主形状、HTTP 鉴权与升级来源、发布产物行为 | ✅ 2026-10-10，见 [verify/README.md](verify/README.md) |
| 实测台 `verify_tab_groups`：agent 标签归组的建组 / 复用 / 退避重试 / 缓存失效 / 按窗口拆组 / 无权限降级 | ✅ 2026-10-11，node:vm + 有状态假 `chrome.tabs`/`chrome.tabGroups`，**未在真实 Chrome 里重跑** |
| 实测台 `verify_extension_e2e`：真桥 + 真扩展代码 + 真 WebSocket 端到端（帧契约、命令可达、错误分类） | ✅ 2026-10-11，只有 `chrome.*` 是假的；视觉与真实 CDP 行为仍需实机确认 |
| 实测台 `verify_cdp_retry`：CDP 会话被抢走后的恢复 / 重放不许把副作用做两遍 / 重试有界（6 场景） | ✅ 2026-10-11，真实 `background.js` + 有状态假 `chrome.debugger`；另用合并预览文件交叉验证过 |
| 实测台 `verify_render_contract`：每条工具的真实返回值同时喂给宿主的输出校验器与它自己的 `render`，断言「模型可见文本里有这次调用真正要的数据」 | ✅ 2026-10-12，真桥 + 假扩展 + 宿主 `validateJsonSchemaValue`；这一层此前**零覆盖**，所以两类缺陷活了 12 / 5 个版本 |
| **真实宿主 × 真实浏览器**：本机 dsh `0.2.0-rc.2` 用隔离 `DSH_HOME` 挂载本插件，用户的真实 Chrome 连上桥，9 条只读工具全部走真实代码路径 | ✅ 2026-10-12，Chrome 153 + 扩展 1.0.10：`browser_read` 交出 1341 字符真实正文、`browser_snapshot` 交出 14 条带 ref 的清单、输出 schema 零违规；**也正是这一跑发现了旧扩展会静默忽略 `mode:"ax"`**（本机扩展是 1.0.10，早于 AX 快照的 1.0.11）——已改成插件侧显式回报 `axFallback` |
| `tsc --noEmit` + `publint` | ✅ 2026-10-10 |

仓库自 v1.0.4 起不再有单测目录，上面三条浏览器场景是历史实机记录，本版未重跑；本版结论都来自 `verify/` 里可重复执行的实测台。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证 · License

本项目采用 **GNU Affero General Public License v3.0 (AGPL-3.0)**。

- **个人 / 学术 / 非商业用途**：完全免费，在遵守 AGPL-3.0 的前提下自由使用、修改、分发
- **企业 / 商业用途**：AGPL-3.0 要求通过网络使用本软件也构成"分发"，必须公开衍生代码。若企业在闭源产品中嵌入、基于本项目构建 SaaS 服务而不愿开源，需要联系作者获取**商业许可**（另行协商授权条款）
- **商业许可咨询**：[GitHub Issues](https://github.com/caob23/dsh-browser-control/issues) 或邮箱 **caob2333@outlook.com**

完整许可证文本见 [LICENSE](LICENSE) 文件（AGPL-3.0）。
