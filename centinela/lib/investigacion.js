'use strict';
// Investigacion automatica de cada incidente: quien es la IP, que historial tiene, que tecnica usa
// y que debe revisar el equipo de tecnologia.
const dns = require('dns').promises;
const { esIpPrivada, log } = require('./util');
const { MITRE } = require('./reglas');

const conTiempo = (promesa, ms) => Promise.race([promesa, new Promise((_, no) => setTimeout(() => no(new Error('tiempo agotado')), ms))]);

async function consultarJson(url, cabeceras = {}) {
  const r = await conTiempo(fetch(url, { headers: { Accept: 'application/json', ...cabeceras } }), 8000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * @param {object} inc incidente
 * @param {object} o
 * @param {import('./almacen').Almacen} o.almacen
 * @param {object} [o.config] seccion "investigacion": { abuseipdbClave, geolocalizar }
 */
async function investigar(inc, { almacen, config = {} }) {
  const r = {
    fecha: new Date().toISOString(),
    tecnica: inc.mitre ? { id: inc.mitre, nombre: MITRE[inc.mitre] || '', url: `https://attack.mitre.org/techniques/${inc.mitre.replace('.', '/')}/` } : null,
    pasos: [],
  };

  if (inc.ip) {
    r.ipPrivada = esIpPrivada(inc.ip);
    r.origen = r.ipPrivada ? 'Red interna (un equipo de la propia red)' : 'Internet';
    r.dnsInverso = [];
    if (config.dnsInverso !== false) { try { r.dnsInverso = await conTiempo(dns.reverse(inc.ip), 3000); } catch { /* sin nombre */ } }

    const todos = almacen.incidentes.filter((x) => x.ip === inc.ip);
    r.historial = {
      incidentes: todos.length,
      reglas: [...new Set(todos.map((x) => x.regla))],
      equiposAtacados: [...new Set(todos.map((x) => x.host))],
      primeraVez: todos.length ? todos.reduce((m, x) => (x.creado < m ? x.creado : m), todos[0].creado) : inc.creado,
      vecesBloqueada: almacen.bloqueos.filter((b) => b.ip === inc.ip).length,
    };

    if (!r.ipPrivada && config.abuseipdbClave) {
      try {
        const j = await consultarJson(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(inc.ip)}&maxAgeInDays=90`, { Key: config.abuseipdbClave });
        const d = j.data || {};
        r.reputacion = {
          fuente: 'AbuseIPDB', puntaje: d.abuseConfidenceScore, reportes: d.totalReports, pais: d.countryCode,
          proveedor: d.isp, dominio: d.domain, tor: d.isTor, uso: d.usageType,
        };
      } catch (e) { log('aviso', `AbuseIPDB no respondio para ${inc.ip}: ${e.message}`); }
    }
    if (!r.ipPrivada && config.geolocalizar) {
      try {
        const g = await consultarJson(`https://ipwho.is/${encodeURIComponent(inc.ip)}`);
        if (g.success !== false) r.ubicacion = { pais: g.country, ciudad: g.city, proveedor: g.connection?.isp, asn: g.connection?.asn };
      } catch (e) { log('aviso', `Geolocalizacion no respondio para ${inc.ip}: ${e.message}`); }
    }

    if (r.ipPrivada) r.pasos.push(`El ataque sale de un equipo de la red interna (${inc.ip}). Ese equipo puede estar infectado: ubicarlo (tabla DHCP del router) y revisarlo.`);
    if (r.reputacion?.puntaje >= 50) r.pasos.push(`La IP tiene mala reputacion publica (${r.reputacion.puntaje}/100 en AbuseIPDB, ${r.reputacion.reportes} reportes): es un atacante conocido.`);
    if (r.historial.equiposAtacados.length > 1) r.pasos.push(`La misma IP ataco ${r.historial.equiposAtacados.length} equipos: ${r.historial.equiposAtacados.join(', ')}.`);
  }

  if (inc.usuarios?.length) r.pasos.push(`Usuarios involucrados: ${inc.usuarios.join(', ')}. Revisar si alguno existe y si su clave es fuerte.`);
  r.pasos.push(inc.recomendacion);
  r.pasos.push('Guardar la evidencia (lineas del registro) antes de que roten los archivos de log.');
  return r;
}

/** Texto plano del informe de un incidente, para correo o para descargar. */
function informeTexto(inc) {
  const inv = inc.investigacion || {};
  const l = [];
  l.push(`INFORME DE INCIDENTE ${inc.id}`);
  l.push(`${inc.titulo}  [${inc.severidad.toUpperCase()}]`);
  l.push('');
  l.push(`Equipo atacado:  ${inc.host}`);
  if (inc.ip) l.push(`IP atacante:     ${inc.ip} (${inv.origen || ''})`);
  if (inv.dnsInverso?.length) l.push(`Nombre (DNS):    ${inv.dnsInverso.join(', ')}`);
  if (inv.ubicacion) l.push(`Ubicacion:       ${[inv.ubicacion.ciudad, inv.ubicacion.pais].filter(Boolean).join(', ')} - ${inv.ubicacion.proveedor || ''}`);
  if (inv.reputacion) l.push(`Reputacion:      ${inv.reputacion.puntaje}/100 (${inv.reputacion.reportes} reportes en AbuseIPDB)`);
  if (inc.usuarios?.length) l.push(`Usuarios:        ${inc.usuarios.join(', ')}`);
  if (inc.procesos?.length) l.push(`Procesos:        ${inc.procesos.map((p) => `${p.pid} ${p.imagen}`).join(' | ')}`);
  if (inc.detalle) l.push(`Detalle:         ${inc.detalle}`);
  l.push(`Primer evento:   ${inc.primerEvento}`);
  l.push(`Ultimo evento:   ${inc.ultimoEvento}`);
  l.push(`Eventos:         ${inc.eventos}`);
  if (inv.tecnica) l.push(`Tecnica:         ${inv.tecnica.id} ${inv.tecnica.nombre} (${inv.tecnica.url})`);
  l.push(`Estado:          ${inc.estado}`);
  if (inc.acciones?.length) { l.push(''); l.push('ACCIONES TOMADAS'); inc.acciones.forEach((a) => l.push(`- ${a.fecha} ${a.texto}`)); }
  if (inc.notas?.length) { l.push(''); l.push('NOTAS'); inc.notas.forEach((n) => l.push(`- ${n}`)); }
  if (inv.historial) {
    l.push(''); l.push('HISTORIAL DE LA IP');
    l.push(`- ${inv.historial.incidentes} incidente(s) desde ${inv.historial.primeraVez}, bloqueada ${inv.historial.vecesBloqueada} vez/veces`);
    l.push(`- Reglas activadas: ${inv.historial.reglas.join(', ')}`);
  }
  if (inv.pasos?.length) { l.push(''); l.push('QUE HACER'); inv.pasos.forEach((p, i) => l.push(`${i + 1}. ${p}`)); }
  l.push(''); l.push('EVIDENCIA');
  (inc.evidencia || []).forEach((e) => l.push(`  ${e}`));
  return l.join('\n');
}

module.exports = { investigar, informeTexto };
