# Lab 5 - Simulacion de ataques en el agente Windows (SOLO en la VM del laboratorio)
# Ejecutar en PowerShell como Administrador:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\simulacion-windows.ps1            -> hace las simulaciones
#   .\simulacion-windows.ps1 -Limpiar   -> borra el usuario y la tarea al final
# Cada paso queda anotado con la hora en lineadetiempo.csv (para el paso 5 del informe).

param([switch]$Limpiar, [switch]$SinBorrarLog)

$csv = Join-Path $PSScriptRoot "lineadetiempo.csv"
$equipo = $env:COMPUTERNAME

function Anotar($eventId, $accion, $tecnica) {
    $hora = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    [pscustomobject]@{Hora=$hora; Sistema=$equipo; EventID=$eventId; Accion=$accion; Tecnica=$tecnica} |
        Export-Csv -Path $csv -Append -NoTypeInformation -Encoding UTF8
    Write-Host ("[{0}] {1,-5} {2}  ({3})" -f $hora, $eventId, $accion, $tecnica) -ForegroundColor Cyan
}

if ($Limpiar) {
    schtasks /delete /tn Updater /f 2>$null | Out-Null
    net user hacker /delete 2>$null | Out-Null
    Write-Host "Limpieza hecha: tarea 'Updater' y usuario 'hacker' eliminados." -ForegroundColor Green
    exit
}

# 0. Activar la auditoria que hace falta (si no, 4698 y a veces 4625 no aparecen)
auditpol /set /subcategory:"Logon" /success:enable /failure:enable | Out-Null
auditpol /set /subcategory:"User Account Management" /success:enable | Out-Null
auditpol /set /subcategory:"Security Group Management" /success:enable | Out-Null
auditpol /set /subcategory:"Other Object Access Events" /success:enable | Out-Null
Write-Host "Auditoria activada. Captura esto para el informe:" -ForegroundColor Yellow
auditpol /get /subcategory:"Logon","User Account Management","Security Group Management","Other Object Access Events"
Read-Host "Toma la captura y pulsa Enter para empezar"

# 1. Fuerza bruta: 5 inicios de sesion fallidos -> 4625
1..5 | ForEach-Object {
    net use \\127.0.0.1\IPC$ /user:$equipo\administrador "ClaveMala$_" 2>$null | Out-Null
    Start-Sleep -Milliseconds 700
}
net use \\127.0.0.1\IPC$ /delete 2>$null | Out-Null
Anotar "4625" "5 inicios de sesion fallidos" "T1110 Fuerza bruta"
Start-Sleep 3

# 2. Crear cuenta -> 4720
net user hacker 'Pass123!' /add | Out-Null
Anotar "4720" "Usuario 'hacker' creado" "T1136.001 Crear cuenta local"
Start-Sleep 3

# 3. Meterla en Administradores -> 4732
$grupo = (Get-LocalGroup -SID "S-1-5-32-544").Name   # 'Administradores' o 'Administrators'
net localgroup "$grupo" hacker /add | Out-Null
Anotar "4732" "Usuario 'hacker' agregado a $grupo" "T1098 Manipulacion de cuentas"
Start-Sleep 3

# 4. Persistencia con tarea programada -> 4698
schtasks /create /tn Updater /tr calc.exe /sc onlogon /f | Out-Null
Anotar "4698" "Tarea programada 'Updater' creada" "T1053.005 Tarea programada"
Start-Sleep 3

# 5. Borrar el log de seguridad -> 1102
if (-not $SinBorrarLog) {
    $r = Read-Host "Paso 5 borra el log de Seguridad de ESTA VM. Verifica antes en Wazuh que llegaron los eventos 4625-4698. Escribe SI para continuar"
    if ($r -eq "SI") {
        wevtutil cl Security
        Anotar "1102" "Log de Seguridad borrado" "T1070.001 Borrado de logs de Windows"
    }
}

Write-Host "`nListo. Linea de tiempo guardada en: $csv" -ForegroundColor Green
Write-Host "En Wazuh > Threat Hunting / Discover filtra con:"
Write-Host "  data.win.system.eventID: (4625 or 4720 or 4732 or 4698 or 1102)"
Write-Host "Cuando termines las capturas: .\simulacion-windows.ps1 -Limpiar"
