<#
    启动Herta手机端.ps1
    ------------------------------------------------------------------
    把 PC 上的桌面版 Herta 变成手机能用的应用（局域网遥控端 + PWA）。

    它做四件事：
      1) 找一个可用的 node（本机 E:\node、PATH、DSH 自带都试）
      2) 确认 Herta 是带 --remote-debugging-port 启动的（没开就帮你重开）
      3) 放行防火墙的 TCP 端口（需要管理员，脚本会提示）
      4) 启动桥接服务并把「手机访问地址 + 二维码」打到屏幕上

    用法：
      双击 启动Herta手机端.bat          # 常规启动
      powershell -File 启动Herta手机端.ps1 -RestartHerta   # 强制重启 Herta
#>
[CmdletBinding()]
param(
    [string]$HertaPath = 'D:\Herta\Herta.exe',
    [int]$Port = 8791,
    [int]$DebugPort = 9222,
    [switch]$RestartHerta,
    [switch]$NoBrowser,
    [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Root = $PSScriptRoot
$Server = Join-Path $Root 'bridge\server.mjs'
$RuleName = "Herta 手机端 (TCP $Port)"

function Say([string]$m) { Write-Host $m }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Good([string]$m) { Write-Host $m -ForegroundColor Green }

function Test-Admin {
    try {
        return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# ---------------------------------------------------------------- 1. node
function Find-Node {
    $cands = @()
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    $cands += @(
        'E:\node\node.exe',
        'C:\Program Files\nodejs\node.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        'D:\nodejs\node.exe'
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            try {
                $v = & $c -v 2>$null
                if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18) { return @{ Path = $c; Version = $v } }
            } catch { }
        }
    }
    return $null
}

Say ''
Say '================= Herta 手机端 ================='
$node = Find-Node
if (-not $node) {
    Warn '没找到 Node.js（需要 18 以上）。'
    Say  '装一个就行：https://nodejs.org/ 或国内镜像 https://npmmirror.com/mirrors/node/'
    exit 1
}
Good ("Node.js {0}  ({1})" -f $node.Version, $node.Path)
if (-not (Test-Path -LiteralPath $Server)) { Warn "找不到桥接服务: $Server"; exit 1 }

# ---------------------------------------------------------------- 2. Herta
if (-not (Test-Path -LiteralPath $HertaPath)) {
    $guess = Get-ChildItem -Path 'C:\','D:\','E:\' -Filter 'Herta.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($guess) { $HertaPath = $guess.FullName; Good "自动找到 Herta: $HertaPath" }
    else { Warn "找不到 Herta.exe，请用 -HertaPath 指定路径（当前: $HertaPath）"; exit 1 }
}

$listening = $false
try {
    $listening = [bool](Get-NetTCPConnection -State Listen -LocalPort $DebugPort -ErrorAction SilentlyContinue)
} catch { }
$running = @(Get-Process -Name 'Herta' -ErrorAction SilentlyContinue)

if ($listening) {
    Good "Herta 已经在 $DebugPort 上开着调试端口，直接用它。"
} elseif ($running.Count -gt 0) {
    Warn "Herta 正在运行（pid=$($running.Id -join ',')），但它没有开调试端口。"
    if (-not $RestartHerta) {
        $ans = Read-Host '要把它关掉并用调试端口重开吗？(y/N)'
        if ($ans -notmatch '^(y|Y)') {
            Warn '已取消。请手动关掉 Herta 后再运行本脚本。'
            exit 1
        }
    }
    Say '正在关闭 Herta…'
    $running | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch { } }
    Start-Sleep -Seconds 2
    Get-Process -Name 'Herta' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch { } }
    Start-Sleep -Seconds 2
}

if (-not $listening) {
    Say "正在启动 Herta（带调试端口 $DebugPort）…"
    Start-Process -FilePath $HertaPath -ArgumentList "--remote-debugging-port=$DebugPort" -WorkingDirectory (Split-Path -Parent $HertaPath)
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try { $ok = [bool](Get-NetTCPConnection -State Listen -LocalPort $DebugPort -ErrorAction SilentlyContinue) } catch { }
        if ($ok) { break }
    }
    if ($ok) { Good "Herta 已启动，调试端口 $DebugPort 就绪。" }
    else { Warn "Herta 起来了但 $DebugPort 还没监听（界面可能还在加载，稍后桥接会自动连上）。" }
}

# ---------------------------------------------------------------- 3. 防火墙
# 注意：很多家用 Wi-Fi 在 Windows 里的类别是「公用(Public)」，规则必须覆盖它，
# 否则手机上连不上（这是实际踩过的坑）。
if (-not $NoFirewall) {
    $ruleCmd = "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private,Public -Description 'Herta 手机端：允许同一 Wi-Fi 下的手机访问'"
    $hasRule = $false
    try { $hasRule = [bool](Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) } catch { }
    if ($hasRule) {
        Good "防火墙规则已存在：$RuleName"
    } elseif (Test-Admin) {
        try {
            Invoke-Expression $ruleCmd | Out-Null
            Good "已放行防火墙 TCP $Port（专用 + 公用网络）。"
        } catch { Warn "放行防火墙失败：$($_.Exception.Message)" }
    } else {
        # 不是管理员：只把这一条命令提权跑一次（弹一次 UAC），比让用户自己敲省事
        Warn "需要放行防火墙端口 TCP $Port（会弹一次 UAC 确认框）。"
        try {
            Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $ruleCmd
            Start-Sleep -Milliseconds 800
            if ([bool](Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
                Good "已放行防火墙 TCP $Port（专用 + 公用网络）。"
            } else {
                Warn '放行好像没生效。手动以管理员身份跑一次：'
                Say  ("  " + $ruleCmd)
            }
        } catch {
            Warn "提权被取消或失败：$($_.Exception.Message)"
            Say  '手动以管理员身份跑一次：'
            Say  ("  " + $ruleCmd)
        }
    }
}

# ---------------------------------------------------------------- 4. 起服务
Say ''
Say '正在启动桥接服务…（这个窗口就是服务本体，关掉窗口＝停止服务）'
Say ('-' * 62)
if (-not $NoBrowser) {
    Start-Sleep -Milliseconds 900
    try { Start-Process "http://127.0.0.1:$Port/" | Out-Null } catch { }
}
$env:HERTA_REMOTE_PORT = "$Port"
$env:HERTA_DEBUG_PORT = "$DebugPort"
& $node.Path $Server
$code = $LASTEXITCODE
Say ('-' * 62)
Say "桥接服务已退出（exit=$code）。"
