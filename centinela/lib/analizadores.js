'use strict';
// Convierte lineas de registros web (formato combinado de nginx/apache y W3C de IIS) en peticiones.
const { normalizarIp } = require('./util');

function decodificar(texto) {
  let t = String(texto || '').replace(/\+/g, ' ');
  for (let i = 0; i < 2; i++) {
    try { const d = decodeURIComponent(t); if (d === t) break; t = d; } catch { break; }
  }
  return t.toLowerCase();
}

function armarPeticion({ ip, metodo, ruta, estado, agente, linea }) {
  const ipLimpia = normalizarIp(ip);
  if (!ipLimpia) return null;
  const rutaDec = decodificar(ruta);
  const agenteDec = decodificar(agente);
  return {
    ip: ipLimpia, metodo: String(metodo || '').toUpperCase(), ruta: String(ruta || ''), estado: Number(estado) || 0,
    agente: agenteDec, rutaMin: rutaDec.split('?')[0], texto: `${rutaDec} ${agenteDec}`, linea,
  };
}

// 1.2.3.4 - - [26/Nov/2026:10:00:00 -0400] "GET /ruta?x=1 HTTP/1.1" 404 153 "-" "Mozilla/5.0"
const COMBINADO = /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;

function parsearCombinado(linea) {
  const m = COMBINADO.exec(linea);
  if (!m) return null;
  return armarPeticion({ ip: m[1], metodo: m[2], ruta: m[3], estado: m[4], agente: m[5], linea });
}

/** IIS escribe "#Fields: ..." con el orden de las columnas; por eso este analizador guarda estado. */
function crearAnalizadorIis() {
  let campos = ['date', 'time', 's-ip', 'cs-method', 'cs-uri-stem', 'cs-uri-query', 's-port', 'cs-username', 'c-ip', 'cs(user-agent)', 'cs(referer)', 'sc-status'];
  return (linea) => {
    if (linea.startsWith('#Fields:')) { campos = linea.slice(8).trim().toLowerCase().split(/\s+/); return null; }
    if (linea.startsWith('#')) return null;
    const v = linea.trim().split(/\s+/);
    const c = (n) => { const i = campos.indexOf(n); return i >= 0 && v[i] !== '-' ? v[i] : ''; };
    const query = c('cs-uri-query');
    return armarPeticion({
      ip: c('c-ip'), metodo: c('cs-method'), ruta: c('cs-uri-stem') + (query ? `?${query}` : ''),
      estado: c('sc-status'), agente: c('cs(user-agent)'), linea,
    });
  };
}

module.exports = { parsearCombinado, crearAnalizadorIis, decodificar };
