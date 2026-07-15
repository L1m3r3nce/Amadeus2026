@echo off
title Amadeus
cd /d E:\Amadeus\amadeus

:: 杀掉旧的 next start 进程(端口 3000)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul

:: 重新 build 确保最新代码
echo 正在编译...
call npx next build
echo.

:: 启动 next start (production 模式)
start "Amadeus Server" /B cmd /c "npx next start"

:: 等待端口 3000 就绪
:wait
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3000.*LISTENING" >nul
if errorlevel 1 goto wait

:: 打开应用窗口
start "" "E:\Amadeus\amadeus\src-tauri\target\debug\app.exe"

:: 本窗口关闭(服务在后台跑)
exit
