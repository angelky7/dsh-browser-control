<div align="center">

<img src="extension/icons/icon128.png" width="100" alt="DSH Browser Control">

# DSH Browser Control

**Let AI work in your own browser — logged-in accounts, visible actions, local files.**

[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.md) [![English](https://img.shields.io/badge/lang-English-blue.svg)](README.en.md)

[![npm version](https://img.shields.io/npm/v/@angelky7/dsh-browser-control?style=flat&label=version&color=2EA44F)](https://www.npmjs.com/package/@angelky7/dsh-browser-control)
[![downloads](https://img.shields.io/npm/dm/@angelky7/dsh-browser-control?style=flat&label=downloads&color=2EA44F)](https://www.npmjs.com/package/@angelky7/dsh-browser-control)
[![CI](https://github.com/angelky7/dsh-browser-control/actions/workflows/ci.yml/badge.svg)](https://github.com/angelky7/dsh-browser-control/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license](https://img.shields.io/badge/license-AGPL--3.0-2EA44F?style=flat)](LICENSE)

</div>

## What it is

A dsh plugin plus a Chrome extension. The extension dials back to dsh over loopback (default `127.0.0.1:9777`), and the model drives **the Chrome you actually use**: navigate, read, click, type, drag, upload, screenshot, export PDF/MHTML, read and write cookies, inspect performance counters.

No headless browser, no copying login state around, no MCP — it drives the signed-in Chrome on your screen.

- 30 `browser_*` tools, usable from natural language
- Visible: tabs the agent opens join a `DSH` group; one-click lock in the extension popup
- Local gates: read-only / no arbitrary JS / upload allowlist
- Auditable: in-memory audit trail plus a cross-restart journal
- Install the extension once: regular feature updates since v1.7.3 are plugin-only (security/platform fixes may still update it)

## Install

### 1. Chrome extension

Download [DSH-Browser-Control-v1.7.2.zip](https://github.com/angelky7/dsh-browser-control/releases/download/v1.7.2/DSH-Browser-Control-v1.7.2.zip), unzip to a fixed folder (don't delete it), open `chrome://extensions` → enable Developer mode → "Load unpacked" → pick that folder. Chrome 116+; a green dot means connected.

> Already on v1.7.2? No reinstall needed: the feature updates in v1.7.3–v1.7.10 do not touch the extension.

### 2. dsh plugin

```bash
dsh plugin --profile web add @angelky7/dsh-browser-control
```

Or from a GitHub tag:

```bash
dsh plugin --profile web add "github:angelky7/dsh-browser-control#v1.7.10"
```

Offline asset: [dsh-browser-control-plugin-v1.7.10.zip](https://github.com/angelky7/dsh-browser-control/releases/download/v1.7.10/dsh-browser-control-plugin-v1.7.10.zip); unzip and run `dsh plugin --profile web add file:<the layer containing package.json>`.

Restart dsh afterwards. The bridge is on by default; status page <http://127.0.0.1:9777/>. If a just-published version will not install (mirror lag / 24-hour package-age gate), see [Install troubleshooting](docs/INSTALL.md).

## Quick start

Once installed, just ask the agent:

> Use browser_snapshot to look at the current page, then click the login button by ref.

Common entry points: `browser_snapshot` first, `browser_read` for the text, `browser_click` / `browser_type` by ref, `browser_screenshot` for images. See [Tools](docs/TOOLS.en.md) and [Behavior](docs/BEHAVIOR.md) for details.

## Safety gates

In your profile override (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), configure `browser-bridge`:

```yaml
config:
  readOnly: true          # refuse everything that changes the page/browser
  allowScript: false      # turn off arbitrary JS in browser_evaluate
  allowUpload: true       # off by default; requires uploadDir
  uploadDir: C:\Users\me\uploads
```

Blocked commands are **never sent to the browser** (zero side effects) and fail with `blocked_by_policy`. `browser_upload` is the only tool that can hand local files to a page: off by default, limited to files inside `uploadDir` (symlinks are resolved first). Field reference and host-version differences: [dsh-config/README.md](dsh-config/README.md).

## Tools (30)

Grouped by purpose; inputs, receipts and edge cases are in the [full tool reference](docs/TOOLS.en.md).

- Page: `browser_navigate` `browser_read` `browser_snapshot` `browser_find` `browser_click` `browser_type` `browser_press` `browser_scroll` `browser_wait` `browser_evaluate` `browser_drag` `browser_upload`
- Tabs & windows: `browser_tabs` `browser_windows` `browser_sessions`
- Browser state: `browser_cookies` `browser_dialog` `browser_hold` `browser_emulate` `browser_metrics` `browser_console_log` `browser_network_log` `browser_network_clear`
- Files: `browser_screenshot` `browser_pdf` `browser_archive` `browser_cleanup`
- Ledger: `browser_audit` `browser_journal`
- Identity: `browser_info`

> `browser_upload` ships with the next plugin release; npm 1.7.10 currently has 29 tools.

## Docs

| Document | Contents |
|---|---|
| [Tools](docs/TOOLS.en.md) | Inputs, receipts and edge cases for all 30 tools |
| [Behavior](docs/BEHAVIOR.md) | Navigation arrival, snapshot, lock, overlay, drag, upload |
| [Install troubleshooting](docs/INSTALL.md) | Mirror lag, 24-hour gate, offline asset, local checkout |
| [Security](SECURITY.md) | Token, permissions, threat boundaries |
| [Verification benches](verify/README.md) | What each bench covers |
| [Changelog](CHANGELOG.md) | Version history |

## Compatibility

The command surface is append-only: **plugin x + extension x-n never regresses** (the compatibility matrix replays real historical extension code). Extension v1.7.2 keeps working with the latest plugin; multi-instance routing comes in a later release.

## License

**AGPL-3.0.** Free for personal / academic / non-commercial use; embedding it in a closed-source product or offering it as a SaaS without releasing your derivative code requires a separate commercial license. Commercial licensing: GitHub Issues or caob2333@outlook.com. See [LICENSE](LICENSE).
