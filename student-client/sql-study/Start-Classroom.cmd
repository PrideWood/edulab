@echo off
setlocal
TITLE EduLab SQL 0.12.0 - Classroom
ECHO [1/4] EduLab SQL Win7 x64 portable launcher
ECHO This entry bypasses the EXE launcher. Keep this window open.
set "EDULAB_PYTHON=%~dp0runtime\python.exe"
if not exist "%EDULAB_PYTHON%" goto missing
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
ECHO Check Win7 SP1 and Microsoft VC/UCRT system updates with the lab administrator.
ECHO Bootstrap details: %LOCALAPPDATA%\EduLab-SQL\bootstrap.log
ECHO If Python started, see: %LOCALAPPDATA%\EduLab-SQL\startup-diagnostic.log
:fallback
ECHO Online classroom: https://edulab.dacnote.com/sql-student
ECHO Open that URL manually in Chrome 69 or later.
PAUSE
exit /b 1
