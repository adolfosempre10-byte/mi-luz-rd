'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { normalizarIp, crearListaRedes, esIpPrivada } = require('../lib/util');
const { armar, PREDETERMINADA } = require('../centinela');
const { analizarSalida } = require('../lib/detectores/red');
const { DetectorWindows } = require('../lib/detectores/windows');
const { DetectorArchivos, NOMBRE_SENUELO } = require('../lib/detectores/archivos');
const { iniciarPanel } = require('../lib/panel');
const crearEscudo = require('../lib/escudo');
const { log } = require('../lib/util');

log.silenciar();

function contexto(ajustes = {}) {
  const cfg = PREDETERMINADA();
  cfg.equipo = 'prueba';
  cfg.respuesta.simulacro = true;
  cfg.investigacion = { dnsInverso: false };
  Object.assign(cfg, ajustes);
  const ctx = armar(cfg, { enMemoria: true });
  ctx.enviados = [];
  ctx.avisos.incidente = async (inc, tipo) => { ctx.enviados.push({ inc, tipo }); return []; };
  return { cfg, ctx };
}
const listo = (ctx) => new Promise((r) => ctx.motor.once('listo', r));
const ssh = (texto) => `Nov 26 10:00:00 srv sshd[1]: ${texto}`;
const web = (ip, ruta, estado = 200, agente = 'Mozilla/5.0') => `${ip} - - [26/Nov/2026:10:00:00 -0400] "GET ${ruta} HTTP/1.1" ${estado} 10 "-" "${agente}"`;

test('normaliza IPs y listas de redes', () => {
  assert.equal(normalizarIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizarIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizarIp('1.2.3.4:22'), '1.2.3.4');
  assert.equal(normalizarIp('1.2.3.4; rm -rf /'), null);
  assert.equal(normalizarIp('unknown'), null);
  const l = crearListaRedes(['10.0.0.0/8', '203.0.113.5', '2001:db8::/32']);
  assert.ok(l.contiene('10.20.30.40'));
  assert.ok(l.contiene('203.0.113.5'));
  assert.ok(l.contiene('2001:db8::abcd'));
  assert.ok(!l.contiene('203.0.113.6'));
  assert.ok(esIpPrivada('192.168.1.10'));
  assert.ok(!esIpPrivada('8.8.8.8'));
});

test('fuerza bruta SSH: abre incidente al llegar al umbral, bloquea y avisa', async () => {
  const { ctx } = contexto();
  for (let i = 0; i < 5; i++) ctx.motor.procesarLinea('ssh', ssh(`Failed password for root from 203.0.113.9 port 22 ssh2`));
  assert.equal(ctx.almacen.incidentes.length, 0, 'con 5 intentos todavia no');
  const espera = listo(ctx);
  ctx.motor.procesarLinea('ssh', ssh('Failed password for invalid user pepe from 203.0.113.9 port 22 ssh2'));
  const inc = await espera;
  assert.equal(inc.regla, 'ssh-fuerza-bruta');
  assert.deepEqual(inc.usuarios, ['root', 'pepe']);
  assert.ok(ctx.almacen.bloqueoActivo('203.0.113.9'));
  assert.equal(ctx.enviados.length, 1);
  assert.ok(inc.investigacion.pasos.length > 0);
  // Mas intentos actualizan el mismo incidente en vez de crear otro
  ctx.motor.procesarLinea('ssh', ssh('Failed password for root from 203.0.113.9 port 22 ssh2'));
  assert.equal(ctx.almacen.incidentes.length, 1);
  assert.equal(ctx.almacen.incidentes[0].eventos, 7);
});

test('entrada exitosa solo es alerta si la IP venia atacando', async () => {
  const { ctx } = contexto();
  ctx.motor.procesarLinea('ssh', ssh('Accepted publickey for ana from 198.51.100.4 port 22 ssh2'));
  assert.equal(ctx.almacen.incidentes.length, 0);
  for (let i = 0; i < 6; i++) ctx.motor.procesarLinea('ssh', ssh('Failed password for root from 198.51.100.4 port 22 ssh2'));
  await listo(ctx);
  const espera = listo(ctx);
  ctx.motor.procesarLinea('ssh', ssh('Accepted password for root from 198.51.100.4 port 22 ssh2'));
  const inc = await espera;
  assert.equal(inc.regla, 'ssh-acceso-tras-ataque');
  assert.equal(inc.severidad, 'critica');
});

test('reglas web: inyeccion SQL codificada, Log4Shell, escaneo con rutas distintas', async () => {
  const { ctx } = contexto();
  ctx.motor.procesarLinea('web', web('198.51.100.1', '/p?id=1%27%20OR%201=1--'));
  ctx.motor.procesarLinea('web', web('198.51.100.1', '/p?id=1%2520UNION%2520SELECT%2520clave%2520FROM%2520u'));
  ctx.motor.procesarLinea('web', web('198.51.100.2', '/', 200, '${jndi:ldap://x/a}'));
  for (let i = 0; i < 4; i++) ctx.motor.procesarLinea('web', web('198.51.100.3', '/.env', 404));
  ctx.motor.procesarLinea('web', web('198.51.100.3', '/.git/config', 404));
  ctx.motor.procesarLinea('web', web('198.51.100.3', '/wp-login.php', 404));
  assert.equal(ctx.almacen.incidentes.filter((i) => i.regla === 'web-escaneo-vulnerabilidades').length, 0, 'la misma ruta repetida no cuenta como distinta');
  ctx.motor.procesarLinea('web', web('198.51.100.3', '/phpmyadmin/', 404));
  const reglas = ctx.almacen.incidentes.map((i) => `${i.regla}:${i.ip}`);
  assert.ok(reglas.includes('web-inyeccion-sql:198.51.100.1'));
  assert.ok(reglas.includes('web-ejecucion-remota:198.51.100.2'));
  assert.ok(reglas.includes('web-escaneo-vulnerabilidades:198.51.100.3'));
  // Navegacion normal no dispara nada
  const antes = ctx.almacen.incidentes.length;
  for (const r of ['/', '/index.html', '/app.js?v=2', '/buscar?q=o%27brien']) ctx.motor.procesarLinea('web', web('198.51.100.50', r));
  assert.equal(ctx.almacen.incidentes.length, antes);
});

test('lista blanca: detecta pero no bloquea', async () => {
  const { ctx } = contexto({ listaBlanca: ['127.0.0.1', '192.168.1.0/24'] });
  const espera = listo(ctx);
  ctx.motor.procesarLinea('web', web('192.168.1.20', '/', 200, '${jndi:ldap://x}'));
  const inc = await espera;
  assert.ok(inc.enListaBlanca);
  assert.equal(ctx.almacen.bloqueos.length, 0);
});

test('bloqueos: duracion creciente, vencimiento y no duplicados', async () => {
  const { ctx } = contexto();
  const r = ctx.respuesta;
  const [a, b] = await Promise.all([r.bloquear('203.0.113.70', { motivo: 'x' }), r.bloquear('203.0.113.70', { motivo: 'y' })]);
  assert.equal(a, b);
  assert.equal(ctx.almacen.bloqueos.length, 1);
  assert.ok(Math.abs(Date.parse(a.hasta) - Date.now() - 3600e3) < 5000);
  a.hasta = new Date(Date.now() - 1000).toISOString();
  await r.revisarVencidos();
  assert.equal(ctx.almacen.bloqueoActivo('203.0.113.70'), undefined);
  const c = await r.bloquear('203.0.113.70', { motivo: 'reincide' });
  assert.ok(Math.abs(Date.parse(c.hasta) - Date.now() - 86400e3) < 5000, 'la segunda vez son 24 h');
  assert.equal((await r.bloquear('no-es-ip')).omitido, 'IP no valida');
  assert.equal((await r.bloquear('127.0.0.1')).omitido, 'IP en lista blanca');
});

test('ataque por varios frentes sube la gravedad', async () => {
  const { ctx } = contexto();
  ctx.motor.procesarLinea('web', web('203.0.113.80', '/', 200, 'Nikto/2.5'));
  ctx.motor.procesarLinea('web', web('203.0.113.80', '/x/../../etc/passwd'));
  ctx.motor.procesarLinea('web', web('203.0.113.80', '/y/../../etc/passwd'));
  ctx.motor.procesarLinea('web', web('203.0.113.80', '/a?q=%3Cscript%3Ealert(1)%3C/script%3E'));
  ctx.motor.procesarLinea('web', web('203.0.113.80', '/b?q=%3Cscript%3Ealert(1)%3C/script%3E'));
  const xss = ctx.almacen.incidentes.find((i) => i.regla === 'web-xss');
  assert.equal(xss.severidad, 'alta', 'XSS es media, pero es la tercera regla de la misma IP');
  assert.match(xss.notas.join(' '), /varios frentes/);
});

test('detector de red: cuenta conexiones entrantes por IP (Linux y Windows)', () => {
  const escucha = 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*';
  const conexiones = Array.from({ length: 3 }, (_, i) => `ESTAB 0 0 10.0.0.5:443 203.0.113.1:${5000 + i}`).join('\n')
    + '\nSYN-RECV 0 0 [::ffff:10.0.0.5]:22 [::ffff:203.0.113.2]:6000\nESTAB 0 0 10.0.0.5:51000 93.184.216.34:443';
  const r = analizarSalida('linux', conexiones, escucha);
  assert.ok(r.escuchando.has(443) && r.escuchando.has(22));
  assert.equal(r.conexiones.length, 5);
  const w = analizarSalida('win32', '  TCP    0.0.0.0:3389    0.0.0.0:0    LISTENING\n  TCP    10.0.0.5:3389   203.0.113.9:5555   ESTABLISHED\n  TCP    [::]:445   [::]:0   LISTENING');
  assert.ok(w.escuchando.has(3389) && w.escuchando.has(445));
  assert.deepEqual(w.conexiones[0], { ip: '203.0.113.9', puerto: 3389, estado: 'ESTABLISHED' });
});

test('detector de Windows: no repite eventos ya vistos', async () => {
  const { ctx } = contexto();
  const d = new DetectorWindows(ctx.motor);
  const salida = Array.from({ length: 8 }, (_, i) => `Log=Security RecordId=${i} EventID=4625 IpAddress=192.0.2.7 TargetUserName=admin LogonType=3 SubjectUserName=-`).join('\r\n');
  d.procesar(salida.split('\r\n').slice(0, 5).join('\r\n'));
  d.procesar(salida.split('\r\n').slice(0, 5).join('\r\n'));
  assert.equal(ctx.almacen.incidentes.length, 0);
  const espera = listo(ctx);
  d.procesar(salida);
  const inc = await espera;
  assert.equal(inc.regla, 'win-fuerza-bruta');
  assert.equal(inc.eventos, 8);
});

test('archivos: señuelo de ransomware e integridad de archivos criticos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'centinela-'));
  const critico = path.join(dir, 'passwd');
  fs.writeFileSync(critico, 'root:x:0:0');
  const { ctx } = contexto();
  const d = new DetectorArchivos(ctx.motor, ctx.almacen, { criticos: [critico], carpetas: [], intervalo: 3600 });
  d.revisarIntegridad(true);
  fs.writeFileSync(critico, 'root:x:0:0\nintruso:x:0:0');
  d.revisarIntegridad(false);
  assert.ok(ctx.almacen.incidentes.some((i) => i.regla === 'archivo-critico-modificado'));

  d.ponerSenuelo(dir);
  const senuelo = path.join(dir, NOMBRE_SENUELO);
  d.cambio(senuelo); // solo lo leyeron: no pasa nada
  assert.ok(!ctx.almacen.incidentes.some((i) => i.regla === 'ransomware-senuelo'));
  fs.writeFileSync(senuelo, 'CIFRADO');
  d.cambio(senuelo);
  assert.ok(ctx.almacen.incidentes.some((i) => i.regla === 'ransomware-senuelo' && i.severidad === 'critica'));
  for (const n of ['a.docx.lockbit', 'b.xlsx.lockbit', 'HOW_TO_DECRYPT.txt']) d.cambio(path.join(dir, n));
  assert.ok(ctx.almacen.incidentes.some((i) => i.regla === 'ransomware-extension'));
  fs.rmSync(dir, { recursive: true, force: true });
});

function pedir(puerto, metodo, ruta, { token, cuerpo } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ codigo: res.statusCode, datos: /json/.test(res.headers['content-type']) ? JSON.parse(t) : t, cabeceras: res.headers }));
    });
    req.on('error', reject);
    if (cuerpo) req.write(JSON.stringify(cuerpo));
    req.end();
  });
}

test('panel y central: token, bloqueo manual, agentes y bloqueo global', async () => {
  const { cfg, ctx } = contexto({ listaBlanca: [] });
  cfg.panel = { puerto: 0, direccion: '127.0.0.1', token: 'token-de-prueba-123' };
  cfg.central = { esCentral: true, tokenAgentes: 'agentes-456', minutosSinReportar: 5 };
  const { Central } = require('../lib/central');
  ctx.central = new Central({ almacen: ctx.almacen, avisos: ctx.avisos, respuesta: ctx.respuesta, motor: ctx.motor, config: cfg.central });
  const servidor = iniciarPanel({ config: cfg, ctx });
  await new Promise((r) => servidor.once('listening', r));
  const puerto = servidor.address().port;
  try {
    const inicio = await pedir(puerto, 'GET', '/');
    assert.equal(inicio.codigo, 200);
    assert.match(inicio.datos, /^<!doctype html>/);
    assert.match(inicio.cabeceras['content-security-policy'], /script-src 'self'/);
    assert.equal((await pedir(puerto, 'GET', '/api/estado')).codigo, 401);
    const est = await pedir(puerto, 'GET', '/api/estado', { token: cfg.panel.token });
    assert.equal(est.codigo, 200);
    assert.equal(est.datos.equipo, 'prueba');

    const b = await pedir(puerto, 'POST', '/api/bloqueos', { token: cfg.panel.token, cuerpo: { ip: '203.0.113.200', horas: 2, motivo: 'manual' } });
    assert.equal(b.codigo, 200);
    assert.match(b.datos.quien, /^admin/);

    // Un agente reporta un incidente: el central lo guarda, avisa y bloquea la IP para todos
    const sinc = await pedir(puerto, 'POST', '/api/agente/sincronizar', {
      token: 'agentes-456',
      cuerpo: { equipo: 'pc-contabilidad', so: 'Windows', incidentes: [{ id: 'inc-abc123', regla: 'win-fuerza-bruta', titulo: 'Fuerza bruta', severidad: 'alta', ip: '192.0.2.99', bloquear: true, eventos: 9, evidencia: ['x'] }] },
    });
    assert.equal(sinc.codigo, 200);
    assert.ok(sinc.datos.bloqueos.some((x) => x.ip === '192.0.2.99'));
    assert.ok(sinc.datos.bloqueos.some((x) => x.ip === '203.0.113.200'));
    assert.equal(ctx.almacen.incidente('inc-abc123').host, 'pc-contabilidad');
    assert.equal(ctx.enviados.at(-1).inc.id, 'inc-abc123');

    // Agente que deja de reportar
    ctx.almacen.agentes['pc-contabilidad'].ultimoContacto = new Date(Date.now() - 10 * 60e3).toISOString();
    ctx.central.revisarAgentes();
    assert.ok(ctx.almacen.incidentes.some((i) => i.regla === 'agente-sin-reportar' && i.host === 'pc-contabilidad'));

    // Fuerza bruta al panel: a los 5 intentos la IP queda bloqueada... salvo que este en lista blanca.
    // Aqui la lista blanca esta vacia, asi que 127.0.0.1 termina bloqueado y recibe 403.
    for (let i = 0; i < 5; i++) await pedir(puerto, 'GET', '/api/estado', { token: 'malo' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(ctx.almacen.incidentes.some((i) => i.regla === 'panel-fuerza-bruta'));
    assert.equal((await pedir(puerto, 'GET', '/api/estado', { token: cfg.panel.token })).codigo, 403);
  } finally { servidor.close(); }
});

test('agente: aplica y levanta los bloqueos globales del central', async () => {
  const { ctx } = contexto();
  const { Agente } = require('../lib/central');
  const ag = new Agente({ config: { url: 'http://127.0.0.1:1', tokenAgentes: 'x' }, almacen: ctx.almacen, respuesta: ctx.respuesta, avisos: ctx.avisos, host: 'pc1', version: '1' });
  await ag.aplicarBloqueosGlobales([{ ip: '192.0.2.50', hasta: new Date(Date.now() + 3600e3).toISOString(), motivo: 'ataque a otro equipo' }]);
  assert.equal(ctx.almacen.bloqueoActivo('192.0.2.50').origen, 'central');
  await ag.aplicarBloqueosGlobales([]);
  assert.equal(ctx.almacen.bloqueoActivo('192.0.2.50'), undefined);
});

test('escudo para servidores Node: registra en formato combinado y limita peticiones por IP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escudo-'));
  const registro = path.join(dir, 'escudo.log');
  const estado = path.join(dir, 'estado.json');
  fs.writeFileSync(estado, JSON.stringify({ bloqueos: [] }));
  const escudo = crearEscudo({ registro, estado, maxPorMinuto: 3 });
  const srv = http.createServer(escudo((req, res) => res.end('hola')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const puerto = srv.address().port;
  try {
    assert.equal((await pedir(puerto, 'GET', '/hola?x="1"')).codigo, 200);
    await pedir(puerto, 'GET', '/a'); await pedir(puerto, 'GET', '/b');
    assert.equal((await pedir(puerto, 'GET', '/c')).codigo, 429);
    await new Promise((r) => setTimeout(r, 100));
    const lineas = fs.readFileSync(registro, 'utf8').trim().split('\n');
    const { parsearCombinado } = require('../lib/analizadores');
    const p = parsearCombinado(lineas[0]);
    assert.equal(p.ip, '127.0.0.1');
    assert.equal(p.estado, 200);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('linea de comandos: --analizar investiga un auth.log viejo con sus horas reales', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analizar-'));
  const archivo = path.join(dir, 'auth.log');
  const lineas = [];
  // 6 intentos en 1 minuto (ataque) y 6 intentos repartidos en 6 dias (no es fuerza bruta)
  for (let i = 0; i < 6; i++) lineas.push(`Nov 20 03:00:${String(i * 5).padStart(2, '0')} srv sshd[9]: Failed password for root from 203.0.113.33 port 1 ssh2`);
  for (let i = 0; i < 6; i++) lineas.push(`Nov ${10 + i} 08:00:00 srv sshd[9]: Failed password for ana from 198.51.100.77 port 1 ssh2`);
  fs.writeFileSync(archivo, lineas.join('\n'));
  const salida = execFileSync(process.execPath, [path.join(__dirname, '..', 'centinela.js'), '--analizar', archivo, '--config', path.join(dir, 'c.json'), '--informe', path.join(dir, 'informe.txt')], { encoding: 'utf8' });
  assert.match(salida, /203\.0\.113\.33/);
  assert.doesNotMatch(salida, /198\.51\.100\.77/);
  assert.match(fs.readFileSync(path.join(dir, 'informe.txt'), 'utf8'), /QUE HACER/);
  fs.rmSync(dir, { recursive: true, force: true });
});
