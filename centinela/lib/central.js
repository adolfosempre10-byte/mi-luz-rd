'use strict';
// Modo central y modo agente.
// - Agente: cada equipo (servidor o PC) detecta y bloquea por su cuenta, y manda sus incidentes al central.
// - Central: junta los incidentes de todos, avisa al equipo de tecnologia y reparte la lista de IPs
//   bloqueadas: un atacante detectado en un equipo queda bloqueado en todos.
const os = require('os');
const { normalizarIp, nivel, log } = require('./util');

const texto = (v, max = 500) => (v == null ? undefined : String(v).slice(0, max));

/** Limpia un incidente recibido de un agente (no confiar en tamaños ni tipos). */
function limpiarIncidente(x, equipo) {
  if (!x || typeof x !== 'object' || !/^[\w-]{4,60}$/.test(String(x.id))) return null;
  return {
    id: `${String(x.id)}`, regla: texto(x.regla, 80), titulo: texto(x.titulo, 200), severidad: ['baja', 'media', 'alta', 'critica'].includes(x.severidad) ? x.severidad : 'media',
    mitre: texto(x.mitre, 20), fuente: texto(x.fuente, 30), host: equipo, ip: normalizarIp(x.ip) || null,
    usuarios: Array.isArray(x.usuarios) ? x.usuarios.slice(0, 20).map((u) => texto(u, 100)) : [],
    eventos: Number(x.eventos) || 1, primerEvento: texto(x.primerEvento, 40), ultimoEvento: texto(x.ultimoEvento, 40),
    creado: texto(x.creado, 40) || new Date().toISOString(), actualizado: new Date().toISOString(), estado: 'abierto',
    detalle: texto(x.detalle, 2000), evidencia: Array.isArray(x.evidencia) ? x.evidencia.slice(-15).map((e) => texto(e, 2000)) : [],
    bloquear: !!x.bloquear, emergencia: !!x.emergencia, recomendacion: texto(x.recomendacion, 2000),
    notas: Array.isArray(x.notas) ? x.notas.slice(0, 20).map((n) => texto(n, 1000)) : [],
    acciones: Array.isArray(x.acciones) ? x.acciones.slice(0, 20).map((a) => ({ fecha: texto(a?.fecha, 40), texto: texto(a?.texto, 500) })) : [],
    investigacion: x.investigacion && typeof x.investigacion === 'object' && JSON.stringify(x.investigacion).length < 20000 ? x.investigacion : undefined,
    desdeAgente: true,
  };
}

class Central {
  constructor({ almacen, avisos, respuesta, motor, config = {} }) {
    this.almacen = almacen; this.avisos = avisos; this.respuesta = respuesta; this.motor = motor;
    this.cfg = { minutosSinReportar: 5, bloqueoGlobal: true, ...config };
    this.timer = setInterval(() => this.revisarAgentes(), 60 * 1000);
    this.timer.unref?.();
  }

  async recibir(cuerpo, ipAgente) {
    const equipo = texto(cuerpo.equipo, 100);
    if (!equipo) throw new Error('falta el nombre del equipo');
    const previo = this.almacen.agentes[equipo];
    if (previo?.sinReportar) {
      log('info', `El equipo ${equipo} volvio a reportar.`);
      this.almacen.auditoria(`AGENTE ${equipo} volvio a reportar`);
    }
    this.almacen.agentes[equipo] = {
      equipo, ip: ipAgente, so: texto(cuerpo.so, 100), version: texto(cuerpo.version, 20), modo: texto(cuerpo.modo, 20),
      ultimoContacto: new Date().toISOString(), sinReportar: false,
    };

    const lista = Array.isArray(cuerpo.incidentes) ? cuerpo.incidentes.slice(0, 200) : [];
    for (const crudo of lista) {
      const inc = limpiarIncidente(crudo, equipo);
      if (!inc) continue;
      const existente = this.almacen.incidente(inc.id);
      if (!existente) {
        this.almacen.agregarIncidente(inc);
        log('alerta', `[${equipo}] ${inc.titulo}${inc.ip ? ` desde ${inc.ip}` : ''} (${inc.severidad})`);
        if (inc.ip && inc.bloquear && this.cfg.bloqueoGlobal) {
          const b = await this.respuesta.bloquear(inc.ip, { motivo: `Ataque a ${equipo}: ${inc.titulo}`, incidente: inc.id, origen: 'global' });
          if (!b.omitido) inc.acciones.push({ fecha: new Date().toISOString(), texto: 'IP bloqueada en todos los equipos (bloqueo global)' });
        }
        this.avisos.incidente(inc, 'nuevo').catch(() => {});
      } else {
        const subio = nivel(inc.severidad) > nivel(existente.severidad);
        Object.assign(existente, {
          eventos: inc.eventos, ultimoEvento: inc.ultimoEvento, actualizado: inc.actualizado, evidencia: inc.evidencia,
          usuarios: inc.usuarios, severidad: subio ? inc.severidad : existente.severidad, investigacion: inc.investigacion || existente.investigacion,
        });
        for (const a of inc.acciones) if (!existente.acciones.some((x) => x.texto === a.texto && x.fecha === a.fecha)) existente.acciones.push(a);
        if (subio) this.avisos.incidente(existente, 'escalado').catch(() => {});
      }
    }
    this.almacen.guardar();
    const ahora = Date.now();
    return {
      bloqueos: this.almacen.bloqueos
        .filter((b) => b.activo && (!b.hasta || Date.parse(b.hasta) > ahora))
        .map((b) => ({ ip: b.ip, hasta: b.hasta, motivo: b.motivo })),
    };
  }

  revisarAgentes() {
    const limite = Date.now() - this.cfg.minutosSinReportar * 60 * 1000;
    for (const a of Object.values(this.almacen.agentes)) {
      if (a.sinReportar || Date.parse(a.ultimoContacto) > limite) continue;
      a.sinReportar = true;
      const detalle = `El equipo ${a.equipo} (${a.ip}) no reporta desde ${a.ultimoContacto}`;
      this.motor.registrar({ regla: 'agente-sin-reportar', host: a.equipo, clave: a.equipo, detalle, linea: detalle });
      this.almacen.guardar();
    }
  }
}

class Agente {
  constructor({ config, almacen, respuesta, avisos, host, version }) {
    this.url = config.url.replace(/\/+$/, '');
    this.token = config.tokenAgentes;
    this.intervalo = config.segundosSincronizar || 30;
    this.almacen = almacen; this.respuesta = respuesta; this.avisos = avisos; this.host = host; this.version = version;
    this.pendientes = new Set();
    this.fallos = 0;
  }

  iniciar() {
    this.sincronizar();
    this.timer = setInterval(() => this.sincronizar(), this.intervalo * 1000);
    log('info', `Modo agente: reportando a ${this.url}`);
    return this;
  }

  detener() { clearInterval(this.timer); }

  marcar(inc) { this.pendientes.add(inc.id); }

  async sincronizar() {
    if (this.ocupado) return;
    this.ocupado = true;
    const ids = [...this.pendientes];
    const incidentes = ids.map((id) => this.almacen.incidente(id)).filter(Boolean);
    try {
      const r = await fetch(`${this.url}/api/agente/sincronizar`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ equipo: this.host, so: `${os.type()} ${os.release()}`, version: this.version, modo: this.respuesta.modo, incidentes }),
      });
      if (!r.ok) throw new Error(`el central respondio ${r.status}`);
      const datos = await r.json();
      ids.forEach((id) => this.pendientes.delete(id));
      if (this.fallos) log('info', 'Conexion con el central recuperada.');
      this.fallos = 0;
      await this.aplicarBloqueosGlobales(datos.bloqueos || []);
    } catch (e) {
      this.fallos++;
      if (this.fallos === 1 || this.fallos % 20 === 0) log('aviso', `No se pudo reportar al central (${e.message}).`);
      // Si el central no responde, el agente avisa directo para que la alerta no se pierda.
      if (this.fallos >= 2) {
        for (const inc of incidentes) {
          if (inc.avisadoLocal) continue;
          inc.avisadoLocal = true;
          inc.notas.push('El central no respondio; el agente aviso directamente.');
          this.avisos.incidente(inc, 'nuevo').catch(() => {});
        }
      }
    } finally { this.ocupado = false; }
  }

  async aplicarBloqueosGlobales(lista) {
    const delCentral = new Set();
    for (const b of lista) {
      const ip = normalizarIp(b.ip);
      if (!ip) continue;
      delCentral.add(ip);
      if (!this.almacen.bloqueoActivo(ip)) await this.respuesta.bloquear(ip, { hasta: b.hasta || undefined, segundos: b.hasta ? undefined : 0, motivo: `Bloqueo global: ${b.motivo || ''}`, origen: 'central' });
    }
    for (const b of this.almacen.bloqueos) {
      if (b.activo && b.origen === 'central' && !delCentral.has(b.ip)) await this.respuesta.desbloquear(b.ip, 'central');
    }
  }
}

module.exports = { Central, Agente, limpiarIncidente };
