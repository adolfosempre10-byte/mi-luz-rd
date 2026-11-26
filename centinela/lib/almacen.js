'use strict';
// Guarda incidentes, bloqueos y equipos en datos/estado.json, y las acciones en datos/auditoria.log.
const fs = require('fs');
const path = require('path');
const { escribirJson, leerJson, log } = require('./util');

const MAX_INCIDENTES = 5000;

class Almacen {
  constructor(carpeta, { enMemoria = false } = {}) {
    this.carpeta = carpeta;
    this.enMemoria = enMemoria;
    this.ruta = path.join(carpeta, 'estado.json');
    const d = enMemoria ? {} : leerJson(this.ruta, {});
    this.incidentes = d.incidentes || [];
    this.bloqueos = d.bloqueos || [];
    this.agentes = d.agentes || {};
    this.lineaBase = d.lineaBase || {};
    this.temporizador = null;
  }

  guardar() {
    if (this.enMemoria || this.temporizador) return;
    this.temporizador = setTimeout(() => { this.temporizador = null; this.guardarYa(); }, 1000);
  }

  guardarYa() {
    if (this.enMemoria) return;
    try {
      escribirJson(this.ruta, { incidentes: this.incidentes, bloqueos: this.bloqueos, agentes: this.agentes, lineaBase: this.lineaBase });
    } catch (e) { log('error', 'No se pudo guardar el estado:', e.message); }
  }

  agregarIncidente(inc) {
    this.incidentes.push(inc);
    if (this.incidentes.length > MAX_INCIDENTES) {
      // Primero se descartan los resueltos mas viejos.
      const i = this.incidentes.findIndex((x) => x.estado === 'resuelto');
      this.incidentes.splice(i >= 0 ? i : 0, 1);
    }
    this.guardar();
  }

  incidente(id) { return this.incidentes.find((x) => x.id === id); }

  incidentesDeIp(ip, desdeMs = 0) {
    return this.incidentes.filter((x) => x.ip === ip && Date.parse(x.creado) >= desdeMs);
  }

  bloqueoActivo(ip) {
    const ahora = Date.now();
    return this.bloqueos.find((b) => b.ip === ip && b.activo && (!b.hasta || Date.parse(b.hasta) > ahora));
  }

  auditoria(texto) {
    const linea = `${new Date().toISOString()} ${texto}\n`;
    if (this.enMemoria) return;
    try { fs.mkdirSync(this.carpeta, { recursive: true }); fs.appendFileSync(path.join(this.carpeta, 'auditoria.log'), linea); } catch { /* sin disco */ }
  }
}

module.exports = { Almacen };
