@echo off
setlocal enabledelayedexpansion
rem RVS 启动脚本：必须脱离进程树启动（Windows 下 Bash 启动的 Node 会随调用结束被杀，SPEC §10）。
rem 只绑定回环地址；启动自检失败时进程直接退出，不会 fallback 到 0.0.0.0。

cd /d "%~dp0"

rem 运行时优先级：RVS_NODE 环境变量 > PATH 中的 node > 本机 managed node。
set "NODE_EXE=%RVS_NODE%"
if "%NODE_EXE%"=="" (
  where node >nul 2>nul
  if !errorlevel!==0 (set "NODE_EXE=node") else (set "NODE_EXE=C:\Users\samal\.workbuddy\binaries\node\versions\22.22.2-6\node.exe")
)

if not exist "data\logs" mkdir "data\logs"

echo [rvs] node = %NODE_EXE%
echo [rvs] 启动中… http://127.0.0.1:4173
start "" /B "%NODE_EXE%" --experimental-sqlite server\bin\rvs.mjs > "data\logs\server.out" 2>&1
echo [rvs] 已在后台启动。日志：data\logs\server.out 与 data\logs\rvs-YYYYMMDD.jsonl
echo [rvs] 停止请运行 stop.bat
endlocal
