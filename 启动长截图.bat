@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 LTS，然后重新双击本文件。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm，请重新安装 Node.js 并启用 Add to PATH。
  pause
  exit /b 1
)
if not exist "node_modules\electron\package.json" (
  echo 首次启动正在安装依赖，需要联网，请稍候。
  call npm ci
  if errorlevel 1 (
    echo 安装未成功，请保留这个窗口并查看上面的错误。
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo 启动失败，请保留此窗口查看错误。
  pause
)
endlocal
