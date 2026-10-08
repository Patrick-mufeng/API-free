@echo off
title API-free stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel\stop.ps1"
echo.
pause
