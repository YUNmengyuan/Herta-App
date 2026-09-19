/** 侦察 4：用 promise 链式表达式取会话列表与记录结构（Runtime.evaluate 里不能写顶层 await） */
import { CdpClient } from '../bridge/cdp.mjs'

const cdp = new CdpClient({ port: 9222 })
await cdp.start()
await new Promise((resolve) => cdp.once('up', resolve))
const ev = async (expr) => {
  try { return await cdp.evaluate(expr) } catch (e) { return `ERR: ${e.message}` }
}

const listRaw = await ev('window.herta.listSessions().then((x) => JSON.stringify(x)).catch((e) => "THROW:" + e.message)')
console.log('=== listSessions ===')
console.log(String(listRaw).slice(0, 4000))

let firstId = null
try {
  const parsed = JSON.parse(String(listRaw))
  const arr = Array.isArray(parsed) ? parsed : parsed?.sessions || parsed?.items || []
  firstId = arr[0]?.id || arr[0]?.sessionId || null
  console.log('first id =', firstId, ' count =', arr.length)
} catch (e) {
  console.log('parse fail:', e.message)
}

if (firstId) {
  const rec = await ev(
    `window.herta.recordSlice(${JSON.stringify(firstId)}, null, 4).then((x) => JSON.stringify(x)).catch((e) => "THROW:" + e.message)`
  )
  console.log('=== recordSlice(firstId, null, 4) ===')
  console.log(String(rec).slice(0, 8000))
}

// 事件采样器：装上，等真实活动发生时再取（此处只确认装载成功）
console.log('sampler =', await ev(`
(() => {
  if (window.__probe) return 'already';
  window.__probe = [];
  const chans = ['onRecord','onOverlay','onSpeech','onAgent','onTurn','onReset','onTitle','onSessionDeleted','onWorkspace','onVoice','onUpdate','onNavBlocked'];
  for (const k of chans) {
    try {
      if (typeof window.herta[k] !== 'function') continue;
      window.herta[k]((payload) => {
        let s; try { s = JSON.stringify(payload) } catch (e) { s = '<<unserializable>>' }
        window.__probe.push({ ch: k, len: s ? s.length : 0, head: s ? s.slice(0, 1500) : null });
        if (window.__probe.length > 300) window.__probe.shift();
      });
    } catch (e) { window.__probe.push({ ch: k, error: String(e) }) }
  }
  return 'installed:' + window.__probe.length;
})()
`))

cdp.stop()
process.exit(0)
