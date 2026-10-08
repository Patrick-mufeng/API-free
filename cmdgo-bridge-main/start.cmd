@echo off
cd /d "%~dp0"
if not exist "dist\index.js" (
  echo [ERROR] dist\index.js not found. Build first: npm install ^&^& npm run build
  pause
  exit /b 1
)
echo Starting cmdgo-bridge ... keep this window open; closing it stops the service.
node dist\index.js
pause