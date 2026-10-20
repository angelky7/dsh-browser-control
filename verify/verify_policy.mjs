// 本机策略闸门台：只读档（readOnly）与脚本开关（allowScript）。
//
// 为什么需要它：这两个开关的语义是「命令根本不要发出去」。如果闸门放在扩展侧或放在
// 链路后面，被拒的命令仍可能已经过了一半；如果靠工具面把工具藏起来，`browser_evaluate`
// 一个人就能旁路掉所有其它工具能做的事（它能在页面里跑任意 JS）。所以闸门只有一个位置：
// `BridgeController.execute()`，在发给扩展**之前**。
//
// 台子怎么判「闸门在前面」：故意不连扩展。被拒的命令报 `blocked_by_policy`；放行的命令
// 会继续走到链路上、报 `extension_offline`。两个 code 把「闸门拦下」和「闸门放行」区分开，
// 不需要假扩展。
//
// 另外做一次**对账**：扩展 `COMMANDS` 表里的每条命令，要么在只读白名单里，要么在只读档下
// 被拒。扩展以后新增命令时，这条会对账失败，逼人做一次「它算不算写操作」的判断——这正是
// 这个仓库错过一次的那种缺口（v1.0.17：新命令漏登记写操作分类）。
//
// 用法：node verify/verify_policy.mjs
import { readFile } from 'node:fs/promises'
import { Config, apply, READ_ONLY_ALLOWED, SCRIPT_COMMANDS } from '../lib/index.js'

let fails = 0
/** 起监听是异步的：等端口真的在听，才能用 extension_offline 区分「放行」。 */
const awaitListening = new Set()
async function waitForPorts() {
  const net = await import('node:net')
  for (const port of awaitListening) {
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(true) })
        s.on('error', () => resolve(false))
      })
      if (ok) break
      await new Promise((r) => setTimeout(r, 100))
    }
    awaitListening.delete(port)
  }
}
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 用最小假 cordis 上下文跑真实 apply()，拿到注册过的工具本体。 */
async function boot(config, port) {
  const tools = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    logger: { info: (l) => logs.push(String(l)), warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => {
      if (!deps.includes('settings')) return
      // dsh-settings 0.1.7-rc.2 / 0.2.x 的导出面（没有 register）
      cb({ settings: { configure: () => () => {}, describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} }, logger: ctx.logger })
    },
    tools: { register: (def) => tools.set(def.name, def) },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, Config({ enabled: true, port, token: 'dsh-local', ...config }))
  // apply() 是同步注册工具、异步起监听；等它真的在听，否则「放行」的命令会报
  // bridge_disabled（还没起）而不是 extension_offline（起了但没扩展连上）。
  awaitListening.add(port)
  const dispose = async () => {
    for (const fn of disposers.reverse()) {
      try { await (typeof fn === 'function' ? fn() : undefined)?.() } catch { /* teardown 失败不该影响断言 */ }
    }
  }
  await waitForPorts()
  return { tools, dispose }
}

/** 调一个工具；不连扩展，所以「过闸」的命令会报 extension_offline。 */
async function call(tools, name, args) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具没注册：${name}`)
  const controller = new AbortController()
  try {
    const value = await def.execute(args, { signal: controller.signal })
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.info?.code,
      effectState: error?.effectState ?? error?.info?.effectState,
      message: String(error?.message ?? error),
    }
  }
}

const WRITE_TOOLS = [
  ['browser_click', { selector: '#q' }],
  ['browser_type', { selector: '#q', value: 'x' }],
  ['browser_press', { key: 'Enter' }],
  ['browser_scroll', { y: 100 }],
  ['browser_navigate', { url: 'https://example.com' }],
  ['browser_tabs', { action: 'close', tabId: 1 }],
  ['browser_evaluate', { expression: '1+1' }],
]
const READ_TOOLS = [
  ['browser_read', {}],
  ['browser_snapshot', {}],
  ['browser_find', { selector: '#q' }],
  ['browser_tabs', { action: 'list' }],
]

// ---- 1) 默认值：老行为不变（readOnly 关、allowScript 开）----
{
  const defaults = Config({})
  check('默认 readOnly=false（装上不会突然只读）', defaults.readOnly === false, String(defaults.readOnly))
  check('默认 allowScript=true（browser_evaluate 仍可用）', defaults.allowScript === true, String(defaults.allowScript))
}

// ---- 2) 只读档：写工具在链路上被拦，读工具照常放行 ----
{
  const { tools, dispose } = await boot({ readOnly: true, allowScript: true }, 9783)
  for (const [name, args] of WRITE_TOOLS) {
    const r = await call(tools, name, args)
    check(`readOnly：${name} 被拦下（blocked_by_policy / not_started）`,
      r.ok === false && r.code === 'blocked_by_policy' && r.effectState === 'not_started',
      `${r.code}/${r.effectState}｜${(r.message ?? '').slice(0, 60)}`)
    check(`readOnly：${name} 的文案点名 readOnly: true 与改哪里`,
      /只读模式已开启（readOnly: true）/.test(r.message ?? '') && /cordis\.patch\.yml/.test(r.message ?? ''))
  }
  for (const [name, args] of READ_TOOLS) {
    const r = await call(tools, name, args)
    check(`readOnly：${name} 放行（走到链路，报 extension_offline 而不是被拦）`,
      r.ok === false && r.code === 'extension_offline',
      `${r.code}｜${(r.message ?? '').slice(0, 60)}`)
  }
  await dispose()
}

// ---- 3) 单独关掉脚本执行：只拦 eval，点击照旧 ----
{
  const { tools, dispose } = await boot({ readOnly: false, allowScript: false }, 9784)
  const evalRes = await call(tools, 'browser_evaluate', { expression: '1+1' })
  check('allowScript:false：browser_evaluate 被拦下并指向 allowScript',
    evalRes.ok === false && evalRes.code === 'blocked_by_policy' && /allowScript: false/.test(evalRes.message ?? ''),
    `${evalRes.code}｜${(evalRes.message ?? '').slice(0, 70)}`)
  check('allowScript:false：文案给出替代工具（读页面用 read/snapshot/find）',
    /browser_read \/ browser_snapshot \/ browser_find/.test(evalRes.message ?? ''))
  const click = await call(tools, 'browser_click', { selector: '#q' })
  check('allowScript:false：点击没有被牵连（走到链路）', click.ok === false && click.code === 'extension_offline', click.code)
  await dispose()
}

// ---- 4) 两个都开：脚本开关先说话（它比只读档更具体）----
{
  const { tools, dispose } = await boot({ readOnly: true, allowScript: false }, 9785)
  const r = await call(tools, 'browser_evaluate', { expression: '1+1' })
  check('两个都限制时，eval 的拒因是 allowScript（更具体的那个）', /allowScript: false/.test(r.message ?? ''), (r.message ?? '').slice(0, 70))
  await dispose()
}

// ---- 5) 什么都不限：闸门不参与（回归：别把正常路径挡了）----
{
  const { tools, dispose } = await boot({ readOnly: false, allowScript: true }, 9786)
  const r = await call(tools, 'browser_click', { selector: '#q' })
  check('都不限制：点击走到链路（extension_offline），没有被策略拦', r.ok === false && r.code === 'extension_offline', r.code)
  await dispose()
}

// ---- 6) 对账：扩展 COMMANDS 表 ↔ 只读白名单 ----
{
  const bg = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
  const table = bg.slice(bg.indexOf('const COMMANDS = {'), bg.indexOf('};', bg.indexOf('const COMMANDS = {')))
  const all = [...new Set([...table.matchAll(/'?([a-zA-Z][\w.]*)'?\s*:\s*cmd[A-Z]/g)].map((m) => m[1]))]
  check('对账：能读出扩展的命令表', all.length >= 25, `读出 ${all.length} 条：${all.slice(0, 6).join(',')}…`)

  const { policyRefusal } = await import('../lib/index.js')
  const stale = [...READ_ONLY_ALLOWED].filter((c) => !all.includes(c))
  check('对账：白名单里没有扩展已经不存在的命令（防改名后留下幽灵条目）', stale.length === 0, stale.join(',') || 'none')
  const scriptStale = [...SCRIPT_COMMANDS].filter((c) => !all.includes(c))
  check('对账：脚本清单同样没有幽灵条目', scriptStale.length === 0, scriptStale.join(',') || 'none')

  const unclassified = all.filter((c) => READ_ONLY_ALLOWED.has(c) === false
    && policyRefusal(c, { readOnly: true, allowScript: true }) === undefined)
  check(`对账：${all.length} 条命令每条都有交代（白名单放行 或 只读档拒绝）`, unclassified.length === 0,
    unclassified.join(',') || 'none')
  const allowed = all.filter((c) => READ_ONLY_ALLOWED.has(c))
  console.log(`      只读档放行 ${allowed.length} 条：${allowed.join(', ')}`)
  console.log(`      只读档拒绝 ${all.length - allowed.length} 条（写操作与改浏览器状态的）`)
}

console.log(fails === 0 ? '\n本机策略闸门全部符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
