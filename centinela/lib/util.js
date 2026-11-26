'use strict';
// Utilidades comunes: direcciones IP, listas de redes, archivos y registro en consola.
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEVERIDADES = ['baja', 'media', 'alta', 'critica'];
const nivel = (s) => Math.max(0, SEVERIDADES.indexOf(s));
const subirSeveridad = (s) => SEVERIDADES[Math.min(SEVERIDADES.length - 1, nivel(s) + 1)];

/** Devuelve la IP limpia (sin ::ffff:, corchetes ni puerto) o null si no es una IP valida. */
function normalizarIp(valor) {
  if (valor == null) return null;
  let ip = String(valor).trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0];
  if (ip.includes('%')) ip = ip.split('%')[0];
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

/** Crea una lista de redes (BlockList de Node) a partir de IPs o rangos CIDR. */
function crearListaRedes(entradas = []) {
  const lista = new net.BlockList();
  for (const e of entradas) {
    const [dir, prefijo] = String(e).trim().split('/');
    const ip = normalizarIp(dir);
    if (!ip) { log('aviso', `Lista de redes: "${e}" no es una IP o rango valido, se ignora.`); continue; }
    const tipo = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    if (prefijo === undefined) lista.addAddress(ip, tipo);
    else lista.addSubnet(ip, Number(prefijo), tipo);
  }
  return {
    contiene(ipCruda) {
      const ip = normalizarIp(ipCruda);
      if (!ip) return false;
      return lista.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
    },
  };
}

const REDES_PRIVADAS = crearListaRedes([
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16',
  '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10',
]);
const esIpPrivada = (ip) => REDES_PRIVADAS.contiene(ip);

function idCorto(prefijo = '') {
  return prefijo + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** Escribe JSON de forma atomica (archivo temporal + rename) para no corromperlo si se corta la luz. */
function escribirJson(ruta, datos) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, ruta);
}

function leerJson(ruta, porDefecto) {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return porDefecto; }
}

let silencioso = false;
function log(tipo, ...partes) {
  if (silencioso && tipo !== 'error') return;
  const hora = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const etiqueta = { info: 'INFO ', aviso: 'AVISO', error: 'ERROR', alerta: 'ALERTA', accion: 'ACCION' }[tipo] || tipo;
  (tipo === 'error' ? console.error : console.log)(`[${hora}] ${etiqueta} ${partes.join(' ')}`);
}
log.silenciar = (v = true) => { silencioso = v; };

function compararSeguro(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = {
  SEVERIDADES, nivel, subirSeveridad, normalizarIp, crearListaRedes, esIpPrivada,
  idCorto, escribirJson, leerJson, log, compararSeguro,
};
