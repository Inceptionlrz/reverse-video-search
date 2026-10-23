@echo off
setlocal enabledelayedexpansion
rem RVS 停止脚本：按端口精确终止监听进程。
rem 禁止杀整棵进程树——只杀占用 4173 端口的那一个 PID，避免误伤同会话的其他 Node 进程。

set "PORT=4173"
if not "%RVS_PORT%"=="" set "PORT=%RVS_PORT%"

set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo [rvs] 终止监听 %PORT% 的进程 PID=%%p
  taskkill /f /pid %%p >nul 2>nul
  if !errorlevel!==0 (set "KILLED=1")
)

if "%KILLED%"=="0" (
  echo [rvs] 没有发现监听 %PORT% 的进程（可能已停止）
) else (
  echo [rvs] 已停止
)
endlocal
