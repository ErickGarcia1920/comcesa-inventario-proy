@echo off
setlocal enabledelayedexpansion
cd /d "C:\Users\Comcesa\comcesa-inventario-proy"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set FECHA=%%i
set "LOG=logs\sync-%FECHA%.log"
set "NODE=C:\Program Files\nodejs\node.exe"

echo ===== Inicio %date% %time% ===== >> "%LOG%"
call :correr scripts\sync-aspel.js
if errorlevel 1 goto fallo
call :correr scripts\sync-precios.js
if errorlevel 1 goto fallo
echo ===== Fin OK %date% %time% ===== >> "%LOG%"
exit /b 0

:fallo
echo ===== TERMINO CON ERROR %date% %time% ===== >> "%LOG%"
exit /b 1

:correr
set INTENTO=1
:reintento
echo [%time%] %~1 intento !INTENTO! de 3 >> "%LOG%"
"%NODE%" "%~1" >> "%LOG%" 2>&1
if not errorlevel 1 exit /b 0
if !INTENTO! GEQ 3 exit /b 1
set /a INTENTO+=1
ping -n 61 127.0.0.1 >nul
goto reintento