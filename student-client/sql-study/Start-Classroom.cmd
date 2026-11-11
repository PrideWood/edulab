@echo off
setlocal
TITLE EduLab SQL 0.14.0 - Classroom
ECHO [1/4] EduLab SQL Win7 x64 portable launcher
ECHO This entry bypasses the EXE launcher. Keep this window open.
set "EDULAB_PYTHON=%~dp0runtime\python.exe"
if not exist "%EDULAB_PYTHON%" goto missing
if not exist "%~dp0runtime\ucrtbase.dll" goto missing
if not exist "%~dp0runtime\api-ms-win-crt-runtime-l1-1-0.dll" goto missing
if not exist "%LOCALAPPDATA%\EduLab-SQL" mkdir "%LOCALAPPDATA%\EduLab-SQL"
set "EDULAB_LOG=%LOCALAPPDATA%\EduLab-SQL\bootstrap.log"
ECHO [CMD] Runtime preflight > "%EDULAB_LOG%"
ECHO [CHECK] Loading Python, SQLite and TLS...
"%EDULAB_PYTHON%" -I -X utf8 -c "import sys,sqlite3,ssl;print('[OK] Runtime preflight passed.')" >> "%EDULAB_LOG%" 2>&1
set "EDULAB_STATUS=%ERRORLEVEL%"
type "%EDULAB_LOG%"
if not "%EDULAB_STATUS%"=="0" goto failed
ECHO [START] Opening the local classroom in Chrome...
"%EDULAB_PYTHON%" -I -X utf8 -u "%~dp0runtime\boot.py" --port 0
if not "%ERRORLEVEL%"=="0" goto failed
exit /b 0
:missing
ECHO [ERROR] Runtime files are missing. Extract the ENTIRE zip before starting.
goto fallback
:failed
ECHO [ERROR] Startup stopped. Do not delete student data.
ECHO This package includes app-local UCRT. No system patch or restart is required.
ECHO Keep runtime intact. Save the exact missing-DLL or startup error for diagnosis.
ECHO Bootstrap details: %LOCALAPPDATA%\EduLab-SQL\bootstrap.log
ECHO If Python started, see: %LOCALAPPDATA%\EduLab-SQL\startup-diagnostic.log
:fallback
ECHO Student web delivery is paused. Use this local classroom package.
ECHO Send the startup error and diagnostic logs to your teacher.
PAUSE
exit /b 1
