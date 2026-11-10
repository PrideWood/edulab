@echo off
setlocal
cd /d "%~dp0"
py -3 build_windows.py %*
if errorlevel 1 goto failed
echo Built release\EduLab-SQL.exe
pause
exit /b 0
:failed
echo Build failed. Check Python, Go and the restricted .private\runtime.json configuration.
pause
exit /b 1
