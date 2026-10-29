@echo off
REM Copia de seguridad de la base de datos. Programela en el Programador de tareas de Windows (ver README.md).
REM Ajuste PG_BIN si PostgreSQL esta instalado en otra carpeta.
setlocal
cd /d "%~dp0"
set PG_BIN=C:\Program Files\PostgreSQL\16\bin
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="DATABASE_URL" set DATABASE_URL=%%b
if "%DATABASE_URL%"=="" (echo Falta DATABASE_URL en .env & exit /b 1)
if not exist backups mkdir backups
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set STAMP=%%d
"%PG_BIN%\pg_dump.exe" --format=custom --no-owner --file="backups\caja-%STAMP%.dump" "%DATABASE_URL%"
if errorlevel 1 (echo ERROR: no se pudo crear la copia & exit /b 1)
echo Copia creada: backups\caja-%STAMP%.dump
REM conserva solo las copias de los ultimos 30 dias
forfiles /p backups /m caja-*.dump /d -30 /c "cmd /c del @path" 2>nul
exit /b 0
