@echo off
title Add Defender Exclusion for Amadeus
echo Adding Windows Defender exclusions (will ask for admin permission)...
powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0add-defender-exclusion.ps1\"'"
echo.
echo If you saw a green OK message, exclusions were added successfully.
echo You can now launch Amadeus again.
pause
