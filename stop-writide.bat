@echo off
rem Stop only the Writide server associated with this directory and port.
setlocal
if not defined PORT set "PORT=5173"
powershell -NoProfile -File "%~dp0scripts\stop-server.ps1" -Port %PORT%
if errorlevel 1 pause
