'use strict';
// Lee los eventos de seguridad de Windows (inicios de sesion fallidos/exitosos, usuarios nuevos,
// registro borrado, servicios nuevos y alertas de Windows Defender) cada 15 segundos.
const { execFile } = require('child_process');
const { log } = require('../util');

const SCRIPT = (segundos) => `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$desde=(Get-Date).AddSeconds(-${segundos})
$filtros=@(
  @{LogName='Security';Id=4625,4624,4720,4732,4740,1102;StartTime=$desde},
  @{LogName='System';Id=7045;StartTime=$desde},
  @{LogName='Microsoft-Windows-Windows Defender/Operational';Id=1116,1117,5001,5010,5012;StartTime=$desde}
)
foreach($f in $filtros){
  Get-WinEvent -FilterHashtable $f | ForEach-Object {
    $ev=$_; $x=[xml]$ev.ToXml(); $d=@{}
    foreach($n in $x.Event.EventData.Data){ if($n.Name){ $d[$n.Name]=$n.'#text' } }
    $lg= if($f.LogName -like '*Defender*'){'Defender'} else {$f.LogName}
    $base="Log=$lg RecordId=$($ev.RecordId) EventID=$($ev.Id)"
    if($ev.Id -eq 4624){
      if(@('3','10') -notcontains $d.LogonType -or @('-','127.0.0.1','::1','') -contains $d.IpAddress){ return }
    }
    if($ev.Id -eq 7045){ "$base ServiceName=$($d.ServiceName) ImagePath=$($d.ImagePath)" }
    elseif($ev.Id -eq 1116 -or $ev.Id -eq 1117){ "$base Threat=$($d.'Threat Name') Path=$($d.Path)" }
    else { "$base IpAddress=$($d.IpAddress) TargetUserName=$($d.TargetUserName) LogonType=$($d.LogonType) SubjectUserName=$($d.SubjectUserName)" }
  }
}`;

class DetectorWindows {
  constructor(motor, { intervalo = 15 } = {}) {
    this.motor = motor; this.intervalo = intervalo; this.vistos = new Set();
  }

  iniciar() {
    if (process.platform !== 'win32') return this;
    log('info', 'Vigilando los eventos de seguridad de Windows.');
    this.revisar();
    this.timer = setInterval(() => this.revisar(), this.intervalo * 1000);
    return this;
  }

  detener() { clearInterval(this.timer); }

  revisar() {
    if (this.ocupado) return;
    this.ocupado = true;
    const codificado = Buffer.from(SCRIPT(this.intervalo * 4), 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', codificado],
      { timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        this.ocupado = false;
        if (err && !stdout) {
          if (!this.avisado) log('error', `No se pudieron leer los eventos de Windows (${err.message}). Ejecuta Centinela como administrador.`);
          this.avisado = true;
          return;
        }
        this.procesar(String(stdout));
      });
  }

  /** Separado para poder probarlo sin Windows. */
  procesar(salida) {
    for (const linea of salida.split(/\r?\n/)) {
      const m = /^Log=(\S+) RecordId=(\d+)/.exec(linea);
      if (!m) continue;
      const llave = `${m[1]}:${m[2]}`;
      if (this.vistos.has(llave)) continue;
      this.vistos.add(llave);
      this.motor.procesarLinea('windows', linea);
    }
    if (this.vistos.size > 50000) this.vistos = new Set([...this.vistos].slice(-20000));
  }
}

module.exports = { DetectorWindows };
