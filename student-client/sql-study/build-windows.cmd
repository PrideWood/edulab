@echo off
setlocal
cd /d "%~dp0"
py -3 -m PyInstaller --noconfirm --clean --onedir --name EduLab-SQL --add-data "web;web" --add-data "questions.json;." server.py
if errorlevel 1 goto failed
echo.
echo Build complete: dist\EduLab-SQL\EduLab-SQL.exe
echo Teacher configuration stays outside the public package. Read README.md before distribution.
pause
exit /b 0
:failed
echo Build failed. Install Python and PyInstaller on the Windows build machine first.
pause
exit /b 1
