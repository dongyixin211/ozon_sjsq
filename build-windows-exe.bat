@echo off
setlocal EnableExtensions
title Ozon SJSQ Windows Build

set "ROOT=%~dp0"
cd /d "%ROOT%"
if errorlevel 1 goto fail

echo.
echo ========================================
echo  Ozon SJSQ Windows EXE Build
echo ========================================
echo Project: %cd%
echo.

set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "D:\APP\nodejs\node.exe" set "NODE_EXE=D:\APP\nodejs\node.exe"

set "NPM_CMD="
for %%I in (npm.cmd) do set "NPM_CMD=%%~$PATH:I"
if not defined NPM_CMD if exist "D:\APP\nodejs\npm.cmd" set "NPM_CMD=D:\APP\nodejs\npm.cmd"

if not defined NODE_EXE (
  echo [ERROR] node.exe was not found.
  echo Please install Node.js LTS, or add node.exe to PATH.
  echo Download: https://nodejs.org/
  goto fail
)

if not defined NPM_CMD (
  echo [ERROR] npm.cmd was not found.
  echo Please reinstall Node.js, or add npm.cmd to PATH.
  goto fail
)

if not exist "package.json" (
  echo [ERROR] package.json was not found.
  echo Please keep this file in the project root folder.
  goto fail
)

echo [INFO] Node:
"%NODE_EXE%" -v
if errorlevel 1 goto fail

echo [INFO] npm:
call "%NPM_CMD%" -v
if errorlevel 1 goto fail

if /I "%~1"=="--check" (
  echo.
  echo [OK] Build script check passed. Build was not started.
  exit /b 0
)

if not exist "node_modules" (
  echo.
  echo [INFO] node_modules was not found. Running npm install...
  call "%NPM_CMD%" install
  if errorlevel 1 goto fail
) else (
  echo [INFO] node_modules found. Skip npm install.
)

echo.
echo [INFO] Start Windows EXE build.
echo [INFO] This may take several minutes. Do not close this window.
echo.

set "CARGO_BUILD_JOBS=1"
if not defined TAURI_SIGNING_PRIVATE_KEY_PATH set "TAURI_SIGNING_PRIVATE_KEY_PATH=%APPDATA%\com.codex.ozon-sjsq\updater-signing.key"
if not exist "%TAURI_SIGNING_PRIVATE_KEY_PATH%" (
  echo [ERROR] Updater signing key was not found: %TAURI_SIGNING_PRIVATE_KEY_PATH%
  echo Run: npx tauri signer generate --ci --write-keys "%TAURI_SIGNING_PRIVATE_KEY_PATH%"
  goto fail
)
set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE=%APPDATA%\com.codex.ozon-sjsq\updater-signing.password"
if not exist "%TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE%" (
  echo [ERROR] Updater signing password file was not found: %TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE%
  goto fail
)
for /f "usebackq delims=" %%K in ("%TAURI_SIGNING_PRIVATE_KEY_PATH%") do set "TAURI_SIGNING_PRIVATE_KEY=%%K"
for /f "usebackq delims=" %%P in ("%TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE%") do set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%%P"
call "%NPM_CMD%" run tauri:build:windows
if errorlevel 1 goto fail

set "NSIS_DIR=%cd%\src-tauri\target\release\bundle\nsis"

echo.
echo ========================================
echo  Build finished
echo ========================================

if exist "%NSIS_DIR%" (
  echo Installer folder: %NSIS_DIR%
  set "LATEST_EXE="
  for /f "delims=" %%F in ('dir /b /a-d /o-d "%NSIS_DIR%\*.exe" 2^>nul') do (
    set "LATEST_EXE=%NSIS_DIR%\%%F"
    goto show_latest
  )
  :show_latest
  if defined LATEST_EXE echo Latest EXE: %LATEST_EXE%
  echo.
  echo [INFO] Opening installer folder...
  start "" "%NSIS_DIR%"
) else (
  echo [WARN] Default NSIS output folder was not found.
  echo Please check the build log above.
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0

:fail
echo.
echo ========================================
echo  Build failed
echo ========================================
echo Please check the error messages above.
echo Common reasons:
echo 1. Rust or Tauri Windows build tools are not installed.
echo 2. Node.js or npm is not available.
echo 3. Network failed while installing dependencies.
echo 4. The project has a compile error.
echo.
echo Press any key to close this window...
pause >nul
exit /b 1
