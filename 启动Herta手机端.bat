@echo off
rem Herta 手机端 launcher (ASCII only on purpose: cmd reads .bat as ANSI)
cd /d "%~dp0"
chcp 65001 >nul 2>nul
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动Herta手机端.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动Herta手机端.ps1" %*
)
echo.
pause
