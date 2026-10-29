@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0qq-local-bot"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 LTS：https://nodejs.org/
  pause
  exit /b 1
)
if not exist ".env" copy ".env.example" ".env" >nul
set OPEN_BROWSER=true
call npm start
pause
endlocal
