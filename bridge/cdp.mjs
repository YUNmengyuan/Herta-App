/**
 * cdp.mjs — 极简 Chrome DevTools Protocol 客户端
 *
 * 只做三件事：
 *   1) 从 http://127.0.0.1:<port>/json/list 里找出 Herta 渲染层那个 page target
 *   2) 连上它的 webSocketDebuggerUrl，提供 send(method, params)
 *   3) 转发 CDP 事件给订阅者
 *
 * 断线自动重连（Herta 重启 / 渲染层 reload 都会断），并且每次重连后
 * 都会重新跑一遍 onReady 回调（重新注入事件订阅、重新登记 executionContext）。
 */
import { EventEmitter } from 'node:events'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class CdpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.port        Herta 的 --remote-debugging-port
   * @param {string} opts.urlMatch    目标页面 URL 的关键字（用于挑出渲染层）
   * @param {(cdp: CdpClient) => Promise<void>} [opts.onReady] 每次（重）连成功后调用
   */
  constructor({ port = 9222, urlMatch = 'renderer/index.html', onReady = null } = {}) {
    super()
    this.port = port
    this.urlMatch = urlMatch
    this.onReady = onReady
    this.ws = null
    this.browserWs = null
    this.target = null
    this.ready = false
    this.closing = false
    this._id = 0
    this._pending = new Map()
    this._retry = 0
  }

  get httpBase() {
    return `http://127.0.0.1:${this.port}`
  }

  async start() {
    this.closing = false
    this._loop()
    return this
  }

  stop() {
    this.closing = true
    try { this.ws?.close() } catch {}
    try { this.browserWs?.close() } catch {}
  }

  async _loop() {
    while (!this.closing) {
      try {
        await this._connectOnce()
        this._retry = 0
        // 连接期间一直等待，直到 ws 关闭
        await new Promise((resolve) => {
          const done = () => resolve()
          this.ws.addEventListener('close', done, { once: true })
          this.ws.addEventListener('error', done, { once: true })
        })
      } catch (err) {
        this.emit('warn', `CDP 连接失败: ${err.message}`)
      }
      this.ready = false
      this.emit('down')
      if (this.closing) break
      this._retry++
      await sleep(Math.min(1000 * this._retry, 5000))
    }
  }

  async _connectOnce() {
    const list = await this._httpJson('/json/list')
    const pages = list.filter((t) => t.type === 'page')
    this.target =
      pages.find((t) => (t.url || '').includes(this.urlMatch)) ||
      pages.find((t) => (t.title || '').includes('Herta')) ||
      pages[0]
    if (!this.target?.webSocketDebuggerUrl) {
      throw new Error(`没找到 Herta 页面目标（现有 ${list.length} 个 target）`)
    }

    this.ws = new WebSocket(this.target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const ok = () => resolve()
      this.ws.addEventListener('open', ok, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 握手失败')), { once: true })
      this.ws.addEventListener('close', () => reject(new Error('WebSocket 被拒绝（可能需要 --remote-allow-origins）')), { once: true })
    })

    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data))
    this.ws.addEventListener('close', () => this._failAllPending('CDP 连接已关闭'))

    // 必须开 Runtime 域才能 evaluate
    await this.send('Runtime.enable')
    this.ready = true
    this.emit('up', this.target)
    if (this.onReady) await this.onReady(this)
  }

  async _httpJson(path) {
    const res = await fetch(this.httpBase + path)
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
    return res.json()
  }

  _onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP 错误'} (${msg.error.code})`))
      else resolve(msg.result)
      return
    }
    if (msg.method) this.emit('cdp', msg)
    if (msg.method) this.emit(msg.method, msg.params)
  }

  _failAllPending(reason) {
    for (const { reject } of this._pending.values()) reject(new Error(reason))
    this._pending.clear()
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('CDP 未连接')
    const id = ++this._id
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 120_000)
    })
  }

  /** 在渲染层里求值，返回结构化结果 */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      const text = d.exception?.description || d.text || 'evaluate 异常'
      throw new Error(text)
    }
    return res.result?.value
  }
}
