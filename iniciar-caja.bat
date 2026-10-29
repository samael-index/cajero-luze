@echo off
REM Inicia la caja: arranca el servidor y abre la pantalla completa.
REM Requiere Node.js, PostgreSQL y el archivo .env (ver README.md).
cd /d "%~dp0"
start "Caja - servidor (no cerrar)" /min cmd /c "npm start"
timeout /t 5 >nul
start msedge --kiosk http://localhost:3000 --edge-kiosk-type=fullscreen
