# Instala Centinela en Windows como tarea que arranca con el equipo (cuenta SYSTEM).
# Uso: clic derecho -> "Ejecutar con PowerShell" como administrador, o:
#   powershell -ExecutionPolicy Bypass -File instalar\instalar-windows.ps1
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Ejecuta este script como administrador.' -ForegroundColor Red; exit 1
}
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Falta Node.js 20 o superior: https://nodejs.org' -ForegroundColor Red; exit 1 }

# 1) Que Windows registre los inicios de sesion fallidos y los cambios de cuentas (GUIDs: funcionan en Windows en español).
auditpol /set /subcategory:"{0CCE9215-69AE-11D9-BED3-505054503030}" /success:enable /failure:enable | Out-Null  # Inicio de sesion
auditpol /set /subcategory:"{0CCE9217-69AE-11D9-BED3-505054503030}" /failure:enable | Out-Null                  # Bloqueo de cuenta
auditpol /set /subcategory:"{0CCE9235-69AE-11D9-BED3-505054503030}" /success:enable | Out-Null                  # Cuentas de usuario
auditpol /set /subcategory:"{0CCE9237-69AE-11D9-BED3-505054503030}" /success:enable | Out-Null                  # Grupos de seguridad
Write-Host 'Auditoria de inicios de sesion activada.'

# 2) Que el firewall registre los paquetes bloqueados (para detectar escaneos de puertos).
netsh advfirewall set allprofiles logging droppedconnections enable | Out-Null
netsh advfirewall set allprofiles logging maxfilesize 32767 | Out-Null
Write-Host 'Registro del firewall activado.'

# 3) Tarea programada que arranca Centinela con Windows y lo reinicia si se cae.
$accion = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\centinela.js`"" -WorkingDirectory $dir
$inicio = New-ScheduledTaskTrigger -AtStartup
$ajustes = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$cuenta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Centinela' -Action $accion -Trigger $inicio -Settings $ajustes -Principal $cuenta -Force | Out-Null
Start-ScheduledTask -TaskName 'Centinela'
Start-Sleep -Seconds 3
Write-Host ''
Write-Host 'Centinela instalado y funcionando.' -ForegroundColor Green
Write-Host "Configuracion: $dir\centinela.config.json"
Write-Host 'Panel: http://localhost:8095'
Write-Host 'Para detenerlo:  Stop-ScheduledTask -TaskName Centinela'
Write-Host 'Para quitarlo:   Unregister-ScheduledTask -TaskName Centinela'
