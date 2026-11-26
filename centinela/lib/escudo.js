'use strict';
// Escudo para cualquier servidor web hecho en Node.js (como servidor.js de Mi Luz RD).
// - Rechaza con 403 las IPs que Centinela bloqueo (funciona aunque no haya permisos de firewall).
// - Limita peticiones por IP (429) para frenar inundaciones.
// - Escribe un registro en formato combinado que Centinela analiza con las reglas web.
//
// Uso:
//   const escudo = require('./centinela/lib/escudo')({ registro: 'centinela/datos/escudo.log' });
//   http.createServer(escudo((req, res) => { ...tu servidor... }))
const fs = require('fs');
const path = require('path');
const { normalizarIp } = require('./util');

const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fechaClf(d) {
  const z = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  return `${z(d.getDate())}/${MESES[d.getMonth()]}/${d.getFullYear()}:${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())} ${signo}${z(Math.floor(Math.abs(off) / 60))}${z(Math.abs(off) % 60)}`;
}
const limpiar = (t) => String(t || '-').replace(/["\\\r\n]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\r': '', '\n': '' }[c]));

function crearEscudo({ registro, estado, maxPorMinuto = 600, detrasDeProxy = false } = {}) {
  const dirDatos = path.join(__dirname, '..', 'datos');
  const rutaRegistro = registro || path.join(dirDatos, 'escudo.log');
  const rutaEstado = estado || path.join(dirDatos, 'estado.json');
  fs.mkdirSync(path.dirname(rutaRegistro), { recursive: true });
  const salida = fs.createWriteStream(rutaRegistro, { flags: 'a' });

  let bloqueadas = new Set();
  const recargar = () => {
    fs.readFile(rutaEstado, 'utf8', (err, t) => {
      if (err) return;
      try {
        const ahora = Date.now();
        bloqueadas = new Set((JSON.parse(t).bloqueos || []).filter((b) => b.activo && (!b.hasta || Date.parse(b.hasta) > ahora)).map((b) => b.ip));
      } catch { /* se esta escribiendo; se reintenta en el proximo ciclo */ }
    });
  };
  recargar();
  setInterval(recargar, 5000).unref();

  const conteo = new Map();
  setInterval(() => conteo.clear(), 60000).unref();

  return (manejador) => (req, res) => {
    const ip = normalizarIp(detrasDeProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress) || '-';
    res.on('finish', () => {
      salida.write(`${ip} - - [${fechaClf(new Date())}] "${limpiar(req.method)} ${limpiar(req.url)} HTTP/${req.httpVersion}" ${res.statusCode} ${res.getHeader('content-length') || 0} "${limpiar(req.headers.referer)}" "${limpiar(req.headers['user-agent'])}"\n`);
    });
    if (bloqueadas.has(ip)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Acceso bloqueado'); }
    const n = (conteo.get(ip) || 0) + 1;
    conteo.set(ip, n);
    if (n > maxPorMinuto) { res.writeHead(429, { 'Retry-After': '60' }); return res.end('Demasiadas peticiones'); }
    return manejador(req, res);
  };
}

module.exports = crearEscudo;
