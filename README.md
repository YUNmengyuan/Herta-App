# Herta 手机端（局域网遥控端 · PWA）

> **v0.1** · 2026-09-19

> ## 📌 来源声明
>
> 本项目是**基于原作者项目所做的第三方改造**，不是原创作品。
>
> - **原作者项目**：**Herta** —— *THE SELF THAT USES THE AGENT*
> - **原作者官网**：<https://www.herta-ai.com/#research>
> - 本项目在 Herta 桌面版之上做了一个**局域网遥控端**（手机浏览器访问的 PWA），
>   零侵入地调用它已经暴露的调试接口，**未修改 Herta 的任何文件**。
>
> 本项目由第三方独立开发，**与 Herta 原作者无任何隶属、合作或背书关系**。
> 如原作者认为本改造有不妥之处，请联系我，我会立即调整或撤下。
>
> 另：「Herta / 黑塔」是 HoYoverse《崩坏：星穹铁道》中的角色。Herta 原作者项目本身
> 即为**非官方同人作品**，本项目同样是非官方同人作品，与 HoYoverse / miHoYo / Cognosphere
> **无关联、未获其背书或赞助**。

把 PC 上那个 **Herta**（`D:\Herta`，Electron 应用）变成手机能用的应用：
手机上打开一个网页就是 Herta 的对话界面，可以聊天、看流式输出、**批准/拒绝它要执行的命令**、
翻历史会话、发图片、切主题、写 API Key。PC 上的 Herta 照常运行，手机只是它的遥控端。

> 为什么不是「重新打个 apk」：Herta 是 Electron 桌面应用，Android/iOS 上没有 Electron 运行时，
> 原样打包不存在。所以这里走的是**遥控端**路线——Agent、工具、文件、会话都留在 PC 上跑，
> 手机拿一个为触屏重做的界面。零侵入：**没有改动 Herta 的任何文件**。

---

## 快速开始（3 步）

1. **双击** `启动Herta手机端.bat`
   - 它会找到 Node、确认 Herta 带着调试端口启动（没开就帮你重开）、放行防火墙端口、启动桥接服务。
   - 第一次如果提示防火墙，用**管理员身份**再运行一次即可（脚本会给出确切命令）。
2. 电脑浏览器会自动打开一个**状态页**，上面有二维码。
3. **手机连同一个 Wi-Fi**，扫码或打开那条链接（形如 `http://192.168.x.x:8791/?k=…`）。
   - 安卓 Chrome/Edge 里点「安装应用 / 添加到主屏幕」，就是一个全屏 App。

停止：关掉那个控制台窗口（或运行 `Stop-HertaRemote.ps1`）。

命令行用法：

```powershell
.\启动Herta手机端.ps1 -Port 8791 -DebugPort 9222     # 常规
.\启动Herta手机端.ps1 -RestartHerta               # Herta 开着但没调试端口时，强制重开
.\启动Herta手机端.ps1 -HertaPath 'X:\某处\Herta.exe' # 自定义路径
.\启动Herta手机端.ps1 -NoFirewall -NoBrowser       # 跳过防火墙/浏览器
```

---

## 它是怎么工作的

```
┌──────────────┐   HTTP/WS    ┌────────────────────┐    CDP     ┌──────────────────────────┐
│ 手机浏览器    │ ───────────► │ bridge/server.mjs  │ ─────────► │ Herta (Electron)         │
│ PWA（触屏 UI）│ ◄─────────── │  :8791 状态折叠/转发 │ ◄───────── │ 渲染层 window.herta 桥    │
└──────────────┘              └────────────────────┘            └──────────────────────────┘
                                        │ 只读
                                        ▼
                       <workspaceRoot>\.herta\transcript\v2\*.jsonl（历史会话）
```

- **不改 app.asar**：Electron 自带的 DevTools 协议（CDP）就是 Herta 的官方调试通道。
  我们用 `--remote-debugging-port` 连上它渲染层，那里 preload 已经挂好了完整的
  `window.herta`（约 70 个命令 + 13 条事件流）。于是：
  - 命令：`Runtime.evaluate` → `window.herta.submitText(...)`，返回值结构化回传；
  - 事件：`Runtime.addBinding` 注入回调，把 `onRecord / onAgent / onTurn / onOverlay …`
    的载荷实时推给桥接服务，再广播给手机。
- **状态折叠共用同一份代码**：`web/store.js` 是照 Herta 官方渲染层 `SessionStore` 的语义写的，
  服务端和手机端都用它折叠事件，所以手机上的会话状态与 PC 完全一致，断线重连也能无缝续上。
- **历史走磁盘**：翻旧会话时直接读 `*.jsonl` 转录，**不会切走 PC 上正在看的会话**；
  只有你点「接管并继续对话」才会 `openSession`，这时 PC 上也会跟着切过去。
- **Herta 自动更新后**：更新会重启 App、丢掉调试端口 → 手机端显示「未连接」，
  这时重新双击一次启动脚本即可（桥接服务本身不用动）。

---

## 手机上能做什么

| 功能 | 说明 |
|---|---|
| 对话 | 和 PC 上同一个会话，流式输出、思考中/工具调用状态都显示 |
| 「想法」折叠 | 黑塔的 thought 块默认折起来，想看再展开 |
| 自我修正 | 她回收上一句重说时，手机上会看到「正在回收…」和重说的内容 |
| 审批 | 命令/改动要你批准时，手机上弹出卡片：**允许一次 / 本次会话 / 总是允许 / 拒绝**，含 diff |
| 打断 / 撤回 | 「停止」中断当前轮；「撤回上一轮」把最后一轮收回 |
| 会话 | 抽屉里列表（标题取自 `.title.json`）、新建、翻旧会话、接管继续 |
| 图片 | 从相册/相机选图，自动压缩到 1568px 再送进 Herta 的待发图片区（最多 5 张） |
| 设置 | 切主题（跟随系统/浅色/深色）、读写/清除 DeepSeek API Key |
| PWA | 可安装、全屏、断线自动重连 |

---

## 安全（请读一眼）

- 桥接服务只监听**局域网**，并且要求**访问令牌**：链接里的 `?k=…` 就是令牌，
  存在 `bridge/.token`（首次运行随机生成）。手机浏览器会把它记在 localStorage。
- 令牌等同于「能遥控你的 Herta」——包括**批准命令执行**、**写入 API Key**、**读工作区文件**。
  所以：别把带令牌的链接发到群里、别在公共 Wi-Fi（咖啡厅/酒店）上开；
  家里/自己的热点没问题。想换令牌：删掉 `bridge/.token` 再启动。
- 手机上打开页面时是**本机 localhost 免令牌**（PC 状态页需要它来显示二维码），
  局域网访问一律要令牌。
- 审批请求默认会送到手机，也仍然会显示在 PC 上——两边都能点，先点的生效。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 手机打开是白屏/一直「连接中…」 | 手机和 PC 得在**同一个 Wi-Fi**；很多路由器开了「AP 隔离」，关掉它 |
| `PC 端 Herta 未连接` | Herta 不是用调试端口启动的。双击启动脚本（会问你要不要重开 Herta） |
| 手机提示「缺少访问令牌」 | 用启动脚本打印的那条完整链接打开，或在页面里粘贴令牌 |
| 手机打不开、PC 上却正常 | 防火墙没放行（本机 Wi-Fi 的网络类别是「公用」，规则要覆盖 Public）。启动脚本会弹一次 UAC 帮你加；手动的话，管理员 PowerShell 跑：<br>`New-NetFirewallRule -DisplayName 'Herta 手机端 (TCP 8791)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8791 -Profile Private,Public` |
| 端口被占用 | `-Port 8792` 换一个 |
| Herta 更新后失联 | 重新双击启动脚本（见上） |
| 手机端发消息没反应，PC 上弹「设置 API Key」 | 在手机抽屉 →「API Key」里填，或直接在 PC 上 Herta 设置里填 |

自检（不用手机也能验证整条链路）：

```powershell
node tools\selftest.mjs           # HTTP/WS/命令/历史/事件/白名单 共 9 项
node tools\uitest.mjs --cdp 9333  # 用无头浏览器真渲染一遍页面并模拟点击
node tools\probe.mjs              # 侦察：CDP 是否连上、window.herta 有哪些能力
```

---

## 目录结构

```
herta-remote/
├─ 启动Herta手机端.bat / .ps1     一键启动（找 node、开 Herta 调试口、放行防火墙、起服务）
├─ Stop-HertaRemote.ps1           停掉桥接服务（不动 Herta）
├─ bridge/
│  ├─ cdp.mjs                     CDP 客户端（自动重连、executeBinding 事件转发）
│  ├─ herta.mjs                   把 window.herta 包装成可远程调用的控制器 + 历史读取 + 图片
│  └─ server.mjs                  HTTP/WS 服务、令牌鉴权、状态折叠、广播
├─ web/                           手机端 PWA（index.html / app.js / style.css / store.js / sw.js）
└─ tools/                         自检与侦察脚本
```

## 已知限制 / 下一步可做

- 只有 **PC 开着、Herta 开着**时手机才可用（它是遥控端，不是独立 App）。
- 手机端目前不做「读工作区文件预览」「语音」；这些能力在桥里已经具备
  （`readWorkspaceFile` / `readWorkspaceBytes` / `onVoice`），接上很快。
- 想要**独立 APK**（不依赖 PC，手机上自带 Key 跑模型）是另一条路，代价完全不同，
  需要重写 Agent 运行时，不在本方案范围内。
