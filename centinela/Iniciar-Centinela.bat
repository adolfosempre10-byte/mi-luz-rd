@echo off
title Centinela
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Centinela necesita permisos de administrador para leer los eventos de seguridad
  echo  y bloquear IPs en el firewall. Clic derecho en este archivo -^> "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)
echo.
echo  Deja esta ventana abierta mientras Centinela vigila el equipo.
echo  Panel: http://localhost:8095
echo.
start "" http://localhost:8095
node centinela.js
pause
