@echo off
chcp 65001 >nul
title Aurora Voyage - EEG Receiver
cd /d "%~dp0"

echo ============================================
echo  Aurora Voyage / Star Voyage EEG Receiver
echo ============================================
echo.

REM Prefer the Windows Python launcher; fall back to python on PATH.
where py >nul 2>nul
if %errorlevel%==0 (
    set PY=py -3
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Python not found.
        echo         Install Python 3.10+ from https://www.python.org/downloads/
        echo         and tick "Add python.exe to PATH" during setup.
        pause
        exit /b 1
    )
    set PY=python
)

REM Install dependencies on first run.
%PY% -c "import pythonosc, websockets" >nul 2>nul
if errorlevel 1 (
    echo [SETUP] Installing dependencies, this only happens once...
    %PY% -m pip install --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Dependency install failed. Run this manually:
        echo         %PY% -m pip install -r requirements.txt
        pause
        exit /b 1
    )
)

echo [RUN] Starting receiver. Press Ctrl+C to stop.
echo       Muse Direct OSC target: 127.0.0.1:8000
echo.
%PY% -u eeg_receiver.py %*

echo.
echo Receiver stopped.
pause
