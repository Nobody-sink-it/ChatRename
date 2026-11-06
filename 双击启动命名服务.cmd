@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-renamer.ps1"
set "renamer_exit=%ERRORLEVEL%"
echo.
echo Service stopped. Press any key to close this window.
pause >nul
exit /b %renamer_exit%
