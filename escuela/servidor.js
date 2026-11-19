// Registro Escolar RD — servidor del centro educativo.
// Uso: node servidor.js   (luego abre la dirección que aparece)
// Guarda todo en la carpeta "datos" de esta misma carpeta. No necesita instalar nada más que Node.js.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { crearDatosDeEjemplo, centroPorDefecto } = require('./demo');

const PORT = Number(process.env.PORT) || 8091;
// En internet el sistema va detrás de un proxy con HTTPS (Caddy o Cloudflare Tunnel): PROXY=1.
// Así se usa la IP real de cada visitante y la cookie de sesión solo viaja por HTTPS.
const PROXY = process.env.PROXY === '1';
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DATOS = process.env.DATOS_DIR || path.join(__dirname, 'datos');
const ARCHIVO = path.join(DATOS, 'escuela.json');
const RESPALDOS = path.join(DATOS, 'respaldos');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ---------- Base de datos (archivo JSON) ----------
fs.mkdirSync(RESPALDOS, { recursive: true });
let db = cargar();
function vacia() {
  return { version: 1, centro: centroPorDefecto(), usuarios: [], cursos: [], cargas: [], estudiantes: [], notas: {}, asistencia: {}, bitacora: [] };
}
function cargar() {
  try {
    const d = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
    return Object.assign(vacia(), d);
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error('No se pudo leer', ARCHIVO, e.message); process.exit(1); }
    return vacia();
  }
}
let guardarTimer = null;
function guardar() {
  clearTimeout(guardarTimer);
  guardarTimer = setTimeout(guardarYa, 200);
}
function guardarYa() {
  clearTimeout(guardarTimer);
  const tmp = ARCHIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, ARCHIVO);
  // Una copia por día, se guardan las últimas 30.
  const hoy = new Date().toISOString().slice(0, 10);
  const copia = path.join(RESPALDOS, `escuela-${hoy}.json`);
  if (!fs.existsSync(copia)) {
    fs.copyFileSync(ARCHIVO, copia);
    const viejas = fs.readdirSync(RESPALDOS).filter(f => f.startsWith('escuela-')).sort();
    while (viejas.length > 30) fs.unlinkSync(path.join(RESPALDOS, viejas.shift()));
  }
}
process.on('SIGINT', () => { if (guardarTimer) guardarYa(); process.exit(0); });
process.on('SIGTERM', () => { if (guardarTimer) guardarYa(); process.exit(0); });

const nuevoId = () => crypto.randomBytes(6).toString('hex');
function hashClave(clave, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(clave), salt, 64).toString('hex') };
}
function claveCorrecta(u, clave) {
  const h = crypto.scryptSync(String(clave), u.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
}
function bitacora(u, accion, detalle) {
  db.bitacora.push({ t: new Date().toISOString(), u: u ? u.nombre : '—', accion, detalle });
  if (db.bitacora.length > 5000) db.bitacora.splice(0, db.bitacora.length - 5000);
}
const usuarioPublico = u => ({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, estudianteIds: u.estudianteIds || [], activo: u.activo !== false, cambiarClave: !!u.cambiarClave });

// ---------- Sesiones ----------
const sesiones = new Map(); // token -> { uid, vence }
const HORAS = 12;
function crearSesion(u) {
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, { uid: u.id, vence: Date.now() + HORAS * 3600e3 });
  return token;
}
function usuarioDe(req) {
  const m = /(?:^|;\s*)sesion=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const s = m && sesiones.get(m[1]);
  if (!s || s.vence < Date.now()) return null;
  s.vence = Date.now() + HORAS * 3600e3;
  const u = db.usuarios.find(x => x.id === s.uid);
  return u && u.activo !== false ? u : null;
}
// Código que se pide para la configuración inicial, así nadie más la hace antes que el centro.
const codigoInstalacion = String(crypto.randomInt(100000, 1000000));
function ipDe(req) {
  if (PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress;
}
const esHttps = req => PROXY && (String(req.headers['x-forwarded-proto'] || '').startsWith('https') || !!req.headers['cf-connecting-ip']);
// Freno simple contra adivinar claves.
const intentos = new Map();
function bloqueado(ip) {
  const r = intentos.get(ip);
  return r && r.n >= 8 && Date.now() - r.t < 5 * 60e3;
}
function fallo(ip) {
  const r = intentos.get(ip) || { n: 0, t: 0 };
  if (Date.now() - r.t > 5 * 60e3) r.n = 0;
  r.n++; r.t = Date.now();
  intentos.set(ip, r);
}

// ---------- Utilidades HTTP ----------
class ErrorApi extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const err = (s, m) => { throw new ErrorApi(s, m); };
function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let tam = 0; const partes = [];
    req.on('data', c => { tam += c.length; if (tam > 20e6) { mal(new ErrorApi(413, 'Archivo demasiado grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { mal(new ErrorApi(400, 'Datos mal formados')); }
    });
    req.on('error', mal);
  });
}
function json(res, status, obj, extra = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra));
  res.end(JSON.stringify(obj));
}
const texto = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const soloAdmin = u => { if (u.rol !== 'admin') err(403, 'Solo la dirección puede hacer esto'); };

// ---------- Qué puede ver cada usuario ----------
function cursosDeDocente(u) {
  const ids = new Set(db.cargas.filter(c => c.docenteId === u.id).map(c => c.cursoId));
  for (const c of db.cursos) if (c.titularId === u.id) ids.add(c.id);
  return ids;
}
function vistaPara(u) {
  const usuarios = u.rol === 'admin' ? db.usuarios.map(usuarioPublico)
    : db.usuarios.filter(x => x.rol !== 'familia' || x.id === u.id).map(x => ({ id: x.id, nombre: x.nombre, rol: x.rol }));
  const base = { yo: usuarioPublico(u), centro: db.centro };
  // Número de orden de cada estudiante en su curso (orden alfabético por apellidos).
  const orden = {};
  const activos = db.estudiantes.filter(e => e.activo !== false)
    .sort((a, b) => a.apellidos.localeCompare(b.apellidos, 'es') || a.nombres.localeCompare(b.nombres, 'es'));
  const cuenta = {};
  for (const e of activos) orden[e.id] = cuenta[e.cursoId] = (cuenta[e.cursoId] || 0) + 1;
  const conOrden = l => l.map(e => Object.assign({}, e, { nOrden: orden[e.id] || null }));
  if (u.rol === 'admin') {
    return Object.assign(base, { usuarios, cursos: db.cursos, cargas: db.cargas, estudiantes: conOrden(db.estudiantes), notas: db.notas, asistencia: db.asistencia });
  }
  let cursoIds, estIds;
  if (u.rol === 'docente') {
    cursoIds = cursosDeDocente(u);
    estIds = new Set(db.estudiantes.filter(e => cursoIds.has(e.cursoId)).map(e => e.id));
  } else {
    estIds = new Set(u.estudianteIds || []);
    cursoIds = new Set(db.estudiantes.filter(e => estIds.has(e.id)).map(e => e.cursoId));
  }
  const cursos = db.cursos.filter(c => cursoIds.has(c.id));
  const cargas = db.cargas.filter(c => cursoIds.has(c.cursoId));
  const titularDe = new Set(cursos.filter(c => c.titularId === u.id).map(c => c.id));
  const cargaVisible = new Set(cargas.filter(c => u.rol === 'familia' || c.docenteId === u.id || titularDe.has(c.cursoId)).map(c => c.id));
  const notas = {};
  for (const [k, v] of Object.entries(db.notas)) {
    const [cid, eid] = k.split('|');
    if (cargaVisible.has(cid) && estIds.has(eid)) notas[k] = v;
  }
  const asistencia = {};
  for (const [k, v] of Object.entries(db.asistencia)) {
    if (!cursoIds.has(k.split('|')[0])) continue;
    if (u.rol === 'docente') { asistencia[k] = v; continue; }
    const f = { _: v._ };
    for (const id of estIds) if (v[id]) f[id] = v[id];
    asistencia[k] = f;
  }
  const estudiantes = conOrden(db.estudiantes.filter(e => estIds.has(e.id)));
  return Object.assign(base, { usuarios, cursos, cargas, estudiantes, notas, asistencia });
}

// ---------- Validaciones ----------
const NIVELES = ['inicial', 'primaria', 'secundaria'];
const MODELOS = ['competencias', 'periodos', 'cualitativo'];
const CUALI = ['L', 'EP', 'I'];
const MARCAS = ['P', 'A', 'T', 'E'];
function limpiarCurso(b) {
  const c = {
    nivel: NIVELES.includes(b.nivel) ? b.nivel : 'secundaria',
    grado: Math.min(6, Math.max(1, parseInt(b.grado, 10) || 1)),
    seccion: texto(b.seccion, 10).toUpperCase() || 'A',
    tanda: texto(b.tanda, 30) || 'Matutina',
    modelo: MODELOS.includes(b.modelo) ? b.modelo : 'competencias',
    titularId: b.titularId && db.usuarios.some(u => u.id === b.titularId) ? b.titularId : null,
  };
  return c;
}
function limpiarEstudiante(b) {
  const e = {
    cursoId: db.cursos.some(c => c.id === b.cursoId) ? b.cursoId : err(400, 'Elige el curso del estudiante'),
    nombres: texto(b.nombres, 80) || err(400, 'Falta el nombre'),
    apellidos: texto(b.apellidos, 80) || err(400, 'Falta el apellido'),
    sexo: b.sexo === 'F' || b.sexo === 'M' ? b.sexo : '',
    fechaNac: /^\d{4}-\d{2}-\d{2}$/.test(b.fechaNac || '') ? b.fechaNac : '',
    idMinerd: texto(b.idMinerd, 30),
    tutor: texto(b.tutor, 100),
    telefono: texto(b.telefono, 30),
    activo: b.activo !== false,
  };
  return e;
}
function limpiarCarga(b) {
  return {
    cursoId: db.cursos.some(c => c.id === b.cursoId) ? b.cursoId : err(400, 'Elige el curso'),
    asignatura: texto(b.asignatura, 80) || err(400, 'Falta la asignatura'),
    docenteId: b.docenteId && db.usuarios.some(u => u.id === b.docenteId) ? b.docenteId : null,
    orden: Number.isFinite(+b.orden) ? +b.orden : 99,
  };
}
function limpiarCentro(b) {
  const c = db.centro;
  const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const per = Array.isArray(b.periodos) ? b.periodos.slice(0, 4).map((p, i) => ({
    nombre: texto(p.nombre, 30) || `P${i + 1}`,
    desde: /^\d{4}-\d{2}-\d{2}$/.test(p.desde || '') ? p.desde : '',
    hasta: /^\d{4}-\d{2}-\d{2}$/.test(p.hasta || '') ? p.hasta : '',
  })) : c.periodos;
  while (per.length < 4) per.push({ nombre: `P${per.length + 1}`, desde: '', hasta: '' });
  return {
    nombre: texto(b.nombre, 120) || c.nombre,
    codigo: texto(b.codigo, 30), regional: texto(b.regional, 60), distrito: texto(b.distrito, 60),
    director: texto(b.director, 100), direccion: texto(b.direccion, 150), telefono: texto(b.telefono, 40),
    sector: texto(b.sector, 30),
    anoEscolar: texto(b.anoEscolar, 20) || c.anoEscolar,
    notaMinima: n(b.notaMinima, 70, 1, 100),
    pesoCompletiva: n(b.pesoCompletiva, 50, 0, 100),
    pesoExtraordinaria: n(b.pesoExtraordinaria, 30, 0, 100),
    asistenciaMinima: n(b.asistenciaMinima, 80, 0, 100),
    competencias: Array.isArray(b.competencias) && b.competencias.length === 4 ? b.competencias.map(x => texto(x, 120)) : c.competencias,
    periodos: per,
    cerrados: Array.isArray(b.cerrados) ? [0, 1, 2, 3, 4].map(i => !!b.cerrados[i]) : c.cerrados,
  };
}
// Qué período toca cada campo de nota: c{comp}{per} / r{comp}{per} / q{comp}{per}; ccf/cex/ce = cierre del año (índice 4).
function etiquetaCampo(campo) {
  const m = /^([crq])([0-3])([0-3])$/.exec(campo);
  if (m) return `${m[1] === 'r' ? 'RP ' : ''}C${+m[2] + 1} · ${db.centro.periodos[+m[3]].nombre}`;
  return { ccf: 'Completiva', cex: 'Extraordinaria', ce: 'Evaluación especial', obs: 'Observación' }[campo] || campo;
}
function periodoDeCampo(campo) {
  const m = /^[crq]([0-3])([0-3])$/.exec(campo);
  if (m) return +m[2];
  if (['ccf', 'cex', 'ce'].includes(campo)) return 4;
  if (campo === 'obs') return -1;
  return null;
}

// ---------- API ----------
async function api(req, res, ruta) {
  const metodo = req.method;
  const ip = ipDe(req);

  if (ruta === '/api/estado' && metodo === 'GET') {
    return json(res, 200, { configurado: db.usuarios.length > 0, centro: db.centro.nombre });
  }
  if (ruta === '/api/configurar' && metodo === 'POST') {
    if (db.usuarios.length) err(400, 'El sistema ya está configurado');
    if (bloqueado(ip)) err(429, 'Demasiados intentos. Espera 5 minutos.');
    const b = await leerCuerpo(req);
    if (String(b.codigo || '').trim() !== codigoInstalacion) { fallo(ip); err(403, 'El código de instalación no es correcto. Míralo en la ventana del servidor.'); }
    if (b.ejemplo) {
      const ej = crearDatosDeEjemplo(nuevoId, hashClave);
      db = Object.assign(vacia(), ej);
    } else {
      if (!texto(b.usuario) || String(b.clave || '').length < 6) err(400, 'Usuario y clave de al menos 6 caracteres');
      db.centro.nombre = texto(b.centro, 120) || db.centro.nombre;
      db.usuarios.push(Object.assign({ id: nuevoId(), nombre: texto(b.nombre, 100) || 'Dirección', usuario: texto(b.usuario, 40).toLowerCase(), rol: 'admin', activo: true }, hashClave(b.clave)));
    }
    bitacora(null, 'Configuración inicial', b.ejemplo ? 'Con datos de ejemplo' : db.centro.nombre);
    guardarYa();
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/entrar' && metodo === 'POST') {
    if (bloqueado(ip)) err(429, 'Demasiados intentos. Espera 5 minutos.');
    const b = await leerCuerpo(req);
    const u = db.usuarios.find(x => x.usuario === texto(b.usuario).toLowerCase() && x.activo !== false);
    if (!u || !claveCorrecta(u, b.clave || '')) { fallo(ip); err(401, 'Usuario o clave incorrectos'); }
    intentos.delete(ip);
    const token = crearSesion(u);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sesion=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HORAS * 3600}${esHttps(req) ? '; Secure' : ''}` });
  }
  if (ruta === '/api/salir' && metodo === 'POST') {
    const m = /(?:^|;\s*)sesion=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) sesiones.delete(m[1]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sesion=; Path=/; Max-Age=0${esHttps(req) ? '; Secure' : ''}` });
  }

  const u = usuarioDe(req);
  if (!u) err(401, 'Tu sesión terminó. Entra de nuevo.');
  // Toda escritura debe venir de esta misma página (protección CSRF básica).
  if (metodo !== 'GET' && req.headers['x-registro'] !== '1') err(403, 'Solicitud no permitida');

  if (ruta === '/api/datos' && metodo === 'GET') return json(res, 200, vistaPara(u));

  if (ruta === '/api/clave' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    if (!claveCorrecta(u, b.actual || '')) err(400, 'La clave actual no es correcta');
    if (String(b.nueva || '').length < 6) err(400, 'La clave nueva debe tener al menos 6 caracteres');
    Object.assign(u, hashClave(b.nueva)); delete u.cambiarClave;
    bitacora(u, 'Cambió su clave', '');
    guardar();
    return json(res, 200, { ok: true });
  }

  // --- Notas: una celda a la vez ---
  if (ruta === '/api/nota' && metodo === 'PUT') {
    const b = await leerCuerpo(req);
    const carga = db.cargas.find(c => c.id === b.cargaId) || err(404, 'Asignatura no encontrada');
    const est = db.estudiantes.find(e => e.id === b.estudianteId && e.cursoId === carga.cursoId) || err(404, 'Estudiante no encontrado');
    const campo = String(b.campo || '');
    const per = periodoDeCampo(campo);
    if (per === null) err(400, 'Campo no válido');
    if (u.rol === 'familia') err(403, 'Sin permiso');
    if (u.rol === 'docente') {
      if (carga.docenteId !== u.id) err(403, 'Esta asignatura no es tuya');
      if (per >= 0 && db.centro.cerrados[per]) err(423, 'Ese período está cerrado por la dirección');
    }
    let valor = b.valor;
    if (valor === '' || valor == null) valor = null;
    else if (campo[0] === 'q') { valor = String(valor).toUpperCase(); if (!CUALI.includes(valor)) err(400, 'Usa L, EP o I'); }
    else if (campo === 'obs') valor = texto(valor, 500);
    else {
      valor = Number(String(valor).replace(',', '.'));
      if (!Number.isFinite(valor) || valor < 0 || valor > 100) err(400, 'La nota debe ser de 0 a 100');
      valor = Math.round(valor);
    }
    const k = `${carga.id}|${est.id}`;
    const reg = db.notas[k] || (db.notas[k] = {});
    const antes = reg[campo] ?? null;
    if (valor === null) delete reg[campo]; else reg[campo] = valor;
    if (!Object.keys(reg).length) delete db.notas[k];
    if (antes !== valor) bitacora(u, 'Nota', `${est.apellidos}, ${est.nombres} · ${carga.asignatura} · ${etiquetaCampo(campo)}: ${antes ?? '—'} → ${valor ?? '—'}`);
    guardar();
    return json(res, 200, { ok: true, valor });
  }

  // --- Asistencia: un día de un curso ---
  if (ruta === '/api/asistencia' && metodo === 'PUT') {
    const b = await leerCuerpo(req);
    const curso = db.cursos.find(c => c.id === b.cursoId) || err(404, 'Curso no encontrado');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '')) err(400, 'Fecha no válida');
    if (u.rol === 'familia' || (u.rol === 'docente' && !cursosDeDocente(u).has(curso.id))) err(403, 'Sin permiso');
    const dia = { _: 1 };
    for (const e of db.estudiantes.filter(e => e.cursoId === curso.id)) {
      const m = b.marcas && b.marcas[e.id];
      if (MARCAS.includes(m) && m !== 'P') dia[e.id] = m;
    }
    const k = `${curso.id}|${b.fecha}`;
    if (b.borrar) delete db.asistencia[k]; else db.asistencia[k] = dia;
    bitacora(u, 'Asistencia', `${nombreCurso(curso)} · ${b.fecha}${b.borrar ? ' (borrada)' : ''}`);
    guardar();
    return json(res, 200, { ok: true });
  }

  // --- Lo demás es de la dirección ---
  soloAdmin(u);

  if (ruta === '/api/centro' && metodo === 'PUT') {
    const b = await leerCuerpo(req);
    const antes = db.centro.cerrados.slice();
    db.centro = limpiarCentro(b);
    const nom = ['P1', 'P2', 'P3', 'P4', 'Cierre del año'];
    db.centro.cerrados.forEach((c, i) => { if (c !== antes[i]) bitacora(u, c ? 'Cerró período' : 'Abrió período', nom[i]); });
    bitacora(u, 'Datos del centro', 'Actualizados');
    guardar();
    return json(res, 200, { ok: true });
  }

  const m = /^\/api\/(usuarios|cursos|cargas|estudiantes)(?:\/([a-f0-9]+))?$/.exec(ruta);
  if (m) {
    const [, col, id] = m;
    const lista = db[col];
    if (metodo === 'POST' && !id) {
      const b = await leerCuerpo(req);
      let obj;
      if (col === 'usuarios') {
        const usuario = texto(b.usuario, 40).toLowerCase();
        if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) err(400, 'El usuario debe tener 3 letras o más, sin espacios');
        if (db.usuarios.some(x => x.usuario === usuario)) err(400, 'Ese usuario ya existe');
        if (String(b.clave || '').length < 6) err(400, 'La clave debe tener al menos 6 caracteres');
        obj = Object.assign({ nombre: texto(b.nombre, 100) || usuario, usuario, rol: ['admin', 'docente', 'familia'].includes(b.rol) ? b.rol : 'docente',
          estudianteIds: Array.isArray(b.estudianteIds) ? b.estudianteIds.filter(x => db.estudiantes.some(e => e.id === x)) : [], activo: true, cambiarClave: true }, hashClave(b.clave));
      } else if (col === 'cursos') obj = limpiarCurso(b);
      else if (col === 'cargas') obj = limpiarCarga(b);
      else obj = limpiarEstudiante(b);
      obj = Object.assign({ id: nuevoId() }, obj);
      lista.push(obj);
      bitacora(u, `Agregó ${col.slice(0, -1)}`, describir(col, obj));
      guardar();
      return json(res, 200, { ok: true, id: obj.id });
    }
    const obj = lista.find(x => x.id === id) || err(404, 'No encontrado');
    if (metodo === 'PUT') {
      const b = await leerCuerpo(req);
      if (col === 'usuarios') {
        if (b.nombre !== undefined) obj.nombre = texto(b.nombre, 100) || obj.nombre;
        if (b.rol && ['admin', 'docente', 'familia'].includes(b.rol)) {
          if (obj.id === u.id && b.rol !== 'admin') err(400, 'No puedes quitarte el rol de dirección a ti mismo');
          obj.rol = b.rol;
        }
        if (Array.isArray(b.estudianteIds)) obj.estudianteIds = b.estudianteIds.filter(x => db.estudiantes.some(e => e.id === x));
        if (b.activo !== undefined) { if (obj.id === u.id && !b.activo) err(400, 'No puedes desactivarte a ti mismo'); obj.activo = !!b.activo; }
        if (b.clave) {
          if (String(b.clave).length < 6) err(400, 'La clave debe tener al menos 6 caracteres');
          Object.assign(obj, hashClave(b.clave)); obj.cambiarClave = obj.id !== u.id;
          for (const [t, s] of sesiones) if (s.uid === obj.id && obj.id !== u.id) sesiones.delete(t);
        }
      } else if (col === 'cursos') Object.assign(obj, limpiarCurso(Object.assign({}, obj, b)));
      else if (col === 'cargas') Object.assign(obj, limpiarCarga(Object.assign({}, obj, b)));
      else {
        const nuevo = limpiarEstudiante(Object.assign({}, obj, b));
        if (nuevo.cursoId !== obj.cursoId) {
          // Cambio de sección: las notas se pasan a la misma asignatura del curso nuevo, si existe.
          for (const c of db.cargas.filter(c => c.cursoId === obj.cursoId)) {
            const k = `${c.id}|${obj.id}`; if (!db.notas[k]) continue;
            const destino = db.cargas.find(d => d.cursoId === nuevo.cursoId && d.asignatura.toLowerCase() === c.asignatura.toLowerCase());
            if (destino && !db.notas[`${destino.id}|${obj.id}`]) db.notas[`${destino.id}|${obj.id}`] = db.notas[k];
            delete db.notas[k];
          }
        }
        Object.assign(obj, nuevo);
        delete obj.nOrden;
      }
      bitacora(u, `Modificó ${col.slice(0, -1)}`, describir(col, obj));
      guardar();
      return json(res, 200, { ok: true });
    }
    if (metodo === 'DELETE') {
      if (col === 'usuarios') {
        if (obj.id === u.id) err(400, 'No puedes borrarte a ti mismo');
        for (const c of db.cargas) if (c.docenteId === obj.id) c.docenteId = null;
        for (const c of db.cursos) if (c.titularId === obj.id) c.titularId = null;
        for (const [t, s] of sesiones) if (s.uid === obj.id) sesiones.delete(t);
      }
      if (col === 'cursos') {
        if (db.estudiantes.some(e => e.cursoId === obj.id)) err(400, 'Primero mueve o borra los estudiantes de este curso');
        const cargas = new Set(db.cargas.filter(c => c.cursoId === obj.id).map(c => c.id));
        db.cargas = db.cargas.filter(c => !cargas.has(c.id));
        for (const k of Object.keys(db.notas)) if (cargas.has(k.split('|')[0])) delete db.notas[k];
        for (const k of Object.keys(db.asistencia)) if (k.startsWith(obj.id + '|')) delete db.asistencia[k];
      }
      if (col === 'cargas') for (const k of Object.keys(db.notas)) if (k.startsWith(obj.id + '|')) delete db.notas[k];
      if (col === 'estudiantes') {
        for (const k of Object.keys(db.notas)) if (k.endsWith('|' + obj.id)) delete db.notas[k];
        for (const d of Object.values(db.asistencia)) delete d[obj.id];
        for (const x of db.usuarios) if (x.estudianteIds) x.estudianteIds = x.estudianteIds.filter(i => i !== obj.id);
      }
      db[col] = db[col].filter(x => x.id !== obj.id);
      bitacora(u, `Borró ${col.slice(0, -1)}`, describir(col, obj));
      guardar();
      return json(res, 200, { ok: true });
    }
  }

  if (ruta === '/api/estudiantes-lote' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    const lista = Array.isArray(b.estudiantes) ? b.estudiantes.slice(0, 2000) : [];
    const nuevos = lista.map(e => Object.assign({ id: nuevoId() }, limpiarEstudiante(Object.assign({}, e, { cursoId: b.cursoId }))));
    db.estudiantes.push(...nuevos);
    bitacora(u, 'Inscribió estudiantes', `${nuevos.length} en ${nombreCurso(db.cursos.find(c => c.id === b.cursoId))}`);
    guardar();
    return json(res, 200, { ok: true, n: nuevos.length });
  }
  if (ruta === '/api/cargas-por-defecto' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    const curso = db.cursos.find(c => c.id === b.cursoId) || err(404, 'Curso no encontrado');
    const ya = new Set(db.cargas.filter(c => c.cursoId === curso.id).map(c => c.asignatura.toLowerCase()));
    let n = 0;
    asignaturasPorDefecto(curso).forEach((a, i) => {
      if (ya.has(a.toLowerCase())) return;
      db.cargas.push({ id: nuevoId(), cursoId: curso.id, asignatura: a, docenteId: null, orden: i }); n++;
    });
    bitacora(u, 'Asignaturas del plan de estudios', `${n} en ${nombreCurso(curso)}`);
    guardar();
    return json(res, 200, { ok: true, n });
  }
  if (ruta === '/api/bitacora' && metodo === 'GET') return json(res, 200, db.bitacora.slice(-1500).reverse());
  if (ruta === '/api/respaldo' && metodo === 'GET') {
    bitacora(u, 'Descargó respaldo', '');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="registro-escolar-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db));
  }
  if (ruta === '/api/restaurar' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    if (!b || !Array.isArray(b.usuarios) || !b.usuarios.some(x => x.rol === 'admin')) err(400, 'Ese archivo no es un respaldo válido');
    guardarYa();
    fs.copyFileSync(ARCHIVO, path.join(RESPALDOS, `antes-de-restaurar-${Date.now()}.json`));
    db = Object.assign(vacia(), b);
    sesiones.clear();
    bitacora(u, 'Restauró respaldo', '');
    guardarYa();
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/nuevo-ano' && metodo === 'POST') {
    // Guarda el año que termina y deja el sistema listo para el siguiente (mismos usuarios, cursos y asignaturas; sin notas ni asistencia).
    const b = await leerCuerpo(req);
    guardarYa();
    fs.copyFileSync(ARCHIVO, path.join(RESPALDOS, `ano-${db.centro.anoEscolar.replace(/[^0-9-]/g, '')}-${Date.now()}.json`));
    db.notas = {}; db.asistencia = {};
    db.centro.anoEscolar = texto(b.anoEscolar, 20) || db.centro.anoEscolar;
    db.centro.cerrados = [false, false, false, false, false];
    db.centro.periodos = db.centro.periodos.map(p => ({ nombre: p.nombre, desde: '', hasta: '' }));
    bitacora(u, 'Nuevo año escolar', db.centro.anoEscolar);
    guardarYa();
    return json(res, 200, { ok: true });
  }
  err(404, 'Ruta no encontrada');
}

function nombreCurso(c) {
  if (!c) return '—';
  const nv = { inicial: 'Inicial', primaria: 'Primaria', secundaria: 'Secundaria' }[c.nivel];
  return `${c.grado}.º ${c.seccion} ${nv}`;
}
function describir(col, o) {
  if (col === 'usuarios') return `${o.nombre} (${o.usuario}, ${o.rol})`;
  if (col === 'cursos') return nombreCurso(o);
  if (col === 'cargas') return `${o.asignatura} · ${nombreCurso(db.cursos.find(c => c.id === o.cursoId))}`;
  return `${o.apellidos}, ${o.nombres}`;
}
function asignaturasPorDefecto(curso) {
  if (curso.nivel === 'secundaria') return ['Lengua Española', 'Lenguas Extranjeras (Inglés)', 'Lenguas Extranjeras (Francés)', 'Matemática', 'Ciencias Sociales',
    'Ciencias de la Naturaleza', 'Educación Artística', 'Educación Física', 'Formación Integral Humana y Religiosa'];
  if (curso.nivel === 'primaria') {
    const base = ['Lengua Española', 'Matemática', 'Ciencias Sociales', 'Ciencias de la Naturaleza', 'Educación Artística', 'Educación Física', 'Formación Integral Humana y Religiosa'];
    return curso.grado >= 4 ? base.concat('Lenguas Extranjeras (Inglés)') : base;
  }
  return ['Desarrollo Personal y Social', 'Comunicación', 'Pensamiento Lógico', 'Exploración del Entorno', 'Expresión Artística', 'Desarrollo Motor'];
}

// ---------- Servidor ----------
http.createServer(async (req, res) => {
  let ruta;
  try { ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (ruta.startsWith('/api/')) {
    try { await api(req, res, ruta); } catch (e) {
      if (!(e instanceof ErrorApi)) console.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e instanceof ErrorApi ? e.message : 'Error interno del servidor' });
    }
    return;
  }
  if (ruta.endsWith('/')) ruta += 'index.html';
  const file = path.normalize(path.join(PUBLIC, ruta));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log('Registro Escolar funcionando.');
  console.log(`  En esta computadora: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  Otras computadoras y celulares (misma red): http://${a.address}:${PORT}`);
  }
  console.log(`  Datos guardados en: ${DATOS}`);
  if (!db.usuarios.length) console.log(`\n  CÓDIGO DE INSTALACIÓN: ${codigoInstalacion}  (se pide al configurar el sistema por primera vez)\n`);
});
