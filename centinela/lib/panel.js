'use strict';
// Panel web (se abre en la PC o en el celular) y API para que los agentes reporten al central.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { normalizarIp, compararSeguro, log } = require('./util');
const { informeTexto } = require('./investigacion');

const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
  '/estilos.css': ['estilos.css', 'text/css; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/icono.svg': ['icono.svg', 'image/svg+xml'],
};
const SEGURIDAD = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};

function leerCuerpo(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0; const partes = [];
    req.on('data', (d) => { total += d.length; if (total > max) { reject(new Error('cuerpo muy grande')); req.destroy(); } else partes.push(d); });
    req.on('end', () => { try { resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); } catch { reject(new Error('JSON no valido')); } });
    req.on('error', reject);
  });
}

/**
 * @param {object} o
 * @param {object} o.config        configuracion completa
 * @param {object} o.ctx           { almacen, motor, respuesta, avisos, host, version, central }
 */
function iniciarPanel({ config, ctx }) {
  const cfg = config.panel || {};
  const usuarios = [...(cfg.usuarios || [])];
  if (cfg.token) usuarios.push({ nombre: 'admin', token: cfg.token });
  const tokensAgentes = config.central?.tokenAgentes ? [config.central.tokenAgentes] : [];
  const carpeta = path.join(__dirname, '..', 'panel');

  const quienEs = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return m ? usuarios.find((u) => compararSeguro(u.token, m[1])) : null;
  };

  const ipCliente = (req) => {
    if (cfg.detrasDeProxy && req.headers['x-forwarded-for']) return normalizarIp(String(req.headers['x-forwarded-for']).split(',')[0]);
    return normalizarIp(req.socket.remoteAddress);
  };

  async function manejar(req, res) {
    const ip = ipCliente(req);
    const url = new URL(req.url, 'http://x');
    const ruta = url.pathname;
    const enviar = (codigo, datos, tipo = 'application/json; charset=utf-8') => {
      res.writeHead(codigo, { 'Content-Type': tipo, ...SEGURIDAD });
      res.end(typeof datos === 'string' || Buffer.isBuffer(datos) ? datos : JSON.stringify(datos));
    };

    if (ip && ctx.almacen.bloqueoActivo(ip) && !ctx.respuesta.listaBlanca.contiene(ip)) return enviar(403, { error: 'bloqueado' });

    if (req.method === 'GET' && ESTATICOS[ruta]) {
      const [archivo, tipo] = ESTATICOS[ruta];
      return fs.readFile(path.join(carpeta, archivo), (err, data) => (err ? enviar(404, { error: 'no existe' }) : enviar(200, data, tipo)));
    }

    // ----- API de agentes (otros equipos que reportan a este central) -----
    if (ruta === '/api/agente/sincronizar' && req.method === 'POST') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!ctx.central || !m || !tokensAgentes.some((t) => compararSeguro(t, m[1]))) {
        ctx.motor.registrar({ regla: 'panel-fuerza-bruta', ip, detalle: `token de agente invalido en ${ruta}`, linea: `${req.method} ${ruta} token invalido` });
        return enviar(401, { error: 'token de agente invalido' });
      }
      try { return enviar(200, await ctx.central.recibir(await leerCuerpo(req), ip)); } catch (e) { return enviar(400, { error: e.message }); }
    }

    if (!ruta.startsWith('/api/')) return enviar(404, { error: 'no existe' });

    const usuario = quienEs(req);
    if (!usuario) {
      ctx.motor.registrar({ regla: 'panel-fuerza-bruta', ip, detalle: `token invalido en ${ruta}`, linea: `${req.method} ${ruta} sin token valido` });
      return enviar(401, { error: 'token invalido' });
    }
    const quien = `${usuario.nombre} (${ip})`;

    try {
      if (ruta === '/api/estado' && req.method === 'GET') {
        const ahora = Date.now();
        const inc = ctx.almacen.incidentes.slice(-500).reverse().map(({ evidencia, investigacion, ...resto }) => resto);
        return enviar(200, {
          equipo: ctx.host, version: ctx.version, modo: ctx.respuesta.modo, esCentral: !!ctx.central, usuario: usuario.nombre,
          incidentes: inc,
          bloqueos: ctx.almacen.bloqueos.filter((b) => b.activo && (!b.hasta || Date.parse(b.hasta) > ahora)),
          agentes: Object.values(ctx.almacen.agentes),
          estadisticas: ctx.motor.estadisticas,
        });
      }

      let m = /^\/api\/incidentes\/([\w-]+)(\/informe)?$/.exec(ruta);
      if (m) {
        const inc = ctx.almacen.incidente(m[1]);
        if (!inc) return enviar(404, { error: 'incidente no encontrado' });
        if (m[2] && req.method === 'GET') return enviar(200, informeTexto(inc), 'text/plain; charset=utf-8');
        if (req.method === 'GET') return enviar(200, inc);
        if (req.method === 'POST') {
          const b = await leerCuerpo(req);
          if (b.estado && ['abierto', 'investigando', 'resuelto', 'falsa-alarma'].includes(b.estado)) {
            inc.estado = b.estado === 'falsa-alarma' ? 'resuelto' : b.estado;
            if (b.estado === 'falsa-alarma') inc.falsaAlarma = true;
            inc.acciones.push({ fecha: new Date().toISOString(), texto: `Estado cambiado a "${b.estado}" por ${quien}` });
          }
          if (b.nota) inc.notas.push(`${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${usuario.nombre}: ${String(b.nota).slice(0, 2000)}`);
          inc.actualizado = new Date().toISOString();
          ctx.almacen.guardar();
          ctx.almacen.auditoria(`INCIDENTE ${inc.id} ${b.estado || 'nota'} por ${quien}`);
          return enviar(200, inc);
        }
      }

      if (ruta === '/api/bloqueos' && req.method === 'POST') {
        const b = await leerCuerpo(req);
        const horas = Number(b.horas);
        const r = await ctx.respuesta.bloquear(b.ip, {
          motivo: String(b.motivo || 'Bloqueo manual').slice(0, 300), origen: 'manual', quien,
          segundos: Number.isFinite(horas) ? Math.max(0, horas * 3600) : undefined,
        });
        return enviar(r.omitido ? 400 : 200, r.omitido ? { error: r.omitido } : r);
      }

      m = /^\/api\/bloqueos\/(.+)$/.exec(ruta);
      if (m && req.method === 'DELETE') {
        const ipDesbloquear = decodeURIComponent(m[1]);
        await ctx.respuesta.desbloquear(ipDesbloquear, quien);
        return enviar(200, { ok: true });
      }

      if (ruta === '/api/avisos/prueba' && req.method === 'POST') {
        const r = await ctx.avisos.aTodos('[Centinela] Prueba de avisos', `Prueba de avisos enviada desde el panel por ${usuario.nombre}. Si lees esto, el canal funciona.`);
        return enviar(200, { resultados: r });
      }
    } catch (e) {
      return enviar(400, { error: e.message });
    }
    return enviar(404, { error: 'no existe' });
  }

  const tieneTls = cfg.certificado && cfg.claveCertificado;
  const servidor = tieneTls
    ? https.createServer({ cert: fs.readFileSync(cfg.certificado), key: fs.readFileSync(cfg.claveCertificado) }, manejar)
    : http.createServer(manejar);
  servidor.requestTimeout = 30000;
  servidor.headersTimeout = 15000;
  const puerto = cfg.puerto ?? 8095;
  const direccion = cfg.direccion || '0.0.0.0';
  servidor.on('error', (e) => log('error', `Panel: ${e.message}`));
  servidor.listen(puerto, direccion, () => log('info', `Panel en ${tieneTls ? 'https' : 'http'}://${direccion === '0.0.0.0' ? 'localhost' : direccion}:${puerto}`));
  return servidor;
}

module.exports = { iniciarPanel };
