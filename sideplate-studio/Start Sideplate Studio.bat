@echo off
REM Windows: double-click to start Sideplate Studio.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org, then try again.
  pause
  exit /b 1
)
node server\index.js
pause
