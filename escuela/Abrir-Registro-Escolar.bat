@echo off
title Registro Escolar
cd /d "%~dp0"
echo.
echo  Deja esta ventana abierta mientras se use el sistema.
echo  Los docentes entran desde sus celulares o computadoras con la direccion
echo  que aparece abajo ("Otras computadoras y celulares").
echo.
start "" http://localhost:8091
node servidor.js
pause
