/**
 * server.mjs — Herta 手机端（局域网遥控端）的桥接服务
 *
 *   ┌────────────┐   HTTP/WS    ┌──────────────┐   CDP    ┌──────────────────────┐
 *   │ 手机浏览器 │ ───────────► │ 本服务 :8791 │ ───────► │ Herta( Electron )    │
 *   │  PWA       │ ◄─────────── │  状态折叠     │ ◄─────── │ 渲染层 window.herta  │
 *   └────────────┘              └──────────────┘          └──────────────────────┘
 *
 * 服务只做三件事：转发命令、折叠事件、托管手机端页面。它自己不碰 Herta 的任何文件。
 */
import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { HertaBridge } from './herta.mjs'
import { createStore, INITIAL } from '../web/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'web')
const TOKEN_FILE = path.join(__dirname, '.token')
const URL_FILE = path.join(__dirname, 'last-url.txt')

const PORT = Number(process.env.HERTA_REMOTE_PORT || 8791)
const DEBUG_PORT = Number(process.env.HERTA_DEBUG_PORT || 9222)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a)

async function loadToken() {
  try {
    const t = (await readFile(TOKEN_FILE, 'utf8')).trim()
    if (/^[a-f0-9]{24,}$/.test(t)) return t
  } catch {}
  const t = randomBytes(16).toString('hex')
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, t, 'utf8')
  return t
}

function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      out.push({ iface: name, address: ni.address })
    }
  }
  const score = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3
  return out.sort((a, b) => score(a.address) - score(b.address))
}

const TOKEN = await loadToken()
const sessionsCache = { at: 0, list: [] }

const store = createStore()

const herta = new HertaBridge({ port: DEBUG_PORT, log })
await herta.start()

// ---------------------------------------------------------------- WS 广播
const wss = new WebSocketServer({ noServer: true })
const clients = new Set()

function send(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj))
    } catch {}
  }
}

function broadcast(obj) {
  const s = JSON.stringify(obj)
  for (const ws of clients) if (ws.readyState === 1) try { ws.send(s) } catch {}
}

herta.on('event', ({ channel, payload }) => {
  // record 的 reset 事件本身不带 sessionId（官方渲染层从旧 state 里沿用），
  // 我们补上自己认定的活动会话，手机端才能区分"哪个会话的记录被重置了"
  if (channel === 'record' && payload?.kind === 'reset' && !payload.sessionId && herta.activeSessionId) {
    payload.sessionId = herta.activeSessionId
  }
  store.apply(channel, payload)
  broadcast({ type: 'event', channel, payload })
  if (channel === 'title' || channel === 'sessionDeleted' || channel === 'reset') scheduleSessionsRefresh()
})

herta.on('link', ({ up, detail }) => {
  broadcast({ type: 'link', up, detail })
  if (up) void primeActiveSession().catch(() => {})
})
herta.on('info', (info) => broadcast({ type: 'info', info }))

let sessionsTimer = null
function scheduleSessionsRefresh() {
  if (sessionsTimer) return
  sessionsTimer = setTimeout(async () => {
    sessionsTimer = null
    try {
      const list = await getSessions(true)
      broadcast({ type: 'sessions', sessions: list })
    } catch {}
  }, 800)
}

async function getSessions(force = false) {
  const now = Date.now()
  if (!force && now - sessionsCache.at < 3000 && sessionsCache.list.length) return sessionsCache.list
  const list = await herta.listSessions()
  // 标题不在 listSessions 里，从磁盘的 .title.json 补上，抽屉才有得看
  try {
    const titles = await herta.titles(list)
    for (const s of list) {
      const id = s.sessionId || s.id
      if (titles[id]) s.title = titles[id]
    }
  } catch {}
  sessionsCache.at = now
  sessionsCache.list = list
  if (herta.activeSessionId === null) await herta.findActiveSession(list)
  return list
}

function findSession(id, list) {
  return (list || []).find((s) => (s.sessionId || s.id) === id) || { sessionId: id, workspaceRoot: null }
}

/**
 * 手机一连上就该看到 PC 上正在聊什么，而不是空白等事件。
 * 做法：认出活动会话 → 把它内存里的记录直接灌进折叠状态。
 */
let priming = null
async function primeActiveSession() {
  if (herta.link !== 'up') return null
  const state = store.getState()
  if (state.sessionId && state.record.length > 0) return state.sessionId
  if (priming) return priming
  priming = (async () => {
    const list = await getSessions().catch(() => [])
    const id = herta.activeSessionId || (await herta.findActiveSession(list).catch(() => null))
    if (!id) return null

    const live = await herta.liveRecord(id).catch(() => null)
    const s = findSession(id, list)
    store.patch({
      bootstrapped: true,
      sessionId: id,
      title: s.title ?? null,
      record: live?.blocks ?? [],
      recordStart: live?.start ?? 0,
      lang: s.lang ?? 'zh',
    })
    log(`已接管 PC 上的当前会话 ${String(id).slice(0, 8)}…（${live?.blocks?.length ?? 0} 块记录）`)
    return id
  })()
  try {
    return await priming
  } finally {
    priming = null
  }
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`桥接服务内部错误: ${err.message}`)
  }
})

function isLocal(req) {
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function authorized(req, url) {
  if (isLocal(req)) return true
  const k = url.searchParams.get('k') || req.headers['x-herta-token']
  return typeof k === 'string' && k === TOKEN
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return json(res, 401, { error: '需要访问令牌（请从启动脚本给出的链接进入）' })
    if (url.pathname === '/api/info') return json(res, 200, await infoPayload(req))
    if (url.pathname === '/api/sessions') return json(res, 200, { sessions: await getSessions(true) })
    if (url.pathname === '/api/history') {
      const id = url.searchParams.get('sessionId')
      const list = await getSessions()
      const h = await herta.history(findSession(id, list))
      return json(res, 200, h || { start: 0, blocks: [], source: 'none' })
    }
    if (url.pathname === '/api/open') {
      const id = url.searchParams.get('sessionId')
      const snap = await herta.call('openSession', [id])
      if (snap) store.replace(snapToState(snap))
      const h = await herta.history(findSession(id, await getSessions(true)))
      return json(res, 200, { snapshot: snap, history: h })
    }
    return json(res, 404, { error: 'not found' })
  }

  // 静态资源
  let rel = parts.length === 0 ? 'index.html' : parts.join('/')
  if (rel.includes('..')) return text(res, 400, 'bad path')
  const file = path.join(WEB, rel)
  if (!file.startsWith(WEB) || !existsSync(file)) {
    // SPA 兜底
    const index = path.join(WEB, 'index.html')
    const body = await readFile(index)
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    return res.end(body)
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': rel === 'sw.js' ? 'no-store' : 'no-cache',
  })
  res.end(body)
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function text(res, code, s) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(s)
}

async function infoPayload() {
  const ips = lanAddresses()
  const primary = ips[0]?.address || '127.0.0.1'
  return {
    port: PORT,
    token: TOKEN,
    ips,
    phoneUrl: `http://${primary}:${PORT}/?k=${TOKEN}`,
    link: { up: herta.link === 'up', detail: herta.linkDetail },
    herta: { appVersion: herta.appVersion, ...herta.info },
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  }
}

/** openSession 的返回值与 session:reset 事件字段基本一致，收敛成 store 状态 */
function snapToState(s) {
  return {
    ...INITIAL,
    bootstrapped: true,
    sessionId: s.sessionId ?? null,
    lang: s.lang ?? 'zh',
    record: Array.isArray(s.record) ? s.record : [],
    recordStart: s.recordStart ?? 0,
    title: s.title ?? null,
    topics: s.topics ?? [],
    overlay: s.overlay ?? null,
    backendWorkspace: s.backendWorkspace ?? null,
    backendWorkspaceIsDefault: s.backendWorkspaceIsDefault ?? false,
  }
}

// ---------------------------------------------------------------- WS
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/ws') return socket.destroy()
  if (!authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', async (ws, req) => {
  clients.add(ws)
  log(`手机端已连接（当前 ${clients.size} 个）`)

  try {
    await primeActiveSession()
  } catch (e) {
    log(`恢复当前会话失败: ${e.message}`)
  }
  let sessions = []
  try {
    sessions = await getSessions(true)
  } catch (e) {
    log(`拉取会话列表失败: ${e.message}`)
  }

  send(ws, {
    type: 'hello',
    state: store.getState(),
    sessions,
    info: await infoPayload().catch(() => null),
    link: { up: herta.link === 'up', detail: herta.linkDetail },
    activeSessionId: herta.activeSessionId || store.getState().sessionId || null,
  })

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    const id = msg.id ?? null
    try {
      const result = await handleClientMessage(msg)
      if (id !== null) send(ws, { type: 'reply', id, ok: true, result })
    } catch (err) {
      if (id !== null) send(ws, { type: 'reply', id, ok: false, error: { message: err.message } })
      else log(`处理消息失败: ${err.message}`)
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    log(`手机端断开（剩余 ${clients.size} 个）`)
  })
  ws.on('error', () => {})
})

async function handleClientMessage(msg) {
  switch (msg.type) {
    case 'call': {
      const name = msg.name
      if (typeof name !== 'string') throw new Error('缺少命令名')
      const args = Array.isArray(msg.args) ? msg.args : []
      const result = await herta.call(name, args)
      // 会话切换类命令后，把折叠状态对齐到新会话
      if (name === 'openSession' && result) store.replace(snapToState(result))
      if (name === 'createSession' || name === 'deleteSession' || name === 'openSession') {
        const list = await getSessions(true)
        broadcast({ type: 'sessions', sessions: list })
      }
      return result ?? null
    }
    case 'sessions':
      return { sessions: await getSessions(true) }
    case 'history': {
      const list = await getSessions()
      return (await herta.history(findSession(msg.sessionId, list))) || { start: 0, blocks: [], source: 'none' }
    }
    case 'info':
      return await infoPayload()
    case 'images': {
      const files = Array.isArray(msg.files) ? msg.files : []
      const r = await herta.stageImages(files)
      return r
    }
    case 'ping':
      return { pong: Date.now() }
    default:
      throw new Error(`未知消息类型: ${msg.type}`)
  }
}

// ---------------------------------------------------------------- 启动
function startServer() {
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`端口 ${PORT} 已被占用：多半是桥接服务已经在跑了。`)
        log(`  直接用已有的那个：http://127.0.0.1:${PORT}/`)
        log(`  想换一个端口：启动脚本加 -Port 8792`)
      } else {
        log(`启动失败：${err.message}`)
      }
      reject(err)
    })
    server.listen(PORT, '0.0.0.0', async () => {
      // 等 CDP 连上 Herta（最多 4 秒）再打日志，免得先冒一句"没连上"又立刻连上
      await new Promise((r) => {
        if (herta.link === 'up') return r()
        const onLink = ({ up }) => {
          if (up) {
            herta.off('link', onLink)
            r()
          }
        }
        herta.on('link', onLink)
        setTimeout(() => {
          herta.off('link', onLink)
          r()
        }, 4000)
      })
      const ips = lanAddresses()
      const primary = ips[0]?.address || '127.0.0.1'
      const url = `http://${primary}:${PORT}/?k=${TOKEN}`
      log(`Herta 手机端已就绪`)
      log(`  手机访问   : ${url}`)
      for (const ip of ips.slice(1)) log(`  备用地址   : http://${ip.address}:${PORT}/?k=${TOKEN}`)
      log(`  本机状态页 : http://127.0.0.1:${PORT}/`)
      log(`  Herta 调试 : 127.0.0.1:${DEBUG_PORT}（${herta.link === 'up' ? '已连上' : '未连上'}）`)
      if (herta.link !== 'up') log(`  提示       : 还没连上 Herta，请确认它是用「启动Herta手机端」脚本拉起来的`)
      try {
        await writeFile(URL_FILE, `${url}\n`, 'utf8')
      } catch {}
      resolve()
    })
  })
}

try {
  await startServer()
} catch {
  process.exit(1)
}

// 启动就把 PC 上正在聊的会话灌进来，手机一连上就有内容
void primeActiveSession().catch(() => {})

process.on('SIGINT', () => {
  log('收到退出信号，关闭…')
  herta.stop()
  server.close()
  process.exit(0)
})
