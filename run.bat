@echo off
REM Serves the whole project (vectorizer + prompts) on http://127.0.0.1:8020 and opens the vectorizer.
cd /d "%~dp0.."
set URL=http://127.0.0.1:8020/vectorizer/
netstat -ano | findstr /r /c:"127.0.0.1:8020 .*LISTENING" >nul
if %errorlevel%==0 (
  start "" "%URL%"
  goto :eof
)
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
start "" "%URL%"
echo Running on %URL%  (prompts: http://127.0.0.1:8020/prompts/)  close this window to stop
"%PY%" -m http.server 8020 --bind 127.0.0.1
if errorlevel 1 (
  echo Could not start the server. Is Python installed?
  pause
)
