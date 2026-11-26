# Revisar-PC.ps1 - Revisa el disco, limpia basura segura y busca señales de acceso remoto.
# Uso: clic derecho sobre el archivo -> "Ejecutar con PowerShell".
# Solo LEE informacion, salvo la limpieza, que pregunta antes (temporales y papelera).
# Al final guarda un informe en el Escritorio: Revision-PC.txt

# --- Pedir permisos de administrador (hacen falta para ver conexiones e inicios de sesion) ---
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$informe = New-Object System.Collections.Generic.List[string]
function Linea($texto = "", $color = "Gray") { Write-Host $texto -ForegroundColor $color; $informe.Add($texto) }
function Titulo($texto) { Linea ""; Linea ("=== " + $texto + " ===") "Cyan" }
function Alerta($texto) { Linea ("  [!] " + $texto) "Yellow" }
function Bien($texto)   { Linea ("  [ok] " + $texto) "Green" }
function GB($bytes) { "{0:N1} GB" -f ($bytes / 1GB) }
function Tamano($ruta) {
    if (-not (Test-Path $ruta)) { return 0 }
    $s = (Get-ChildItem $ruta -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($s) { $s } else { 0 }
}

Linea "REVISION DE LA COMPUTADORA - $(Get-Date -Format 'dd/MM/yyyy hh:mm tt') - $env:COMPUTERNAME" "White"

# ---------------------------------------------------------------- 1. Disco
Titulo "1. Espacio en disco"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    $libre = $_.FreeSpace; $total = $_.Size; $pct = [math]::Round(100 * $libre / $total)
    $txt = "$($_.DeviceID)  libre $(GB $libre) de $(GB $total)  ($pct% libre)"
    if ($pct -lt 10) { Alerta "$txt  <- casi lleno" } else { Bien $txt }
}

$sitios = [ordered]@{
    "Temporales de tu usuario"       = $env:TEMP
    "Temporales de Windows"          = "$env:WINDIR\Temp"
    "Descargas de Windows Update"    = "$env:WINDIR\SoftwareDistribution\Download"
    "Cache de Edge"                  = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache"
    "Cache de Chrome"                = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache"
    "Carpeta Descargas (revisala tu)" = "$env:USERPROFILE\Downloads"
}
Linea ""
Linea "  Lo que mas ocupa:"
foreach ($n in $sitios.Keys) { Linea ("    {0,-34} {1}" -f $n, (GB (Tamano $sitios[$n]))) }

# ---------------------------------------------------------------- 2. Limpieza (pregunta)
Titulo "2. Limpieza de basura segura"
Linea "  Se borrarian: temporales de tu usuario, temporales de Windows, descargas viejas de"
Linea "  Windows Update y la Papelera. NO se tocan tus documentos, fotos ni Descargas."
$r = Read-Host "  Escribe SI para limpiar (Enter para saltar)"
if ($r -eq "SI") {
    $antes = (Get-PSDrive C).Free
    foreach ($ruta in @($env:TEMP, "$env:WINDIR\Temp")) {
        Get-ChildItem $ruta -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue   # lo que este en uso se salta solo
    }
    Stop-Service wuauserv -Force -ErrorAction SilentlyContinue
    Get-ChildItem "$env:WINDIR\SoftwareDistribution\Download" -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Start-Service wuauserv -ErrorAction SilentlyContinue
    Clear-RecycleBin -Force -ErrorAction SilentlyContinue
    $liberado = (Get-PSDrive C).Free - $antes
    Bien "Limpieza hecha. Se liberaron $(GB ([math]::Max($liberado,0)))."
    $zips = Get-ChildItem "$env:USERPROFILE\Downloads\DetectorCamaras-Windows*.zip" -ErrorAction SilentlyContinue
    if ($zips) {
        $r2 = Read-Host "  Hay $($zips.Count) zip(s) viejos del Detector de camaras en Descargas. Escribe SI para borrarlos"
        if ($r2 -eq "SI") { $zips | Remove-Item -Force; Bien "Zips viejos borrados." }
    }
} else { Linea "  Limpieza saltada." }

# ---------------------------------------------------------------- 3. Acceso remoto
Titulo "3. ¿Hay alguien conectado a tu computadora?"

# 3a. Sesiones abiertas
$sesiones = (quser 2>$null) | Select-Object -Skip 1
if ($sesiones) {
    Linea "  Sesiones abiertas ahora:"
    $sesiones | ForEach-Object { Linea "    $_" }
    if ($sesiones | Where-Object { $_ -match "rdp-tcp" }) { Alerta "Hay una sesion de Escritorio remoto ACTIVA." }
}

# 3b. Escritorio remoto
$rdp = (Get-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server" -ErrorAction SilentlyContinue).fDenyTSConnections
if ($rdp -eq 0) { Alerta "El Escritorio remoto de Windows esta ACTIVADO. Si no lo usas, apagalo en Configuracion > Sistema > Escritorio remoto." }
else { Bien "Escritorio remoto de Windows apagado." }

# 3c. Programas de control remoto
$remotos = "AnyDesk","TeamViewer","rustdesk","UltraViewer","ScreenConnect","ConnectWise","Splashtop","SRService",
           "remoting_host","vncserver","winvnc","tvnserver","LogMeIn","Ammyy","AA_v3","Atera","NinjaRMM","Supremo",
           "parsecd","AeroAdmin","QuickAssist","RemotePC","Zoho","dwagent","MeshAgent","getscreen","radmin"
$enMarcha = Get-Process | Where-Object { $p = $_.ProcessName; $remotos | Where-Object { $p -like "*$_*" } }
if ($enMarcha) {
    foreach ($p in $enMarcha | Sort-Object ProcessName -Unique) {
        Alerta "Programa de control remoto ABIERTO: $($p.ProcessName)  ($($p.Path))"
    }
    Linea "      Si no lo instalaste tu o no lo estas usando, cierralo y desinstalalo."
} else { Bien "No hay programas de control remoto abiertos (AnyDesk, TeamViewer, RustDesk, VNC...)." }

$instalados = Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
                               "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
                               "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
              Where-Object { $n = $_.DisplayName; $n -and ($remotos | Where-Object { $n -like "*$_*" }) }
foreach ($i in $instalados) { Alerta "Instalado: $($i.DisplayName)  (si no lo reconoces, desinstalalo)" }

# 3d. Inicios de sesion remotos y fallidos (ultimos 30 dias)
$desde = (Get-Date).AddDays(-30)
$rdpLogons = Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624; StartTime=$desde} -ErrorAction SilentlyContinue |
             Where-Object { $_.Properties[8].Value -eq 10 }
if ($rdpLogons) {
    Alerta "Hubo $(@($rdpLogons).Count) inicio(s) de sesion por Escritorio remoto en 30 dias. Ultimos:"
    $rdpLogons | Select-Object -First 5 | ForEach-Object {
        Linea "      $($_.TimeCreated)  usuario: $($_.Properties[5].Value)  desde IP: $($_.Properties[18].Value)"
    }
} else { Bien "Ningun inicio de sesion por Escritorio remoto en 30 dias." }
$fallidos = @(Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=$desde} -ErrorAction SilentlyContinue).Count
if ($fallidos -gt 20) { Alerta "$fallidos intentos de inicio de sesion FALLIDOS en 30 dias (alguien probando contraseñas?)." }
else { Bien "$fallidos intentos fallidos de inicio de sesion en 30 dias (normal)." }

# 3e. Usuarios y administradores
Linea ""
Linea "  Usuarios activos en esta PC (revisa que los conozcas todos):"
Get-LocalUser | Where-Object Enabled | ForEach-Object { Linea "    - $($_.Name)   ultimo inicio: $($_.LastLogon)" }
Linea "  Administradores:"
Get-LocalGroupMember -SID "S-1-5-32-544" -ErrorAction SilentlyContinue | ForEach-Object { Linea "    - $($_.Name)" }

# 3f. Conexiones a internet ahora mismo
Linea ""
Linea "  Programas conectados a internet ahora mismo:"
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -notmatch '^(127\.|::1|0\.0\.0\.0)' } |
    Group-Object OwningProcess | ForEach-Object {
        $proc = Get-Process -Id $_.Name -ErrorAction SilentlyContinue
        [pscustomobject]@{ Programa = $(if ($proc) { $proc.ProcessName } else { "PID $($_.Name)" }); Conexiones = $_.Count }
    } | Sort-Object Conexiones -Descending | Select-Object -First 15 |
    ForEach-Object { Linea ("    {0,-28} {1} conexion(es)" -f $_.Programa, $_.Conexiones) }

# 3g. Programas que arrancan solos
Linea ""
Linea "  Programas que arrancan solos con Windows (revisa que los reconozcas):"
Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue |
    ForEach-Object { Linea "    - $($_.Name)" }

# ---------------------------------------------------------------- 4. Antivirus
Titulo "4. Antivirus (Microsoft Defender)"
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    if ($mp.RealTimeProtectionEnabled) { Bien "Proteccion en tiempo real ACTIVADA." } else { Alerta "Proteccion en tiempo real APAGADA. Activala en Seguridad de Windows." }
    Linea "  Firmas actualizadas: $($mp.AntivirusSignatureLastUpdated)   Ultimo analisis rapido: $($mp.QuickScanEndTime)"
    $amenazas = Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { $_.InitialDetectionTime -gt $desde }
    if ($amenazas) { Alerta "Defender detecto $($amenazas.Count) amenaza(s) en 30 dias. Revisa: Seguridad de Windows > Historial de proteccion." }
    else { Bien "Sin amenazas detectadas en 30 dias." }
    $r3 = Read-Host "  Escribe SI para hacer un analisis rapido ahora (tarda unos minutos)"
    if ($r3 -eq "SI") { Linea "  Analizando..."; Start-MpScan -ScanType QuickScan; Bien "Analisis terminado. Revisa Seguridad de Windows por si encontro algo." }
} catch { Linea "  (Defender no disponible; puede que uses otro antivirus.)" }

# ---------------------------------------------------------------- Fin
$ruta = Join-Path ([Environment]::GetFolderPath("Desktop")) "Revision-PC.txt"
$informe | Out-File $ruta -Encoding UTF8
Linea ""
Linea "Informe guardado en: $ruta" "White"
Linea "Las lineas con [!] son las que hay que revisar." "White"
Read-Host "Pulsa Enter para cerrar"
