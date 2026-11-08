// 兼容矩阵台（v1.7.2）：把用户定的铁律钉死——
//   **dsh插件 x + crx x-n ≥ dsh插件 x-n + crx x-n**（逐条功能比）。
// 做法：从 git 标签物化**真实的历史扩展代码**（不是模拟），当前插件对它跑全部
// 工具的探针，逐格验收：
//   - 那个年代就有的工具 → 必须照常工作（至少不许比当年差），且错误里
//     绝不允许出现 "unknown command"（那是闸门失职）；
//   - 比扩展新的工具 → 必须报带重装指引的 extension-outdated（fail-fast 且可执行），
//     不许裸 unknown command，更不许静默假成功；
//   - 反向 append-only：历史命令面 ⊆ 当前命令面（扩展从不删命令）。
// 历史 hello 不带 capabilities ⇒ 这张台同时是「版本映射兜底」这条路径的唯一实测。
import { execSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { Config, apply } from '../lib/index.js'
import { bootBackground } from './ext_harness.mjs'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// 每个面的探针表：since=null = 基线命令（任何版本都有）；expect='ok' = 测试台能
// 让它真成功的锚点工具；'any' = 管道通了即可（测试台给不了真数据，只禁
// unknown-command / extension-outdated 这两种契约性失败）。
const PROBES = [
  { tool: 'browser_info', args: () => ({}), since: null, expect: 'ok' },
  { tool: 'browser_tabs', args: () => ({ action: 'list' }), since: null, expect: 'ok' },
  { tool: 'browser_tabs', args: () => ({ action: 'back' }), since: '1.7.0', expect: 'ok' },
  { tool: 'browser_tabs', args: () => ({ action: 'forward' }), since: '1.7.0', expect: 'ok' },
  { tool: 'browser_navigate', args: (tab) => ({ tabId: tab, url: 'https://m.test/' }), since: null, expect: 'ok' },
  { tool: 'browser_evaluate', args: (tab) => ({ tabId: tab, expression: '1+1' }), since: null, expect: 'ok' },
  { tool: 'browser_scroll', args: (tab) => ({ tabId: tab, x: 0, y: 5 }), since: null, expect: 'ok' },
  { tool: 'browser_emulate', args: (tab) => ({ tabId: tab, device: 'desktop' }), since: null, expect: 'ok' },
  { tool: 'browser_console_log', args: (tab) => ({ tabId: tab }), since: null, expect: 'ok' },
  { tool: 'browser_network_log', args: (tab) => ({ tabId: tab }), since: null, expect: 'ok' },
  { tool: 'browser_network_clear', args: (tab) => ({ tabId: tab }), since: null, expect: 'ok' },
  { tool: 'browser_cleanup', args: () => ({}), since: null, expect: 'ok' },
  { tool: 'browser_metrics', args: (tab) => ({ tabId: tab }), since: '1.7.1', expect: 'ok' },
  { tool: 'browser_windows', args: () => ({ action: 'list' }), since: '1.6.0', expect: 'ok' },
  { tool: 'browser_windows', args: (tab) => ({ action: 'update', windowId: 1, focused: true }), since: '1.6.0', expect: 'any' },
  { tool: 'browser_archive', args: (tab) => ({ tabId: tab }), since: '1.5.0', expect: 'any' },
  { tool: 'browser_read', args: (tab) => ({ tabId: tab }), since: null, expect: 'any' },
  { tool: 'browser_snapshot', args: (tab) => ({ tabId: tab }), since: null, expect: 'any' },
  { tool: 'browser_find', args: (tab) => ({ tabId: tab, selector: '.none' }), since: null, expect: 'any' },
  { tool: 'browser_click', args: (tab) => ({ tabId: tab, selector: '.none' }), since: null, expect: 'any' },
  { tool: 'browser_type', args: (tab) => ({ tabId: tab, selector: '.none', value: 'x' }), since: null, expect: 'any' },
  { tool: 'browser_press', args: (tab) => ({ tabId: tab, key: 'Enter' }), since: null, expect: 'any' },
  { tool: 'browser_wait', args: (tab) => ({ tabId: tab, fn: 'true', timeoutMs: 500 }), since: null, expect: 'ok' },
  { tool: 'browser_drag', args: (tab) => ({ tabId: tab, from: '.a', to: '.b', steps: 2 }), since: '1.7.2', expect: 'ok' },
  { tool: 'browser_audit', args: () => ({ limit: 2 }), since: null, expect: 'ok' },
  { tool: 'browser_journal', args: () => ({ limit: 2 }), since: null, expect: 'ok' },
  { tool: 'browser_cookies', args: (tab) => ({ tabId: tab, action: 'get' }), since: null, expect: 'any' },
  { tool: 'browser_hold', args: (tab) => ({ tabId: tab, action: 'status' }), since: null, expect: 'any' },
  { tool: 'browser_screenshot', args: (tab) => ({ tabId: tab, format: 'png' }), since: null, expect: 'any' },
  { tool: 'browser_pdf', args: (tab) => ({ tabId: tab }), since: null, expect: 'any' },
]

const SURFACES = ['v1.2.0', 'v1.5.0', 'v1.6.0', 'v1.7.0', 'v1.7.1', 'v1.7.2']

// 物化历史扩展代码（git 里的原文，不是模拟）
const cacheDir = new URL('../.compat-cache/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
await mkdir(cacheDir, { recursive: true })
const surfaceCommands = new Map()
for (const tag of SURFACES) {
  const dir = `${cacheDir}${tag.slice(1)}/`
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}background.js`, execSync(`git show ${tag}:extension/background.js`, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }))
  await writeFile(`${dir}manifest.json`, execSync(`git show ${tag}:extension/manifest.json`, { cwd: repoRoot, maxBuffer: 1024 * 1024 }))
  const bg = await readFile(`${dir}background.js`, 'utf8')
  const at = bg.indexOf('const COMMANDS = {')
  const table = bg.slice(at, bg.indexOf('}', at))
  surfaceCommands.set(tag, new Set([...table.matchAll(/(?:^|[{,\s])'?([a-zA-Z_.]+)'?\s*:\s*cmd[A-Z]\w*/gm)].map((m) => m[1])))
}

// 反向 append-only：历史面 ⊆ 当前命令面（扩展从不删命令——升级扩展对旧插件也纯增益）
{
  const bg = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
  const at = bg.indexOf('const COMMANDS = {')
  const table = bg.slice(at, bg.indexOf('}', at))
  const current = new Set([...table.matchAll(/(?:^|[{,\s])'?([a-zA-Z_.]+)'?\s*:\s*cmd[A-Z]\w*/gm)].map((m) => m[1]))
  for (const [tag, cmds] of surfaceCommands) {
    const missing = [...cmds].filter((c) => !current.has(c))
    check(`${tag} → 当前命令面 append-only（历史命令一条不少）`, missing.length === 0, missing.join(', ') || `${cmds.size} 条全部在场`)
  }
}

let port = 9791
for (const tag of SURFACES) {
  const surface = surfaceCommands.get(tag)
  const PORT = port++
  const TOKEN = `compat-${tag.slice(1)}`
  const tools = []
  const disposers = []
  const config = Config({ stateDir: (process.env.TEMP || '/tmp') + '/dsh-verify-state', enabled: true, port: PORT, token: TOKEN, shotsDir: new URL('../.compat-cache/shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
  const settingsService = { register: (_n, schema, o) => ({ get: () => schema(o?.base ?? config), watch: () => {}, set: () => {} }) }
  const pctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn, msg) => disposers.push([fn, msg]),
    inject: (deps, cb) => { if (deps.includes('settings')) cb({ settings: settingsService, logger: pctx.logger }) },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: () => {} },
  }
  apply(pctx, config)

  // 真实的历史扩展（vm 里跑 git 标签原文）+ 真 WebSocket → 连到当前插件的桥
  const { model } = await bootBackground({
    backgroundPath: `../.compat-cache/${tag.slice(1)}/background.js`,
    manifest: JSON.parse(await readFile(`${cacheDir}${tag.slice(1)}/manifest.json`, 'utf8')),
    realWebSocket: true,
    storage: { port: PORT, token: TOKEN, autoConnect: true },
  })
  const TAB = model.addTab(1, 'https://start.test/')

  // browser_drag（纯插件特性）经 cdp 通道驱动 DOM/Input 域：给假会话一套最小语义。
  // 老表面的闸门在碰任何 CDP 之前就抛 extension-outdated，这些假件用不到。
  Object.assign(model.dbg.results, {
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': (p) => ({ nodeId: p.selector === '.a' ? 11 : p.selector === '.b' ? 22 : 0 }),
    'DOM.scrollIntoViewIfNeeded': () => ({}),
    'DOM.getAttributes': () => ({ attributes: [] }),
    'DOM.getBoxModel': (p) => ({ model: p.nodeId === 11
      ? { content: [0, 0, 10, 0, 10, 10, 0, 10], width: 10, height: 10 }
      : { content: [20, 20, 30, 20, 30, 30, 20, 30], width: 10, height: 10 } }),
    'Input.dispatchMouseEvent': () => ({}),
  })

  // 等 hello：/api/status 里能看到扩展报的版本（历史扩展没有 capabilities 字段
  // ⇒ 插件走版本映射兜底——这正是这张台要实测的路径）
  let helloVersion = null
  for (let i = 0; i < 50 && helloVersion === null; i++) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })
      const j = await res.json()
      if (j.hello?.version !== undefined) helloVersion = j.hello
    } catch { /* 桥还没起来，再等 */ }
  }
  check(`${tag}: hello 到位且报的是历史版本`, helloVersion?.version === tag.slice(1), JSON.stringify(helloVersion))
  if (tag === 'v1.7.2') {
    // 第一个带 capabilities 的版本：精确握手路径在这张台上被实测。
    check(`${tag}: hello 带 capabilities（精确握手路径被实测）`, Array.isArray(helloVersion?.capabilities) && helloVersion.capabilities.includes('cdp'), JSON.stringify(helloVersion?.capabilities?.slice(0, 6)))
  } else {
    check(`${tag}: 历史 hello 无 capabilities（版本映射兜底路径被实测）`, helloVersion?.capabilities === undefined)
  }

  const signal = () => new AbortController().signal
  for (const probe of PROBES) {
    const tool = tools.find((t) => t.name === probe.tool)
    if (tool === undefined) { check(`${tag} ${probe.tool}: 工具在注册表里`, false); continue }
    const out = await tool.execute(probe.args(TAB), { signal: signal() }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e?.message ?? e) }))
    const error = out.ok ? '' : String(out.error)
    const cmd = commandOfTool(probe.tool, probe.args(TAB))
    const isNewerThanSurface = probe.since !== null && cmd !== null && !surface.has(cmd)
    const label = `${tag} × ${probe.tool}${probe.args(TAB).action ? ` ${probe.args(TAB).action}` : ''}`
    if (isNewerThanSurface) {
      check(`${label}: 比扩展新 ⇒ extension-outdated 指引`, /extension-outdated/.test(error) && /releases\/latest/.test(error), error.slice(0, 90))
    } else if (probe.expect === 'ok') {
      check(`${label}: 照常工作（≥ 当年组合）`, out.ok === true, error.slice(0, 90))
    } else {
      check(`${label}: 管道通（错误只能是功能性的）`, !/unknown command|extension-outdated/.test(error), out.ok ? 'ok' : error.slice(0, 90))
    }
  }
  disposers.reverse().forEach(([fn]) => { try { fn(); } catch {} })
}

function commandOfTool(tool, args) {
  switch (tool) {
    case 'browser_tabs': return `tabs.${args.action}`
    case 'browser_navigate': return 'nav'
    case 'browser_read': return 'content'
    case 'browser_snapshot': return 'snapshot'
    case 'browser_evaluate': return 'eval'
    case 'browser_screenshot': return 'screenshot'
    case 'browser_console_log': return 'console.log'
    case 'browser_network_log': return 'network.log'
    case 'browser_network_clear': return 'network.clear'
    case 'browser_pdf': return 'pdf'
    case 'browser_archive': return 'archive'
    case 'browser_emulate': return 'emulate'
    case 'browser_metrics': return 'metrics'
    case 'browser_wait': return 'wait'
    case 'browser_find': return 'find'
    case 'browser_dialog': return 'dialog'
    case 'browser_info': return 'browser.info'
    case 'browser_hold': return 'hold'
    case 'browser_cookies': return `cookies.${args.action}`
    case 'browser_windows': return `windows.${args.action}`
    case 'browser_press': return 'press'
    case 'browser_type': return 'input'
    case 'browser_scroll': return 'scroll'
    case 'browser_click': return 'click'
    case 'browser_drag': return 'cdp'
    case 'browser_audit': return null // 插件本地工具，不经扩展
    case 'browser_journal': return null // 纯本地磁盘读
    case 'browser_cleanup': return null // 插件本地命令，不经扩展
    default: return null
  }
}

console.log(fails === 0 ? '\n矩阵全部通过：插件升级对旧扩展纯增益' : `\n矩阵失败 ${fails} 项`)
process.exit(fails === 0 ? 0 : 1)
