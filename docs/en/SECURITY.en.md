# Security Policy

[简体中文](../../SECURITY.md)

## Permissions requested

The extension requests these Chrome permissions:

| Permission | Purpose |
|---|---|
| `debugger` | Drive pages via CDP (run JS, synthesize input, capture screenshots) |
| `tabs` | Read tab info and manage tab navigation |
| `storage` | Save user configuration (port, token, auto-connect) |
| `alarms` | Keepalive heartbeat for the WebSocket connection |

## Security boundaries

- **Listens on 127.0.0.1 only** — the bridge is never exposed to the network
- **Token authentication** — the extension must present the correct token to connect; `/api/command` and `/api/cleanup` demand the same token (`Authorization: Bearer`, `X-Token` or `?token=`) and answer 401 without it
- **Upgrade origin checks** — the WebSocket handshake requires a loopback `Host` (blocking DNS rebinding) and refuses any web-page `Origin`; only the extension's own scheme and non-browser clients that send no Origin are accepted
- **No cross-origin grant** — no HTTP response carries `Access-Control-Allow-Origin`; the status page and its own requests are same-origin
- **Local-only communication** — extension and bridge talk over WebSocket on localhost
- **`browser_cookies` hands cookie values to the model verbatim** — a get is defined as "give the credentials to the caller" (session reuse / login-state migration depends on it), so values land in the model-visible text and the conversation log; treat them like page passwords and do not point the tool at sites you do not control. `set` / `remove` require an anchor (url or domain) and are refused in read-only mode (`readOnly: true`)
- **No data upload** — nothing is sent to any external server
- **User control** — since v1.0.6 the plugin is on by default and binds only to 127.0.0.1; set `enabled: false` in your profile override layer to turn it off
- **Visibility** — Chrome shows its "is being debugged" banner during control; every action is visible on screen

## Known limitations

- The bridge has no per-process identity check: **any local process that knows the token can drive this browser**. The loopback bind is not the boundary, the token is. `/api/status` and the status page remain unauthenticated read-only information (port, extension hello, browser name and version, screenshots directory).
- The `eval` command is always available; neither the extension nor the plugin has a switch to disable it. The `allowEval` mentioned in an old changelog entry was never implemented — do not rely on it.
- The default token `dsh-local` is published in the README and in `cordis.patch.yml`, so it is public knowledge, not a secret. Starting with the default token or one shorter than 16 characters logs a warning and shows "token: default/short" on the status page, but the bridge **still starts** — changing it is on you.

## Reporting a vulnerability

Either channel works:

- **Private report (preferred)**: GitHub Security Advisories (repo Security tab → Report a vulnerability)
- **Public issue**: fine for problems without exploitable details (no concrete attack steps, no token-bypass methods)

For anything exploitable, please use the private channel so it is not abused before a fix ships.
