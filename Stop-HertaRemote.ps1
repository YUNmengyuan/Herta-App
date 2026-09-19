/** 停止 Herta 手机端的桥接服务（只杀我们自己的 node 进程，不动 Herta） */
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$me = $PID
$killed = 0
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -match 'herta-remote[\\/]bridge[\\/]server\.mjs') {
        Write-Host ("停止桥接服务 pid={0}" -f $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
if ($killed -eq 0) { Write-Host '没有正在运行的桥接服务。' } else { Write-Host ("已停止 {0} 个进程。" -f $killed) }
