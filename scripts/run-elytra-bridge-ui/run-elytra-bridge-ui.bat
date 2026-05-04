@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%" || exit /b 1

where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker CLI not found. Install Docker Desktop or Docker Engine.
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker daemon not running. Start Docker Desktop.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+.
  exit /b 1
)

cd /d "%ROOT%\application" || exit /b 1

if not exist node_modules (
  echo Installing npm dependencies (first run only; may take a minute)...
  call npm install || exit /b 1
)

echo.
echo Starting Elytra Bridge backend + frontend dev servers.
echo Opening http://localhost:5173 in a few seconds.
echo Press Ctrl+C here to stop.
echo.

start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:5173"

call npm run dev
