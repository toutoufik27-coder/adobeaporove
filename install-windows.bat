@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installing Quality Guard...
python -m pip install --upgrade pip
python -m pip install ".[vision]"
if errorlevel 1 (
  echo.
  echo Python was not found or the install failed. Install Python 3.11+ from python.org and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
echo.
echo Done. Double-click run-windows.bat to check a folder.
pause
