@echo off
setlocal

cd /d "%~dp0server"

echo [INFO] Starting Ozon SJSQ cloud backend...
echo [INFO] Working directory: %CD%

if not exist package.json (
  echo [ERROR] server package.json not found.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo [WARN] .env not found. Copying .env.example to .env.
  copy .env.example .env >nul
  echo [WARN] Please edit server\.env before using real R2 and PostgreSQL.
)

call npm run dev

pause
