@echo off
rem Guitar Helper launcher for Windows: double-click this file.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start.py %*
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3.11+ is required. Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^).
    pause
    exit /b 1
  )
  python start.py %*
)
if errorlevel 1 pause
