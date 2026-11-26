'use strict';
// Motor de correlacion: recibe lineas o eventos, cuenta por IP en ventanas de tiempo
// y, cuando se pasa el umbral de una regla, abre un incidente.
const { EventEmitter } = require('events');
const { normalizarIp, idCorto, subirSeveridad, nivel } = require('./util');
const { parsearCombinado, crearAnalizadorIis } = require('./analizadores');

const MAX_EVIDENCIA = 15;
const DIA = 24 * 3600 * 1000;

class Motor extends EventEmitter {
  /**
   * @param {object} o
   * @param {Map} o.reglas            reglas cargadas (cargarReglas)
   * @param {import('./almacen').Almacen} o.almacen
   * @param {string} o.host           nombre de este equipo
   * @param {{contiene(ip):boolean}} o.listaBlanca
   * @param {number} [o.minutosIncidente] tiempo sin actividad tras el cual un ataque nuevo abre otro incidente
   */
  constructor({ reglas, almacen, host, listaBlanca, minutosIncidente = 60 }) {
    super();
    this.reglas = reglas;
    this.almacen = almacen;
    this.host = host;
    this.listaBlanca = listaBlanca;
    this.msIncidente = minutosIncidente * 60 * 1000;
    this.ventanas = new Map();
    this.iis = new Map();
    this.estadisticas = { lineas: 0, eventos: 0 };
    setInterval(() => this.limpiarVentanas(), 60 * 1000).unref();
  }

  /** Revisa una linea de un registro contra todas las reglas de esa fuente. Devuelve cuantas reglas coincidieron. */
  procesarLinea(fuente, linea, { archivo = '', fecha } = {}) {
    this.estadisticas.lineas++;
    let entrada = linea;
    let fuenteReglas = fuente;
    if (fuente === 'web' || fuente === 'iis') {
      if (fuente === 'iis') {
        if (!this.iis.has(archivo)) this.iis.set(archivo, crearAnalizadorIis());
        entrada = this.iis.get(archivo)(linea);
      } else entrada = parsearCombinado(linea);
      if (!entrada) return 0;
      fuenteReglas = 'web';
    }
    let n = 0;
    for (const regla of this.reglas.values()) {
      if (regla.fuente !== fuenteReglas || !regla.detectar) continue;
      const r = regla.detectar(entrada);
      if (!r) continue;
      n++;
      this.registrar({ regla: regla.id, ...r, linea, fecha, archivo });
    }
    return n;
  }

  /**
   * Registra un evento suelto. Campos: regla, ip?, clave?, usuario?, detalle?, linea?, fecha?, host?
   * Devuelve el incidente si se abrio o actualizo uno.
   */
  registrar(ev) {
    const regla = this.reglas.get(ev.regla);
    if (!regla) return null;
    const ip = ev.ip ? normalizarIp(ev.ip) : null;
    if (ev.ip && !ip) return null;
    this.estadisticas.eventos++;
    const ahora = ev.fecha ? new Date(ev.fecha).getTime() : Date.now();
    const host = ev.host || this.host;
    const sujeto = ip || host;

    const abierto = this.buscarAbierto(regla.id, sujeto, host, ahora);
    if (abierto) return this.actualizar(abierto, ev, ahora);

    if (regla.soloSiPrevio && !(ip && this.tieneHistorial(ip, ahora))) return null;

    const llave = `${regla.id}|${sujeto}|${host}`;
    const ventana = this.ventanas.get(llave) || [];
    ventana.push({ t: ahora, clave: ev.clave ?? ev.linea ?? ev.detalle, linea: ev.linea || ev.detalle || '', usuario: ev.usuario });
    const limite = ahora - regla.umbral.segundos * 1000;
    while (ventana.length && ventana[0].t < limite) ventana.shift();
    if (ventana.length > 5000) ventana.splice(0, ventana.length - 5000);
    this.ventanas.set(llave, ventana);

    const cuenta = regla.distinto ? new Set(ventana.map((e) => e.clave)).size : ventana.length;
    if (cuenta < regla.umbral.cantidad) return null;
    this.ventanas.delete(llave);
    return this.abrir(regla, ip, host, ev, ventana, ahora);
  }

  abrir(regla, ip, host, ev, ventana, ahora) {
    const iso = new Date(ahora).toISOString();
    const usuarios = [...new Set(ventana.map((e) => e.usuario).filter(Boolean))].slice(0, 20);
    const inc = {
      id: idCorto('inc-'),
      regla: regla.id, titulo: regla.titulo, severidad: regla.severidad, mitre: regla.mitre, fuente: regla.fuente,
      host, ip, usuarios, archivo: ev.archivo || undefined,
      eventos: ventana.length, primerEvento: new Date(ventana[0].t).toISOString(), ultimoEvento: iso,
      creado: iso, actualizado: iso, estado: 'abierto',
      detalle: ev.detalle || '', evidencia: ventana.slice(-MAX_EVIDENCIA).map((e) => e.linea).filter(Boolean),
      bloquear: !!regla.bloquear, emergencia: !!regla.emergencia, recomendacion: regla.recomendacion,
      enListaBlanca: ip ? this.listaBlanca.contiene(ip) : false,
      notas: [], acciones: [],
    };

    // Ataque por varios frentes: la misma IP disparo 3 reglas distintas en 24 horas.
    if (ip) {
      const previas = this.almacen.incidentesDeIp(ip, ahora - DIA);
      const reglasDistintas = new Set([...previas.map((x) => x.regla), regla.id]);
      if (reglasDistintas.size >= 3 && nivel(inc.severidad) < 3) {
        inc.severidad = subirSeveridad(inc.severidad);
        inc.notas.push(`Ataque por varios frentes: esta IP activo ${reglasDistintas.size} reglas en 24 h (${[...reglasDistintas].join(', ')}). Se subio la gravedad.`);
      }
      if (previas.length) inc.notas.push(`Esta IP ya tenia ${previas.length} incidente(s) en las ultimas 24 h.`);
    }
    if (inc.enListaBlanca) inc.notas.push('La IP esta en la lista blanca: se avisa pero no se bloquea.');

    this.almacen.agregarIncidente(inc);
    this.emit('incidente', inc);
    return inc;
  }

  actualizar(inc, ev, ahora) {
    inc.eventos++;
    inc.ultimoEvento = inc.actualizado = new Date(ahora).toISOString();
    if (ev.detalle) inc.detalle = ev.detalle;
    const linea = ev.linea || ev.detalle;
    if (linea) { inc.evidencia.push(linea); if (inc.evidencia.length > MAX_EVIDENCIA) inc.evidencia.shift(); }
    if (ev.usuario && !inc.usuarios.includes(ev.usuario) && inc.usuarios.length < 20) inc.usuarios.push(ev.usuario);
    this.almacen.guardar();
    this.emit('actualizado', inc);
    return inc;
  }

  buscarAbierto(reglaId, sujeto, host, ahora) {
    for (let i = this.almacen.incidentes.length - 1; i >= 0; i--) {
      const x = this.almacen.incidentes[i];
      if (ahora - Date.parse(x.actualizado) > this.msIncidente) continue;
      if (x.regla === reglaId && x.host === host && (x.ip || x.host) === sujeto && x.estado !== 'resuelto') return x;
    }
    return null;
  }

  tieneHistorial(ip, ahora) {
    return this.almacen.incidentes.some((x) => x.ip === ip && ahora - Date.parse(x.creado) < DIA && !this.reglas.get(x.regla)?.soloSiPrevio);
  }

  limpiarVentanas() {
    const ahora = Date.now();
    for (const [llave, v] of this.ventanas) {
      const regla = this.reglas.get(llave.split('|')[0]);
      if (!v.length || !regla || v[v.length - 1].t < ahora - regla.umbral.segundos * 1000) this.ventanas.delete(llave);
    }
  }
}

/** Intenta sacar la fecha de una linea de registro (para analizar registros viejos con su hora real). */
function extraerFecha(linea) {
  let m = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]/.exec(linea);
  if (m) return new Date(`${m[2]} ${m[1]} ${m[3]} ${m[4]} GMT${m[5]}`).getTime();
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}:?\d{2}|Z)?/.exec(linea);
  if (m) return new Date(`${m[1]}T${m[2]}${m[3] || ''}`).getTime();
  m = /^(\w{3})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2})/.exec(linea);
  if (m) {
    const anio = new Date().getFullYear();
    let t = new Date(`${m[1]} ${m[2]} ${anio} ${m[3]}`).getTime();
    if (t > Date.now() + DIA) t = new Date(`${m[1]} ${m[2]} ${anio - 1} ${m[3]}`).getTime();
    return t;
  }
  return NaN;
}

module.exports = { Motor, extraerFecha };
