@echo off
rem Starts the dashboard on http://localhost:5175.
cd /d "%~dp0"

rem A window opened before Node.js was installed still has the old PATH.
where npm >nul 2>nul || set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org and try again. & pause & exit /b 1)

if not exist node_modules (
  echo Installing dashboard dependencies...
  call npm ci --no-fund --no-audit || (pause & exit /b 1)
)

call npm run dev
pause
