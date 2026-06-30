@echo off
cd /d "%~dp0"
node server.js
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required to run multiplayer.
  pause
)
