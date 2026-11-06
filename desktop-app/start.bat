@echo off
rem Starts the Bid Bot desktop app.
cd /d "%~dp0"

rem A window opened before Node.js was installed still has the old PATH.
where npm >nul 2>nul || set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org and try again. & pause & exit /b 1)

if not exist node_modules (
  echo Installing desktop app dependencies...
  call npm ci --no-fund --no-audit || (pause & exit /b 1)
)

rem npm 11 skips install scripts by default, so Electron's own binary may be missing.
if not exist node_modules\electron\dist\electron.exe (
  echo Downloading Electron...
  call node node_modules\electron\install.js || (pause & exit /b 1)
)

call npm start
pause
