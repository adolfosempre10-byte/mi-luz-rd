@echo off
title Detector de camaras ocultas
cd /d "%~dp0"
if exist DetectorCamaras.exe (start "" DetectorCamaras.exe & exit /b)
where pyw >nul 2>nul && (start "" pyw app_camaras.py & exit /b)
where pythonw >nul 2>nul && (start "" pythonw app_camaras.py & exit /b)
echo.
echo  Falta Python. Instalalo gratis desde https://www.python.org/downloads/
echo  (marca la casilla "Add Python to PATH") y vuelve a abrir este archivo.
start "" https://www.python.org/downloads/
pause
