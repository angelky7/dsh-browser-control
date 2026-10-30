# 安全政策

[English](docs/en/SECURITY.en.md)

## 权限说明

本扩展请求以下 Chrome 权限：

| 权限 | 用途 |
|---|---|
| `debugger` | 通过 CDP 驱动页面（执行 JS、模拟输入、截图） |
| `tabs` | 读取标签页信息、管理标签页导航 |
| `storage` | 保存用户配置（端口、Token、自动连接） |
| `alarms` | 保活心跳，维持 WebSocket 连接 |

## 安全边界

- **仅监听 127.0.0.1**：桥接服务不暴露到网络
- **Token 认证**：扩展连接时需携带正确 Token；`/api/command`、`/api/cleanup` 也要求同一个 Token（`Authorization: Bearer`、`X-Token` 或 `?token=`），不带或不对一律 401
- **升级来源校验**：WebSocket 握手检查 `Host` 必须是回环地址（挡 DNS 重绑定），并拒绝任何网页 `Origin`；只放行扩展自身来源与无 Origin 的本机客户端
- **不做跨源放行**：所有 HTTP 响应都不带 `Access-Control-Allow-Origin`，状态页与其自身请求同源
- **本地通信**：扩展与桥仅在本机通过 WebSocket 通信
- **`browser_cookies` 会把 cookie 值原样交给模型**：get 的定义就是「把凭据交给调用方」（复制登录态、迁移会话靠它），所以这些值会进入模型可见文本与对话记录，敏感级别等同页面密码——不要把它指向你不掌握的站点。`set` / `remove` 需要锚点（url 或 domain），且在只读档（`readOnly: true`）下被拒绝
- **无数据上传**：不向任何外部服务器发送数据
- **用户控制**：插件自 v1.0.6 起默认开启并只监听 127.0.0.1；不需要时可在 profile 覆盖层写 `enabled: false` 关闭
- **可见性**：控制期间 Chrome 显示「正在被调试」横幅，所有操作屏幕上实时可见

## 已知限制

- 桥接没有进程级身份校验：**同一台机器上任何知道 Token 的进程都能驱动这个浏览器**。回环绑定本身不是隔离边界，Token 才是；`/api/status` 与状态页仍是免鉴权的只读信息（端口、扩展 hello、浏览器名与版本、截图目录路径）
- `eval` 命令始终可用，扩展与插件侧都没有「禁用 eval」的开关（历史 CHANGELOG 里提到的 `allowEval` 从未实现，别指望它）
- Token 默认值为 `dsh-local`，写进 README 和 `cordis.patch.yml`，是公开信息，不是安全凭据。桥接启动时若仍是默认值或长度不足 16 会打警告日志、状态页显示「令牌强度：默认/过短」，但**不会拒绝启动**——改掉它要你自己动手

## 报告安全问题

两种方式都可以：

- **私下报告（推荐）**：GitHub Security Advisories（仓库 Security 标签 → Report a vulnerability）
- **直接提 Issue**：如果问题不涉及可被利用的细节（如具体的攻击步骤、Token 绕过方法），直接开 Issue 描述即可

涉及利用方式的问题请优先走私信渠道，避免被未修复时公开利用。
