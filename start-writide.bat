@echo off
setlocal
cd /d "%~dp0"

if not defined PORT set "PORT=5173"
set "APP_URL=http://127.0.0.1:%PORT%"
set "LOG_FILE=%~dp0writide.log"
set "OPEN_BROWSER=1"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER=0"

where node >nul 2>&1
if errorlevel 1 (
    echo [Writide] ERROR: Node.js was not found. Install Node.js and try again.
    pause
    exit /b 1
)

if not exist "Workspace" mkdir "Workspace"

if not exist "node_modules" (
    echo [Writide] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [Writide] ERROR: npm install failed. Check the network and Node.js installation.
        pause
        exit /b 1
    )
)

powershell -NoProfile -NonInteractive -Command "try { $response = Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 goto :already_running

powershell -NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 0 }; exit 1" >nul 2>&1
if not errorlevel 1 (
    echo [Writide] ERROR: Port %PORT% is occupied by another program.
    echo [Writide] Close that program or set another PORT, then try again.
    pause
    exit /b 1
)

echo [Writide] Starting server...
start "Writide Server" /b node "%~dp0server.mjs" 1>"%LOG_FILE%" 2>&1

echo [Writide] Waiting for server...
for /l %%i in (1,1,30) do (
    powershell -NoProfile -NonInteractive -Command "try { $response = Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
    if not errorlevel 1 goto :ready
    timeout /t 1 /nobreak >nul
)

echo [Writide] ERROR: Server did not start within 30 seconds.
echo [Writide] Check "%LOG_FILE%" for details.
pause
exit /b 1

:already_running
echo [Writide] Server is already running at %APP_URL%

:ready
if "%OPEN_BROWSER%"=="1" (
    echo [Writide] Opening default browser at %APP_URL%/
    start "" "%APP_URL%/"
)
echo [Writide] Ready at %APP_URL%
exit /b 0
