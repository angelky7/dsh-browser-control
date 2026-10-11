# 贡献指南

[English](docs/en/CONTRIBUTING.en.md)

## 仓库形状

- `src/` 是插件源码，`extension/` 是 MV3 扩展，两者**互不依赖**：扩展只连 WS。
- `lib/` 是构建产物，但**按约定提交进仓库**，这样 GitHub 安装零编译。改了 `src/` 必须重新构建并把 `lib/` 一起提交，否则发出去的包和源码不一致——v1.0.7 就这么栽过：`src/` 有 16 个工具，npm 里的 `lib/index.js` 只注册了 11 个。

## 开发流程

```bash
npm install
npm run check     # tsc --noEmit + tsdown 构建 + publint
npm run verify    # verify/ 里的实测台，会占用 127.0.0.1:9777
```

`npm run verify` 覆盖的是：配置解析（包内 patch 与 schema 默认谁赢）、三种宿主形状下 `apply()` 的行为、HTTP 面的鉴权与 WebSocket 升级来源、以及**发布产物 `lib/index.js`** 的同样行为。每条 issue 的结论都应能在这里复现，别把推断当实测。

只改 `extension/` 时不会动 `lib/`；只改文档时两个都可以不跑，但改动涉及下载链接要跑：

```bash
curl -s "https://api.github.com/repos/caob23/dsh-browser-control/releases?per_page=100" -o /tmp/releases.json
node verify/verify_release_links.mjs /tmp/releases.json
```

## 打包扩展 zip

必须用 Python `zipfile` 或 `tar` 这类标准写法，产出要满足：**文件头就是 `PK\x03\x04`**（不能带 multipart 前言）、**条目分隔符为正斜杠**。Windows 资源管理器只认文件头，前面多出 162 字节的 `------formdata-undici-…` 就拒绝展开，而 7-Zip / `tar` / Python 会往里搜 `PK`，于是「一人解压失败、另一人包完好」会同时为真（issue #2）。上传后**匿名再下载一次**，核对头 4 字节、`unzip -t` 与条目分隔符；校验和按下面「发布」第 6 条写在 Release 正文里。

## 发布

1. 同步版本号：`package.json` 与 `extension/manifest.json`（改了扩展行为时）
2. `CHANGELOG.md` 的 `Unreleased` 段落落成正式版本标题；README / README.en 的下载链接与 `#vX.Y.Z` 引用改成新版本名
3. **先 `npm publish`，后打 tag / 建 Release**（v1.0.10 就是先把 Release 发出去了，结果用户装不到）。这台机器 `~/.npmrc` 的默认源是 npmmirror 镜像，**不能发布**；包里的 `publishConfig.registry` 已写死官方源，别再依赖命令行默认值。`files` 白名单不含 `verify/` 和 `extension/`，发包前确认 `lib/` 已是最新
4. **发布后要等镜像同步再宣布**：`dsh plugin add` 会把依赖**钉成确切版本号**，而宿主用的是用户自己的 registry（国内多半是 `registry.npmmirror.com`）。镜像没跟上时 pnpm 直接 `ERR_PNPM_NO_MATCHING_VERSION`，安装失败。核对两条：`curl https://registry.npmjs.org/@caob23%2F<pkg>` 与 `curl https://registry.npmmirror.com/@caob23%2F<pkg>`，**两边都要看到该版本、且 `dist-tags.latest` 也跟上**，再说「装 XX 版」
5. 打 tag、建 Release，资产沿用现有命名：`DSH-Browser-Control-vX.Y.Z.zip`（扩展）、`dsh-browser-control-plugin-vX.Y.Z.zip`（插件）
6. **插件离线包里必须有 `cordis.patch.yml`**——`package.json` 的 `dsh.bundle.patch` 指向它，v1.0.7 那份资产漏了这个文件，离线安装就等于没挂载；扩展包必须含 `extension/` 下全部文件（含 `icons/`）
7. **校验和写在 Release 正文里，不要上传 `.sha256` 附件**：正文列 文件名 / 字节数 / SHA-256（必要时加 MD5），上传后匿名下载回来核对头 4 字节、`unzip -t` 与条目分隔符；最后跑 `verify_release_links.mjs` 确认文档链接不是死链

## 写宿主适配时会踩的坑

- `dsh-settings` 的导出面按版本变：`0.1.2-rc.1` 有 `register`，`0.1.7-rc.2` / `0.2.0-rc.2` 只有 `SettingsForms`（`configure/describe/update/replace/mutate`）。不用装宿主，`npm pack @deepseek-ai/dsh-settings@<ver>` 解包 grep 就能确认。
- schemastery 的 schema 本身就是校验函数：`Config(data)` 直接返回补齐默认值后的对象，没有 `.parse()`。
- cordis 的 `ctx.effect(execute, label)`，`execute` 的**返回值**才是 teardown 函数，所以注册 disposer 写成 `ctx.effect(() => dispose, 'label')`。
- 桥接的 Token 是唯一的实际边界，回环绑定不是。任何放宽 HTTP 面的改动都要同时考虑 `Origin` 与 `Host`（WebSocket 握手不受 CORS 约束）。
- **本机 `npm config get registry` 指的是 `registry.npmmirror.com`，它会滞后。** 判断「npm 上到底有没有某个版本」必须显式走官方源：`npm view <pkg> versions --registry=https://registry.npmjs.org/`，或直接 `curl https://registry.npmjs.org/<转义后的包名>`。踩过一次：拿镜像的结果断言「1.0.9 从没发布」，而官方源文档里它是 `2026-10-10T13:42:43Z` 就发出去了。
- **一条 peer 范围有两个读法完全不同的消费者，必须同时过两关。**
  - 宿主门禁（`@deepseek-ai/dsh-app-boot`，实测 `lib/index.js:294-300`）：只看名字为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，拿**宿主版本号**做 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，不过就 throw（`:931`）→ 整个插件 bundle 被跳过，要 `dsh plugin allow-version` 才救得回来。`cordis` / `schemastery` 不在这套筛选里。
  - 包管理器（pnpm / npm，默认语义**不带** includePrerelease）：拿**包自己的版本列表**匹配。semver 的预发布规则是「范围里得有同 `[major,minor,patch]` 元组的预发布比较符」，而 `@deepseek-ai/dsh-*` 全族没有任何稳定版（`latest` 停在 `0.0.1-rc.1`，真版本在 `next`/`alpha`）。
  - 两个坑各朝一边：`">=0.1.0-rc.1 <0.3.0-0"` 这种宽范围门禁全过，但解析器最大只给到 **0.1.0-rc.8**（v1.0.8 就这么写的，锁文件因此把宿主 API 钉在半年前那代）；只钉 `"0.2.0-rc.2"` 解析器满意，但 0.1.7 / 0.2.1 宿主会被判不兼容而整个跳过。**能同时过的写法是两条并列**：`0.2.0-rc.2 || >=0.1.0-rc.1 <0.3.0-0`——精确支当锚点，宽支给门禁放行。判据用 `npm view "<pkg>@<range>" version` 和宿主任意版本的 `satisfies(..., {includePrerelease:true})` 各跑一遍，别心算。
- **不要加 `engines.node`。** 官方 dsh 插件一个都没写，Node 版本归宿主决定，留着它只是给 `engine-strict` 的用户多摆一个会拒绝安装的开关（宿主门禁实测根本不读 engines）。
- 宿主注入的包（cordis / dsh-tools / dsh-settings / dsh-invariants）**只能是 peer**，不能同时出现在 `dependencies`——装出第二份宿主包会让服务注入/工具注册失效。纯工具库 `@deepseek-ai/schemastery` 反过来必须是 `dependencies`（官方插件也是这么做的，`~3.18.4`）。宿主换代时要手动把精确锚点改成新一代（`verify_peers.mjs` 会用宿主同款 semver 把两关都跑一遍并拦住改错）。

## 提交规范

- 一个 PR 只做一件事，拆分独立改动
- 提交信息用英文，格式：`feat: xxx` / `fix: xxx` / `docs: xxx`
- 改了 `src/` 就把重新构建的 `lib/` 一起提交，别让它落后
- 修 issue 的提交里写清**实测证据**（跑了什么、看到什么），而不是只写结论

## 报告问题

提 Issue 时请附上：dsh 版本、Chrome/Edge 版本、桥接状态页（`http://127.0.0.1:9777/`）的输出、`netstat -ano | findstr :9777` 的结果，以及 npm 包的版本号（`npm ls @caob23/dsh-browser-control`）。

更多实测台的坑与结论记录见 [verify/README.md](verify/README.md)。

