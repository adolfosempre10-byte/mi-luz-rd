@echo off
title Mi Luz RD
cd /d "%~dp0"
echo.
echo  Deja esta ventana abierta mientras usas la app.
echo  Para cerrarla, cierra esta ventana.
echo.
start "" http://localhost:8090
node servidor.js
pause
