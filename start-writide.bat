@echo off
setlocal
cd /d "%~dp0"
echo [Writide] Checking local server...
where node >nul 2>&1
if errorlevel 1 (
    echo [Writide] ERROR: Install Node.js 22.12 or newer first.
    pause
    exit /b 1
)
node "%~dp0scripts\start-server.mjs" %*
set "RESULT=%errorlevel%"
if not "%RESULT%"=="0" if /i not "%~1"=="--no-browser" pause
exit /b %RESULT%
