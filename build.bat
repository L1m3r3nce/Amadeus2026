@echo off
title Amadeus Build
cd /d E:\Amadeus\amadeus

REM Clear env vars that conflict with Next.js 16 worker
set NODE_OPTIONS=

echo ========================================
echo  Amadeus Build
echo  next build + tauri build
echo ========================================
echo.

call npx tauri build

echo.
echo ========================================
if errorlevel 1 (
    echo  BUILD FAILED! Check errors above.
) else (
    echo  BUILD SUCCESS!
    echo  Installer at: src-tauri\target\release\bundle\nsis\
)
echo ========================================
pause
