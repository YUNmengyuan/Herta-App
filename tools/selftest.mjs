/**
 * selftest.mjs — 不开手机也能验证整条链路
 *
 * 走的就是手机端那条路：HTTP /api/info → WS 连上 → hello → 调命令 / 拉历史 /
 * 订阅事件（用 resyncRecord 触发一次真实的 record reset 事件来证明事件管道通）。
 *
 *   node tools/selftest.mjs [--port 8791]
 */
import { WebSocket } from 'ws'

const argPort = (() => {
  const i = process.argv.indexOf('--port')
  return i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.HERTA_REMOTE_PORT || 8791)
})()

const BASE = `http://127.0.0.1:${argPort}`
const results = []
const ok = (name, detail = '') => results.push({ ok: true, name, detail })
const bad = (name, detail = '') => results.push({ ok: false, name, detail })

const info = await (await fetch(`${BASE}/api/info`)).json().catch((e) => ({ error: e.message }))
if (info.error) {
  bad('GET /api/info', info.error)
  report()
  process.exit(1)
}
ok('GET /api/info', `port=${info.port} 手机地址=${info.phoneUrl}`)

const ws = new WebSocket(`ws://127.0.0.1:${argPort}/ws?k=${info.token}`)
const waiters = new Map()
const events = []
let nextId = 1

const rpc = (payload) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiters.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, ...payload }))
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id)
        reject(new Error(`超时: ${payload.type} ${payload.name || ''}`))
      }
    }, 60000)
  })

const hello = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('60 秒内没收到 hello（桥接没连上 Herta？）')), 60000)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'event') events.push(msg)
    if (msg.type === 'reply') {
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error?.message))
      }
    }
    if (msg.type === 'hello') {
      clearTimeout(t)
      resolve(msg)
    }
  })
  ws.on('error', (e) => reject(e))
})

ok('WS 握手 + hello', `link=${hello.link.up ? '已连上 Herta' : '未连上'} 会话数=${hello.sessions.length}`)
if (hello.state?.sessionId) ok('PC 当前会话', `${hello.state.sessionId}（记录 ${hello.state.record.length} 块）`)
else if (hello.sessions.length) ok('PC 当前会话', 'PC 上还没打开会话 —— 手机端会显示"选一个接管"引导（预期状态）')
else bad('PC 当前会话', '既没有活动会话也没有历史会话')

const version = await rpc({ type: 'call', name: 'getAppVersion', args: [] })
version ? ok('调用 getAppVersion', `Herta ${version}`) : bad('调用 getAppVersion', '空返回')

const theme = await rpc({ type: 'call', name: 'getTheme', args: [] })
ok('调用 getTheme', String(theme))

const sessions = (await rpc({ type: 'sessions' })).sessions
ok('拉会话列表', `${sessions.length} 个${sessions[0]?.title ? `，最新标题「${sessions[0].title}」` : ''}`)

if (sessions[0]) {
  const h = await rpc({ type: 'history', sessionId: sessions[0].sessionId })
  const kinds = [...new Set((h.blocks || []).map((b) => b.kind || b._kind))].join(',')
  if (h.blocks?.length) ok('读取当前会话历史', `${h.blocks.length} 块（来源 ${h.source}；类型 ${kinds}）`)
  else bad('读取当前会话历史', `空记录（来源 ${h.source}）`)
}

// 旧会话走的是磁盘转录（只读，不会切走 PC 上的界面）
const older = sessions.find((s) => s.sessionId !== hello.activeSessionId) || null
if (older) {
  const h = await rpc({ type: 'history', sessionId: older.sessionId })
  if (h.blocks?.length && h.source === 'disk') {
    ok('读取旧会话历史（磁盘只读）', `${h.blocks.length} 块，标题「${older.title || '未命名'}」`)
    if (h.blocks.some((b) => b.kind === 'herta' || b.kind === 'user')) ok('历史块结构可用', 'user/herta 块解析正常')
    else bad('历史块结构可用', '块类型不符合预期')
  } else {
    bad('读取旧会话历史（磁盘只读）', `来源 ${h.source}，块数 ${h.blocks?.length ?? 0}`)
  }
} else {
  ok('读取旧会话历史（磁盘只读）', '只有一个会话，跳过')
}

const key = await rpc({ type: 'call', name: 'getDeepSeekKeyStatus', args: [] })
ok('读取 API Key 状态', key?.set ? `已设置${key.hint ? `（${key.hint}）` : ''}` : '未设置（对话会失败，属于预期）')

// 事件管道：resyncRecord 会让 main 重推一次 record reset，理应出现在事件流里
events.length = 0
await rpc({ type: 'call', name: 'resyncRecord', args: [] }).catch(() => null)
await new Promise((r) => setTimeout(r, 2500))
const got = events.filter((e) => e.channel === 'record')
if (got.length) ok('事件推送', `收到 ${got.length} 条 record 事件（kind=${got.map((g) => g.payload?.kind).join('/')}）`)
else if (!hello.state?.sessionId) ok('事件推送', '跳过：PC 上没有打开的会话，resyncRecord 没有对象（在手机上点"接管"后即可验证）')
else bad('事件推送', 'resyncRecord 之后没收到任何 record 事件')

// 命令白名单：越权命令必须被拒
let refused = false
try {
  await rpc({ type: 'call', name: 'eval', args: ['1+1'] })
} catch {
  refused = true
}
refused ? ok('命令白名单', '未授权命令被拒绝') : bad('命令白名单', '危险命令竟然通过了')

report()
ws.close()
process.exit(results.some((r) => !r.ok) ? 1 : 0)

function report() {
  console.log('\n===== Herta 手机端自检 =====')
  for (const r of results) console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项。\n`)
}
