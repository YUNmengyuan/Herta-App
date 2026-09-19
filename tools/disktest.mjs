/**
 * disktest.mjs — 直接验证「读磁盘转录」这条只读路径（不需要 Herta 在跑）
 *   node tools/disktest.mjs [工作区根目录]
 * 默认拿你真实 profile 里的旧会话试：C:\Users\<你>\AppData\Roaming\Herta
 */
import { HertaBridge } from '../bridge/herta.mjs'

const root = process.argv[2] || 'C:\\Users\\梦源\\AppData\\Roaming\\Herta'
const ids = process.argv.slice(3)

const h = new HertaBridge({ port: 9222, log: () => {} }) // 只用它的磁盘读取，不连 CDP

const targets = ids.length
  ? ids.map((id) => ({ sessionId: id, workspaceRoot: root }))
  : [
      { sessionId: 'f813975f-09c5-4ec6-ad19-a373837053fc', workspaceRoot: root },
      { sessionId: '90b7296e-1a46-4fb2-82ed-66187c7c9688', workspaceRoot: root },
    ]

let fail = 0
for (const s of targets) {
  const hist = await h.diskHistory(s)
  if (!hist) {
    console.log(`❌ ${s.sessionId} 没读到转录文件`)
    fail++
    continue
  }
  const kinds = {}
  for (const b of hist.blocks) kinds[b.kind || b._kind || '?'] = (kinds[b.kind || b._kind || '?'] || 0) + 1
  const first = hist.blocks.find((b) => b.kind === 'user') || hist.blocks[0]
  const titles = await h.titles([s])
  console.log(`✅ ${s.sessionId}`)
  console.log(`   文件   : ${hist.file}`)
  console.log(`   块数   : ${hist.blocks.length}（start=${hist.start}）类型 ${JSON.stringify(kinds)}`)
  console.log(`   标题   : ${titles[s.sessionId] || '（无 title.json）'}`)
  console.log(`   首条   : ${JSON.stringify(first).slice(0, 120)}`)
  if (hist.blocks.length < 2) {
    console.log('   ⚠️ 块数偏少，检查一下')
    fail++
  }
}

h.stop()
process.exit(fail ? 1 : 0)
