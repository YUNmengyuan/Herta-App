/**
 * app.js — Herta 手机端（PWA 前端）
 *
 * 与 PC 上的桥接服务之间只有两种消息：
 *   → {id, type:'call'|'sessions'|'history'|'images'|'info', ...}
 *   ← {type:'hello'|'event'|'reply'|'sessions'|'link'|'info'}
 * 事件用与 Herta 官方渲染层同源的 store.js 折叠，所以手机上的状态和 PC 上一致。
 */
import { createStore, INITIAL } from './store.js'

/* ---------------------------------------------------------------- 小工具 */
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const isLocalhost = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname)

let token = params.get('k') || localStorage.getItem('herta-token') || ''
if (params.get('k')) localStorage.setItem('herta-token', params.get('k'))

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function toast(msg, ms = 2600) {
  const el = $('toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

function relTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const d = Date.now() - t
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

const KIND_LABEL = {
  user: '我',
  herta: '黑塔',
  system: '系统',
  attachment: '图片',
  image: '图片',
  op: '操作',
  todo: '待办',
  plan: '计划',
  patch: '改动',
  code: '代码',
  text: '文本',
  mention: '提及',
  ctx: '上下文',
  activity: '动作',
  trace: '轨迹',
  meta: '元信息',
  cue: '提示',
  structured: '结构化',
  files: '文件',
  finding: '发现',
  raw: '原文',
  unknown: '未知',
}

/* ---------------------------------------------------------------- 状态 */
const ui = {
  sessions: [],
  activeSessionId: null,
  info: null,
  link: { up: false, detail: '' },
  viewMode: 'live', // live | history
  history: null, // {start, blocks, source}
  staged: [],
  pendingImages: [],
  sending: false,
  approvalBusy: false,
}

const store = createStore(() => scheduleRender())

/* ---------------------------------------------------------------- WS */
let ws = null
let wsRetry = 0
let nextId = 1
const pending = new Map()

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws?k=${encodeURIComponent(token)}`
}

function connect() {
  try {
    ws?.close()
  } catch {}
  setLink(false, '连接中…')
  if (!token) {
    setLink(false, '缺少访问令牌')
    renderEmptyHelp()
    return
  }
  ws = new WebSocket(wsUrl())
  ws.onopen = () => {
    wsRetry = 0
    setLink(false, '已连接，等待 PC 状态…')
  }
  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handleServerMessage(msg)
  }
  ws.onclose = () => {
    setLink(false, '与 PC 断开了，正在重连…')
    const delay = Math.min(1000 * ++wsRetry, 6000)
    setTimeout(connect, delay)
  }
  ws.onerror = () => {}
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'hello': {
      ui.sessions = msg.sessions || []
      ui.activeSessionId = msg.activeSessionId || msg.state?.sessionId || null
      ui.info = msg.info || ui.info
      setLink(!!msg.link?.up, msg.link?.up ? 'PC 端 Herta 在线' : msg.link?.detail || 'PC 端 Herta 未连接')
      store.replace(msg.state || INITIAL)
      ui.viewMode = 'live'
      ui.history = null
      renderAll()
      break
    }
    case 'event': {
      if (msg.channel === 'reset' && msg.payload?.sessionId) {
        ui.activeSessionId = msg.payload.sessionId
        if (ui.viewMode === 'history') {
          // PC 那边切了会话：手机跟随
          ui.viewMode = 'live'
          ui.history = null
        }
      }
      if (msg.channel === 'sessionDeleted' && msg.payload?.sessionId === ui.activeSessionId) {
        ui.activeSessionId = null
      }
      store.apply(msg.channel, msg.payload)
      scheduleRender()
      break
    }
    case 'reply': {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error?.message || '调用失败'))
      break
    }
    case 'sessions':
      ui.sessions = msg.sessions || []
      scheduleRender()
      break
    case 'link':
      setLink(!!msg.up, msg.up ? 'PC 端 Herta 在线' : msg.detail || 'PC 端 Herta 未连接')
      break
    case 'info':
      ui.info = msg.info
      scheduleRender()
      break
  }
}

function request(type, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('与 PC 的连接还没建立'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, type, ...extra }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('PC 没有响应（超时）'))
      }
    }, 190000)
  })
}

const call = (name, args = []) => request('call', { name, args })

function setLink(up, detail) {
  ui.link = { up, detail }
  const dot = $('link-dot')
  dot.className = 'dot ' + (up ? 'up' : 'down')
  $('link-text').textContent = detail
}

/* ---------------------------------------------------------------- 渲染 */
let rafPending = false
function scheduleRender() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    renderTranscript()
    renderComposer()
    renderApproval()
  })
}

let renderKey = null
let renderedCount = 0

function currentBlocks() {
  if (ui.viewMode === 'history') return ui.history?.blocks || []
  return store.getState().record || []
}

function renderAll() {
  renderHeader()
  renderTranscript(true)
  renderComposer()
  renderApproval()
  renderSessions()
  renderDrawerMeta()
}

function renderHeader() {
  const s = store.getState()
  const title = ui.viewMode === 'history' ? ui.history?.title || '旧会话' : s.title
  const session = ui.sessions.find((x) => (x.sessionId || x.id) === ui.activeSessionId)
  $('title').textContent = title || session?.title || 'Herta'
}

function blockNode(b) {
  if (!b || typeof b !== 'object') return document.createElement('div')

  if (b.kind === 'user') {
    const wrap = document.createElement('div')
    wrap.className = 'row-item'
    const d = document.createElement('div')
    d.className = 'bubble user'
    d.textContent = b.text ?? ''
    wrap.appendChild(d)
    return wrap
  }

  if (b.kind === 'herta') {
    if (b.surface === 'thought') {
      const det = document.createElement('details')
      det.className = 'thought'
      const sum = document.createElement('summary')
      sum.textContent = `想法（${(b.text || '').length} 字）`
      const body = document.createElement('div')
      body.className = 'thought-body'
      body.textContent = b.text ?? ''
      det.append(sum, body)
      return det
    }
    const d = document.createElement('div')
    d.className = 'bubble herta'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = 'HERTA'
    d.appendChild(who)
    d.appendChild(document.createTextNode(b.text ?? ''))
    if (b.selfCorrection) {
      const sc = document.createElement('div')
      sc.className = 'self-correct'
      sc.innerHTML = `<b>自我修正：</b>${esc(b.selfCorrection)}`
      d.appendChild(sc)
    }
    return d
  }

  if (b.kind === 'system') {
    const d = document.createElement('div')
    d.className = 'sys'
    d.textContent = [b.label, b.body].filter(Boolean).join(' · ')
    return d
  }

  // 其它块：一行折叠
  const det = document.createElement('details')
  det.className = 'generic'
  const sum = document.createElement('summary')
  const label = KIND_LABEL[b.kind] || b.kind || '?'
  const preview = (b.title || b.summary || b.label || b.text || b.body || b.command || b.path || '').toString()
  sum.innerHTML = `<span class="badge">${esc(b.kind || '?')}</span>${esc(label)}${
    preview ? ' · ' + esc(preview.slice(0, 60)) : ''
  }`
  const pre = document.createElement('pre')
  pre.textContent = JSON.stringify(b, null, 2)
  det.append(sum, pre)
  return det
}

function renderTranscript(force = false) {
  const box = $('transcript')
  const blocks = currentBlocks()
  const key = `${ui.viewMode}:${ui.activeSessionId}:${ui.history?.source || ''}:${ui.history?.start || 0}`

  let tail = $('tail')
  if (!tail) {
    tail = document.createElement('div')
    tail.id = 'tail'
    tail.style.display = 'contents'
  }

  if (force || key !== renderKey || blocks.length < renderedCount) {
    box.innerHTML = ''
    box.appendChild(tail)
    renderedCount = 0
    renderKey = key
  }

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120

  for (let i = renderedCount; i < blocks.length; i++) box.insertBefore(blockNode(blocks[i]), tail)
  renderedCount = blocks.length

  if (blocks.length === 0 && ui.viewMode === 'live') {
    const s = store.getState()
    if (!token) {
      if (!$('empty')) renderEmptyHelp()
    } else if (s.bootstrapped && !s.sessionId) {
      // PC 上的 Herta 开着但没打开会话：入口卡片在 renderTail 里画
      if ($('empty')) $('empty').remove()
    } else {
      if (!$('empty')) renderEmptyHelp()
      if ($('empty') && s.bootstrapped) {
        const p = $('empty').querySelector('p')
        if (p) p.textContent = '这个会话还是空的 —— 在下面说点什么吧。'
      }
    }
  } else if ($('empty')) {
    $('empty').remove()
  }

  renderTail(tail)
  if (nearBottom) box.scrollTop = box.scrollHeight
}

function renderTail(tail) {
  tail.innerHTML = ''
  if (ui.viewMode === 'history') return
  const s = store.getState()

  // PC 上还没打开任何会话：先给"选一个接管"的入口，别让它干等
  if (token && s.bootstrapped && !s.sessionId && s.record.length === 0) {
    tail.appendChild(noSessionCard())
    return
  }

  if (s.error) {
    const d = document.createElement('div')
    d.className = 'notice'
    d.textContent = `会话错误：${s.error}`
    tail.appendChild(d)
    return
  }

  if (s.pendingUser && !s.record.some((b) => b.kind === 'user' && b.text === s.pendingUser)) {
    const d = document.createElement('div')
    d.className = 'bubble user'
    d.style.alignSelf = 'flex-end'
    d.textContent = s.pendingUser
    tail.appendChild(d)
  }

  if (s.retryText !== null && s.retracting) {
    const d = document.createElement('div')
    d.className = 'retry'
    d.textContent = `（黑塔正在回收上一句…）\n${s.retryText || ''}`
    tail.appendChild(d)
  } else if (s.streamingText !== null) {
    const d = document.createElement('div')
    d.className = 'bubble herta streaming'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = 'HERTA'
    d.appendChild(who)
    d.appendChild(document.createTextNode(s.streamingText))
    const caret = document.createElement('span')
    caret.className = 'caret'
    d.appendChild(caret)
    tail.appendChild(d)
  }

  const bits = []
  if (s.status === 'thinking' && s.streamingText === null && !s.retracting) bits.push('正在思考…')
  if (s.backendActive) bits.push(s.backendInFlight > 0 ? `执行中（${s.backendInFlight} 个工具调用）` : '后端执行中…')
  if (s.recapCompacting) bits.push('整理记忆…')
  if (s.supervisorChecking) bits.push('自检…')

  if (bits.length) {
    const d = document.createElement('div')
    d.className = 'status'
    const sp = document.createElement('span')
    sp.className = 'spinner'
    d.append(sp, document.createTextNode(bits.join(' · ')))
    tail.appendChild(d)
  }

  if (s.turnFailed) {
    const d = document.createElement('div')
    d.className = 'notice'
    const code = s.turnFailedStatus ? `HTTP ${s.turnFailedStatus}` : s.turnFailedProviderCode || ''
    d.textContent = `这一轮失败了 ${code}${s.turnFailedStatus === 402 ? '（余额不足）' : s.turnFailedStatus === 401 ? '（API Key 无效）' : '（网络或服务端问题，可直接重发）'}`
    tail.appendChild(d)
  }
}

/** PC 上还没打开会话时的引导卡片：选一个接管，或新建 */
function noSessionCard() {
  const box = document.createElement('div')
  box.className = 'picker'
  const h = document.createElement('div')
  h.className = 'picker-title'
  h.textContent = 'PC 上的 Herta 还没有打开会话'
  const sub = document.createElement('div')
  sub.className = 'picker-sub'
  sub.textContent = '选一个继续聊（会把 PC 也切到这个会话），或者新建一个'
  box.append(h, sub)

  const list = document.createElement('div')
  list.className = 'picker-list'
  if (!ui.sessions.length) {
    const e = document.createElement('div')
    e.className = 'meta'
    e.textContent = '（还没有任何会话）'
    list.appendChild(e)
  }
  for (const s of ui.sessions.slice(0, 8)) {
    const id = s.sessionId || s.id
    const b = document.createElement('button')
    b.className = 'session'
    b.innerHTML = `<div class="st">${esc(s.title || '未命名会话')}</div><div class="sm">${esc(
      relTime(s.lastActivityAt || s.startedAt)
    )}</div>`
    b.onclick = () => openSessionById(id)
    list.appendChild(b)
  }
  box.appendChild(list)

  const row = document.createElement('div')
  row.className = 'picker-row'
  const nw = document.createElement('button')
  nw.className = 'ghost'
  nw.textContent = '新建会话'
  nw.onclick = newSession
  const rf = document.createElement('button')
  rf.className = 'ghost'
  rf.textContent = '刷新列表'
  rf.onclick = async () => {
    const r = await request('sessions').catch(() => null)
    if (r?.sessions) ui.sessions = r.sessions
    renderAll()
  }
  row.append(nw, rf)
  box.appendChild(row)
  return box
}

function renderEmptyHelp() {
  const box = $('transcript')
  if ($('empty')) return
  const d = document.createElement('div')
  d.className = 'empty'
  d.id = 'empty'
  d.innerHTML = token
    ? `<div class="empty-logo">Herta</div><p>正在连接 PC 上的 Herta…</p>`
    : `<div class="empty-logo">Herta</div>
       <p>缺少访问令牌。<br/>请用启动脚本给出的那条链接打开本页（形如 <code>?k=……</code>）。</p>
       <p style="margin-top:10px"><input id="token-input" placeholder="粘贴完整链接或令牌" style="width:80%;padding:8px;border-radius:10px;border:1px solid #8888;background:transparent;color:inherit"/></p>
       <p><button id="token-save" style="padding:8px 14px;border-radius:10px;border:1px solid #17b6c9;background:transparent;color:#17b6c9">使用这个令牌</button></p>`
  box.appendChild(d)
  if (!token) {
    $('token-save').onclick = () => {
      const v = $('token-input').value.trim()
      const m = v.match(/[?&]k=([a-f0-9]+)/i)
      const t = m ? m[1] : v
      if (!/^[a-f0-9]{24,}$/i.test(t)) return toast('令牌看起来不对')
      localStorage.setItem('herta-token', t)
      token = t
      location.reload()
    }
  }
}

function renderComposer() {
  const s = store.getState()
  const busy = ui.viewMode === 'live' && (s.status !== 'idle' || s.backendActive)
  $('btn-send').classList.toggle('hidden', busy)
  $('btn-stop').classList.toggle('hidden', !busy)
  $('btn-send').disabled = ui.sending
  $('input').disabled = ui.viewMode === 'history'

  const bar = $('readonly-bar')
  bar.classList.toggle('hidden', ui.viewMode !== 'history')
  if (ui.viewMode === 'history') {
    const t = ui.history?.title
    $('readonly-text').textContent = `正在查看旧会话${t ? `「${t}」` : ''}（只读，${ui.history?.blocks?.length || 0} 块）`
  }

  const staged = $('staged')
  staged.classList.toggle('hidden', ui.staged.length === 0)
  staged.innerHTML = ''
  ui.staged.forEach((img, i) => {
    const d = document.createElement('div')
    d.className = 'thumb'
    const im = document.createElement('img')
    im.src = img.preview
    im.alt = img.name || '图片'
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '×'
    x.onclick = () => {
      ui.staged.splice(i, 1)
      renderComposer()
    }
    d.append(im, x)
    staged.appendChild(d)
  })
}

function renderSessions() {
  const box = $('session-list')
  box.innerHTML = ''
  if (!ui.sessions.length) {
    const d = document.createElement('div')
    d.className = 'meta'
    d.style.padding = '10px'
    d.textContent = '（还没有会话）'
    box.appendChild(d)
    return
  }
  for (const s of ui.sessions) {
    const id = s.sessionId || s.id
    const b = document.createElement('button')
    b.className = 'session' + (id === ui.activeSessionId && ui.viewMode === 'live' ? ' active' : '')
    const title = document.createElement('div')
    title.className = 'st'
    title.textContent = s.title || '未命名会话'
    const sub = document.createElement('div')
    sub.className = 'sm'
    sub.textContent = `${relTime(s.lastActivityAt || s.startedAt)} · ${(s.workspaceRoot || '').split(/[\\/]/).pop() || ''}`
    b.append(title, sub)
    b.onclick = () => {
      closeDrawer()
      openSessionById(id)
    }
    box.appendChild(b)
  }
}

function renderDrawerMeta() {
  const s = store.getState()
  $('meta-workspace').textContent = `工作区：${s.backendWorkspace || '（未设置）'}`
  const version = ui.info?.herta?.appVersion || '—'
  const model = ui.info?.herta?.model?.actor ? ` · ${ui.info.herta.model.actor}` : ''
  $('meta-version').textContent = `Herta ${version}${model} · 桥接${ui.link.up ? '已连接' : '未连接'}`
  const keyInfo = ui.info?.herta?.deepseekKey
  if ($('key-status')) {
    $('key-status').textContent = keyInfo
      ? keyInfo.set
        ? `已设置${keyInfo.hint ? `（${keyInfo.hint}）` : ''}`
        : 'PC 上还没设置 API Key —— 设置前无法对话'
      : '—'
  }
}

/* ---------------------------------------------------------------- 审批 */
function renderApproval() {
  const s = store.getState()
  const el = $('approval')
  const ov = s.overlay
  if (!ov || ui.viewMode === 'history') {
    el.classList.add('hidden')
    return
  }
  el.classList.remove('hidden')
  $('approval-summary').textContent = ov.summary || 'Herta 想执行一个操作'
  $('approval-body').textContent = ov.command || ov.code || ov.detail || JSON.stringify(ov, null, 2)
  const diffWrap = $('approval-diff-wrap')
  if (ov.diff) {
    diffWrap.classList.remove('hidden')
    $('approval-diff').textContent = ov.diff
  } else {
    diffWrap.classList.add('hidden')
  }
  for (const btn of el.querySelectorAll('.approval-actions button')) {
    btn.disabled = ui.approvalBusy
    btn.onclick = async () => {
      if (ui.approvalBusy) return
      ui.approvalBusy = true
      renderApproval()
      const decision = btn.dataset.decision
      const persistence = btn.dataset.persistence
      try {
        await call('resolveApproval', [
          persistence ? { requestId: ov.requestId, decision, persistence } : { requestId: ov.requestId, decision },
        ])
        store.patch({ overlay: null })
        toast(decision === 'deny' ? '已拒绝' : '已允许')
      } catch (e) {
        toast(`审批失败：${e.message}`)
      } finally {
        ui.approvalBusy = false
        scheduleRender()
      }
    }
  }
}

/* ---------------------------------------------------------------- 会话操作 */
async function openSessionById(id) {
  if (!id) return
  if (id === ui.activeSessionId) {
    ui.viewMode = 'live'
    ui.history = null
    renderAll()
    return
  }
  try {
    const h = await request('history', { sessionId: id })
    ui.viewMode = 'history'
    ui.history = { ...h, sessionId: id }
    const s = ui.sessions.find((x) => (x.sessionId || x.id) === id)
    ui.history.title = s?.title
    renderAll()
  } catch (e) {
    toast(`读取历史失败：${e.message}`)
  }
}

async function takeover() {
  const id = ui.history?.sessionId
  if (!id) return
  if (!confirm('接管这个会话会把 PC 上的 Herta 也切到它，确定继续？')) return
  try {
    const snap = await call('openSession', [id])
    if (!snap) return toast('接管失败（多半没有这个会话）')
    ui.activeSessionId = id
    ui.viewMode = 'live'
    ui.history = null
    store.replace({ ...INITIAL, ...snap, bootstrapped: true })
    renderAll()
    toast('已接管')
  } catch (e) {
    toast(`接管失败：${e.message}`)
  }
}

async function newSession() {
  try {
    const snap = await call('createSession', [{}])
    if (!snap) return toast('新建失败')
    ui.activeSessionId = snap.sessionId
    ui.viewMode = 'live'
    ui.history = null
    store.replace({ ...INITIAL, ...snap, bootstrapped: true })
    const r = await request('sessions').catch(() => null)
    if (r?.sessions) ui.sessions = r.sessions
    closeDrawer()
    renderAll()
  } catch (e) {
    toast(`新建失败：${e.message}`)
  }
}

/* ---------------------------------------------------------------- 发送 */
async function send() {
  const input = $('input')
  const text = input.value.trim()
  if (!text && ui.staged.length === 0) return
  if (ui.viewMode !== 'live') return toast('这是旧会话，先点「接管并继续对话」')
  const s = store.getState()
  if (!s.sessionId) {
    // PC 上没有活动会话时 submitText 会被静默忽略，这里直接拦下来引导
    toast('先在会话列表里选一个会话（或新建）', 3500)
    openDrawer()
    renderAll()
    return
  }
  if (s.status !== 'idle' || s.backendActive) return toast('上一轮还没结束')

  input.value = ''
  autoGrow()
  ui.sending = true
  store.patch({ pendingUser: text || '（图片）' })
  renderComposer()

  try {
    let ids = []
    if (ui.staged.length) {
      const r = await request('images', {
        files: ui.staged.map((x) => ({ name: x.name, b64: x.b64 })),
      })
      if (r?.ok && Array.isArray(r.staged)) ids = r.staged.map((x) => x.id).filter(Boolean)
      else toast(`图片没被接收：${r?.reason || '未知原因'}`)
    }
    ui.staged = []
    renderComposer()
    const res = await call('submitText', [text, ids])
    if (res && res.needsKey) {
      // PC 上没设 Key，这一轮根本不会开始：把乐观回显撤掉，文字还给输入框
      store.patch({ pendingUser: null })
      input.value = text
      autoGrow()
      toast('PC 上的 Herta 还没设置 DeepSeek API Key', 5000)
      openSheet()
    }
  } catch (e) {
    toast(`发送失败：${e.message}`, 4000)
    store.patch({ pendingUser: null })
    input.value = text
    autoGrow()
  } finally {
    ui.sending = false
    scheduleRender()
  }
}

async function stop() {
  try {
    await call('interrupt', [])
  } catch (e) {
    toast(`打断失败：${e.message}`)
  }
}

async function rewind() {
  if (!ui.activeSessionId) return
  if (!confirm('撤回 PC 上这个会话的最后一轮？')) return
  try {
    const r = await call('rewindLastTurn', [ui.activeSessionId])
    toast(r?.ok ? '已撤回' : `撤回失败：${r?.reason || '没有可撤回的一轮'}`)
  } catch (e) {
    toast(`撤回失败：${e.message}`)
  }
}

/* ---------------------------------------------------------------- 图片 */
function autoGrow() {
  const el = $('input')
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.33) + 'px'
}

async function downscale(file, maxSide = 1568, quality = 0.85) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = () => rej(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('解码图片失败'))
    i.src = dataUrl
  })
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  const out = canvas.toDataURL('image/jpeg', quality)
  return { b64: out.split(',')[1], preview: out, name: file.name || `photo-${Date.now()}.jpg` }
}

async function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try {
      const img = await downscale(f)
      if (ui.staged.length >= 5) return toast('一次最多 5 张图')
      ui.staged.push(img)
    } catch (e) {
      toast(`处理 ${f.name} 失败：${e.message}`)
    }
  }
  renderComposer()
}

/* ---------------------------------------------------------------- 抽屉/弹层 */
function openDrawer() {
  $('drawer').classList.add('open')
  $('scrim').classList.remove('hidden')
}
function closeDrawer() {
  $('drawer').classList.remove('open')
  $('scrim').classList.add('hidden')
}
function openSheet() {
  $('sheet-wrap').classList.remove('hidden')
  renderDrawerMeta()
}
function closeSheet() {
  $('sheet-wrap').classList.add('hidden')
}

/* ---------------------------------------------------------------- PC 状态页 */
async function showPcPanel() {
  const panel = $('pc-panel')
  panel.classList.remove('hidden')
  try {
    const info = await (await fetch('/api/info')).json()
    $('pc-url').textContent = info.phoneUrl
    const qr = qrcode(0, 'M')
    qr.addData(info.phoneUrl)
    qr.make()
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    const metas = [
      `Herta ${info.herta?.appVersion || '—'} · ${info.herta?.model?.actor || ''}`,
      `调试连接：${info.link?.up ? '已连上 Herta' : '未连上（Herta 没在用调试端口启动）'}`,
      `本机网卡：${info.ips.map((i) => i.address).join(' / ') || '无'}`,
      `主机：${info.host} · ${info.node}`,
    ]
    $('pc-meta').innerHTML = metas.map((m) => `<li>${esc(m)}</li>`).join('')
    $('btn-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(info.phoneUrl)
        toast('链接已复制')
      } catch {
        toast(info.phoneUrl, 6000)
      }
    }
    $('btn-enter').onclick = () => {
      localStorage.setItem('herta-token', info.token)
      token = info.token
      panel.classList.add('hidden')
      connect()
    }
  } catch (e) {
    $('pc-url').textContent = `读取本机信息失败：${e.message}`
  }
}

/* ---------------------------------------------------------------- 事件绑定 */
function bind() {
  $('btn-drawer').onclick = openDrawer
  $('scrim').onclick = closeDrawer
  $('btn-menu').onclick = () => {
    openDrawer()
  }
  $('btn-new').onclick = newSession
  $('btn-takeover').onclick = takeover
  $('btn-send').onclick = send
  $('btn-stop').onclick = stop
  $('btn-rewind').onclick = () => {
    closeDrawer()
    rewind()
  }
  $('btn-reconnect').onclick = () => {
    closeDrawer()
    connect()
  }
  $('btn-theme').onclick = async () => {
    const order = ['system', 'light', 'dark']
    const cur = ui.info?.herta?.theme || 'system'
    const next = order[(order.indexOf(cur) + 1) % order.length]
    try {
      await call('setTheme', [next])
      ui.info = { ...(ui.info || {}), herta: { ...(ui.info?.herta || {}), theme: next } }
      toast(`主题：${{ system: '跟随系统', light: '浅色', dark: '深色' }[next]}`)
      renderDrawerMeta()
    } catch (e) {
      toast(`切换主题失败：${e.message}`)
    }
  }
  $('btn-settings').onclick = () => {
    closeDrawer()
    openSheet()
  }
  $('btn-sheet-close').onclick = closeSheet
  $('btn-key-save').onclick = async () => {
    const k = $('key-input').value.trim()
    if (!k) return toast('先填 Key')
    try {
      await call('setDeepSeekKey', [k])
      $('key-input').value = ''
      const st = await call('getDeepSeekKeyStatus').catch(() => null)
      ui.info = { ...(ui.info || {}), herta: { ...(ui.info?.herta || {}), deepseekKey: st } }
      toast('已写入 PC 上的 Herta')
      renderDrawerMeta()
    } catch (e) {
      toast(`保存失败：${e.message}`)
    }
  }
  $('btn-key-clear').onclick = async () => {
    try {
      await call('clearDeepSeekKey', [])
      ui.info = { ...(ui.info || {}), herta: { ...(ui.info?.herta || {}), deepseekKey: { set: false } } }
      toast('已清除')
      renderDrawerMeta()
    } catch (e) {
      toast(`清除失败：${e.message}`)
    }
  }
  $('btn-image').onclick = () => $('file').click()
  $('file').onchange = (e) => {
    addImages([...e.target.files])
    e.target.value = ''
  }
  $('input').addEventListener('input', autoGrow)
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  window.addEventListener('resize', () => {
    const box = $('transcript')
    box.scrollTop = box.scrollHeight
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState > 1)) connect()
  })
}

/* ---------------------------------------------------------------- 启动 */
// 给无头测试/排障留的后门：可以直接注入事件看 UI 反应（正常使用不会用到）
window.__hertaDebug = {
  store,
  ui,
  renderAll,
  renderTranscript: () => renderTranscript(true),
  inject: (channel, payload) => {
    store.apply(channel, payload)
    renderAll()
  },
}

bind()
renderEmptyHelp()
if (isLocalhost) {
  showPcPanel()
} else {
  connect()
}
