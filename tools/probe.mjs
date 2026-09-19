/** 侦察脚本：确认 CDP -> window.herta 桥可用，并打印会话/记录的真实数据结构 */
import { CdpClient } from '../bridge/cdp.mjs'

const cdp = new CdpClient({ port: 9222 })
await cdp.start()

const waitReady = new Promise((resolve) => cdp.once('up', resolve))
await Promise.race([waitReady, new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 15000))])

const out = {}
out.bridgeKeys = await cdp.evaluate('Object.keys(window.herta || {})')
out.platform = await cdp.evaluate('window.herta?.platform')
out.version = await cdp.evaluate('window.herta.getAppVersion()')
out.deepseekKey = await cdp.evaluate('window.herta.getDeepSeekKeyStatus()')
out.workspace = await cdp.evaluate('window.herta.getLocale()')
out.locale = await cdp.evaluate('window.herta.getLocale()')
out.theme = await cdp.evaluate('window.herta.getTheme()')
out.sessions = await cdp.evaluate('window.herta.listSessions()')

console.log(JSON.stringify(out, null, 2))

const sessions = Array.isArray(out.sessions) ? out.sessions : (out.sessions?.sessions || [])
if (sessions.length) {
  const id = sessions[0].id || sessions[0].sessionId
  const rec = await cdp.evaluate(`window.herta.recordSlice(${JSON.stringify(id)}, null, 6)`)
  console.log('=== recordSlice keys ===')
  console.log(JSON.stringify(rec, null, 2).slice(0, 6000))
}

cdp.stop()
process.exit(0)
