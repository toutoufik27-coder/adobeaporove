@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Quality Guard... your browser will open. Close this window to quit.
python -m quality_guard %*
if errorlevel 1 pause
