'use strict';
// Revisa las conexiones abiertas cada pocos segundos y detecta IPs que abren demasiadas conexiones
// contra los servicios del equipo (inundacion / DoS).
const { execFile } = require('child_process');
const { normalizarIp, log } = require('../util');

const correr = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
});

/** "1.2.3.4:22", "[::1]:22", "*:22" o (macOS) "1.2.3.4.22" -> { ip, puerto } */
function separar(dir, conPunto = false) {
  const i = conPunto ? dir.lastIndexOf('.') : dir.lastIndexOf(':');
  if (i < 0) return null;
  return { ip: normalizarIp(dir.slice(0, i)), puerto: Number(dir.slice(i + 1)) };
}

const ESTADOS = /^(ESTAB|ESTABLISHED|SYN-RECV|SYN_RECV|SYN_RCVD|SYN_RECEIVED)$/i;

/** Devuelve { escuchando: Set<puerto>, conexiones: [{ip, puerto, estado}] } segun el sistema. */
function analizarSalida(plataforma, texto, textoEscucha = '') {
  const escuchando = new Set();
  const conexiones = [];
  if (plataforma === 'linux') {
    for (const l of textoEscucha.split('\n')) { const p = l.trim().split(/\s+/); if (p.length >= 4) { const s = separar(p[3]); if (s) escuchando.add(s.puerto); } }
    for (const l of texto.split('\n')) {
      const p = l.trim().split(/\s+/);
      if (p.length < 5 || !ESTADOS.test(p[0])) continue;
      const local = separar(p[3]); const remoto = separar(p[4]);
      if (local && remoto?.ip) conexiones.push({ ip: remoto.ip, puerto: local.puerto, estado: p[0] });
    }
  } else {
    const mac = plataforma === 'darwin';
    for (const l of texto.split('\n')) {
      const p = l.trim().split(/\s+/);
      if (!/^tcp/i.test(p[0] || '')) continue;
      const [localTxt, remotoTxt, estado] = mac ? [p[3], p[4], p[5]] : [p[1], p[2], p[3]];
      const local = separar(localTxt || '', mac);
      if (!local) continue;
      if (/^LISTEN/i.test(estado || '')) { escuchando.add(local.puerto); continue; }
      const remoto = separar(remotoTxt || '', mac);
      if (remoto?.ip && ESTADOS.test(estado || '')) conexiones.push({ ip: remoto.ip, puerto: local.puerto, estado });
    }
  }
  return { escuchando, conexiones };
}

class DetectorRed {
  constructor(motor, { intervalo = 10, maxConexionesPorIp = 100, maxMediasAbiertasPorIp = 30 } = {}) {
    this.motor = motor;
    this.cfg = { intervalo, maxConexionesPorIp, maxMediasAbiertasPorIp };
  }

  iniciar() {
    this.timer = setInterval(() => this.revisar().catch((e) => log('error', 'Detector de red:', e.message)), this.cfg.intervalo * 1000);
    this.timer.unref?.();
    return this;
  }

  detener() { clearInterval(this.timer); }

  async revisar() {
    const pl = process.platform;
    let r;
    if (pl === 'linux') r = analizarSalida(pl, await correr('ss', ['-Htn']), await correr('ss', ['-Htln']));
    else if (pl === 'win32') r = analizarSalida(pl, await correr('netstat', ['-an', '-p', 'TCP']) + await correr('netstat', ['-an', '-p', 'TCPv6']));
    else if (pl === 'darwin') r = analizarSalida(pl, await correr('netstat', ['-an', '-p', 'tcp']));
    else return;
    this.evaluar(r);
  }

  evaluar({ escuchando, conexiones }) {
    const porIp = new Map();
    for (const c of conexiones) {
      if (!escuchando.has(c.puerto) || c.ip === '127.0.0.1' || c.ip === '::1') continue; // solo conexiones entrantes
      const e = porIp.get(c.ip) || { total: 0, medias: 0, puertos: new Set() };
      e.total++; if (/SYN/i.test(c.estado)) e.medias++; e.puertos.add(c.puerto);
      porIp.set(c.ip, e);
    }
    for (const [ip, e] of porIp) {
      if (e.total >= this.cfg.maxConexionesPorIp || e.medias >= this.cfg.maxMediasAbiertasPorIp) {
        const detalle = `${e.total} conexiones abiertas (${e.medias} a medio abrir / SYN) a los puertos ${[...e.puertos].join(', ')}`;
        this.motor.registrar({ regla: 'red-inundacion-conexiones', ip, detalle, linea: detalle });
      }
    }
  }
}

module.exports = { DetectorRed, analizarSalida };
