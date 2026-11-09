# 安装与排障

## 前置

- Chrome / Edge 116+
- dsh（插件通过 `dsh plugin` 安装；它转发给 pnpm，所以 pnpm 要在 PATH 上）
- 首次使用会自动初始化目标 profile

## 1. Chrome 扩展

下载 [DSH-Browser-Control-v1.7.2.zip](https://github.com/angelky7/dsh-browser-control/releases/download/v1.7.2/DSH-Browser-Control-v1.7.2.zip) → 解压到固定文件夹（别删）→ `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压后的文件夹。

工具栏出现鲸鱼图标、绿点呼吸 = 已连接。

> v1.7.2 之后的功能更新（v1.7.3–v1.7.10）都不需要重装扩展；扩展侧的截断/焦点修复会随下一次扩展更新发布。

## 2. dsh 插件

### npm（推荐）

```bash
dsh plugin --profile web add @angelky7/dsh-browser-control
```

### GitHub tag

```bash
dsh plugin --profile web add "github:angelky7/dsh-browser-control#v1.7.10"
```

### 离线包

从 Release 下载 `dsh-browser-control-plugin-v<版本>.zip`，解压后对**含有 `package.json` 的那一层**执行：

```bash
dsh plugin --profile web add file:<那一层>
```

### 本地目录调试

```bash
dsh plugin --profile web add "file:D:\path\to\dsh-browser-control"
```

⚠️ 本地目录必须带 `file:` 前缀。裸路径/相对路径会被 pnpm 当作 `link:` 协议，在 hoisted 布局下不会物化到 node_modules 顶层，启动时无法解析。

装完**重启 dsh**。桥接默认开启（v1.0.6+），状态页 <http://127.0.0.1:9777/>。

## 装不上时：先看错误码

刚发布的版本可能一时装不上，原因有两种，长得像但处理方式相反：

### `ERR_PNPM_NO_MATCHING_VERSION`

你配置的源里没有这个版本。`dsh plugin add` 会把依赖钉成确切版本，而 pnpm 用的是你自己的源——国内常是 `registry.npmmirror.com`，它同步官方源有延迟。

三条路：

1. 这次显式走官方源：
   ```bash
   dsh plugin --profile web add @angelky7/dsh-browser-control@<版本> --registry=https://registry.npmjs.org/
   ```
2. 用 Release 离线包（见上）。
3. 等镜像同步：`curl -s https://registry.npmmirror.com/@angelky7/dsh-browser-control`，看到该版本且 `dist-tags.latest` 跟上后重试。

### `ERR_PNPM_NO_MATURE_MATCHING_VERSION`

版本**存在**，但没满 dsh profile 的 24 小时「包龄」供应链闸门（`node_modules/.pnpm-workspace-state-v1.json` 里的 `minimumReleaseAge: 1440`）。报文会写 `was published at …, within the minimumReleaseAge cutoff (…)`。

只有等满 cutoff 时刻这一条路；改 registry 或离线包都不需要。判据：`NO_MATCHING_VERSION` = 源里没有；`NO_MATURE_MATCHING_VERSION` = 有，但太新。

## 设置卡片与覆盖层

「设置 → 插件」里有没有 browser-bridge 卡片，取决于宿主版本：

| 宿主 | 设置页 | 改配置 |
|---|---|---|
| dsh 0.1.7+ / 0.2.x（dsh-settings 0.1.7-rc.2 起） | 有，宿主按插件 `Config` schema 自动投影 | 设置页，或 profile 覆盖层 |
| dsh 0.1.2 及更早 | 没有（没有客户端半区认领命名空间） | 只能改 profile 覆盖层 |

覆盖层写法（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`）：

```yaml
- id: browser-bridge
  name: '@angelky7/dsh-browser-control'
  config:
    readOnly: true
    allowScript: false
```

完整字段见 [dsh-config/README.md](../dsh-config/README.md)。

> 关掉桥接：`config: { enabled: false }`。不要改包内 `cordis.patch.yml` 的 `enabled: true`——那会盖掉 schema 默认值，表现为装上后 9777 无人监听（issue #4）。

## 卸载

```bash
dsh plugin --profile web remove @angelky7/dsh-browser-control
```

扩展在 `chrome://extensions` 里移除即可。
