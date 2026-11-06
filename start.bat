@echo off
rem Starts the backend and the dashboard, each in its own window, then opens
rem the dashboard. Close a window to stop that server.
cd /d "%~dp0"

start "Bid Bot backend" cmd /c backend\start.bat
start "Bid Bot dashboard" cmd /c frontend\start.bat

rem Give Vite a moment to come up before opening the page.
timeout /t 5 /nobreak >nul
start "" http://localhost:5175
