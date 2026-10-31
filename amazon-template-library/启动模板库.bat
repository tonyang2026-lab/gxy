@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TASK_PY="
where py >nul 2>nul
if not errorlevel 1 set "TASK_PY=py -3"
if not defined TASK_PY (
 where python >nul 2>nul
 if not errorlevel 1 set "TASK_PY=python"
)
if not defined TASK_PY (
 echo 请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/windows/
 echo 安装时勾选 Add python.exe to PATH，完成后重新打开本文件。
 pause
 exit /b 1
)
%TASK_PY% -c "import sys; sys.exit(sys.version_info < (3,10))"
if errorlevel 1 (
 echo 需要 Python 3.10 或更高版本，请升级Python后重试。
 pause
 exit /b 1
)
%TASK_PY% app.py
pause
