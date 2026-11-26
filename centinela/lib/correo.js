'use strict';
// Cliente SMTP minimo (sin dependencias). Soporta TLS directo (puerto 465) y STARTTLS (puerto 587).
const net = require('net');
const tls = require('tls');

function lector(socket) {
  let buffer = '';
  let lineas = [];
  const esperando = [];
  const alDato = (d) => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lineas.push(linea);
      if (/^\d{3} /.test(linea) || /^\d{3}$/.test(linea)) {
        const resp = { codigo: Number(linea.slice(0, 3)), texto: lineas.join('\n') };
        lineas = [];
        const e = esperando.shift();
        if (e) e(resp);
      }
    }
  };
  socket.on('data', alDato);
  return {
    leer: () => new Promise((resolve) => esperando.push(resolve)),
    soltar: () => socket.removeListener('data', alDato),
  };
}

function conectar(cfg) {
  return new Promise((resolve, reject) => {
    const s = cfg.seguro
      ? tls.connect({ host: cfg.host, port: cfg.puerto, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.puerto });
    s.setTimeout(20000, () => s.destroy(new Error('el servidor de correo no responde')));
    s.once('error', reject);
    s.once(cfg.seguro ? 'secureConnect' : 'connect', () => resolve(s));
  });
}

const b64 = (t) => Buffer.from(String(t), 'utf8').toString('base64');
const enLineas = (t) => t.match(/.{1,76}/g).join('\r\n');

/**
 * @param {object} cfg { host, puerto, seguro, usuario, clave, de, para: [] }
 */
async function enviarCorreo(cfg, asunto, texto) {
  const puerto = cfg.puerto || (cfg.seguro === false ? 587 : 465);
  const c = { ...cfg, puerto, seguro: cfg.seguro ?? puerto === 465 };
  let socket = await conectar(c);
  let l = lector(socket);
  const cmd = async (linea, esperado) => {
    if (linea != null) socket.write(`${linea}\r\n`);
    const r = await l.leer();
    const ok = Array.isArray(esperado) ? esperado.includes(r.codigo) : r.codigo === esperado;
    if (!ok) throw new Error(`SMTP respondio ${r.texto} a "${String(linea).startsWith('AUTH') || linea === b64(c.usuario) ? 'AUTH' : linea}"`);
    return r;
  };
  try {
    await cmd(null, 220);
    let ehlo = await cmd('EHLO centinela', 250);
    if (!c.seguro && /STARTTLS/i.test(ehlo.texto)) {
      await cmd('STARTTLS', 220);
      l.soltar();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: c.host }, () => resolve(t));
        t.once('error', reject);
      });
      l = lector(socket);
      ehlo = await cmd('EHLO centinela', 250);
    }
    if (c.usuario) {
      await cmd('AUTH LOGIN', 334);
      await cmd(b64(c.usuario), 334);
      socket.write(`${b64(c.clave || '')}\r\n`);
      const r = await l.leer();
      if (r.codigo !== 235) throw new Error(`El servidor de correo rechazo el usuario o la clave (${r.codigo})`);
    }
    await cmd(`MAIL FROM:<${c.de}>`, 250);
    for (const p of c.para) await cmd(`RCPT TO:<${p}>`, [250, 251]);
    await cmd('DATA', 354);
    const mensaje = [
      `From: Centinela <${c.de}>`,
      `To: ${c.para.join(', ')}`,
      `Subject: =?UTF-8?B?${b64(asunto)}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      enLineas(b64(texto)),
      '.',
    ].join('\r\n');
    await cmd(mensaje, 250);
    socket.write('QUIT\r\n');
  } finally {
    setTimeout(() => socket.destroy(), 500).unref();
  }
}

module.exports = { enviarCorreo };
