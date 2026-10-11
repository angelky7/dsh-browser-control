# dsh 配置参考

安装方式见 [README](../README.md)。本文只说明插件的配置项含义，供需要自定义默认值的用户参考。

## 安装提示
官方源与镜像可能不一致：安装若报 `ERR_PNPM_NO_MATCHING_VERSION`，一般是**镜像还没同步**（`dsh plugin add` 会把依赖钉成确切版本号，而 pnpm 用的是你配置的源，国内默认常常是 `registry.npmmirror.com`），不是包出了问题。三条解法见 [README 的安装一节](../README.md#方式-a从-npm-安装推荐)。

## cordis.patch.yml 字段

插件包根目录的 `cordis.patch.yml` 声明默认配置：

```yaml
- insert:
    - id: browser-bridge
      name: '@caob23/dsh-browser-control'
      config:
        enabled: true
        port: 9777
        token: dsh-local
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `id` | `browser-bridge` | 插件实例 ID，勿改 |
| `name` | `@caob23/dsh-browser-control` | npm 包名，即 Loader 的解析目标 |
| `config.enabled` | `true` | 默认开启，装好即监听（v1.0.6+）。这里写 `false` 会覆盖 schema 默认值，导致 9777 无监听（issue #4）；想关掉请用下面「覆盖默认值」里的 `merge` 写法 |
| `config.port` | `9777` | 本地桥接服务端口（127.0.0.1，仅监听回环） |
| `config.token` | `dsh-local` | 扩展与桥接的握手令牌；多用户环境建议改掉 |

## 覆盖默认值

不想改包内文件的话，在你的 profile 覆盖层（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`，它作用在 bundle 层之后）里按 `id` 覆盖 `browser-bridge` 的 config 即可。把要用的字段写全，例如改端口、或者干脆关掉：

```yaml
- id: browser-bridge
  name: '@caob23/dsh-browser-control'
  config:
    enabled: false
    port: 8888
    token: dsh-local
```

> dsh 生成的 profile 覆盖层就是「每个条目带一份完整 config」这种写法，照它写最稳妥；
> 写不全时未列出的字段走哪一层并未在文档里保证，别依赖。

## 设置页里到底有没有这一节（issue #5）

npm 发布的 bundle 只有宿主侧 `lib/index.js`，没有浏览器端模块，卡片不是插件画的：

- dsh 0.1.7+ / 0.2.x（dsh-settings 0.1.7-rc.2 起）：宿主自己按插件 `Config` schema 投影出设置节，所以看得到、也能改。
- dsh 0.1.2 及更早：设置 → 插件 里**没有**条目（没有客户端半区认领命名空间，宿主就不渲染），只能改配置文件。

两边通用的做法就是下面「覆盖默认值」那份 profile 覆盖层。

## 状态页

桥接启动后可访问 `http://127.0.0.1:9777/` 查看连接状态；扩展工具栏图标绿点呼吸 = 已连接。
