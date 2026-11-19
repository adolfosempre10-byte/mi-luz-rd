'use strict';
/* Registro Escolar — interfaz para dirección, docentes y familias. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = { datos: null };
const NIVEL = { inicial: 'Inicial', primaria: 'Primaria', secundaria: 'Secundaria' };
const MODELO = { competencias: 'Por competencias (C1–C4)', periodos: 'Una nota por período', cualitativo: 'Cualitativo (L / EP / I)' };
const ROL = { admin: 'Dirección', docente: 'Docente', familia: 'Familia' };
const CUALI = { L: 'Logrado', EP: 'En proceso', I: 'Iniciado' };
const MARCA = { P: 'Presente', A: 'Ausente', T: 'Tardanza', E: 'Excusa' };
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fechaBonita = f => f ? new Date(f + 'T12:00').toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

// ---------- Comunicación con el servidor ----------
async function llamar(metodo, ruta, cuerpo) {
  const r = await fetch(ruta, {
    method: metodo, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Registro': '1' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let d = {};
  try { d = await r.json(); } catch { /* respuesta vacía */ }
  if (r.status === 401 && ruta !== '/api/entrar') { S.datos = null; pantallaEntrada(d.error); throw new Error(d.error || 'Sesión terminada'); }
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}
function aviso(msg, mal = false) {
  const div = document.createElement('div');
  div.textContent = msg; if (mal) div.className = 'mal';
  $('#avisos').append(div);
  setTimeout(() => div.remove(), mal ? 5000 : 2500);
}
async function intentar(fn) { try { return await fn(); } catch (e) { aviso(e.message, true); } }

// ---------- Datos e índices ----------
function indexar() {
  const d = S.datos;
  const mapa = l => Object.fromEntries(l.map(x => [x.id, x]));
  d.uMap = mapa(d.usuarios); d.cMap = mapa(d.cursos); d.eMap = mapa(d.estudiantes); d.kMap = mapa(d.cargas);
}
async function recargar() {
  S.datos = await llamar('GET', '/api/datos');
  indexar();
  render();
}
const yo = () => S.datos.yo;
const esAdmin = () => yo().rol === 'admin';
const nombreCurso = c => c ? `${c.grado}.º ${c.seccion} · ${NIVEL[c.nivel]}` : '—';
const nombreEst = e => e ? `${e.apellidos}, ${e.nombres}` : '—';
const nombreUsuario = id => S.datos.uMap[id]?.nombre || 'Sin asignar';
const ordenCursos = (a, b) => ['inicial', 'primaria', 'secundaria'].indexOf(a.nivel) - ['inicial', 'primaria', 'secundaria'].indexOf(b.nivel) || a.grado - b.grado || a.seccion.localeCompare(b.seccion);
const cursosOrdenados = () => S.datos.cursos.slice().sort(ordenCursos);
const estudiantesDe = (cursoId, todos = false) => S.datos.estudiantes.filter(e => e.cursoId === cursoId && (todos || e.activo !== false))
  .sort((a, b) => a.apellidos.localeCompare(b.apellidos, 'es') || a.nombres.localeCompare(b.nombres, 'es'));
const cargasDe = cursoId => S.datos.cargas.filter(c => c.cursoId === cursoId).sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.asignatura.localeCompare(b.asignatura, 'es'));
const reg = (cargaId, estId) => S.datos.notas[`${cargaId}|${estId}`];
const modeloDe = carga => S.datos.cMap[carga.cursoId]?.modelo || 'competencias';
function periodoActual() {
  const per = S.datos.centro.periodos, h = hoy();
  let i = per.findIndex(p => p.desde && p.hasta && h >= p.desde && h <= p.hasta);
  if (i < 0) { i = 0; per.forEach((p, j) => { if (p.desde && p.desde <= h) i = j; }); }
  return i;
}
// El servidor solo manda los cursos que este usuario puede ver.
const cursosVisibles = () => cursosOrdenados();
const cursosTitular = () => esAdmin() ? cursosOrdenados() : cursosOrdenados().filter(c => c.titularId === yo().id);
const misCargas = () => (esAdmin() ? S.datos.cargas : S.datos.cargas.filter(c => c.docenteId === yo().id))
  .slice().sort((a, b) => ordenCursos(S.datos.cMap[a.cursoId], S.datos.cMap[b.cursoId]) || (a.orden ?? 99) - (b.orden ?? 99));
function avance(carga, p) {
  const modelo = modeloDe(carga), ests = estudiantesDe(carga.cursoId);
  const nb = modelo === 'periodos' ? 1 : 4, letra = modelo === 'cualitativo' ? 'q' : 'c';
  let hay = 0;
  for (const e of ests) { const r = reg(carga.id, e.id); for (let c = 0; c < nb; c++) if (r && r[`${letra}${c}${p}`] != null) hay++; }
  return ests.length ? Math.round(100 * hay / (ests.length * nb)) : 0;
}

// ---------- Rutas ----------
function ruta() {
  const [v, q] = location.hash.slice(1).split('?');
  return { vista: v || 'inicio', p: Object.fromEntries(new URLSearchParams(q || '')) };
}
function ir(vista, p = {}) {
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const h = '#' + vista + (q ? '?' + q : '');
  if (location.hash === h) render(); else location.hash = h;
}
window.addEventListener('hashchange', () => S.datos && render());

const MENU = {
  admin: [['inicio', '🏠', 'Inicio'], ['calificaciones', '📝', 'Calificaciones'], ['asistencia', '📅', 'Asistencia'], ['boletines', '📄', 'Boletines'],
    ['reportes', '📊', 'Reportes'], ['estudiantes', '🎒', 'Estudiantes'], ['cursos', '🏫', 'Cursos y asignaturas'], ['usuarios', '👥', 'Usuarios'],
    ['centro', '⚙️', 'Centro educativo'], ['bitacora', '🕘', 'Bitácora'], ['cuenta', '🔑', 'Mi cuenta']],
  docente: [['inicio', '🏠', 'Inicio'], ['calificaciones', '📝', 'Calificaciones'], ['asistencia', '📅', 'Asistencia'], ['boletines', '📄', 'Boletines'],
    ['reportes', '📊', 'Reportes'], ['cuenta', '🔑', 'Mi cuenta']],
  familia: [['boletines', '📄', 'Boletín'], ['asistencia', '📅', 'Asistencia'], ['cuenta', '🔑', 'Mi cuenta']],
};
const VISTAS = {
  inicio: vInicio, calificaciones: vCalificaciones, asistencia: vAsistencia, boletines: vBoletines, reportes: vReportes,
  estudiantes: vEstudiantes, cursos: vCursos, usuarios: vUsuarios, centro: vCentro, bitacora: vBitacora, cuenta: vCuenta,
};

function render() {
  const { vista, p } = ruta();
  const menu = MENU[yo().rol];
  const v = menu.some(m => m[0] === vista) ? vista : menu[0][0];
  const c = S.datos.centro;
  $('#app').innerHTML = `
    <header class="barra">
      <span class="logo">📘 ${esc(c.nombre)}</span><span class="ano">Año escolar ${esc(c.anoEscolar)}</span>
      <span class="yo">${esc(yo().nombre)}<small>${ROL[yo().rol]}</small></span>
      <button id="salir" class="mini">Salir</button>
    </header>
    <div class="cuerpo">
      <nav class="menu">${menu.map(([id, ic, t]) => `<a href="#${id}" class="${id === v ? 'activo' : ''}">${ic} ${t}</a>`).join('')}</nav>
      <main id="main"></main>
    </div>`;
  $('#salir').onclick = async () => { await llamar('POST', '/api/salir').catch(() => {}); S.datos = null; pantallaEntrada(); };
  VISTAS[v]($('#main'), p);
}

// ---------- Entrada y configuración ----------
function pantallaEntrada(msg) {
  $('#app').innerHTML = `
    <div class="entrada"><form class="tarjeta" id="fEntrar">
      <h1>📘 Registro Escolar</h1>
      <p class="suave">${esc(S.nombreCentro || '')}</p>
      ${msg ? `<div class="aviso ambar">${esc(msg)}</div>` : ''}
      <label>Usuario<input name="usuario" autocomplete="username" required autofocus autocapitalize="none"></label>
      <label>Clave<input name="clave" type="password" autocomplete="current-password" required></label>
      <button class="prim" style="width:100%;justify-content:center">Entrar</button>
      <p class="suave peq">¿Olvidaste la clave? Pídele a la dirección del centro que te ponga una nueva.</p>
    </form></div>`;
  $('#fEntrar').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await intentar(async () => {
      await llamar('POST', '/api/entrar', { usuario: f.get('usuario'), clave: f.get('clave') });
      await recargar();
      if (yo().cambiarClave) { ir('cuenta', { primera: 1 }); }
    });
  };
}
function pantallaConfigurar() {
  $('#app').innerHTML = `
    <div class="entrada"><div class="tarjeta" style="width:min(480px,100%)">
      <h1>📘 Bienvenido al Registro Escolar</h1>
      <p>Primero crea la cuenta de la <b>dirección</b> del centro. Con ella vas a registrar los cursos, los docentes y los estudiantes.</p>
      <label>Código de instalación<input id="codigo" inputmode="numeric" required placeholder="Lo muestra la ventana negra del servidor"></label>
      <form id="fConf">
        <label>Nombre del centro educativo<input name="centro" required></label>
        <label>Tu nombre<input name="nombre" required placeholder="Ej.: Lic. Juana Pérez"></label>
        <div class="dos">
          <label>Usuario<input name="usuario" required autocapitalize="none" pattern="[a-zA-Z0-9._\\-]{3,40}"></label>
          <label>Clave (6 o más)<input name="clave" type="password" required minlength="6"></label>
        </div>
        <button class="prim">Crear y empezar</button>
      </form>
      <hr style="margin:20px 0;border:0;border-top:1px solid var(--borde2)">
      <p class="suave peq">¿Solo quieres verlo funcionar? Carga un centro de ejemplo con cursos, docentes, estudiantes y notas (nombres inventados).</p>
      <button id="ejemplo">Probar con datos de ejemplo</button>
    </div></div>`;
  $('#fConf').onsubmit = async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    f.codigo = $('#codigo').value;
    await intentar(async () => {
      await llamar('POST', '/api/configurar', f);
      await llamar('POST', '/api/entrar', { usuario: f.usuario, clave: f.clave });
      await recargar(); ir('centro');
    });
  };
  $('#ejemplo').onclick = () => intentar(async () => {
    await llamar('POST', '/api/configurar', { ejemplo: true, codigo: $('#codigo').value });
    S.nombreCentro = 'Centro Educativo Ejemplo';
    pantallaEntrada('Datos de ejemplo cargados. Entra como dirección: usuario «direccion», clave «direccion123». Docentes: «lperez» / «docente123». Familia: «familia» / «familia123».');
  });
}

// ---------- Ventana modal ----------
function modal(titulo, cuerpo, alGuardar, { textoBoton = 'Guardar', ancho } = {}) {
  const d = $('#modal'), f = $('#modalForm');
  d.style.width = ancho || '';
  f.innerHTML = `<h3>${titulo}</h3>${cuerpo}<div class="pie">${alGuardar ? `<button class="prim" value="ok">${textoBoton}</button>` : ''}<button value="cancelar" formnovalidate>Cancelar</button></div>`;
  f.onsubmit = async ev => {
    if (ev.submitter && ev.submitter.value === 'cancelar') return;
    ev.preventDefault();
    if (!alGuardar) return d.close();
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try { await alGuardar(new FormData(f), f); d.close(); } catch (e) { aviso(e.message, true); } finally { if (btn) btn.disabled = false; }
  };
  d.showModal();
  return f;
}
const opciones = (lista, sel) => lista.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('');
const opcionesDocentes = sel => opciones([['', '— Sin asignar —'], ...S.datos.usuarios.filter(u => u.rol !== 'familia' && u.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map(u => [u.id, u.nombre])], sel);
const opcionesCursos = (sel, lista = cursosOrdenados()) => opciones(lista.map(c => [c.id, nombreCurso(c)]), sel);

// =====================================================================
// INICIO
// =====================================================================
function vInicio(main) {
  const d = S.datos, c = d.centro, pa = periodoActual();
  const estadoPer = c.periodos.map((p, i) => `<tr><td><b>${esc(p.nombre)}</b></td><td>${fechaBonita(p.desde)} – ${fechaBonita(p.hasta)}</td>
      <td>${c.cerrados[i] ? '<span class="etq R">🔒 Cerrado</span>' : '<span class="etq A">Abierto</span>'} ${i === pa ? '<span class="etq curso">Actual</span>' : ''}</td>
      ${esAdmin() ? `<td class="der"><button class="mini" data-cerrar="${i}">${c.cerrados[i] ? 'Abrir' : 'Cerrar'}</button></td>` : ''}</tr>`).join('')
    + `<tr><td><b>Cierre del año</b></td><td class="suave">Completiva, extraordinaria y especial</td><td>${c.cerrados[4] ? '<span class="etq R">🔒 Cerrado</span>' : '<span class="etq A">Abierto</span>'}</td>
      ${esAdmin() ? `<td class="der"><button class="mini" data-cerrar="4">${c.cerrados[4] ? 'Abrir' : 'Cerrar'}</button></td>` : ''}</tr>`;
  const cargas = misCargas();
  let riesgo = 0;
  for (const k of cargas) {
    const m = modeloDe(k); if (m === 'cualitativo') continue;
    for (const e of estudiantesDe(k.cursoId)) if (Calc.area(reg(k.id, e.id), m, c).riesgo) riesgo++;
  }
  const filasAvance = cargas.map(k => ({ k, a: avance(k, pa) })).sort((x, y) => x.a - y.a);
  const datosAdmin = esAdmin() ? `
    <div class="dato"><b>${d.estudiantes.filter(e => e.activo !== false).length}</b><span>Estudiantes inscritos</span></div>
    <div class="dato"><b>${d.cursos.length}</b><span>Cursos / secciones</span></div>
    <div class="dato"><b>${d.usuarios.filter(u => u.rol === 'docente').length}</b><span>Docentes</span></div>
    <div class="dato"><b>${d.cargas.filter(k => !k.docenteId).length}</b><span>Asignaturas sin docente</span></div>` : `
    <div class="dato"><b>${cargas.length}</b><span>Mis asignaturas</span></div>
    <div class="dato"><b>${new Set(cargas.map(k => k.cursoId)).size}</b><span>Mis cursos</span></div>`;
  main.innerHTML = `
    <div class="encabezado"><h2>Hola, ${esc(yo().nombre)}</h2><span class="suave">${new Date().toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
    <div class="tarjetas">${datosAdmin}
      <div class="dato"><b>${esc(c.periodos[pa].nombre)}</b><span>Período actual</span></div>
      <div class="dato"><b style="color:${riesgo ? 'var(--rojo)' : 'var(--verde)'}">${riesgo}</b><span>Notas de área por debajo de ${c.notaMinima}</span></div>
    </div>
    <div class="tarjeta"><h3>Períodos de calificación</h3>
      <p class="suave peq">Cuando la dirección cierra un período, los docentes ya no pueden cambiar esas notas.</p>
      <div class="tabla-caja"><table>${estadoPer}</table></div></div>
    <div class="tarjeta"><h3>Avance de notas del ${esc(c.periodos[pa].nombre)}</h3>
      ${filasAvance.length ? `<div class="tabla-caja"><table><tr><th>Curso</th><th>Asignatura</th>${esAdmin() ? '<th>Docente</th>' : ''}<th>Notas puestas</th><th></th></tr>
      ${filasAvance.map(({ k, a }) => `<tr><td>${esc(nombreCurso(d.cMap[k.cursoId]))}</td><td>${esc(k.asignatura)}</td>${esAdmin() ? `<td>${esc(nombreUsuario(k.docenteId))}</td>` : ''}
        <td><div style="background:var(--borde2);border-radius:99px;height:8px;width:120px;display:inline-block;vertical-align:middle"><div style="background:${a === 100 ? 'var(--verde)' : 'var(--azul2)'};height:8px;border-radius:99px;width:${a * 1.2}px"></div></div> ${a}%</td>
        <td class="der"><a href="#calificaciones?carga=${k.id}&p=${pa}">Abrir</a></td></tr>`).join('')}</table></div>`
        : `<p class="suave">${esAdmin() ? 'Todavía no hay asignaturas. Ve a <a href="#cursos">Cursos y asignaturas</a>.' : 'La dirección todavía no te ha asignado asignaturas.'}</p>`}
    </div>`;
  $$('[data-cerrar]', main).forEach(b => b.onclick = () => intentar(async () => {
    const i = +b.dataset.cerrar, cer = c.cerrados.slice(); cer[i] = !cer[i];
    if (cer[i] && !confirm(`¿Cerrar ${i < 4 ? c.periodos[i].nombre : 'el cierre del año'}? Los docentes ya no podrán cambiar esas notas.`)) return;
    await llamar('PUT', '/api/centro', Object.assign({}, c, { cerrados: cer }));
    await recargar();
  }));
}

// =====================================================================
// CALIFICACIONES
// =====================================================================
function vCalificaciones(main, p) {
  const cargas = misCargas();
  if (!cargas.length) { main.innerHTML = `<h2>Calificaciones</h2><p class="suave">${esAdmin() ? 'No hay asignaturas creadas. Ve a <a href="#cursos">Cursos y asignaturas</a>.' : 'La dirección todavía no te ha asignado asignaturas.'}</p>`; return; }
  const pedida = S.datos.kMap[p.carga || S.ultimaCarga];
  const carga = pedida && cargas.includes(pedida) ? pedida : cargas[0];
  S.ultimaCarga = carga.id;
  const curso = S.datos.cMap[carga.cursoId], modelo = curso.modelo, c = S.datos.centro;
  const tab = p.p ?? String(periodoActual());
  const porCurso = {};
  for (const k of cargas) (porCurso[k.cursoId] ||= []).push(k);
  const selector = Object.entries(porCurso).map(([cid, ks]) => `<optgroup label="${esc(nombreCurso(S.datos.cMap[cid]))}">${ks.map(k => `<option value="${k.id}" ${k === carga ? 'selected' : ''}>${esc(k.asignatura)} — ${esc(nombreCurso(S.datos.cMap[cid]))}</option>`).join('')}</optgroup>`).join('');
  const tabs = [...c.periodos.map((x, i) => [String(i), `${x.nombre}${c.cerrados[i] ? ' <span class="candado">🔒</span>' : ''}`]), ['f', `Calificación final${c.cerrados[4] ? ' <span class="candado">🔒</span>' : ''}`], ['r', 'Registro completo']];
  main.innerHTML = `
    <div class="encabezado no-imprimir"><h2>Calificaciones</h2>
      <div class="grupo-botones"><button id="imprimir">🖨️ Imprimir</button></div></div>
    <div class="tarjeta no-imprimir">
      <div class="fila"><label class="crece">Asignatura y curso<select id="selCarga">${selector}</select></label></div>
      <div class="suave peq">Docente: <b>${esc(nombreUsuario(carga.docenteId))}</b> · Titular: ${esc(nombreUsuario(curso.titularId))} · Tanda ${esc(curso.tanda)} · ${MODELO[modelo]} · ${estudiantesDe(curso.id).length} estudiantes</div>
    </div>
    <div class="pestanas">${tabs.map(([id, t]) => `<button data-tab="${id}" class="${id === tab ? 'activo' : ''}">${t}</button>`).join('')}</div>
    <div id="hoja"></div>`;
  $('#selCarga').onchange = e => ir('calificaciones', { carga: e.target.value, p: tab });
  $$('[data-tab]', main).forEach(b => b.onclick = () => ir('calificaciones', { carga: carga.id, p: b.dataset.tab }));
  $('#imprimir').onclick = () => window.print();
  const hoja = $('#hoja');
  if (tab === 'f') hojaFinal(hoja, carga, curso);
  else if (tab === 'r') hojaRegistro(hoja, carga, curso);
  else hojaPeriodo(hoja, carga, curso, +tab);
}
const puedeEditar = (carga, per) => esAdmin() || (carga.docenteId === yo().id && !(per >= 0 && S.datos.centro.cerrados[per]));
const cabeceraImpresion = (carga, curso, titulo) => `<div style="display:none" class="solo-imprimir"></div>
  <p class="suave peq" style="margin:0 0 8px"><b>${esc(S.datos.centro.nombre)}</b> · ${esc(titulo)} · ${esc(carga.asignatura)} · ${esc(nombreCurso(curso))} · Docente: ${esc(nombreUsuario(carga.docenteId))} · Año escolar ${esc(S.datos.centro.anoEscolar)}</p>`;
const claseNota = v => v != null && v !== '' && Number(v) < S.datos.centro.notaMinima ? 'bajo' : '';
const celdaNum = (v, extra = '') => `<td class="calc ${claseNota(v)} ${extra}">${v ?? '—'}</td>`;

function hojaPeriodo(hoja, carga, curso, per) {
  const modelo = curso.modelo, c = S.datos.centro, ests = estudiantesDe(curso.id);
  const editable = puedeEditar(carga, per);
  const nb = modelo === 'periodos' ? 1 : 4;
  let cab1 = '<tr><th rowspan="2">#</th><th rowspan="2" class="nom">Estudiante</th>', cab2 = '<tr>';
  for (let b = 0; b < nb; b++) {
    const t = modelo === 'periodos' ? 'Nota del período' : `C${b + 1}`;
    if (modelo === 'cualitativo') { cab1 += `<th class="comp" title="${esc(c.competencias[b])}">C${b + 1}</th>`; cab2 += `<th class="peq">${esc(c.competencias[b].split(/[;,]/)[0])}</th>`; }
    else { cab1 += `<th class="comp" colspan="2" title="${esc(modelo === 'periodos' ? '' : c.competencias[b])}">${t}</th>`; cab2 += `<th>${esc(c.periodos[per].nombre)}</th><th title="Recuperación pedagógica">RP</th>`; }
  }
  if (modelo !== 'cualitativo') { cab1 += '<th rowspan="2">Prom.<br>período</th><th rowspan="2">Prom.<br>acumulado</th>'; }
  cab1 += '</tr>'; cab2 += '</tr>';
  const filas = ests.map((e, i) => {
    const r = reg(carga.id, e.id) || {};
    let tds = '';
    for (let b = 0; b < nb; b++) {
      if (modelo === 'cualitativo') {
        tds += `<td><select data-e="${e.id}" data-campo="q${b}${per}" ${editable ? '' : 'disabled'}>${opciones([['', '—'], ['L', 'L'], ['EP', 'EP'], ['I', 'I']], r[`q${b}${per}`])}</select></td>`;
      } else {
        const v = r[`c${b}${per}`], rp = r[`r${b}${per}`];
        tds += `<td><input inputmode="numeric" maxlength="3" data-e="${e.id}" data-campo="c${b}${per}" value="${v ?? ''}" class="${claseNota(v)}" ${editable ? '' : 'disabled'}></td>
                <td><input inputmode="numeric" maxlength="3" class="rp ${claseNota(rp)}" data-e="${e.id}" data-campo="r${b}${per}" value="${rp ?? ''}" ${editable ? '' : 'disabled'} title="Recuperación pedagógica"></td>`;
      }
    }
    if (modelo !== 'cualitativo') {
      const pp = Calc.promedioPeriodo(r, modelo, per), cf = Calc.area(r, modelo, c).cf;
      tds += `<td class="calc ${claseNota(pp)}" data-pp="${e.id}">${pp ?? '—'}</td><td class="calc ${claseNota(cf)}" data-acum="${e.id}">${cf ?? '—'}</td>`;
    }
    return `<tr><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>${tds}</tr>`;
  }).join('');
  hoja.innerHTML = `${cabeceraImpresion(carga, curso, `Calificaciones ${c.periodos[per].nombre}`)}
    ${!editable ? `<div class="aviso ambar no-imprimir">${c.cerrados[per] ? `🔒 El ${esc(c.periodos[per].nombre)} está cerrado por la dirección. Solo la dirección puede corregir estas notas.` : 'Solo el docente de esta asignatura puede poner las notas.'}</div>`
      : `<p class="suave peq no-imprimir">${modelo !== 'cualitativo' ? `Escribe la nota (0 a 100) y pasa a la siguiente con <b>Enter</b> o las flechas. Se guarda sola. <b>RP</b> = recuperación pedagógica: si la pones, cuenta la nota más alta. Puedes copiar una columna de Excel y pegarla en la primera casilla.` : 'Elige el nivel de logro de cada competencia; se guarda solo. <b>L</b> = Logrado, <b>EP</b> = En proceso, <b>I</b> = Iniciado.'}</p>`}
    ${ests.length ? `<div class="tabla-caja"><table class="notas">${cab1}${cab2}${filas}</table></div>` : '<p class="suave">Este curso no tiene estudiantes inscritos.</p>'}
    ${modelo === 'competencias' ? `<p class="suave peq">${c.competencias.map((x, i) => `<b>C${i + 1}</b>: ${esc(x)}`).join(' · ')}</p>` : ''}`;
  activarCeldas(hoja, carga, () => {
    for (const e of ests) {
      const r = reg(carga.id, e.id) || {};
      const td = $(`[data-pp="${e.id}"]`, hoja); if (!td) continue;
      const pp = Calc.promedioPeriodo(r, modelo, per), cf = Calc.area(r, modelo, c).cf;
      td.textContent = pp ?? '—'; td.className = 'calc ' + claseNota(pp);
      const ta = $(`[data-acum="${e.id}"]`, hoja); ta.textContent = cf ?? '—'; ta.className = 'calc ' + claseNota(cf);
    }
  });
}

function hojaFinal(hoja, carga, curso) {
  const modelo = curso.modelo, c = S.datos.centro, ests = estudiantesDe(curso.id);
  if (modelo === 'cualitativo') return hojaRegistro(hoja, carga, curso, true);
  const editable = puedeEditar(carga, 4);
  const nb = Calc.bloques(modelo), pC = c.pesoCompletiva, pE = c.pesoExtraordinaria;
  const filas = ests.map((e, i) => `<tr data-fila="${e.id}"><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>${celdasFinal(carga, e, nb, editable)}</tr>`).join('');
  hoja.innerHTML = `${cabeceraImpresion(carga, curso, 'Calificación final')}
    <p class="suave peq no-imprimir">C.F. = promedio de las competencias. Si es menor de <b>${c.notaMinima}</b>, el estudiante va a <b>completiva</b> (C.F.C. = ${pC}% C.F. + ${100 - pC}% C.C.F.);
      si no la aprueba, a <b>extraordinaria</b> (C.F.E. = ${pE}% C.F. + ${100 - pE}% C.Ex.); y si tampoco, a <b>evaluación especial</b>. ${!editable && c.cerrados[4] ? '🔒 El cierre del año está cerrado por la dirección.' : ''}</p>
    ${ests.length ? `<div class="tabla-caja"><table class="notas">
      <tr><th rowspan="2">#</th><th rowspan="2" class="nom">Estudiante</th>${nb > 1 ? `<th class="comp" colspan="${nb}">Promedio de competencias</th>` : ''}<th rowspan="2">C.F.</th>
        <th class="comp" colspan="2">Completiva</th><th class="comp" colspan="2">Extraordinaria</th><th rowspan="2">Eval.<br>especial</th><th rowspan="2">Calif.<br>final</th><th rowspan="2">Condición</th><th rowspan="2" class="no-imprimir">Observación</th></tr>
      <tr>${nb > 1 ? [...Array(nb).keys()].map(b => `<th title="${esc(c.competencias[b])}">PC${b + 1}</th>`).join('') : ''}<th>C.C.F.</th><th>C.F.C.</th><th>C.Ex.</th><th>C.F.E.</th></tr>
      ${filas}</table></div>` : '<p class="suave">Este curso no tiene estudiantes inscritos.</p>'}`;
  activarCeldas(hoja, carga, campoEst => {
    const e = S.datos.eMap[campoEst], tr = $(`[data-fila="${campoEst}"]`, hoja);
    if (!tr) return;
    // Solo se redibujan las celdas calculadas para no borrar lo que se esté escribiendo.
    const nuevo = document.createElement('tbody'); nuevo.innerHTML = `<tr>${celdasFinal(carga, e, nb, editable)}</tr>`;
    $$('td[data-c]', tr).forEach(td => { const n = $(`td[data-c="${td.dataset.c}"]`, nuevo); td.className = n.className; td.innerHTML = n.innerHTML; });
    $$('input[data-campo]', tr).forEach(inp => { const n = $(`input[data-campo="${inp.dataset.campo}"]`, nuevo); if (n) inp.disabled = n.disabled; });
  }, true);
}
function celdasFinal(carga, e, nb, editable) {
  const r = reg(carga.id, e.id) || {}, a = Calc.area(r, modeloDe(carga), S.datos.centro);
  const inp = (campo, v, activo) => `<td><input inputmode="numeric" maxlength="3" data-e="${e.id}" data-campo="${campo}" value="${v ?? ''}" class="${claseNota(v)}" ${editable && (activo || v != null) ? '' : 'disabled'}></td>`;
  const cal = (k, v) => `<td data-c="${k}" class="calc ${claseNota(v)}">${v ?? '—'}</td>`;
  const min = S.datos.centro.notaMinima;
  let h = nb > 1 ? a.pc.map((v, i) => `<td data-c="pc${i}" class="calc ${claseNota(v)}" style="${a.pcCompleto[i] ? '' : 'font-style:italic;opacity:.7'}">${v ?? '—'}</td>`).join('') : '';
  h += `<td data-c="cf" class="calc ${claseNota(a.cf)}" style="${a.completo ? '' : 'font-style:italic;opacity:.7'}" title="${a.completo ? '' : 'Faltan notas: promedio parcial'}">${a.cf ?? '—'}</td>`;
  h += inp('ccf', r.ccf, a.completo && a.cf < min) + cal('cfc', a.cfc);
  h += inp('cex', r.cex, a.cfc != null && a.cfc < min) + cal('cfe', a.cfe);
  h += inp('ce', r.ce, a.cfe != null && a.cfe < min);
  h += cal('fin', a.final);
  h += `<td data-c="cond">${a.condicion ? `<span class="etq ${a.condicion}">${a.condicion === 'P' ? a.texto : a.condicion === 'A' ? 'A' : 'R'}</span>` : `<span class="suave peq">${a.texto}</span>`}</td>`;
  h += `<td class="no-imprimir"><input data-e="${e.id}" data-campo="obs" value="${esc(r.obs || '')}" style="width:180px;text-align:left" placeholder="Opcional" ${puedeEditar(carga, -1) ? '' : 'disabled'}></td>`;
  return h;
}

function hojaRegistro(hoja, carga, curso, soloCuali) {
  const modelo = curso.modelo, c = S.datos.centro, ests = estudiantesDe(curso.id);
  const nb = Calc.bloques(modelo);
  let cab1 = '<tr><th rowspan="2">#</th><th rowspan="2" class="nom">Estudiante</th>', cab2 = '<tr>';
  for (let b = 0; b < nb; b++) {
    const t = modelo === 'periodos' ? 'Períodos' : `C${b + 1}`;
    if (modelo === 'cualitativo') { cab1 += `<th class="comp" colspan="4" title="${esc(c.competencias[b])}">C${b + 1}</th>`; cab2 += c.periodos.map(x => `<th>${esc(x.nombre)}</th>`).join(''); }
    else { cab1 += `<th class="comp" colspan="9" title="${esc(c.competencias[b])}">${t}</th>`; cab2 += c.periodos.map((x, i) => `<th>${esc(x.nombre)}</th><th>RP${i + 1}</th>`).join('') + `<th>PC${nb > 1 ? b + 1 : ''}</th>`; }
  }
  if (modelo !== 'cualitativo') cab1 += '<th rowspan="2">C.F.</th><th rowspan="2">Final</th><th rowspan="2">Cond.</th>';
  cab1 += '</tr>'; cab2 += '</tr>';
  const filas = ests.map((e, i) => {
    const r = reg(carga.id, e.id) || {}, a = Calc.area(r, modelo, c);
    let tds = '';
    for (let b = 0; b < nb; b++) {
      if (modelo === 'cualitativo') tds += [0, 1, 2, 3].map(p => `<td>${r[`q${b}${p}`] || ''}</td>`).join('');
      else tds += [0, 1, 2, 3].map(p => `<td class="${claseNota(r[`c${b}${p}`])}">${r[`c${b}${p}`] ?? ''}</td><td class="${claseNota(r[`r${b}${p}`])}">${r[`r${b}${p}`] ?? ''}</td>`).join('') + celdaNum(a.pc[b]);
    }
    if (modelo !== 'cualitativo') tds += celdaNum(a.cf) + celdaNum(a.final) + `<td>${a.condicion === 'A' || a.condicion === 'R' ? `<span class="etq ${a.condicion}">${a.condicion}</span>` : ''}</td>`;
    return `<tr><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>${tds}</tr>`;
  }).join('');
  hoja.innerHTML = `${cabeceraImpresion(carga, curso, soloCuali ? 'Resumen del año' : 'Registro de calificaciones')}
    ${soloCuali ? '<p class="suave peq">En el modelo cualitativo no hay nota final numérica. L = Logrado, EP = En proceso, I = Iniciado.</p>' : ''}
    <div class="tabla-caja"><table class="notas">${cab1}${cab2}${filas}</table></div>`;
}

// Guardado de celdas, navegación con teclado y pegado desde Excel.
function activarCeldas(hoja, carga, alCambiar, final = false) {
  const columna = el => $$(`[data-campo="${el.dataset.campo}"]`, hoja);
  async function guardar(el) {
    let v = el.value.trim();
    if (el.dataset.campo !== 'obs' && el.tagName === 'INPUT' && v !== '') {
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 100) { el.classList.add('error'); aviso('La nota debe ser un número de 0 a 100', true); return; }
      v = String(Math.round(n)); el.value = v;
    }
    const r = reg(carga.id, el.dataset.e) || {};
    if (String(r[el.dataset.campo] ?? '') === v) { el.classList.remove('error'); return; }
    el.classList.remove('ok', 'error'); el.classList.add('guardando');
    try {
      const res = await llamar('PUT', '/api/nota', { cargaId: carga.id, estudianteId: el.dataset.e, campo: el.dataset.campo, valor: v });
      const k = `${carga.id}|${el.dataset.e}`;
      const nr = S.datos.notas[k] || (S.datos.notas[k] = {});
      if (res.valor === null) delete nr[el.dataset.campo]; else nr[el.dataset.campo] = res.valor;
      el.classList.remove('guardando'); el.classList.add('ok');
      if (el.tagName === 'INPUT' && el.dataset.campo !== 'obs') { el.classList.toggle('bajo', !!claseNota(res.valor)); }
      setTimeout(() => el.classList.remove('ok'), 900);
      alCambiar(el.dataset.e);
    } catch (e) {
      el.classList.remove('guardando'); el.classList.add('error');
      aviso(e.message, true);
    }
  }
  $$('[data-campo]', hoja).forEach(el => {
    el.addEventListener('change', () => guardar(el));
    el.addEventListener('focus', () => el.select && el.select());
    el.addEventListener('keydown', ev => {
      if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(ev.key) || el.tagName === 'SELECT' && ev.key !== 'Enter') return;
      const col = columna(el), i = col.indexOf(el);
      const sig = col[ev.key === 'ArrowUp' ? i - 1 : i + 1];
      ev.preventDefault();
      if (sig) sig.focus(); else el.blur();
    });
    if (el.tagName === 'INPUT' && el.dataset.campo !== 'obs') el.addEventListener('paste', ev => {
      const t = (ev.clipboardData || window.clipboardData).getData('text');
      if (!/[\n\t]/.test(t.trim())) return;
      ev.preventDefault();
      const filas = t.replace(/\r/g, '').split('\n').filter((x, j, arr) => x !== '' || j < arr.length - 1);
      const col = columna(el), i0 = col.indexOf(el);
      // Si pegan varias columnas, se reparten hacia la derecha dentro de la misma fila.
      filas.forEach((f, j) => {
        const fila = col[i0 + j]?.closest('tr'); if (!fila) return;
        const ins = $$('input[data-campo]:not([disabled])', fila).filter(x => x.dataset.campo !== 'obs');
        const k0 = ins.indexOf(fila.querySelector(`[data-campo="${el.dataset.campo}"]`));
        f.split('\t').forEach((v, m) => { const x = ins[k0 + m]; if (x) { x.value = v.trim(); guardar(x); } });
      });
    });
  });
}

// =====================================================================
// ASISTENCIA
// =====================================================================
function vAsistencia(main, p) {
  const d = S.datos;
  if (yo().rol === 'familia') return asistenciaFamilia(main);
  const cursos = cursosVisibles();
  if (!cursos.length) { main.innerHTML = '<h2>Asistencia</h2><p class="suave">No tienes cursos asignados.</p>'; return; }
  const curso = d.cMap[p.curso] || cursos[0];
  const modo = p.modo || 'dia';
  main.innerHTML = `
    <div class="encabezado"><h2>Asistencia</h2><button id="imprimir" class="no-imprimir">🖨️ Imprimir</button></div>
    <div class="tarjeta no-imprimir"><div class="fila">
      <label class="crece">Curso<select id="selCurso">${opcionesCursos(curso.id, cursos)}</select></label>
      ${modo === 'dia' ? `<label>Fecha<input type="date" id="fecha" value="${esc(p.fecha || hoy())}"></label>` : ''}
    </div></div>
    <div class="pestanas"><button data-modo="dia" class="${modo === 'dia' ? 'activo' : ''}">Pasar lista</button><button data-modo="resumen" class="${modo === 'resumen' ? 'activo' : ''}">Resumen por período</button></div>
    <div id="hoja"></div>`;
  $('#imprimir').onclick = () => window.print();
  $('#selCurso').onchange = e => ir('asistencia', { curso: e.target.value, modo, fecha: p.fecha });
  $$('[data-modo]', main).forEach(b => b.onclick = () => ir('asistencia', { curso: curso.id, modo: b.dataset.modo, fecha: p.fecha }));
  if (modo === 'dia') {
    $('#fecha').onchange = e => ir('asistencia', { curso: curso.id, modo, fecha: e.target.value });
    pasarLista($('#hoja'), curso, p.fecha || hoy());
  } else resumenAsistencia($('#hoja'), curso);
}
function pasarLista(hoja, curso, fecha) {
  const ests = estudiantesDe(curso.id);
  const k = `${curso.id}|${fecha}`, dia = S.datos.asistencia[k];
  const marcas = Object.fromEntries(ests.map(e => [e.id, (dia && dia[e.id]) || 'P']));
  const finde = [0, 6].includes(new Date(fecha + 'T12:00').getDay());
  const pintar = () => {
    const cuenta = { P: 0, A: 0, T: 0, E: 0 }; Object.values(marcas).forEach(m => cuenta[m]++);
    hoja.innerHTML = `
      ${dia ? `<div class="aviso verde">✔ La lista de este día ya se pasó. Puedes corregirla y guardar de nuevo.</div>` : `<div class="aviso ${finde ? 'ambar' : ''}">${finde ? 'Este día es fin de semana. ' : ''}Todavía no se ha pasado lista este día. Todos aparecen presentes: marca solo a los que faltaron o llegaron tarde.</div>`}
      <div class="tabla-caja"><table>
        <tr><th>#</th><th>Estudiante</th><th>Asistencia</th></tr>
        ${ests.map((e, i) => `<tr><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>
          <td><span class="marcas">${['P', 'A', 'T', 'E'].map(m => `<button title="${MARCA[m]}" data-e="${e.id}" data-m="${m}" class="${m} ${marcas[e.id] === m ? 'sel' : ''}">${m}</button>`).join('')}</span></td></tr>`).join('')}
      </table></div>
      <p class="suave peq">P = Presente · A = Ausente · T = Tardanza · E = Excusa &nbsp;—&nbsp; Hoy: ${cuenta.P} presentes, ${cuenta.A} ausentes, ${cuenta.T} tardanzas, ${cuenta.E} excusas.</p>
      <div class="grupo-botones no-imprimir"><button class="prim" id="guardarLista">Guardar asistencia</button><button id="todosP">Todos presentes</button>${dia ? '<button id="borrarDia" class="peligro">Borrar este día</button>' : ''}</div>`;
    $$('[data-m]', hoja).forEach(b => b.onclick = () => { marcas[b.dataset.e] = b.dataset.m; pintar(); });
    $('#todosP').onclick = () => { for (const id in marcas) marcas[id] = 'P'; pintar(); };
    $('#guardarLista').onclick = () => intentar(async () => {
      await llamar('PUT', '/api/asistencia', { cursoId: curso.id, fecha, marcas });
      const nuevo = { _: 1 }; for (const [id, m] of Object.entries(marcas)) if (m !== 'P') nuevo[id] = m;
      S.datos.asistencia[k] = nuevo; aviso('Asistencia guardada'); pasarLista(hoja, curso, fecha);
    });
    if (dia) $('#borrarDia').onclick = () => confirm('¿Borrar la asistencia de este día?') && intentar(async () => {
      await llamar('PUT', '/api/asistencia', { cursoId: curso.id, fecha, borrar: true });
      delete S.datos.asistencia[k]; pasarLista(hoja, curso, fecha);
    });
  };
  pintar();
}
function resumenAsistencia(hoja, curso, ests = estudiantesDe(curso.id)) {
  const c = S.datos.centro;
  const filas = ests.map((e, i) => {
    const r = Calc.asistencia(S.datos.asistencia, curso.id, e.id, c.periodos);
    const pct = v => v == null ? '<td class="num suave">—</td>' : `<td class="num ${v < c.asistenciaMinima ? 'bajo' : ''}">${v}%</td>`;
    return `<tr><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>${r.per.map(x => pct(x.pct)).join('')}
      <td class="num">${r.total.dias}</td><td class="num">${r.total.A}</td><td class="num">${r.total.T}</td><td class="num">${r.total.E}</td>${pct(r.total.pct)}</tr>`;
  }).join('');
  hoja.innerHTML = `<p class="suave peq">Porcentaje = días presente (incluye tardanzas) entre días de clase registrados. En rojo, por debajo de ${c.asistenciaMinima}%.</p>
    <div class="tabla-caja"><table><tr><th>#</th><th>Estudiante</th>${c.periodos.map(x => `<th class="num">${esc(x.nombre)}</th>`).join('')}<th class="num">Días</th><th class="num">Ausencias</th><th class="num">Tardanzas</th><th class="num">Excusas</th><th class="num">Total</th></tr>${filas}</table></div>`;
}
function asistenciaFamilia(main) {
  const ests = S.datos.estudiantes;
  main.innerHTML = '<h2>Asistencia</h2>' + ests.map(e => `<div class="tarjeta"><h3>${esc(nombreEst(e))} — ${esc(nombreCurso(S.datos.cMap[e.cursoId]))}</h3><div data-r="${e.id}"></div></div>`).join('');
  for (const e of ests) {
    const box = $(`[data-r="${e.id}"]`, main);
    resumenAsistencia(box, S.datos.cMap[e.cursoId], [e]);
    const faltas = Object.entries(S.datos.asistencia).filter(([k, d]) => k.startsWith(e.cursoId + '|') && d[e.id]).map(([k, d]) => [k.split('|')[1], d[e.id]]).sort().reverse();
    box.insertAdjacentHTML('beforeend', faltas.length ? `<h3 style="margin-top:14px">Días que no estuvo presente</h3><ul>${faltas.map(([f, m]) => `<li>${fechaBonita(f)} — ${MARCA[m]}</li>`).join('')}</ul>` : '<p class="suave">Sin ausencias ni tardanzas registradas.</p>');
  }
}

// =====================================================================
// BOLETINES
// =====================================================================
function vBoletines(main, p) {
  const d = S.datos;
  let cursos, ests;
  if (yo().rol === 'familia') {
    ests = d.estudiantes;
    main.innerHTML = `<div class="encabezado no-imprimir"><h2>Boletín de calificaciones</h2><button id="imprimir">🖨️ Imprimir o guardar PDF</button></div>
      ${ests.length ? '' : '<p class="suave">Tu cuenta todavía no tiene estudiantes vinculados. Pídeselo a la dirección del centro.</p>'}<div id="hoja"></div>`;
  } else {
    cursos = cursosTitular();
    if (!cursos.length) { main.innerHTML = '<h2>Boletines</h2><p class="suave">Los boletines los imprime el <b>titular</b> del curso o la dirección. No eres titular de ningún curso.</p>'; return; }
    const curso = d.cMap[p.curso] && cursos.includes(d.cMap[p.curso]) ? d.cMap[p.curso] : cursos[0];
    const lista = estudiantesDe(curso.id);
    ests = p.est && p.est !== 'todos' ? lista.filter(e => e.id === p.est) : lista;
    main.innerHTML = `<div class="encabezado no-imprimir"><h2>Boletines</h2><button id="imprimir">🖨️ Imprimir ${ests.length > 1 ? `los ${ests.length} boletines` : 'boletín'}</button></div>
      <div class="tarjeta no-imprimir"><div class="fila">
        <label class="crece">Curso<select id="selCurso">${opcionesCursos(curso.id, cursos)}</select></label>
        <label class="crece">Estudiante<select id="selEst">${opciones([['todos', `Todos (${lista.length})`], ...lista.map((e, i) => [e.id, `${i + 1}. ${nombreEst(e)}`])], p.est || 'todos')}</select></label>
      </div><p class="suave peq" style="margin:0">Al imprimir, cada boletín sale en una hoja horizontal. Para guardar en PDF elige «Guardar como PDF» en la impresora.</p></div>
      <div id="hoja"></div>`;
    $('#selCurso').onchange = e => ir('boletines', { curso: e.target.value });
    $('#selEst').onchange = e => ir('boletines', { curso: curso.id, est: e.target.value });
  }
  $('#imprimir').onclick = () => window.print();
  $('#hoja').innerHTML = ests.map(boletin).join('');
}
function boletin(e) {
  const d = S.datos, c = d.centro, curso = d.cMap[e.cursoId], modelo = curso.modelo, cargas = cargasDe(curso.id);
  const nb = Calc.bloques(modelo);
  const res = cargas.map(k => ({ k, r: reg(k.id, e.id) || {}, a: Calc.area(reg(k.id, e.id), modelo, c) }));
  let tabla;
  if (modelo === 'cualitativo') {
    tabla = `<table><tr><th rowspan="2">Área</th>${[0, 1, 2, 3].map(b => `<th colspan="4" title="${esc(c.competencias[b])}">C${b + 1}</th>`).join('')}</tr>
      <tr>${[0, 1, 2, 3].map(() => c.periodos.map(x => `<th>${esc(x.nombre)}</th>`).join('')).join('')}</tr>
      ${res.map(({ k, r }) => `<tr><td class="asig">${esc(k.asignatura)}</td>${[0, 1, 2, 3].map(b => [0, 1, 2, 3].map(p => `<td>${r[`q${b}${p}`] || ''}</td>`).join('')).join('')}</tr>`).join('')}</table>`;
  } else {
    const comps = [...Array(nb).keys()];
    tabla = `<table><tr><th rowspan="2">Asignatura</th>${comps.map(b => `<th colspan="9" title="${esc(c.competencias[b])}">${nb > 1 ? `C${b + 1}` : 'Períodos'}</th>`).join('')}
        <th rowspan="2">C.F.</th><th colspan="2">Completiva</th><th colspan="2">Extraordinaria</th><th rowspan="2">C.E.</th><th rowspan="2">Calif.<br>final</th><th rowspan="2">Cond.</th></tr>
      <tr>${comps.map(b => c.periodos.map((x, i) => `<th>${esc(x.nombre)}</th><th>RP${i + 1}</th>`).join('') + `<th>PC${nb > 1 ? b + 1 : ''}</th>`).join('')}<th>C.C.F.</th><th>C.F.C.</th><th>C.Ex.</th><th>C.F.E.</th></tr>
      ${res.map(({ k, r, a }) => `<tr><td class="asig">${esc(k.asignatura)}</td>
        ${comps.map(b => [0, 1, 2, 3].map(p => `<td class="${claseNota(r[`c${b}${p}`])}">${r[`c${b}${p}`] ?? ''}</td><td class="${claseNota(r[`r${b}${p}`])}">${r[`r${b}${p}`] ?? ''}</td>`).join('') + `<td class="calc ${claseNota(a.pc[b])}">${a.pcCompleto[b] ? a.pc[b] : ''}</td>`).join('')}
        <td class="calc ${claseNota(a.cf)}">${a.completo ? a.cf : ''}</td><td>${r.ccf ?? ''}</td><td>${a.cfc ?? ''}</td><td>${r.cex ?? ''}</td><td>${a.cfe ?? ''}</td><td>${r.ce ?? ''}</td>
        <td class="calc ${claseNota(a.final)}">${a.final ?? ''}</td><td>${a.condicion === 'A' || a.condicion === 'R' ? a.condicion : ''}</td></tr>`).join('')}</table>`;
  }
  const asis = Calc.asistencia(d.asistencia, curso.id, e.id, c.periodos);
  const filaAsis = (t, x) => `<tr><td class="asig">${esc(t)}</td><td>${x.dias || ''}</td><td>${x.dias ? x.P + x.T : ''}</td><td>${x.dias ? x.A : ''}</td><td>${x.dias ? x.T : ''}</td><td>${x.dias ? x.E : ''}</td><td>${x.pct != null ? x.pct + '%' : ''}</td></tr>`;
  let situacion = '';
  if (modelo !== 'cualitativo') {
    const rep = res.filter(x => x.a.condicion === 'R').map(x => x.k.asignatura), pend = res.filter(x => x.a.condicion === 'P').map(x => `${x.k.asignatura} (${x.a.instancia.toLowerCase()})`);
    const completo = res.length && res.every(x => x.a.completo);
    situacion = !completo ? 'Año escolar en curso.' : rep.length ? `<b>Reprobado(a)</b> en: ${esc(rep.join(', '))}.` : pend.length ? `Pendiente: ${esc(pend.join(', '))}.` : `<b>Promovido(a)</b>.`;
    const notasF = res.filter(x => x.a.final != null).map(x => x.a.final);
    if (notasF.length) situacion += ` &nbsp; Promedio general: <b>${Calc.redondo(Calc.prom(notasF))}</b>.`;
  }
  const obs = res.filter(x => x.r.obs).map(x => `<b>${esc(x.k.asignatura)}:</b> ${esc(x.r.obs)}`);
  const leyenda = modelo === 'cualitativo'
    ? 'L = Logrado · EP = En proceso · I = Iniciado.'
    : `RP = Recuperación pedagógica · PC = Promedio de la competencia · C.F. = Calificación final · C.C.F. = Calificación completiva · C.F.C. = Calificación final completiva (${c.pesoCompletiva}% C.F. + ${100 - c.pesoCompletiva}% C.C.F.) · C.Ex. = Calificación extraordinaria · C.F.E. = Calificación final extraordinaria (${c.pesoExtraordinaria}% C.F. + ${100 - c.pesoExtraordinaria}% C.Ex.) · C.E. = Evaluación especial · A = Aprobado · R = Reprobado. Nota mínima de aprobación: ${c.notaMinima}.`;
  return `<div class="boletin">
    <div class="cab">República Dominicana<b>${esc(c.nombre)}</b>
      ${[c.codigo && `Código ${esc(c.codigo)}`, c.regional && `Regional ${esc(c.regional)}`, c.distrito && `Distrito ${esc(c.distrito)}`].filter(Boolean).join(' · ')}<br>
      <b style="font-size:13px;margin-top:4px">INFORME DE CALIFICACIONES — AÑO ESCOLAR ${esc(c.anoEscolar)}</b></div>
    <div class="datos"><span>Estudiante: <b>${esc(e.apellidos)}, ${esc(e.nombres)}</b></span><span>Grado: <b>${curso.grado}.º ${esc(curso.seccion)}</b></span>
      <span>Nivel: <b>${NIVEL[curso.nivel]}</b></span><span>Tanda: <b>${esc(curso.tanda)}</b></span>
      <span>N.º de orden: <b>${e.nOrden || ''}</b></span><span>ID: <b>${esc(e.idMinerd || '')}</b></span>
      <span>Titular: <b>${esc(nombreUsuario(curso.titularId))}</b></span><span>Fecha: <b>${fechaBonita(hoy())}</b></span></div>
    <div class="bol-tabla">${tabla}</div>
    ${modelo === 'competencias' ? `<div class="leyenda">${c.competencias.map((x, i) => `<b>C${i + 1}</b> = ${esc(x)}`).join(' · ')}</div>` : ''}
    <div class="leyenda">${leyenda}</div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px;align-items:flex-start">
      <div class="bol-tabla"><table style="width:auto"><tr><th>Asistencia</th><th>Días</th><th>Presente</th><th>Ausencias</th><th>Tardanzas</th><th>Excusas</th><th>%</th></tr>
        ${asis.per.map((x, i) => filaAsis(c.periodos[i].nombre, x)).join('')}${filaAsis('Total', asis.total)}</table></div>
      <div style="flex:1;min-width:200px">${situacion ? `<p style="margin:0 0 6px">Situación: ${situacion}</p>` : ''}
        <p style="margin:0">Observaciones: ${obs.length ? obs.join(' · ') : '<span style="display:inline-block;border-bottom:1px solid #94a3b8;width:70%">&nbsp;</span>'}</p></div>
    </div>
    <div class="firmas"><div>Maestro(a) titular</div><div>${esc(c.director || 'Director(a)')}<br><small>Director(a)</small></div><div>Padre, madre o tutor</div></div>
  </div>`;
}

// =====================================================================
// REPORTES
// =====================================================================
function vReportes(main, p) {
  const d = S.datos, c = d.centro;
  const cursos = cursosTitular();
  const tab = p.tab || 'cuadro';
  const tabs = [['cuadro', 'Cuadro de calificaciones'], ['riesgo', 'Estudiantes en riesgo'], ...(esAdmin() ? [['cursos', 'Resumen por curso'], ['asistencia', 'Asistencia baja']] : [])];
  main.innerHTML = `<div class="encabezado"><h2>Reportes</h2><div class="grupo-botones no-imprimir"><button id="csv">⬇️ Descargar Excel (CSV)</button><button id="imprimir">🖨️ Imprimir</button></div></div>
    <div class="pestanas">${tabs.map(([id, t]) => `<button data-tab="${id}" class="${id === tab ? 'activo' : ''}">${t}</button>`).join('')}</div><div id="hoja"></div>`;
  $$('[data-tab]', main).forEach(b => b.onclick = () => ir('reportes', { tab: b.dataset.tab, curso: p.curso }));
  $('#imprimir').onclick = () => window.print();
  const hoja = $('#hoja');
  let tablaCSV = () => $('table', hoja);
  if (!cursos.length && tab !== 'riesgo') { hoja.innerHTML = '<p class="suave">Los reportes por curso son para el titular del curso o la dirección.</p>'; $('#csv').disabled = true; return; }

  if (tab === 'cuadro') {
    const curso = d.cMap[p.curso] && cursos.includes(d.cMap[p.curso]) ? d.cMap[p.curso] : (cursos.find(x => x.modelo !== 'cualitativo') || cursos[0]);
    const per = p.per ?? 'f';
    const cargas = cargasDe(curso.id), ests = estudiantesDe(curso.id);
    hoja.innerHTML = `<div class="tarjeta no-imprimir"><div class="fila">
        <label class="crece">Curso<select id="selCurso">${opcionesCursos(curso.id, cursos)}</select></label>
        <label>Mostrar<select id="selPer">${opciones([...c.periodos.map((x, i) => [i, `Promedio del ${x.nombre}`]), ['f', 'Calificación final (o acumulada)']], per)}</select></label></div></div>
      <p class="suave peq"><b>${esc(c.nombre)}</b> · ${esc(nombreCurso(curso))} · Titular: ${esc(nombreUsuario(curso.titularId))} · ${per === 'f' ? 'Calificación final; en cursiva, promedio acumulado si faltan notas' : 'Promedio del ' + esc(c.periodos[per].nombre)}</p>
      ${curso.modelo === 'cualitativo' ? '<p class="suave">Este curso usa el modelo cualitativo (L / EP / I); no tiene promedios numéricos. Usa el boletín.</p>' : `
      <div class="tabla-caja"><table class="notas"><tr><th>#</th><th class="nom">Estudiante</th>${cargas.map(k => `<th title="${esc(k.asignatura)}">${esc(abreviar(k.asignatura))}</th>`).join('')}<th>Promedio</th><th>Bajo ${c.notaMinima}</th></tr>
      ${ests.map((e, i) => {
        const vals = cargas.map(k => {
          const r = reg(k.id, e.id);
          if (per !== 'f') return { v: Calc.promedioPeriodo(r, curso.modelo, +per), parcial: false };
          const a = Calc.area(r, curso.modelo, c);
          return { v: a.final ?? a.cf, parcial: !a.completo };
        });
        const nums = vals.map(x => x.v).filter(x => x != null), pr = nums.length ? Calc.redondo(Calc.prom(nums)) : null;
        const bajos = nums.filter(x => x < c.notaMinima).length;
        return `<tr><td class="n">${i + 1}</td><td class="nom">${esc(nombreEst(e))}</td>${vals.map(x => `<td class="${claseNota(x.v)}" style="${x.parcial ? 'font-style:italic;opacity:.75' : ''}">${x.v ?? ''}</td>`).join('')}
          <td class="calc ${claseNota(pr)}">${pr ?? ''}</td><td class="${bajos ? 'bajo' : 'suave'}">${bajos || ''}</td></tr>`;
      }).join('')}
      <tr><td></td><td class="nom"><b>Promedio del curso</b></td>${cargas.map(k => {
        const v = ests.map(e => { const r = reg(k.id, e.id); if (per !== 'f') return Calc.promedioPeriodo(r, curso.modelo, +per); const a = Calc.area(r, curso.modelo, c); return a.final ?? a.cf; }).filter(x => x != null);
        const pr = v.length ? Calc.redondo(Calc.prom(v)) : null; return `<td class="calc ${claseNota(pr)}">${pr ?? ''}</td>`;
      }).join('')}<td></td><td></td></tr></table></div>`}`;
    $('#selCurso').onchange = e => ir('reportes', { tab, curso: e.target.value, per });
    $('#selPer').onchange = e => ir('reportes', { tab, curso: curso.id, per: e.target.value });
  }

  if (tab === 'riesgo') {
    const lista = [];
    const cargas = esAdmin() ? d.cargas : d.cargas.filter(k => k.docenteId === yo().id || d.cMap[k.cursoId].titularId === yo().id);
    for (const k of cargas) {
      const curso = d.cMap[k.cursoId]; if (curso.modelo === 'cualitativo') continue;
      for (const e of estudiantesDe(curso.id)) {
        const a = Calc.area(reg(k.id, e.id), curso.modelo, c);
        if (a.riesgo) lista.push({ e, k, curso, a });
      }
    }
    lista.sort((x, y) => ordenCursos(x.curso, y.curso) || nombreEst(x.e).localeCompare(nombreEst(y.e), 'es'));
    hoja.innerHTML = `<p class="suave peq">Estudiantes con promedio por debajo de ${c.notaMinima} en alguna asignatura, o que van a completiva, extraordinaria o evaluación especial.</p>
      ${lista.length ? `<div class="tabla-caja"><table><tr><th>Curso</th><th>Estudiante</th><th>Asignatura</th><th>Docente</th><th class="num">Promedio</th><th>Situación</th><th>Tutor</th><th>Teléfono</th></tr>
      ${lista.map(({ e, k, curso, a }) => `<tr><td>${esc(nombreCurso(curso))}</td><td class="nom">${esc(nombreEst(e))}</td><td>${esc(k.asignatura)}</td><td>${esc(nombreUsuario(k.docenteId))}</td>
        <td class="num bajo">${a.final ?? a.cf}</td><td><span class="etq ${a.condicion || 'P'}">${esc(a.texto)}</span></td><td>${esc(e.tutor || '')}</td><td>${esc(e.telefono || '')}</td></tr>`).join('')}</table></div>`
        : '<div class="aviso verde">No hay estudiantes en riesgo. 🎉</div>'}`;
  }

  if (tab === 'cursos') {
    hoja.innerHTML = `<div class="tabla-caja"><table><tr><th>Curso</th><th>Titular</th><th class="num">Estudiantes</th><th class="num">Promedio general</th><th class="num">Áreas aprobadas</th><th class="num">En riesgo / pendientes</th><th class="num">Reprobadas</th><th class="num">Asistencia</th></tr>
      ${cursosOrdenados().map(curso => {
        const ests = estudiantesDe(curso.id), cargas = cargasDe(curso.id);
        const vals = [], estado = { A: 0, P: 0, R: 0 }; let riesgo = 0;
        if (curso.modelo !== 'cualitativo') for (const k of cargas) for (const e of ests) {
          const a = Calc.area(reg(k.id, e.id), curso.modelo, c);
          const v = a.final ?? a.cf; if (v != null) vals.push(v);
          if (a.condicion) estado[a.condicion]++; else if (a.riesgo) riesgo++;
        }
        const asis = ests.map(e => Calc.asistencia(d.asistencia, curso.id, e.id, c.periodos).total).filter(t => t.dias);
        const pa = asis.length ? Calc.redondo(Calc.prom(asis.map(t => t.pct))) : null;
        const pr = vals.length ? Calc.redondo(Calc.prom(vals)) : null;
        return `<tr><td><a href="#reportes?tab=cuadro&curso=${curso.id}">${esc(nombreCurso(curso))}</a> <span class="suave peq">${esc(curso.tanda)}</span></td><td>${esc(nombreUsuario(curso.titularId))}</td><td class="num">${ests.length}</td>
          <td class="num calc ${claseNota(pr)}">${pr ?? '—'}</td><td class="num">${estado.A}</td><td class="num">${estado.P + riesgo}</td><td class="num ${estado.R ? 'bajo' : ''}">${estado.R}</td><td class="num">${pa != null ? pa + '%' : '—'}</td></tr>`;
      }).join('')}</table></div>`;
  }

  if (tab === 'asistencia') {
    const filas = [];
    for (const curso of cursosOrdenados()) for (const e of estudiantesDe(curso.id)) {
      const t = Calc.asistencia(d.asistencia, curso.id, e.id, c.periodos).total;
      if (t.dias && t.pct < c.asistenciaMinima) filas.push({ curso, e, t });
    }
    hoja.innerHTML = `<p class="suave peq">Estudiantes con asistencia por debajo de ${c.asistenciaMinima}% en lo que va de año.</p>
      ${filas.length ? `<div class="tabla-caja"><table><tr><th>Curso</th><th>Estudiante</th><th class="num">Días</th><th class="num">Ausencias</th><th class="num">Tardanzas</th><th class="num">Excusas</th><th class="num">%</th><th>Tutor</th><th>Teléfono</th></tr>
      ${filas.map(({ curso, e, t }) => `<tr><td>${esc(nombreCurso(curso))}</td><td class="nom">${esc(nombreEst(e))}</td><td class="num">${t.dias}</td><td class="num">${t.A}</td><td class="num">${t.T}</td><td class="num">${t.E}</td><td class="num bajo">${t.pct}%</td><td>${esc(e.tutor || '')}</td><td>${esc(e.telefono || '')}</td></tr>`).join('')}</table></div>`
        : '<div class="aviso verde">Ningún estudiante está por debajo del mínimo de asistencia.</div>'}`;
  }

  $('#csv').onclick = () => {
    const t = tablaCSV(); if (!t) return aviso('No hay tabla para descargar', true);
    descargarCSV(t, `reporte-${tab}.csv`);
  };
}
function abreviar(a) {
  const fijo = { 'Lengua Española': 'Lengua', 'Matemática': 'Mat.', 'Ciencias Sociales': 'Sociales', 'Ciencias de la Naturaleza': 'Naturales', 'Educación Artística': 'Artística',
    'Educación Física': 'Ed. Física', 'Formación Integral Humana y Religiosa': 'FIHR', 'Lenguas Extranjeras (Inglés)': 'Inglés', 'Lenguas Extranjeras (Francés)': 'Francés' };
  return fijo[a] || (a.length > 12 ? a.slice(0, 11) + '.' : a);
}
function descargarCSV(tabla, nombre) {
  const filas = $$('tr', tabla).map(tr => $$('th,td', tr).filter(x => !x.classList.contains('no-imprimir')).map(td => {
    const span = +td.getAttribute('colspan') || 1;
    const v = `"${(td.querySelector('input,select')?.value ?? td.textContent).trim().replace(/\s+/g, ' ').replace(/"/g, '""')}"`;
    return [v, ...Array(span - 1).fill('""')].join(';');
  }).join(';'));
  const blob = new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// =====================================================================
// ESTUDIANTES (dirección)
// =====================================================================
function vEstudiantes(main, p) {
  const d = S.datos;
  const filtroCurso = p.curso || '';
  const q = (p.q || '').toLowerCase();
  const lista = d.estudiantes.filter(e => (!filtroCurso || e.cursoId === filtroCurso) && (p.inactivos || e.activo !== false)
    && (!q || `${e.nombres} ${e.apellidos} ${e.idMinerd} ${e.tutor}`.toLowerCase().includes(q)))
    .sort((a, b) => ordenCursos(d.cMap[a.cursoId], d.cMap[b.cursoId]) || a.apellidos.localeCompare(b.apellidos, 'es') || a.nombres.localeCompare(b.nombres, 'es'));
  main.innerHTML = `<div class="encabezado"><h2>Estudiantes</h2><div class="grupo-botones no-imprimir">
      <button class="prim" id="nuevo">➕ Inscribir estudiante</button><button id="importar">📋 Pegar lista</button><button id="csv">⬇️ CSV</button></div></div>
    <div class="tarjeta no-imprimir"><div class="fila">
      <label class="crece">Curso<select id="fCurso">${opciones([['', 'Todos los cursos'], ...cursosOrdenados().map(c => [c.id, nombreCurso(c)])], filtroCurso)}</select></label>
      <label class="crece">Buscar<input id="fQ" value="${esc(p.q || '')}" placeholder="Nombre, ID o tutor"></label>
      <label class="chk"><input type="checkbox" id="fIn" ${p.inactivos ? 'checked' : ''}> Ver retirados</label></div></div>
    ${d.cursos.length ? '' : '<div class="aviso ambar">Primero crea los cursos en <a href="#cursos">Cursos y asignaturas</a>.</div>'}
    <p class="suave peq">${lista.length} estudiante(s)</p>
    <div class="tabla-caja"><table><tr><th>#</th><th>Apellidos</th><th>Nombres</th><th>Curso</th><th>Sexo</th><th>Nacimiento</th><th>ID</th><th>Tutor</th><th>Teléfono</th><th class="no-imprimir"></th></tr>
    ${lista.map((e, i) => `<tr style="${e.activo === false ? 'opacity:.5' : ''}"><td class="n">${i + 1}</td><td>${esc(e.apellidos)}</td><td>${esc(e.nombres)}</td><td>${esc(nombreCurso(d.cMap[e.cursoId]))}</td>
      <td>${esc(e.sexo)}</td><td>${fechaBonita(e.fechaNac)}</td><td>${esc(e.idMinerd)}</td><td>${esc(e.tutor)}</td><td>${esc(e.telefono)}</td>
      <td class="der no-imprimir" style="white-space:nowrap"><button class="mini" data-ed="${e.id}">Editar</button> <button class="mini" data-fam="${e.id}" title="Crear usuario para la familia">👪</button></td></tr>`).join('')}</table></div>`;
  const filtrar = () => ir('estudiantes', { curso: $('#fCurso').value, q: $('#fQ').value, inactivos: $('#fIn').checked ? 1 : '' });
  $('#fCurso').onchange = filtrar; $('#fIn').onchange = filtrar;
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(() => { filtrar(); setTimeout(() => { const i = $('#fQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 400); };
  $('#nuevo').onclick = () => formEstudiante(null, filtroCurso);
  $('#importar').onclick = () => importarEstudiantes(filtroCurso);
  $('#csv').onclick = () => descargarCSV($('table', main), 'estudiantes.csv');
  $$('[data-ed]', main).forEach(b => b.onclick = () => formEstudiante(d.eMap[b.dataset.ed]));
  $$('[data-fam]', main).forEach(b => b.onclick = () => formUsuario(null, { rol: 'familia', estudianteIds: [b.dataset.fam], nombre: `Familia de ${d.eMap[b.dataset.fam].nombres} ${d.eMap[b.dataset.fam].apellidos}` }));
}
function formEstudiante(e, cursoDef) {
  const x = e || { cursoId: cursoDef };
  const f = modal(e ? 'Editar estudiante' : 'Inscribir estudiante', `
    <div class="dos"><label>Nombres<input name="nombres" required value="${esc(x.nombres)}"></label><label>Apellidos<input name="apellidos" required value="${esc(x.apellidos)}"></label></div>
    <label>Curso<select name="cursoId" required>${opcionesCursos(x.cursoId)}</select></label>
    <div class="dos"><label>Sexo<select name="sexo">${opciones([['', '—'], ['F', 'Femenino'], ['M', 'Masculino']], x.sexo)}</select></label>
      <label>Fecha de nacimiento<input type="date" name="fechaNac" value="${esc(x.fechaNac)}"></label></div>
    <div class="dos"><label>ID del estudiante (SIGERD / cédula)<input name="idMinerd" value="${esc(x.idMinerd)}"></label><label>Teléfono del tutor<input name="telefono" value="${esc(x.telefono)}"></label></div>
    <label>Padre, madre o tutor<input name="tutor" value="${esc(x.tutor)}"></label>
    ${e ? `<label class="chk"><input type="checkbox" name="activo" ${e.activo !== false ? 'checked' : ''}> Estudiante activo (desmarca si se retiró del centro)</label>
      <p class="suave peq">Si lo cambias de curso, sus notas pasan a las mismas asignaturas del curso nuevo.</p>
      <button type="button" class="peligro mini" id="borrarEst">Borrar estudiante y todas sus notas</button>` : ''}`, async fd => {
    const b = Object.fromEntries(fd); b.activo = e ? fd.get('activo') === 'on' : true;
    await llamar(e ? 'PUT' : 'POST', `/api/estudiantes${e ? '/' + e.id : ''}`, b);
    aviso(e ? 'Estudiante actualizado' : 'Estudiante inscrito'); await recargar();
  });
  if (e) $('#borrarEst', f).onclick = () => confirm(`¿Borrar a ${nombreEst(e)}? Se borran también sus notas y asistencia. Si solo se retiró, mejor desmarca «activo».`) && intentar(async () => {
    await llamar('DELETE', `/api/estudiantes/${e.id}`); $('#modal').close(); aviso('Estudiante borrado'); await recargar();
  });
}
function importarEstudiantes(cursoDef) {
  const f = modal('Pegar lista de estudiantes', `
    <label>Curso<select name="cursoId" required>${opcionesCursos(cursoDef)}</select></label>
    <label>Lista (un estudiante por línea)<textarea name="lista" rows="10" placeholder="Pérez Rodríguez, Juan Carlos&#10;García Santana, María"></textarea></label>
    <p class="suave peq">Escribe <b>Apellidos, Nombres</b> en cada línea. También puedes copiar desde Excel con estas columnas en orden:
      <b>Apellidos · Nombres · Sexo (F/M) · Fecha de nacimiento · ID · Tutor · Teléfono</b> (solo las dos primeras son obligatorias).</p>
    <p id="vista" class="suave peq"></p>`, async fd => {
    const ests = leerLista(fd.get('lista'));
    if (!ests.length) throw new Error('No se encontró ningún estudiante en la lista');
    const r = await llamar('POST', '/api/estudiantes-lote', { cursoId: fd.get('cursoId'), estudiantes: ests });
    aviso(`${r.n} estudiantes inscritos`); await recargar();
  }, { textoBoton: 'Inscribir', ancho: 'min(700px, calc(100vw - 24px))' });
  $('textarea', f).oninput = ev => { const n = leerLista(ev.target.value); $('#vista', f).textContent = n.length ? `${n.length} estudiante(s). Primero: ${n[0].apellidos}, ${n[0].nombres}` : ''; };
}
function leerLista(txt) {
  return String(txt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    let col = l.includes('\t') ? l.split('\t') : l.split(/\s*[,;]\s*/);
    col = col.map(x => x.trim());
    const fecha = v => { if (!v) return ''; let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
    const sx = (col[2] || '').toUpperCase()[0];
    return { apellidos: col[0] || '', nombres: col[1] || '', sexo: sx === 'F' || sx === 'M' ? sx : '', fechaNac: fecha(col[3]), idMinerd: col[4] || '', tutor: col[5] || '', telefono: col[6] || '' };
  }).filter(e => e.apellidos && e.nombres && !/^apellido/i.test(e.apellidos));
}

// =====================================================================
// CURSOS Y ASIGNATURAS (dirección)
// =====================================================================
function vCursos(main) {
  const d = S.datos;
  main.innerHTML = `<div class="encabezado"><h2>Cursos y asignaturas</h2><button class="prim" id="nuevo">➕ Nuevo curso</button></div>
    <p class="suave peq">Cada curso (grado y sección) tiene su titular y sus asignaturas. A cada asignatura se le asigna el docente que pone las notas.</p>
    ${d.cursos.length ? '' : '<div class="aviso">Empieza creando los cursos del centro, por ejemplo «1.º A Secundaria».</div>'}
    ${cursosOrdenados().map(c => `<div class="tarjeta">
      <div class="encabezado"><div><h3 style="margin:0">${esc(nombreCurso(c))}</h3>
        <span class="suave peq">Tanda ${esc(c.tanda)} · ${MODELO[c.modelo]} · Titular: <b>${esc(nombreUsuario(c.titularId))}</b> · ${estudiantesDe(c.id).length} estudiantes</span></div>
        <div class="grupo-botones"><button class="mini" data-ed="${c.id}">Editar</button><button class="mini peligro" data-del="${c.id}">Borrar</button></div></div>
      <div class="tabla-caja"><table><tr><th>Asignatura</th><th>Docente</th><th class="num">Orden</th><th></th></tr>
        ${cargasDe(c.id).map(k => `<tr><td>${esc(k.asignatura)}</td><td><select data-doc="${k.id}" style="max-width:260px">${opcionesDocentes(k.docenteId)}</select></td>
          <td class="num"><input data-orden="${k.id}" value="${k.orden ?? ''}" style="width:56px;text-align:center" inputmode="numeric"></td>
          <td class="der"><button class="mini" data-ren="${k.id}">Renombrar</button> <button class="mini peligro" data-delk="${k.id}">Quitar</button></td></tr>`).join('')}
      </table></div>
      <div class="fila" style="margin-top:10px">
        <input placeholder="Nueva asignatura (ej.: Informática)" data-nueva="${c.id}" class="crece" style="max-width:340px">
        <button class="mini" data-agregar="${c.id}">Agregar</button>
        ${cargasDe(c.id).length < 3 ? `<button class="mini" data-plan="${c.id}">Poner las asignaturas del plan de estudios</button>` : ''}
      </div></div>`).join('')}`;
  $('#nuevo').onclick = () => formCurso();
  $$('[data-ed]', main).forEach(b => b.onclick = () => formCurso(d.cMap[b.dataset.ed]));
  $$('[data-del]', main).forEach(b => b.onclick = () => confirm('¿Borrar este curso con todas sus asignaturas, notas y asistencia?') && intentar(async () => { await llamar('DELETE', `/api/cursos/${b.dataset.del}`); await recargar(); }));
  $$('[data-doc]', main).forEach(s => s.onchange = () => intentar(async () => { await llamar('PUT', `/api/cargas/${s.dataset.doc}`, { docenteId: s.value || null }); d.kMap[s.dataset.doc].docenteId = s.value || null; aviso('Docente asignado'); }));
  $$('[data-orden]', main).forEach(s => s.onchange = () => intentar(async () => { await llamar('PUT', `/api/cargas/${s.dataset.orden}`, { orden: +s.value || 0 }); await recargar(); }));
  $$('[data-ren]', main).forEach(b => b.onclick = () => { const k = d.kMap[b.dataset.ren]; const n = prompt('Nuevo nombre de la asignatura', k.asignatura); if (n && n.trim()) intentar(async () => { await llamar('PUT', `/api/cargas/${k.id}`, { asignatura: n.trim() }); await recargar(); }); });
  $$('[data-delk]', main).forEach(b => b.onclick = () => confirm('¿Quitar esta asignatura del curso? Se borran sus notas.') && intentar(async () => { await llamar('DELETE', `/api/cargas/${b.dataset.delk}`); await recargar(); }));
  const agregar = id => { const inp = $(`[data-nueva="${id}"]`, main); if (!inp.value.trim()) return; intentar(async () => { await llamar('POST', '/api/cargas', { cursoId: id, asignatura: inp.value.trim(), orden: cargasDe(id).length }); await recargar(); }); };
  $$('[data-agregar]', main).forEach(b => b.onclick = () => agregar(b.dataset.agregar));
  $$('[data-nueva]', main).forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') agregar(i.dataset.nueva); });
  $$('[data-plan]', main).forEach(b => b.onclick = () => intentar(async () => { const r = await llamar('POST', '/api/cargas-por-defecto', { cursoId: b.dataset.plan }); aviso(`${r.n} asignaturas agregadas`); await recargar(); }));
}
function formCurso(c) {
  const x = c || { nivel: 'secundaria', grado: 1, seccion: 'A', tanda: 'Matutina', modelo: 'competencias' };
  const f = modal(c ? 'Editar curso' : 'Nuevo curso', `
    <div class="dos"><label>Nivel<select name="nivel">${opciones(Object.entries(NIVEL), x.nivel)}</select></label>
      <label>Grado<select name="grado">${opciones([1, 2, 3, 4, 5, 6].map(g => [g, `${g}.º`]), x.grado)}</select></label></div>
    <div class="dos"><label>Sección<input name="seccion" value="${esc(x.seccion)}" maxlength="10" required></label>
      <label>Tanda<select name="tanda">${opciones(['Matutina', 'Vespertina', 'Nocturna', 'Jornada Escolar Extendida', 'Sabatina'].map(t => [t, t]), x.tanda)}</select></label></div>
    <label>Forma de calificar<select name="modelo">${opciones(Object.entries(MODELO), x.modelo)}</select></label>
    <p class="suave peq">Por competencias: cada asignatura con C1–C4 en cada período (secundaria y 2.º ciclo de primaria). Cualitativo: Logrado / En proceso / Iniciado (1.er ciclo de primaria e inicial).</p>
    <label>Maestro(a) titular<select name="titularId">${opcionesDocentes(x.titularId)}</select></label>
    ${c ? '' : '<label class="chk"><input type="checkbox" name="plan" checked> Agregar las asignaturas del plan de estudios</label>'}`, async fd => {
    const b = Object.fromEntries(fd);
    const r = await llamar(c ? 'PUT' : 'POST', `/api/cursos${c ? '/' + c.id : ''}`, b);
    if (!c && b.plan) await llamar('POST', '/api/cargas-por-defecto', { cursoId: r.id });
    await recargar();
  });
  const nivel = $('[name=nivel]', f), grado = $('[name=grado]', f), modelo = $('[name=modelo]', f);
  if (!c) { const sug = () => { modelo.value = nivel.value === 'inicial' || (nivel.value === 'primaria' && +grado.value <= 3) ? 'cualitativo' : 'competencias'; }; nivel.onchange = sug; grado.onchange = sug; }
}

// =====================================================================
// USUARIOS (dirección)
// =====================================================================
function vUsuarios(main, p) {
  const d = S.datos, rol = p.rol || '';
  const lista = d.usuarios.filter(u => !rol || u.rol === rol).sort((a, b) => a.rol.localeCompare(b.rol) || a.nombre.localeCompare(b.nombre, 'es'));
  main.innerHTML = `<div class="encabezado"><h2>Usuarios</h2><button class="prim" id="nuevo">➕ Nuevo usuario</button></div>
    <p class="suave peq"><b>Dirección</b>: maneja todo. <b>Docente</b>: pone notas en sus asignaturas, pasa lista en sus cursos e imprime boletines si es titular. <b>Familia</b>: ve el boletín y la asistencia de sus hijos.</p>
    <div class="pestanas">${[['', 'Todos'], ['admin', 'Dirección'], ['docente', 'Docentes'], ['familia', 'Familias']].map(([r, t]) => `<button data-rol="${r}" class="${r === rol ? 'activo' : ''}">${t} (${r ? d.usuarios.filter(u => u.rol === r).length : d.usuarios.length})</button>`).join('')}</div>
    <div class="tabla-caja"><table><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Asignaturas / estudiantes</th><th>Estado</th><th></th></tr>
    ${lista.map(u => `<tr style="${u.activo ? '' : 'opacity:.5'}"><td>${esc(u.nombre)}</td><td><code>${esc(u.usuario)}</code></td><td>${ROL[u.rol]}</td>
      <td class="peq">${u.rol === 'familia' ? u.estudianteIds.map(id => esc(nombreEst(d.eMap[id]))).join('; ') : u.rol === 'docente' ? `${d.cargas.filter(k => k.docenteId === u.id).length} asignatura(s)${d.cursos.some(c => c.titularId === u.id) ? ' · titular de ' + d.cursos.filter(c => c.titularId === u.id).map(c => esc(nombreCurso(c))).join(', ') : ''}` : ''}</td>
      <td>${u.activo ? (u.cambiarClave ? '<span class="etq P">Debe cambiar la clave</span>' : '<span class="etq A">Activo</span>') : '<span class="etq gris">Desactivado</span>'}</td>
      <td class="der"><button class="mini" data-ed="${u.id}">Editar</button></td></tr>`).join('')}</table></div>`;
  $$('[data-rol]', main).forEach(b => b.onclick = () => ir('usuarios', { rol: b.dataset.rol }));
  $('#nuevo').onclick = () => formUsuario(null, { rol: rol || 'docente' });
  $$('[data-ed]', main).forEach(b => b.onclick = () => formUsuario(d.uMap[b.dataset.ed]));
}
function formUsuario(u, def = {}) {
  const x = u || def;
  const sugerida = () => Math.random().toString(36).slice(2, 6) + Math.floor(1000 + Math.random() * 9000);
  const opcionesEst = cursosOrdenados().map(c => `<optgroup label="${esc(nombreCurso(c))}">${estudiantesDe(c.id).map(e => `<option value="${e.id}" ${(x.estudianteIds || []).includes(e.id) ? 'selected' : ''}>${esc(nombreEst(e))}</option>`).join('')}</optgroup>`).join('');
  const f = modal(u ? 'Editar usuario' : 'Nuevo usuario', `
    <label>Nombre completo<input name="nombre" required value="${esc(x.nombre)}"></label>
    <div class="dos"><label>Usuario (para entrar)<input name="usuario" ${u ? 'disabled' : 'required'} value="${esc(x.usuario || '')}" autocapitalize="none" pattern="[a-zA-Z0-9._\\-]{3,40}"></label>
      <label>Rol<select name="rol">${opciones(Object.entries(ROL), x.rol)}</select></label></div>
    <label>${u ? 'Clave nueva (déjala vacía para no cambiarla)' : 'Clave inicial'}<input name="clave" ${u ? '' : 'required'} minlength="6" value="${u ? '' : sugerida()}"></label>
    <p class="suave peq">Anota la clave y entrégasela a la persona. La primera vez que entre se le pedirá cambiarla.</p>
    <label data-est>Estudiantes de esta familia (Ctrl o ⌘ para elegir varios)<select name="est" multiple size="8">${opcionesEst}</select></label>
    ${u ? `<label class="chk"><input type="checkbox" name="activo" ${u.activo ? 'checked' : ''}> Usuario activo (puede entrar)</label>
      <button type="button" class="mini peligro" id="borrarU">Borrar usuario</button>` : ''}`, async fd => {
    const b = { nombre: fd.get('nombre'), rol: fd.get('rol'), estudianteIds: fd.getAll('est') };
    if (!u) b.usuario = fd.get('usuario');
    if (fd.get('clave')) b.clave = fd.get('clave');
    if (u) b.activo = fd.get('activo') === 'on';
    await llamar(u ? 'PUT' : 'POST', `/api/usuarios${u ? '/' + u.id : ''}`, b);
    aviso(u ? 'Usuario actualizado' : `Usuario creado. Clave: ${b.clave}`); await recargar();
  });
  const rolSel = $('[name=rol]', f), est = $('[data-est]', f);
  const ver = () => { est.hidden = rolSel.value !== 'familia'; };
  rolSel.onchange = ver; ver();
  if (u) $('#borrarU', f).onclick = () => confirm(`¿Borrar el usuario ${u.nombre}? Sus asignaturas quedarán sin docente.`) && intentar(async () => {
    await llamar('DELETE', `/api/usuarios/${u.id}`); $('#modal').close(); await recargar();
  });
}

// =====================================================================
// CENTRO EDUCATIVO (dirección)
// =====================================================================
function vCentro(main) {
  const c = S.datos.centro;
  main.innerHTML = `<h2>Centro educativo</h2>
    <form id="fCentro">
    <div class="tarjeta"><h3>Datos del centro</h3>
      <label>Nombre<input name="nombre" value="${esc(c.nombre)}" required></label>
      <div class="dos"><label>Código del centro<input name="codigo" value="${esc(c.codigo)}"></label><label>Sector<select name="sector">${opciones(['Público', 'Privado', 'Semioficial'].map(x => [x, x]), c.sector)}</select></label></div>
      <div class="dos"><label>Regional<input name="regional" value="${esc(c.regional)}"></label><label>Distrito educativo<input name="distrito" value="${esc(c.distrito)}"></label></div>
      <div class="dos"><label>Director(a)<input name="director" value="${esc(c.director)}"></label><label>Teléfono<input name="telefono" value="${esc(c.telefono)}"></label></div>
      <label>Dirección<input name="direccion" value="${esc(c.direccion)}"></label>
      <label>Año escolar<input name="anoEscolar" value="${esc(c.anoEscolar)}" required></label>
    </div>
    <div class="tarjeta"><h3>Períodos de calificación</h3>
      <div class="tabla-caja"><table><tr><th>Período</th><th>Desde</th><th>Hasta</th><th>Cerrado</th></tr>
      ${c.periodos.map((p, i) => `<tr><td><input name="pn${i}" value="${esc(p.nombre)}" style="width:80px"></td><td><input type="date" name="pd${i}" value="${esc(p.desde)}"></td><td><input type="date" name="ph${i}" value="${esc(p.hasta)}"></td>
        <td class="centro"><input type="checkbox" name="pc${i}" ${c.cerrados[i] ? 'checked' : ''}></td></tr>`).join('')}
      <tr><td colspan="3">Cierre del año (completiva, extraordinaria, especial)</td><td class="centro"><input type="checkbox" name="pc4" ${c.cerrados[4] ? 'checked' : ''}></td></tr></table></div>
      <p class="suave peq">Las fechas sirven para la asistencia por período. Al cerrar un período, los docentes ya no pueden cambiar esas notas (la dirección sí).</p>
    </div>
    <div class="tarjeta"><h3>Reglas de evaluación</h3>
      <div class="dos"><label>Nota mínima para aprobar<input name="notaMinima" type="number" min="1" max="100" value="${c.notaMinima}"></label>
        <label>Asistencia mínima (%)<input name="asistenciaMinima" type="number" min="0" max="100" value="${c.asistenciaMinima}"></label></div>
      <div class="dos"><label>Completiva: peso de la C.F. (%)<input name="pesoCompletiva" type="number" min="0" max="100" value="${c.pesoCompletiva}"></label>
        <label>Extraordinaria: peso de la C.F. (%)<input name="pesoExtraordinaria" type="number" min="0" max="100" value="${c.pesoExtraordinaria}"></label></div>
      <p class="suave peq">Completiva: C.F.C. = ${c.pesoCompletiva}% de la C.F. + ${100 - c.pesoCompletiva}% de la nota de completiva. Extraordinaria: C.F.E. = ${c.pesoExtraordinaria}% de la C.F. + ${100 - c.pesoExtraordinaria}% de la nota extraordinaria. Ajústalo si tu ordenanza de evaluación dice otra cosa.</p>
      <h3>Competencias fundamentales (C1–C4)</h3>
      ${c.competencias.map((x, i) => `<label>C${i + 1}<input name="comp${i}" value="${esc(x)}"></label>`).join('')}
    </div>
    <button class="prim">Guardar cambios</button>
    </form>
    <div class="tarjeta" style="margin-top:16px"><h3>Copias de seguridad</h3>
      <p class="suave peq">El sistema guarda solo una copia por día en la carpeta <code>datos/respaldos</code> de la computadora del servidor. Descarga una copia de vez en cuando y guárdala en una memoria USB o en la nube.</p>
      <div class="grupo-botones"><a class="boton" href="/api/respaldo">⬇️ Descargar copia de todo</a>
        <label class="boton" style="margin:0;color:var(--texto)">⬆️ Restaurar una copia<input type="file" id="restaurar" accept=".json,application/json" hidden></label></div>
    </div>
    <div class="tarjeta"><h3>Empezar un año escolar nuevo</h3>
      <p class="suave peq">Guarda una copia del año actual y borra las notas y la asistencia. Se quedan los usuarios, cursos, asignaturas y estudiantes (luego puedes cambiarlos de curso).</p>
      <button id="nuevoAno" class="peligro">Empezar año escolar nuevo…</button></div>`;
  $('#fCentro').onsubmit = ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target), g = k => fd.get(k);
    intentar(async () => {
      await llamar('PUT', '/api/centro', {
        nombre: g('nombre'), codigo: g('codigo'), sector: g('sector'), regional: g('regional'), distrito: g('distrito'), director: g('director'), telefono: g('telefono'),
        direccion: g('direccion'), anoEscolar: g('anoEscolar'), notaMinima: g('notaMinima'), asistenciaMinima: g('asistenciaMinima'),
        pesoCompletiva: g('pesoCompletiva'), pesoExtraordinaria: g('pesoExtraordinaria'),
        competencias: [0, 1, 2, 3].map(i => g('comp' + i)),
        periodos: [0, 1, 2, 3].map(i => ({ nombre: g('pn' + i), desde: g('pd' + i), hasta: g('ph' + i) })),
        cerrados: [0, 1, 2, 3, 4].map(i => g('pc' + i) === 'on'),
      });
      aviso('Datos del centro guardados'); await recargar();
    });
  };
  $('#restaurar').onchange = ev => {
    const file = ev.target.files[0]; if (!file) return;
    if (!confirm('Esto reemplaza TODOS los datos actuales por los de la copia. (Se guarda una copia de lo actual antes.) ¿Seguir?')) return;
    file.text().then(t => intentar(async () => { await llamar('POST', '/api/restaurar', JSON.parse(t)); aviso('Copia restaurada. Entra de nuevo.'); setTimeout(() => location.reload(), 1200); }));
  };
  $('#nuevoAno').onclick = () => {
    const sig = c.anoEscolar.replace(/(\d{4})-(\d{4})/, (m, a, b) => `${+a + 1}-${+b + 1}`);
    const n = prompt('Se guardará una copia del año actual y se borrarán todas las notas y la asistencia.\n\nEscribe el año escolar nuevo:', sig);
    if (n) intentar(async () => { await llamar('POST', '/api/nuevo-ano', { anoEscolar: n }); aviso('Año escolar nuevo listo'); await recargar(); ir('centro'); });
  };
}

// =====================================================================
// BITÁCORA (dirección)
// =====================================================================
async function vBitacora(main) {
  main.innerHTML = '<h2>Bitácora</h2><p class="suave">Cargando…</p>';
  const lista = await intentar(() => llamar('GET', '/api/bitacora')) || [];
  main.innerHTML = `<h2>Bitácora</h2><p class="suave peq">Quién cambió qué y cuándo: cada nota, cada lista de asistencia y cada cambio de la dirección.</p>
    <div class="tarjeta no-imprimir"><label>Buscar<input id="fq" placeholder="Nombre de docente, estudiante o asignatura"></label></div>
    <div class="tabla-caja"><table><thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead><tbody id="filas"></tbody></table></div>`;
  const pintar = q => {
    q = q.toLowerCase();
    $('#filas').innerHTML = lista.filter(x => !q || `${x.u} ${x.accion} ${x.detalle}`.toLowerCase().includes(q)).slice(0, 500)
      .map(x => `<tr><td class="peq" style="white-space:nowrap">${new Date(x.t).toLocaleString('es-DO')}</td><td>${esc(x.u)}</td><td>${esc(x.accion)}</td><td class="peq">${esc(x.detalle)}</td></tr>`).join('');
  };
  $('#fq').oninput = e => pintar(e.target.value);
  pintar('');
}

// =====================================================================
// MI CUENTA
// =====================================================================
function vCuenta(main, p) {
  main.innerHTML = `<h2>Mi cuenta</h2>
    ${p.primera || yo().cambiarClave ? '<div class="aviso ambar">Por seguridad, cambia la clave que te dio la dirección por una que solo tú sepas.</div>' : ''}
    <div class="tarjeta" style="max-width:420px"><p><b>${esc(yo().nombre)}</b><br><span class="suave">Usuario: ${esc(yo().usuario)} · ${ROL[yo().rol]}</span></p>
    <form id="fClave"><label>Clave actual<input type="password" name="actual" required autocomplete="current-password"></label>
      <label>Clave nueva (6 o más)<input type="password" name="nueva" required minlength="6" autocomplete="new-password"></label>
      <label>Repite la clave nueva<input type="password" name="otra" required minlength="6" autocomplete="new-password"></label>
      <button class="prim">Cambiar clave</button></form></div>`;
  $('#fClave').onsubmit = ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (f.nueva !== f.otra) return aviso('Las claves nuevas no son iguales', true);
    intentar(async () => { await llamar('POST', '/api/clave', f); aviso('Clave cambiada'); ev.target.reset(); await recargar(); ir(MENU[yo().rol][0][0]); });
  };
}

// ---------- Arranque ----------
(async () => {
  try {
    const est = await (await fetch('/api/estado')).json();
    S.nombreCentro = est.centro;
    if (!est.configurado) return pantallaConfigurar();
    await recargar();
  } catch (e) {
    if (!S.datos && !$('#fEntrar')) $('#app').innerHTML = `<p class="cargando">No se pudo conectar con el servidor del centro. ¿Está abierta la ventana del servidor?<br><small>${esc(e.message)}</small></p>`;
  }
})();
