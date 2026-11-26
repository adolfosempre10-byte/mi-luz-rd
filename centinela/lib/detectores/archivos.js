'use strict';
// 1) Integridad: avisa si cambian archivos criticos (usuarios, claves SSH, sudoers, hosts...).
// 2) Ransomware: vigila carpetas de documentos; deja archivos señuelo y detecta extensiones de cifrado,
//    notas de rescate y cambios masivos.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../util');

const NOMBRE_SENUELO = '000_no_borrar_centinela.docx';
const EXT_RANSOMWARE = /\.(locked|encrypted|enc|crypt|crypted|crypto|locky|cerber|wncry|wnry|ryk|lockbit|conti|akira|phobos|djvu|basta|blackcat|royal|hive|ransom|rhysida|play|medusa|8base|lck|pay2key)$/i;
const NOTA_RESCATE = /(decrypt|ransom|restore[_-]?(my[_-]?)?files|how[_-]?to[_-]?(back|recover|restore|decrypt)|read[_-]?me[_-]?(now|!)|!!!)/i;

function hashArchivo(ruta) {
  return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
}

function criticosPorDefecto(plataforma = process.platform) {
  if (plataforma === 'linux') return ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/sudoers', '/etc/ssh/sshd_config', '/etc/crontab', '/root/.ssh/authorized_keys', '/etc/ld.so.preload'];
  if (plataforma === 'win32') return ['C:\\Windows\\System32\\drivers\\etc\\hosts'];
  if (plataforma === 'darwin') return ['/etc/hosts', '/etc/sudoers', '/etc/ssh/sshd_config'];
  return [];
}

class DetectorArchivos {
  /**
   * @param {object} cfg { criticos: [], carpetas: [], senuelos: true, intervalo: 60 }
   */
  constructor(motor, almacen, cfg = {}) {
    this.motor = motor; this.almacen = almacen;
    this.cfg = { criticos: criticosPorDefecto(), carpetas: [], senuelos: true, intervalo: 60, ...cfg };
    this.vigilantes = [];
    this.senuelos = new Map();
  }

  iniciar() {
    this.revisarIntegridad(true);
    this.timer = setInterval(() => this.revisarIntegridad(false), this.cfg.intervalo * 1000);
    this.timer.unref?.();
    for (const carpeta of this.cfg.carpetas) this.vigilarCarpeta(carpeta);
    return this;
  }

  detener() { clearInterval(this.timer); this.vigilantes.forEach((v) => v.close()); }

  revisarIntegridad(inicio) {
    const base = this.almacen.lineaBase;
    for (const ruta of this.cfg.criticos) {
      let st;
      try { st = fs.statSync(ruta); } catch {
        if (base[ruta] && !base[ruta].borrado) {
          this.motor.registrar({ regla: 'archivo-critico-modificado', clave: ruta, detalle: `Se borro ${ruta}`, linea: `BORRADO ${ruta}` });
          base[ruta] = { borrado: true }; this.almacen.guardar();
        }
        continue;
      }
      const previo = base[ruta];
      if (previo && !previo.borrado && previo.tam === st.size && previo.mtime === st.mtimeMs) continue;
      let hash;
      try { hash = hashArchivo(ruta); } catch (e) {
        if (inicio && (e.code === 'EACCES' || e.code === 'EPERM')) log('aviso', `Sin permiso para revisar ${ruta} (ejecuta como administrador).`);
        continue;
      }
      if (previo?.hash && previo.hash !== hash) {
        const detalle = `Cambio ${ruta}: tamaño ${previo.tam} -> ${st.size} bytes, modificado ${new Date(st.mtimeMs).toISOString()}`;
        this.motor.registrar({ regla: 'archivo-critico-modificado', clave: ruta, detalle, linea: detalle });
      }
      base[ruta] = { hash, tam: st.size, mtime: st.mtimeMs };
      this.almacen.guardar();
    }
    if (inicio && this.cfg.criticos.length) log('info', `Vigilando la integridad de ${this.cfg.criticos.length} archivo(s) critico(s).`);
  }

  ponerSenuelo(carpeta) {
    const ruta = path.join(carpeta, NOMBRE_SENUELO);
    try {
      if (!fs.existsSync(ruta)) fs.writeFileSync(ruta, crypto.randomBytes(4096));
      this.senuelos.set(ruta, hashArchivo(ruta));
    } catch (e) { log('aviso', `No se pudo poner el archivo señuelo en ${carpeta}: ${e.message}`); }
  }

  vigilarCarpeta(carpeta) {
    if (!fs.existsSync(carpeta)) { log('aviso', `La carpeta ${carpeta} no existe; no se vigila.`); return; }
    if (this.cfg.senuelos) this.ponerSenuelo(carpeta);
    try {
      const v = fs.watch(carpeta, { recursive: true }, (tipo, nombre) => { if (nombre) this.cambio(path.join(carpeta, nombre.toString())); });
      v.on('error', (e) => log('error', `Vigilancia de ${carpeta}: ${e.message}`));
      this.vigilantes.push(v);
      log('info', `Vigilando ransomware en ${carpeta}${this.cfg.senuelos ? ' (con archivo señuelo)' : ''}`);
    } catch (e) { log('error', `No se puede vigilar ${carpeta}: ${e.message}`); }
  }

  /** Se llama por cada archivo creado, cambiado, renombrado o borrado en las carpetas vigiladas. */
  cambio(ruta) {
    const nombre = path.basename(ruta);
    if (this.senuelos.has(ruta)) {
      let hash = null;
      try { hash = hashArchivo(ruta); } catch { /* borrado o bloqueado: tambien es sospechoso */ }
      if (hash === this.senuelos.get(ruta)) return; // solo lo leyeron (por ejemplo el antivirus)
      const detalle = hash ? `El archivo señuelo ${ruta} fue modificado (cifrado?)` : `El archivo señuelo ${ruta} fue borrado o renombrado`;
      this.motor.registrar({ regla: 'ransomware-senuelo', clave: ruta, detalle, linea: detalle });
      if (hash) this.senuelos.set(ruta, hash);
      return;
    }
    if (EXT_RANSOMWARE.test(nombre) || NOTA_RESCATE.test(nombre)) {
      this.motor.registrar({ regla: 'ransomware-extension', clave: ruta, detalle: `Archivo sospechoso: ${ruta}`, linea: ruta });
    }
    this.motor.registrar({ regla: 'ransomware-cambios-masivos', clave: ruta, detalle: `Ultimo archivo cambiado: ${ruta}`, linea: ruta });
  }
}

module.exports = { DetectorArchivos, criticosPorDefecto, EXT_RANSOMWARE, NOTA_RESCATE, NOMBRE_SENUELO };
