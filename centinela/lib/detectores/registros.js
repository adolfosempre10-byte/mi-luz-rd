'use strict';
// Sigue archivos de registro (como "tail -f"), carpetas con registros que rotan (IIS) o la salida de un
// comando (journalctl), y pasa cada linea nueva al motor.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('../util');

const MAX_LECTURA = 4 * 1024 * 1024;

class SeguidorArchivo {
  constructor({ ruta, tipo, desdeInicio = false }, alLinea) {
    this.ruta = ruta; this.tipo = tipo; this.alLinea = alLinea;
    this.pos = null; this.ino = null; this.resto = ''; this.desdeInicio = desdeInicio;
    this.archivoActual = null; this.ocupado = false;
  }

  iniciar() {
    this.revisar();
    this.timer = setInterval(() => this.revisar(), 1000);
    this.timer.unref?.();
    return this;
  }

  detener() { clearInterval(this.timer); }

  /** Si la ruta es una carpeta, sigue el archivo modificado mas recientemente dentro de ella. */
  resolver() {
    let st;
    try { st = fs.statSync(this.ruta); } catch { return null; }
    if (!st.isDirectory()) return this.ruta;
    let mejor = null; let t = 0;
    for (const n of fs.readdirSync(this.ruta)) {
      if (!/\.(log|txt)$/i.test(n)) continue;
      try { const s = fs.statSync(path.join(this.ruta, n)); if (s.isFile() && s.mtimeMs > t) { t = s.mtimeMs; mejor = path.join(this.ruta, n); } } catch { /* rotando */ }
    }
    return mejor;
  }

  revisar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      const archivo = this.resolver();
      if (!archivo) return;
      const st = fs.statSync(archivo);
      if (archivo !== this.archivoActual) {
        // Archivo nuevo: si es el primero, se empieza al final (solo lo que pase de ahora en adelante).
        const primero = this.archivoActual === null;
        this.archivoActual = archivo; this.ino = st.ino; this.resto = '';
        this.pos = primero && !this.desdeInicio ? st.size : 0;
        if (primero) log('info', `Vigilando ${archivo} (${this.tipo})`);
      }
      if (st.ino !== this.ino || st.size < this.pos) { this.ino = st.ino; this.pos = 0; this.resto = ''; } // rotacion
      if (st.size <= this.pos) return;
      const largo = Math.min(st.size - this.pos, MAX_LECTURA);
      const buf = Buffer.alloc(largo);
      const fd = fs.openSync(archivo, 'r');
      try { fs.readSync(fd, buf, 0, largo, this.pos); } finally { fs.closeSync(fd); }
      this.pos += largo;
      const texto = this.resto + buf.toString('utf8');
      const lineas = texto.split(/\r?\n/);
      this.resto = lineas.pop();
      for (const l of lineas) if (l) this.alLinea(this.tipo, l, archivo);
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        if (!this.avisoPermiso) log('error', `Sin permiso para leer ${this.ruta}. Ejecuta Centinela como administrador/root.`);
        this.avisoPermiso = true;
      }
    } finally { this.ocupado = false; }
  }
}

class SeguidorComando {
  constructor({ comando, tipo }, alLinea) { this.comando = comando; this.tipo = tipo; this.alLinea = alLinea; }

  iniciar() {
    const [cmd, ...args] = this.comando;
    this.proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let resto = '';
    log('info', `Vigilando la salida de: ${this.comando.join(' ')} (${this.tipo})`);
    this.proc.stdout.on('data', (d) => {
      const lineas = (resto + d.toString('utf8')).split(/\r?\n/);
      resto = lineas.pop();
      for (const l of lineas) if (l) this.alLinea(this.tipo, l, this.comando[0]);
    });
    this.proc.on('error', (e) => log('error', `No se pudo ejecutar ${cmd}: ${e.message}`));
    this.proc.on('exit', () => { if (!this.detenido) this.reinicio = setTimeout(() => this.iniciar(), 10000); });
    return this;
  }

  detener() { this.detenido = true; clearTimeout(this.reinicio); this.proc?.kill(); }
}

const existe = (r) => { try { fs.accessSync(r); return true; } catch { return false; } };

/** Registros que se vigilan por defecto si la configuracion no dice otra cosa. */
function registrosPorDefecto(plataforma = process.platform) {
  const lista = [];
  if (plataforma === 'linux') {
    const ssh = ['/var/log/auth.log', '/var/log/secure'].find(existe);
    if (ssh) lista.push({ ruta: ssh, tipo: 'ssh' });
    else if (existe('/usr/bin/journalctl') || existe('/bin/journalctl')) {
      lista.push({ comando: ['journalctl', '-f', '-n0', '-o', 'short', '_COMM=sshd', '_COMM=sshd-session', '_COMM=sudo', '_COMM=useradd'], tipo: 'ssh' });
    }
    for (const r of ['/var/log/nginx/access.log', '/var/log/apache2/access.log', '/var/log/httpd/access_log']) if (existe(r)) lista.push({ ruta: r, tipo: 'web' });
    const kern = ['/var/log/kern.log', '/var/log/messages'].find(existe);
    if (kern) lista.push({ ruta: kern, tipo: 'firewall-linux' });
  } else if (plataforma === 'win32') {
    const fw = 'C:\\Windows\\System32\\LogFiles\\Firewall\\pfirewall.log';
    if (existe(fw)) lista.push({ ruta: fw, tipo: 'firewall-windows' });
    const iis = 'C:\\inetpub\\logs\\LogFiles';
    if (existe(iis)) for (const sitio of fs.readdirSync(iis)) lista.push({ ruta: path.join(iis, sitio), tipo: 'iis' });
  } else if (plataforma === 'darwin') {
    for (const r of ['/usr/local/var/log/nginx/access.log', '/opt/homebrew/var/log/nginx/access.log']) if (existe(r)) lista.push({ ruta: r, tipo: 'web' });
  }
  return lista;
}

function iniciarRegistros(lista, motor) {
  const alLinea = (tipo, linea, archivo) => motor.procesarLinea(tipo, linea, { archivo });
  return lista.map((r) => (r.comando ? new SeguidorComando(r, alLinea) : new SeguidorArchivo(r, alLinea)).iniciar());
}

module.exports = { SeguidorArchivo, SeguidorComando, iniciarRegistros, registrosPorDefecto };
