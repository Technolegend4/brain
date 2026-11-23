@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "%~dp0Aurora_Voyage.html"
call "%~dp0start_receiver.bat"
