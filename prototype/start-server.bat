@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"
echo.
echo   ==========================================
echo    星图 . 本地服务
echo   ==========================================
echo    地址： http://localhost:5173
echo    关掉这个窗口 = 停止服务
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5173'"
"%NODEEXE%" server.js
echo.
echo   服务已停止。若上面有报错，多半是端口被占用，或 config.json 写坏了。
pause
