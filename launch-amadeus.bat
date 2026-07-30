@echo off
title Amadeus
cd /d E:\Amadeus\amadeus

REM kill old next start on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul

REM build
echo Building...
call npx next build
echo.

REM start next start in background
start "Amadeus Server" /B cmd /c "npx next start"

REM wait for port 3000 ready
:wait
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3000.*LISTENING" >nul
if errorlevel 1 goto wait

REM open app window
start "" "E:\Amadeus\amadeus\src-tauri\target\debug\app.exe"

REM done, server runs in background
exit
