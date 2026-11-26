@echo off
title Detector de camaras ocultas
cd /d "%~dp0"
where py >nul 2>nul && (py detector_camaras.py %* & goto fin)
where python >nul 2>nul && (python detector_camaras.py %* & goto fin)
echo.
echo  Falta Python. Instalalo gratis desde https://www.python.org/downloads/
echo  (marca la casilla "Add Python to PATH") y vuelve a abrir este archivo.
start "" https://www.python.org/downloads/
:fin
echo.
pause
