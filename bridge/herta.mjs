/**
 * herta.mjs — 把桌面 Herta 的渲染层桥（window.herta）包装成一个可远程调用的控制器
 *
 * 原理：
 *   Herta 是 Electron 应用，渲染层里 preload 已经挂好了完整的能力桥
 *   （window.herta.*，约 70 个命令 + 12 个事件订阅）。我们不改它的任何文件，
 *   只是让 Herta 带 --remote-debugging-port 启动，然后用 CDP：
 *     1) Runtime.addBinding 装一个回调，让页面里的事件订阅把载荷推给我们；
 *     2) Runtime.evaluate 调 window.herta.<command>(...)，拿到结构化返回值。
 *   于是「PC 上正在跑的那个 Herta」原封不动地变成了一个可被手机遥控的服务。
 *
 * 历史记录另走一条只读通道：直接读工作区里的
 *   <workspaceRoot>\.herta\transcript\v2\<sessionId>.jsonl
 * 这样手机翻旧会话不会切走 PC 上正在看的会话。
 */
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CdpClient } from './cdp.mjs'

/** 允许手机端调用的命令白名单 = Herta preload 暴露的全部桥命令（去掉只能吃 File 对象的那个） */
export const COMMANDS = new Set([
  'submitText', 'interrupt', 'rewindLastTurn', 'maybePlayEasterEgg',
  'listSessions', 'searchSessions', 'recordSlice', 'openSession', 'createSession', 'deleteSession',
  'resolveApproval', 'listCommandRules', 'removeCommandRule', 'resyncRecord',
  'checkForUpdate', 'restartAndInstall', 'getUpdateState', 'getAppVersion',
  'pickWorkspace', 'setWorkspace', 'resetWorkspace',
  'pickAttachments', 'attachFiles', 'removeAttachment', 'stageImages', 'unstageImage',
  'readWorkspaceFile', 'readWorkspaceBytes', 'openWorkspaceFile',
  'getDreamConfig', 'setDreamConfig', 'getBackendConfig', 'setBackendConfig',
  'getModelConfig', 'setModelConfig', 'getLocale', 'setLocale',
  'getInteractionLanguage', 'setInteractionLanguage',
  'getCloseToTray', 'setCloseToTray', 'getAutoUpdate', 'setAutoUpdate',
  'getTheme', 'setTheme', 'getDeepSeekKeyStatus', 'setDeepSeekKey', 'clearDeepSeekKey',
  'windowMinimize', 'windowToggleMaximize', 'windowClose', 'windowIsMaximized',
])

const BINDING = '__hertaRemotePush'
const SEP = '\u0001'
const HISTORY_LIMIT = 500

/** 注入页面的事件订阅器（幂等）。载荷通过 CDP binding 回传，不经轮询。 */
const INSTALL_EXPR = `(() => {
  if (window.__hertaRemoteInstalled) return 'already';
  const chans = {
    record: 'onRecord', overlay: 'onOverlay', speech: 'onSpeech', agent: 'onAgent',
    turn: 'onTurn', title: 'onTitle', reset: 'onReset',
    sessionDeleted: 'onSessionDeleted', workspace: 'onWorkspace', voice: 'onVoice',
    navBlocked: 'onNavBlocked', update: 'onUpdate', windowMaximized: 'onWindowMaximized'
  };
  let installed = 0;
  for (const [name, fn] of Object.entries(chans)) {
    try {
      if (typeof window.herta?.[fn] !== 'function') continue;
      window.herta[fn]((payload) => {
        let json;
        try { json = JSON.stringify(payload ?? null); } catch (e) { json = null; }
        try { window.${BINDING}(name + '\\u0001' + (json ?? 'null')); } catch (e) {}
      });
      installed++;
    } catch (e) {}
  }
  window.__hertaRemoteInstalled = true;
  return 'installed:' + installed;
})()`

export class HertaBridge extends EventEmitter {
  constructor({ port = 9222, log = () => {} } = {}) {
    super()
    this.port = port
    this.log = log
    this.cdp = new CdpClient({
      port,
      urlMatch: 'renderer/index.html',
      onReady: (c) => this._onCdpReady(c),
    })
    this.link = 'down'
    this.linkDetail = '还没连上 PC 上的 Herta（它没启动，或者没用调试端口启动）'
    this._lastWarnAt = 0
    this.appVersion = null
    this.info = {}
    this.activeSessionId = null
    /** 官方渲染层在 record dropped 时会自愈；我们也补一手，但要防空转 */
    this._lastResync = 0
  }

  async start() {
    this.cdp.on('up', (target) => {
      this.link = 'up'
      this.linkDetail = target?.title || 'Herta'
      this.log(`已连上 Herta 渲染层 (${target?.url})`)
      this.emit('link', { up: true, detail: this.linkDetail })
      // 连上后刷新一次基础信息
      void this.refreshInfo().catch((e) => this.log(`refreshInfo 失败: ${e.message}`))
    })
    this.cdp.on('down', () => {
      if (this.link !== 'down') {
        this.link = 'down'
        this.linkDetail = '和 Herta 的连接断了（它可能被关掉或更新重启了），正在重连…'
        this.log('与 Herta 的连接断开，等待重连…')
        this.emit('link', { up: false, detail: this.linkDetail })
      }
    })
    // 连不上时别每 2 秒刷一行日志，半分钟提一次就够
    this.cdp.on('warn', (m) => {
      const now = Date.now()
      if (now - this._lastWarnAt < 30000) return
      this._lastWarnAt = now
      this.log(`${m}（还在等 Herta，最多每 30 秒提一次）`)
    })
    this.cdp.on('Runtime.bindingCalled', (p) => this._onBindingCalled(p))
    this.cdp.on('Runtime.executionContextCreated', () => {
      // 页面重载后事件订阅会丢，重新装一遍
      void this._install().catch(() => {})
    })
    await this.cdp.start()
    return this
  }

  stop() {
    this.cdp.stop()
  }

  async _onCdpReady(cdp) {
    try {
      await cdp.send('Runtime.addBinding', { name: BINDING })
    } catch (e) {
      this.log(`addBinding 失败（事件转发可能不可用）: ${e.message}`)
    }
    await this._install()
    // 让 main 把当前会话的 record 重新推一遍，顺便确认会话是哪个
    try {
      await this.call('resyncRecord', [], { timeoutMs: 5000 })
    } catch {}
  }

  async _install() {
    const r = await this.cdp.evaluate(INSTALL_EXPR)
    this.log(`事件转发注入: ${r}`)
    return r
  }

  _onBindingCalled({ name, payload }) {
    if (name !== BINDING || typeof payload !== 'string') return
    const i = payload.indexOf(SEP)
    if (i < 0) return
    const channel = payload.slice(0, i)
    let data = null
    try {
      data = JSON.parse(payload.slice(i + 1))
    } catch {
      return
    }
    if (channel === 'record' && data?.kind === 'dropped') this._healRecord()
    if (channel === 'reset' && data?.sessionId) this.activeSessionId = data.sessionId
    this.emit('event', { channel, payload: data })
  }

  _healRecord() {
    const now = Date.now()
    if (now - this._lastResync < 4000) return
    this._lastResync = now
    void this.call('resyncRecord', []).catch(() => {})
  }

  /** 调用渲染层里的 window.herta.<name>(...args) */
  async call(name, args = [], { timeoutMs = 180000 } = {}) {
    if (!COMMANDS.has(name)) throw new Error(`命令不在白名单内: ${name}`)
    if (this.cdp.ready !== true) throw new Error('还没连上 Herta（调试端口未开或界面未加载）')
    const expr = `window.herta[${JSON.stringify(name)}](...${JSON.stringify(args)})`
    const timer = timeoutMs
      ? new Promise((_, rej) => setTimeout(() => rej(new Error(`命令超时（${timeoutMs}ms）: ${name}`)), timeoutMs))
      : null
    const run = this.cdp.evaluate(expr)
    return timer ? Promise.race([run, timer]) : run
  }

  /** 通过 base64 把手机上的图片塞进 Herta 的待发图片区，返回 staged 列表 */
  async stageImages(files) {
    if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: 'no_files' }
    const payload = files.map((f) => ({ name: f.name || 'photo.jpg', b64: f.b64 }))
    const expr = `(() => {
      const inputs = ${JSON.stringify(payload)}.map((f) => {
        const bin = atob(f.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return { name: f.name, bytes: arr };
      });
      return window.herta.stageImages(null, inputs);
    })()`
    return this.cdp.evaluate(expr)
  }

  async refreshInfo() {
    const get = async (name, fallback = null) => {
      try {
        return await this.call(name, [], { timeoutMs: 15000 })
      } catch {
        return fallback
      }
    }
    this.info = {
      appVersion: await get('getAppVersion'),
      theme: await get('getTheme'),
      locale: await get('getLocale'),
      interactionLanguage: await get('getInteractionLanguage'),
      closeToTray: await get('getCloseToTray'),
      autoUpdate: await get('getAutoUpdate'),
      deepseekKey: await get('getDeepSeekKeyStatus'),
      backend: await get('getBackendConfig'),
      model: await get('getModelConfig'),
      dream: await get('getDreamConfig'),
      update: await get('getUpdateState'),
    }
    this.appVersion = this.info.appVersion
    this.emit('info', this.info)
    return this.info
  }

  async listSessions() {
    const list = await this.call('listSessions', [], { timeoutMs: 20000 })
    return Array.isArray(list) ? list : []
  }

  /**
   * 找出 PC 上此刻正在看的会话：
   * recordSlice 只对 active session 生效，于是逐个探测（最新的先试）。
   */
  async findActiveSession(sessions) {
    const candidates = (sessions || []).slice(0, 12)
    for (const s of candidates) {
      const id = s.sessionId || s.id
      if (!id) continue
      try {
        const r = await this.call('recordSlice', [id, 1_000_000_000, 1], { timeoutMs: 10000 })
        if (r && Array.isArray(r.blocks) && r.blocks.length > 0) {
          this.activeSessionId = id
          return id
        }
      } catch {}
    }
    return this.activeSessionId
  }

  /** 活动会话的内存记录（最新 500 块） */
  async liveRecord(sessionId, count = HISTORY_LIMIT) {
    const r = await this.call('recordSlice', [sessionId, 1_000_000_000, count], { timeoutMs: 20000 })
    if (!r || !Array.isArray(r.blocks)) return null
    return { start: r.start ?? 0, blocks: r.blocks, source: 'live' }
  }

  /** 磁盘上的转录（只读，翻旧会话不会动 PC 的界面） */
  async diskHistory(session, count = HISTORY_LIMIT) {
    const id = session?.sessionId || session?.id
    const roots = [session?.workspaceRoot, ...defaultWorkspaceRoots()].filter(Boolean)
    for (const root of roots) {
      const file = path.join(root, '.herta', 'transcript', 'v2', `${id}.jsonl`)
      if (!existsSync(file)) continue
      const text = await readFile(file, 'utf8')
      const blocks = []
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let obj
        try {
          obj = JSON.parse(t)
        } catch {
          continue
        }
        if (obj._kind) continue // session_meta / turn_end / workspace_set 这类元信息不渲染
        blocks.push(obj)
      }
      const start = Math.max(0, blocks.length - count)
      return { start, blocks: blocks.slice(start), source: 'disk', file }
    }
    return null
  }

  /** 会话标题存在 <workspaceRoot>\.herta\transcript\v2\<id>.title.json，顺手读出来给列表用 */
  async titles(sessions) {
    const out = {}
    await Promise.all(
      (sessions || []).map(async (s) => {
        const id = s.sessionId || s.id
        if (!id) return
        for (const root of [s.workspaceRoot, ...defaultWorkspaceRoots()].filter(Boolean)) {
          const file = path.join(root, '.herta', 'transcript', 'v2', `${id}.title.json`)
          if (!existsSync(file)) continue
          try {
            const j = JSON.parse(await readFile(file, 'utf8'))
            if (j?.title) out[id] = j.title
          } catch {}
          return
        }
      })
    )
    return out
  }

  /** 会话历史：活动会话优先内存，其余读磁盘 */
  async history(session, count = HISTORY_LIMIT) {
    const id = session?.sessionId || session?.id
    if (id && id === this.activeSessionId) {
      const live = await this.liveRecord(id, count).catch(() => null)
      if (live && live.blocks.length > 0) return live
    }
    const disk = await this.diskHistory(session, count).catch(() => null)
    if (disk) return disk
    if (id) {
      const live = await this.liveRecord(id, count).catch(() => null)
      if (live) return live
    }
    return null
  }
}

function defaultWorkspaceRoots() {
  const roots = []
  const appData =
    process.env.APPDATA ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : null)
  if (appData) roots.push(path.join(appData, 'Herta'))
  roots.push(path.join(os.homedir(), '.herta'))
  return roots
}
