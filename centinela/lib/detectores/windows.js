'use strict';
// Lee cada 15 segundos los eventos de seguridad de Windows (inicios de sesion, usuarios nuevos, registro borrado,
// servicios nuevos), las alertas de Windows Defender y, si esta instalado, Sysmon (procesos, acceso a lsass,
// persistencia en el registro y en la carpeta de Inicio). El trabajo lo hace leer-eventos.ps1.
const { execFile } = require('child_process');
const path = require('path');
const { log } = require('../util');

const SCRIPT = path.join(__dirname, 'leer-eventos.ps1');

/** Ejecuta leer-eventos.ps1 y devuelve su salida. Con -File (no -EncodedCommand) para no parecer un ataque en Sysmon. */
function leerEventos(segundos, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Segundos', String(Math.round(segundos))],
      { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer }, (err, stdout) => {
        if (err && !stdout) reject(err); else resolve(String(stdout));
      });
  });
}

class DetectorWindows {
  constructor(motor, { intervalo = 15 } = {}) {
    this.motor = motor; this.intervalo = intervalo; this.vistos = new Set();
  }

  iniciar() {
    if (process.platform !== 'win32') return this;
    log('info', 'Vigilando los eventos de seguridad de Windows, Defender y Sysmon.');
    this.revisar();
    this.timer = setInterval(() => this.revisar(), this.intervalo * 1000);
    return this;
  }

  detener() { clearInterval(this.timer); }

  async revisar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      this.procesar(await leerEventos(this.intervalo * 4));
    } catch (e) {
      if (!this.avisado) log('error', `No se pudieron leer los eventos de Windows (${e.message}). Ejecuta Centinela como administrador.`);
      this.avisado = true;
    } finally { this.ocupado = false; }
  }

  /** Separado para poder probarlo sin Windows. No repite eventos ya vistos (las lecturas se solapan). */
  procesar(salida) {
    for (const linea of salida.split(/\r?\n/)) {
      const m = /^(?:\S+ )?Log=(\S+) RecordId=(\d+)/.exec(linea);
      if (!m) continue;
      const llave = `${m[1]}:${m[2]}`;
      if (this.vistos.has(llave)) continue;
      this.vistos.add(llave);
      this.motor.procesarLinea('windows', linea);
    }
    if (this.vistos.size > 50000) this.vistos = new Set([...this.vistos].slice(-20000));
  }
}

module.exports = { DetectorWindows, leerEventos };
