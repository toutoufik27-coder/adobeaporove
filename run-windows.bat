@echo off
chcp 65001 >nul
python -m quality_guard %*
pause
