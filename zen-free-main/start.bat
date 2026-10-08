@echo off
rem ============================================================
rem  zen-free local server launcher (Windows)
rem
rem  Double-click this file, or run:  start.bat
rem  Stop it with Ctrl+C, or by closing this window.
rem
rem  This file is intentionally ASCII-ONLY: cmd.exe mis-parses
rem  batch files that contain multi-byte UTF-8 (it splits lines at
rem  wrong byte offsets when such a character ends a line). The
rem  Chinese notes live in README.md and in the service log.
rem  Keep this file UTF-8 (no BOM) with CRLF line endings.
rem ============================================================

chcp 65001 >nul
setlocal enableextensions
cd /d "%~dp0"
title zen-free

netstat -ano | findstr "127.0.0.1:8020" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto :already_running

where go >nul 2>nul
if errorlevel 1 goto :no_go

if not exist "bin\zen-free.exe" (
  echo [start] bin\zen-free.exe not found, building ...
  go build -o bin\zen-free.exe .\cmd\server
  if errorlevel 1 goto :build_failed
)

echo [start] starting zen-free - listening on 127.0.0.1:8020
echo [start] config file: config.json  (created with a random api_key on first run)
echo [start] endpoints: /v1/models, /v1/chat/completions, /healthz
echo [start] keep this window open; Ctrl+C or closing it stops the service.
echo.
bin\zen-free.exe -config config.json
set "EXITCODE=%ERRORLEVEL%"

rem Pause only when double-clicked, so a command-line run does not block the caller.
echo %cmdcmdline% | find /i "%~f0" >nul 2>nul
if not errorlevel 1 pause
endlocal
exit /b %EXITCODE%

:already_running
echo.
echo [ERROR] something is already listening on 127.0.0.1:8020:
echo.
netstat -ano | findstr "127.0.0.1:8020" | findstr "LISTENING"
echo.
echo         Either the service is already running, or the API-free panel
echo         started it. Stop that one first, or just keep using it:
echo           - panel:    Services - Zen-free - Stop
echo           - by hand:  taskkill /F /PID ^<pid^>   (pid = last column above)
echo.
pause
endlocal
exit /b 1

:no_go
echo.
echo [ERROR] go not found.
echo.
echo         Install Go 1.24 or newer first: https://go.dev/dl/
echo.
pause
endlocal
exit /b 1

:build_failed
echo.
echo [ERROR] build failed. Run it by hand to see the error:
echo           go build -o bin\zen-free.exe .\cmd\server
echo.
pause
endlocal
exit /b 1
