/**
 * uitest.mjs — 用无头浏览器真的把手机端页面跑一遍（渲染 + 交互 + 控制台报错）
 *
 * 前置：先起一个带调试端口的无头浏览器，指着手机端地址，例如
 *   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\herta-ui "http://<lan-ip>:8791/?k=<token>"
 * 然后：
 *   node tools/uitest.mjs --cdp 9333
 *
 * 会自适应两种现场：
 *   A) PC 上已有活动会话  → 直接检查对话渲染
 *   B) PC 上没打开会话    → 检查"选一个接管"引导卡片，点进只读历史
 */
import { CdpClient } from '../bridge/cdp.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const cdpPort = Number(arg('--cdp', 9333))
const urlMatch = arg('--url-match', ':8791')

const cdp = new CdpClient({ port: cdpPort, urlMatch })
const consoleErrors = []
const pageErrors = []
const problems = []

cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
})
cdp.on('Runtime.exceptionThrown', (p) => {
  pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
})
cdp.on('Log.entryAdded', (p) => {
  if (p.entry?.level === 'error') consoleErrors.push(p.entry.text)
})

await cdp.start()
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('连接超时')), 15000)
  cdp.once('up', () => {
    clearTimeout(t)
    resolve()
  })
})
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Page.enable')
// 强制刷新，保证测的是磁盘上最新版前端（而不是浏览器缓存）
await cdp.send('Page.reload', { ignoreCache: true }).catch(() => {})
await new Promise((r) => setTimeout(r, 6000))

const ev = (expr) => cdp.evaluate(expr)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const show = (label, obj) => {
  console.log(`=== ${label} ===`)
  console.log(JSON.stringify(obj, null, 2))
}

/* ---------------------------------------------------------------- 1. 首屏 */
const first = {
  title: await ev('document.getElementById("title")?.textContent'),
  link: await ev('document.getElementById("link-text")?.textContent'),
  linkDot: await ev('document.getElementById("link-dot")?.className'),
  hertaBubbles: await ev('document.querySelectorAll(".bubble.herta").length'),
  pickerVisible: await ev('!!document.querySelector(".picker")'),
  pickerSessions: await ev('document.querySelectorAll(".picker-list .session").length'),
  drawerSessions: await ev('document.querySelectorAll("#session-list .session").length'),
  noSessionToastGuardReady: await ev('!!document.getElementById("btn-send")'),
}
show('首屏探测', first)

if (!String(first.link || '').includes('在线') && !String(first.link || '').includes('已连接')) {
  problems.push(`连接状态异常: ${first.link}`)
}
if (!first.pickerVisible && first.hertaBubbles < 1) problems.push('既没有会话引导卡片，也没有渲染出 Herta 气泡')

/* ------------------------------------------------- 2. 审批卡片 + 流式输出 */
// 这两个平时要靠真实命令触发，这里直接往 store 里灌事件看 UI 反应。
// 必须"注入 + 测量"在同一个 JS 执行回合里完成，否则真实事件（用户正在用 Herta）
// 会在中间把状态覆盖掉，测试就会抢跑。
const approval = await ev(`(() => {
  window.__hertaDebug.inject('overlay', { kind: 'pending', overlay: {
    requestId: 'selftest-request', summary: '要在工作区执行一条命令', code: 'command',
    command: 'rm -rf ./build && npm run build', diff: '--- a/x\\n+++ b/x\\n+added line\\n-removed line'
  } });
  const el = document.getElementById('approval');
  const r = {
    visible: !el.classList.contains('hidden'),
    summary: document.getElementById('approval-summary').textContent,
    command: document.getElementById('approval-body').textContent.slice(0, 40),
    buttons: document.querySelectorAll('#approval .approval-actions button').length,
    diffShown: !document.getElementById('approval-diff-wrap').classList.contains('hidden'),
  };
  window.__hertaDebug.inject('overlay', { kind: 'resolved' });
  return r;
})()`)

const streaming = await ev(`(() => {
  const d = window.__hertaDebug;
  d.inject('turn', { kind: 'started' });
  d.inject('agent', { kind: 'event', event: { type: 'assistant.delta', layer: 'actor', text: '这是流式输出的' } });
  d.inject('agent', { kind: 'event', event: { type: 'assistant.delta', layer: 'actor', text: '一段话。' } });
  const el = document.querySelector('.bubble.herta.streaming');
  const r = {
    bubbles: document.querySelectorAll('.bubble.herta.streaming').length,
    text: el ? el.innerText : null,
    stopVisible: !document.getElementById('btn-stop').classList.contains('hidden'),
  };
  d.inject('turn', { kind: 'finished' });
  d.inject('agent', { kind: 'event', event: { type: 'turn.finished', layer: 'backend' } });
  return r;
})()`)

show('审批卡片', approval)
show('流式输出', streaming)
if (!approval.visible || approval.buttons < 4) problems.push('审批卡片没渲染出来')
if (!streaming.bubbles || !String(streaming.text || '').includes('一段话')) problems.push('流式输出没渲染出来')

/* ---------------------------------------------------------------- 3. 抽屉 */
await ev('document.getElementById("btn-drawer").click()')
await wait(500)
const drawerOpen = await ev('document.getElementById("drawer").classList.contains("open")')
const drawerList = await ev('document.querySelectorAll("#session-list .session").length')
const drawerFirstTitle = await ev('document.querySelector("#session-list .session .st")?.textContent')
await ev('document.getElementById("scrim").click()')
show('会话抽屉', { drawerOpen, sessions: drawerList, firstTitle: drawerFirstTitle })
if (!drawerOpen) problems.push('抽屉打不开')
if (drawerList < 1) problems.push('抽屉里没有会话')

/* --------------------------------------------- 4. 只读历史 / 接管入口 */
let history = { skipped: true }
if (first.pickerVisible) {
  await ev('document.querySelector(".picker-list .session").click()')
  await wait(2500)
  history = {
    readonlyBarVisible: await ev('!document.getElementById("readonly-bar").classList.contains("hidden")'),
    readonlyText: await ev('document.getElementById("readonly-text").textContent'),
    blocks: await ev('document.querySelectorAll("#transcript .bubble, #transcript .sys, #transcript .generic, #transcript .thought").length'),
    takeoverButton: await ev('!!document.getElementById("btn-takeover")'),
    composerDisabled: await ev('document.getElementById("input").disabled'),
    sample: await ev('(document.querySelector("#transcript .bubble")?.innerText || "").slice(0, 60)'),
  }
  show('只读历史（点会话后）', history)
  if (!history.readonlyBarVisible) problems.push('点旧会话后没进入只读模式')
  if (history.blocks < 1) problems.push('只读历史没有渲染出任何块')
  if (!history.takeoverButton) problems.push('缺少「接管并继续对话」入口')
  if (!history.composerDisabled) problems.push('只读模式下输入框应该被禁用')

  // 只读模式下发送应被拦住
  await ev(`(() => { const i = document.getElementById('input'); i.disabled = false; i.value = '只读测试'; return true })()`)
  await ev('document.getElementById("btn-send").click()')
  await wait(600)
  const guardToast = await ev('document.getElementById("toast").classList.contains("hidden") ? null : document.getElementById("toast").textContent')
  show('只读发送拦截', { toast: guardToast })
  if (!String(guardToast || '').includes('接管')) problems.push('只读模式下发送没有被拦住')
} else {
  show('只读历史（点会话后）', { skipped: '当前 PC 上已有活动会话，跳过' })
}

/* ------------------------------------- 5. 模拟"PC 上没打开会话"的引导流程 */
// 真实场景里这取决于 PC 端有没有激活会话，这里直接把 store 置成那个状态来验证 UI
const picker = await ev(`(() => {
  const d = window.__hertaDebug;
  d.store.replace({ bootstrapped: true, sessionId: null, record: [], recordStart: 0, status: 'idle', streamingText: null, overlay: null });
  d.renderAll();
  return {
    visible: !!document.querySelector('.picker'),
    sessions: document.querySelectorAll('.picker-list .session').length,
    title: document.querySelector('.picker-title')?.textContent || null,
    hasNewButton: !!document.querySelector('.picker-row .ghost'),
  };
})()`)
show('无会话时的引导卡片', picker)
if (!picker.visible) problems.push('PC 没打开会话时没显示引导卡片')
if (picker.sessions < 1) problems.push('引导卡片里没有会话可选')

// 点最后一个会话（不是当前活动会话）→ 应进入只读历史，而不是切走 PC
const roi = await ev(`(async () => {
  const btns = document.querySelectorAll('.picker-list .session');
  btns[btns.length - 1].click();
  for (let i = 0; i < 40 && document.getElementById('readonly-bar').classList.contains('hidden'); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    readonlyVisible: !document.getElementById('readonly-bar').classList.contains('hidden'),
    readonlyText: document.getElementById('readonly-text').textContent,
    blocks: document.querySelectorAll('#transcript .bubble, #transcript .sys, #transcript .generic, #transcript .thought').length,
    takeoverButton: !!document.getElementById('btn-takeover'),
    sample: (document.querySelector('#transcript .bubble')?.innerText || '').slice(0, 50),
  };
})()`)
show('只读历史（磁盘）', roi)
if (!roi.readonlyVisible) problems.push('点旧会话没进入只读模式')
if (roi.blocks < 1) problems.push('只读历史没渲染出内容')
if (!roi.takeoverButton) problems.push('缺少「接管并继续对话」入口')

/* ---------------------------------------------------------------- 6. 结论 */
console.log('=== 控制台错误 ===')
console.log(consoleErrors.length ? consoleErrors.join('\n') : '（无）')
console.log('=== 页面异常 ===')
console.log(pageErrors.length ? pageErrors.join('\n') : '（无）')
if (pageErrors.length) problems.push(`页面异常 ${pageErrors.length} 条`)

console.log('=== 结论 ===')
console.log(problems.length ? '❌ ' + problems.join('; ') : '✅ 页面渲染与交互全部正常')
cdp.stop()
process.exit(problems.length ? 1 : 0)
