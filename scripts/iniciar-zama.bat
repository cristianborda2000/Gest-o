@echo off
cd /d "%~dp0\.."
echo Iniciando o servidor local da ZAMA...
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:5174/'"
npm.cmd run serve
pause
