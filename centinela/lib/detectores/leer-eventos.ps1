# Lee los eventos de seguridad de Windows, Windows Defender y Sysmon de los ultimos N segundos
# y los escribe en una linea cada uno para que Centinela los analice.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File leer-eventos.ps1 -Segundos 60
param([int]$Segundos = 60)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$desde = (Get-Date).AddSeconds(-$Segundos)

function L($v) {
  if ($null -eq $v) { return '' }
  return (([string]$v) -replace '\|\|', '| |' -replace '[\r\n\t]+', ' ').Trim()
}

$filtros = @(
  @{ LogName = 'Security'; Id = 4625, 4624, 4720, 4732, 4740, 1102; StartTime = $desde },
  @{ LogName = 'System'; Id = 7045; StartTime = $desde },
  @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; Id = 1116, 1117, 5001, 5010, 5012; StartTime = $desde },
  @{ LogName = 'Microsoft-Windows-Sysmon/Operational'; Id = 1, 10, 11, 13; StartTime = $desde }
)

foreach ($f in $filtros) {
  $eventos = Get-WinEvent -FilterHashtable $f
  foreach ($ev in $eventos) {
    $x = [xml]$ev.ToXml()
    $d = @{}
    foreach ($n in $x.Event.EventData.Data) { if ($n.Name) { $d[$n.Name] = $n.'#text' } }
    $lg = $f.LogName
    if ($lg -like '*Defender*') { $lg = 'Defender' }
    if ($lg -like '*Sysmon*') { $lg = 'Sysmon' }
    $t = $ev.TimeCreated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $base = "$t Log=$lg RecordId=$($ev.RecordId) EventID=$($ev.Id)"

    if ($lg -eq 'Sysmon') {
      if ($ev.Id -eq 1) {
        "$base || User=$(L $d.User) || ProcessId=$(L $d.ProcessId) || Image=$(L $d.Image) || ParentImage=$(L $d.ParentImage) || CommandLine=$(L $d.CommandLine)"
      }
      elseif ($ev.Id -eq 10) {
        if ($d.TargetImage -like '*\lsass.exe') {
          "$base || User=$(L $d.SourceUser) || ProcessId=$(L $d.SourceProcessId) || Image=$(L $d.SourceImage) || TargetImage=$(L $d.TargetImage) || GrantedAccess=$(L $d.GrantedAccess)"
        }
      }
      elseif ($ev.Id -eq 11) {
        if ($d.TargetFilename -like '*\Start Menu\Programs\Startup\*') {
          "$base || User=$(L $d.User) || ProcessId=$(L $d.ProcessId) || Image=$(L $d.Image) || TargetFilename=$(L $d.TargetFilename)"
        }
      }
      elseif ($ev.Id -eq 13) {
        if ($d.TargetObject -match '\\CurrentVersion\\(Run|RunOnce|Policies\\Explorer\\Run)\\|\\Winlogon\\(Shell|Userinit)$|\\Image File Execution Options\\.*\\Debugger$') {
          "$base || User=$(L $d.User) || ProcessId=$(L $d.ProcessId) || Image=$(L $d.Image) || TargetObject=$(L $d.TargetObject) || Details=$(L $d.Details)"
        }
      }
      continue
    }

    if ($ev.Id -eq 4624) {
      if ((@('3', '10') -notcontains $d.LogonType) -or (@('-', '127.0.0.1', '::1', '') -contains $d.IpAddress)) { continue }
    }
    if ($ev.Id -eq 7045) { "$base ServiceName=$(L $d.ServiceName) ImagePath=$(L $d.ImagePath)" }
    elseif ($ev.Id -eq 1116 -or $ev.Id -eq 1117) { "$base Threat=$(L $d.'Threat Name') Path=$(L $d.Path)" }
    else { "$base IpAddress=$(L $d.IpAddress) TargetUserName=$(L $d.TargetUserName) LogonType=$(L $d.LogonType) SubjectUserName=$(L $d.SubjectUserName)" }
  }
}
