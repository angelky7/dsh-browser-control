# Tools (30)

| Tool | Purpose |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_read` | Read page text/HTML — the text itself, in an `offset`/`limit` window |
| `browser_snapshot` | Page snapshot → the ref list itself (`mode:"ax"` reads Chrome's accessibility tree: role + accessible name) |
| `browser_click` | Click an element (by ref / selector) |
| `browser_type` | Type into inputs |
| `browser_press` | Send keyboard keys (Enter, Tab, arrows, and combinations like "Ctrl+A" / "Shift+ArrowRight"; one press inserts exactly once) |
| `browser_scroll` | Scroll the page |
| `browser_wait` | Wait for an element / text / page condition (up to 120s, v1.0.9+) |
| `browser_find` | Query elements by CSS selector, returning count and viewport rects (read-only, v1.0.9+) |
| `browser_dialog` | Read or set the native-dialog policy accept/dismiss/manual, plus the recent dialog log (v1.0.9+) |
| `browser_hold` | Put or remove a cancellable take-over overlay on a tab (tells the user, stops mis-clicks); `covered:false` says why it could not cover the page. A soft layer, not a security boundary |
| `browser_cookies` | Read/set/remove cookies visible to a tab (`action: get/set/remove`; get takes a `domain` filter, set/remove need a `url` or `domain` anchor, remove re-checks and reports `remaining`). **Cookie values are credentials** — a get puts them fully into the model-visible text; see SECURITY.md |
| `browser_tabs` | Tab management (list/open/close/activate/group/ungroup; v1.7.0+ history back/forward — same arrival judging as navigate, reports unchanged at the history edge) |
| `browser_evaluate` | Run arbitrary JS |
| `browser_screenshot` | Capture page screenshot (v1.7.0+ receipt carries the real pixel size; fullPage captures the whole scrollable page, selector captures one element) |
| `browser_console_log` | Captured console entries, listed with their text (v1.0.7+) |
| `browser_network_log` | Captured HTTP requests, listed with method/status/URL (v1.0.7+) |
| `browser_network_clear` | Clear the network log buffer on its own (v1.0.7+) |
| `browser_pdf` | Export the current page as PDF (v1.0.7+) |
| `browser_archive` | Save the whole page as a single-file MHTML (text/images/styles inline; a greppable offline evidence snapshot — embedded scripts do not run, v1.5.0+) |
| `browser_windows` | Window control: list / open / update state & geometry / close a whole window / move tabs across windows (the only tool that may touch window geometry, v1.6.0+) |
| `browser_emulate` | Switch to a device viewport (mobile / desktop / custom, v1.0.7+); v1.7.1+ adds throttling: `network` slow3g/fast3g/offline/reset + `cpuThrottlingRate` (1–20), the receipt states the applied numbers, `device:"reset"` clears them too |
| `browser_metrics` | Read performance counters (DOM nodes / JS heap / layout & script durations, Performance.getMetrics, read-only; puts numbers behind "this page is heavy", v1.7.1+) |
| `browser_drag` | Drag from/to a selector or viewport point: `auto` synthesizes html5 dragstart→dragover→drop for `draggable="true"` sources (no drop unless accepted), otherwise sends real mouse input (press, interpolated moves, release — sliders/canvas/sortable widgets). **Plugin-side only** over the cdp channel embedded in extension v1.7.2, v1.7.3+ |
| `browser_upload` | Set local files on a page's file input through CDP `DOM.setFileInputFiles` (no native picker). **Off by default**: set `allowUpload: true` + `uploadDir` (an absolute directory) in the browser-bridge config; only files inside that directory are accepted (symlinks are resolved first). The receipt carries each file's real byte size. Ships in the next release. |
| `browser_audit` | Read this plugin session's in-memory audit trail — every command sent or refused (redacted params, `code`/`effectState`, duration), capped at 200 entries and wiped on restart; typed text and cookie values are redacted, eval expressions truncated. Plugin-local read, works in read-only mode (v1.7.4+) |
| `browser_journal` | Read the **persistent journal across dsh restarts** (`<stateDir>/journal.jsonl`, last 1000 entries, grouped by run) — ask it after a restart "what was I doing in which tab"; same redaction; plugin-local disk read that works with the extension offline (v1.7.5+) |
| `browser_sessions` | Multi-session isolation: list the dsh sessions sharing this browser and each one's **working tab**; `action:"release"` forgets yours. Calls that omit tabId default to THIS session's working tab (verified live) — concurrent sessions stop fighting over the active tab; explicit tabId always wins. Plugin-local, v1.7.6+ |
| `browser_cleanup` | Clean up temp files |
| `browser_info` | Which browser and extension build is attached (run it first when debugging, v1.0.9+) |


