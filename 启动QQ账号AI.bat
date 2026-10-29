@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0qq-account-ai"
where node >nul 2>nul
if errorlevel 1 (
 echo 请先安装 Node.js 24。
 pause
 exit /b 1
)
if not exist ".env" (
 copy ".env.example" ".env" >nul
 echo 首次使用：请在记事本中填写NapCat令牌、允许的群号与好友QQ号，保存后重新启动。
 notepad ".env"
 pause
 exit /b 0
)
call npm start
pause
