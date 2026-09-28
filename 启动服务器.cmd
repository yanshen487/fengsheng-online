@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org
  echo         Then run this file again.
  pause
  exit /b 1
)
node launcher.cjs
if errorlevel 1 pause
