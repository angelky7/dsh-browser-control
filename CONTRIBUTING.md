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
2. `CHANGELOG.md` 的 `Unreleased` 段落落成正式版本标题
3. 打 tag、建 Release，资产沿用现有命名：`DSH-Browser-Control-vX.Y.Z.zip`（扩展）、`dsh-browser-control-plugin-vX.Y.Z.zip`（插件）
4. **插件离线包里必须有 `cordis.patch.yml`**——`package.json` 的 `dsh.bundle.patch` 指向它，v1.0.7 那份资产漏了这个文件，离线安装就等于没挂载；扩展包必须含 `extension/` 下全部文件（含 `icons/`）
5. README / README.en 的下载链接改成新名字，然后跑上面那条链接实测
6. **校验和写在 Release 正文里，不要上传 `.sha256` 附件**：正文列 文件名 / 字节数 / SHA-256（必要时加 MD5），上传后匿名下载回来核对头 4 字节、`unzip -t` 与条目分隔符
7. `npm publish`（`files` 白名单不含 `verify/` 和 `extension/`，发包前确认 `lib/` 已是最新）。这台机器 `~/.npmrc` 的默认源是 npmmirror 镜像，**不能发布**；包里的 `publishConfig.registry` 已写死官方源，别再依赖命令行默认值

## 写宿主适配时会踩的坑

- `dsh-settings` 的导出面按版本变：`0.1.2-rc.1` 有 `register`，`0.1.7-rc.2` / `0.2.0-rc.2` 只有 `SettingsForms`（`configure/describe/update/replace/mutate`）。不用装宿主，`npm pack @deepseek-ai/dsh-settings@<ver>` 解包 grep 就能确认。
- schemastery 的 schema 本身就是校验函数：`Config(data)` 直接返回补齐默认值后的对象，没有 `.parse()`。
- cordis 的 `ctx.effect(execute, label)`，`execute` 的**返回值**才是 teardown 函数，所以注册 disposer 写成 `ctx.effect(() => dispose, 'label')`。
- 桥接的 Token 是唯一的实际边界，回环绑定不是。任何放宽 HTTP 面的改动都要同时考虑 `Origin` 与 `Host`（WebSocket 握手不受 CORS 约束）。
- **`@deepseek-ai/*` 这一族没有稳定版**（`latest` dist-tag 停在 `0.0.1-rc.1`，真版本在 `next`/`alpha`），而 semver 对预发布版有条硬规则：`0.2.0-rc.2` 只有当范围里存在**同 `[major,minor,patch]` 元组**且也带预发布的比较符时才匹配。所以 `">=0.1.0-rc.1 <0.3.0-0"` 这类"看着宽松"的写法实际谁也匹配不到（v1.0.8 就这么写过，锁文件因此把宿主 API 钉在 0.1.0-rc.8 上，typecheck 校的是半年前的类型）。**写法只认三种**：精确钉版 `0.2.0-rc.2`、稳定版 `~4.0.4` / `^3.18.4`、或它们的 `||` 并列；`verify/verify_peers.mjs` 会拦其他形态。
- 宿主注入的包（cordis / dsh-tools / dsh-settings / dsh-invariants）**只能是 peer**，且跟官方插件一样按宿主世代逐个精确钉版；宿主换代时要手动改这几行（旧宿主不会装不上，pnpm 只给一条 peer 警告）。纯工具库 `@deepseek-ai/schemastery` 反过来必须是 `dependencies`。判据是「装出第二份会不会坏事」——宿主包的实例必须与宿主同源，重复一份会让服务注入/工具注册失效。

## 提交规范

- 一个 PR 只做一件事，拆分独立改动
- 提交信息用英文，格式：`feat: xxx` / `fix: xxx` / `docs: xxx`
- 改了 `src/` 就把重新构建的 `lib/` 一起提交，别让它落后
- 修 issue 的提交里写清**实测证据**（跑了什么、看到什么），而不是只写结论

## 报告问题

提 Issue 时请附上：dsh 版本、Chrome/Edge 版本、桥接状态页（`http://127.0.0.1:9777/`）的输出、`netstat -ano | findstr :9777` 的结果，以及 npm 包的版本号（`npm ls @caob23/dsh-browser-control`）。

更多实测台的坑与结论记录见 [verify/README.md](verify/README.md)。

