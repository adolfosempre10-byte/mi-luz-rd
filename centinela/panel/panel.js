'use strict';
// Panel de Centinela: todo el texto se inserta con textContent (nunca innerHTML con datos del atacante).
const $ = (id) => document.getElementById(id);
const CLAVE = 'centinela-token';
let token = '';
try { token = localStorage.getItem(CLAVE) || ''; } catch { /* sin almacenamiento */ }
let estado = null;
let abierto = null;
let criticosVistos = null;

function el(etiqueta, props = {}, ...hijos) {
  const e = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'clase') e.className = v; else if (k === 'texto') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const h of hijos.flat()) if (h != null) e.append(h);
  return e;
}

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { ...opciones, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opciones.headers || {}) } });
  if (r.status === 401) { salir('El token no es válido.'); throw new Error('token invalido'); }
  const tipo = r.headers.get('content-type') || '';
  const datos = tipo.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
  return datos;
}

const fecha = (iso) => (iso ? new Date(iso).toLocaleString('es-DO', { hour12: false }) : '—');
const SEV = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja' };

function salir(mensaje = '') {
  token = '';
  try { localStorage.removeItem(CLAVE); } catch { /* nada */ }
  $('app').hidden = true; $('entrar').hidden = false; $('errorEntrar').textContent = mensaje;
}

$('formEntrar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  token = $('token').value.trim();
  try { await cargar(); try { localStorage.setItem(CLAVE, token); } catch { /* nada */ } } catch (e) { $('errorEntrar').textContent = e.message; }
});
$('btnSalir').addEventListener('click', () => salir());
$('btnPrueba').addEventListener('click', async () => {
  try {
    const r = await api('/api/avisos/prueba', { method: 'POST' });
    alert(r.resultados.length ? r.resultados.map((x) => `${x.ok ? '✔' : '✘'} ${x.canal}${x.error ? `: ${x.error}` : ''}`).join('\n') : 'No hay canales de aviso configurados.');
  } catch (e) { alert(e.message); }
});

document.querySelectorAll('[data-pestana]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-pestana]').forEach((x) => x.classList.toggle('activa', x === b));
  document.querySelectorAll('.pestana').forEach((p) => { p.hidden = p.id !== `p-${b.dataset.pestana}`; });
}));
['filtroEstado', 'filtroSeveridad', 'filtroTexto'].forEach((id) => $(id).addEventListener('input', pintarIncidentes));

async function cargar() {
  estado = await api('/api/estado');
  $('entrar').hidden = true; $('app').hidden = false;
  pintar();
}

function pintar() {
  const e = estado;
  $('subtitulo').textContent = `${e.esCentral ? 'Central' : 'Equipo'}: ${e.equipo} · modo ${e.modo} · v${e.version} · ${e.usuario}`;
  const activos = e.incidentes.filter((i) => i.estado !== 'resuelto');
  const criticos = activos.filter((i) => i.severidad === 'critica');
  $('nAbiertos').textContent = activos.length;
  $('nCriticos').textContent = criticos.length;
  $('nBloqueos').textContent = e.bloqueos.length;
  $('nEquipos').textContent = 1 + e.agentes.length;

  const caidos = e.agentes.filter((a) => a.sinReportar);
  const banner = criticos.length ? `⚠ ${criticos.length} incidente(s) crítico(s) sin resolver: ${criticos[0].titulo} (${criticos[0].host})`
    : caidos.length ? `⚠ ${caidos.length} equipo(s) no reportan: ${caidos.map((a) => a.equipo).join(', ')}` : '';
  $('banner').hidden = !banner; $('banner').textContent = banner;

  const ids = new Set(criticos.map((i) => i.id));
  if (criticosVistos) {
    const nuevos = criticos.filter((i) => !criticosVistos.has(i.id));
    if (nuevos.length) notificar(nuevos[0]);
  }
  criticosVistos = ids;

  pintarIncidentes(); pintarBloqueos(); pintarEquipos();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && !abierto && e.incidentes.some((i) => i.id === hash)) verIncidente(hash);
}

function notificar(inc) {
  try { navigator.vibrate?.([300, 100, 300]); } catch { /* nada */ }
  if ('Notification' in window && Notification.permission === 'granted') new Notification(`Centinela: ${inc.titulo}`, { body: `${inc.host}${inc.ip ? ` · ${inc.ip}` : ''}` });
}
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });

function pintarIncidentes() {
  if (!estado) return;
  const fEstado = $('filtroEstado').value; const fSev = $('filtroSeveridad').value; const fTxt = $('filtroTexto').value.toLowerCase();
  const lista = estado.incidentes.filter((i) => (fEstado === 'todos' || (fEstado === 'activos' ? i.estado !== 'resuelto' : i.estado === fEstado))
    && (!fSev || i.severidad === fSev)
    && (!fTxt || `${i.ip} ${i.host} ${i.titulo} ${(i.usuarios || []).join(' ')}`.toLowerCase().includes(fTxt)));
  const ul = $('listaIncidentes');
  ul.replaceChildren(...(lista.length ? lista.map((i) => el('li', { clase: `clic sev-${i.severidad}`, onclick: () => verIncidente(i.id) },
    el('div', { clase: 'info' },
      el('b', { texto: i.titulo }),
      el('small', { texto: `${i.host}${i.ip ? ` · ${i.ip}` : ''} · ${i.eventos} eventos · ${fecha(i.ultimoEvento)}` }),
      el('small', { texto: (i.acciones || []).map((a) => a.texto).join(' · ') || 'Solo aviso' })),
    el('div', {}, el('span', { clase: `etiqueta ${i.severidad}`, texto: SEV[i.severidad] }), ' ',
      el('span', { clase: `etiqueta ${i.estado === 'resuelto' ? 'ok' : 'gris'}`, texto: i.falsaAlarma ? 'falsa alarma' : i.estado }))))
    : [el('li', { clase: 'vacio', texto: 'No hay incidentes con estos filtros. 👍' })]));
}

function pintarBloqueos() {
  const ul = $('listaBloqueos');
  ul.replaceChildren(...(estado.bloqueos.length ? estado.bloqueos.map((b) => el('li', {},
    el('div', { clase: 'info' }, el('b', { texto: b.ip }),
      el('small', { texto: `${b.motivo || ''} · ${b.origen} · desde ${fecha(b.desde)} · ${b.hasta ? `hasta ${fecha(b.hasta)}` : 'permanente'}${b.aplicado === false ? ` · ⚠ no aplicado: ${b.error}` : ''}` })),
    el('button', { clase: 'secundario', type: 'button', texto: 'Desbloquear', onclick: () => desbloquear(b.ip) })))
    : [el('li', { clase: 'vacio', texto: 'No hay IPs bloqueadas.' })]));
}

function pintarEquipos() {
  const filas = [el('li', {}, el('div', { clase: 'info' }, el('b', { texto: `${estado.equipo} (este equipo)` }), el('small', { texto: `modo ${estado.modo} · ${estado.estadisticas.lineas} líneas revisadas` })), el('span', { clase: 'etiqueta ok', texto: 'activo' }))];
  for (const a of estado.agentes) {
    filas.push(el('li', {}, el('div', { clase: 'info' }, el('b', { texto: a.equipo }), el('small', { texto: `${a.so || ''} · ${a.ip || ''} · modo ${a.modo || '?'} · último reporte ${fecha(a.ultimoContacto)}` })),
      el('span', { clase: `etiqueta ${a.sinReportar ? 'critica' : 'ok'}`, texto: a.sinReportar ? 'sin reportar' : 'activo' })));
  }
  $('listaEquipos').replaceChildren(...filas);
}

async function desbloquear(ip) {
  if (!confirm(`¿Quitar el bloqueo de ${ip}?`)) return;
  try { await api(`/api/bloqueos/${encodeURIComponent(ip)}`, { method: 'DELETE' }); await cargar(); } catch (e) { alert(e.message); }
}

$('formBloquear').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/api/bloqueos', { method: 'POST', body: JSON.stringify({ ip: $('ipBloquear').value.trim(), horas: Number($('horasBloquear').value), motivo: $('motivoBloquear').value }) });
    $('ipBloquear').value = ''; $('motivoBloquear').value = '';
    await cargar();
  } catch (e) { alert(e.message); }
});

function fila(dl, titulo, valor) { if (valor != null && valor !== '') dl.append(el('dt', { texto: titulo }), el('dd', { texto: String(valor) })); }

async function verIncidente(id) {
  let inc;
  try { inc = await api(`/api/incidentes/${encodeURIComponent(id)}`); } catch (e) { alert(e.message); return; }
  abierto = inc;
  history.replaceState(null, '', `#${id}`);
  $('dTitulo').textContent = `${inc.titulo}`;
  const inv = inc.investigacion || {};
  const dl = el('dl');
  fila(dl, 'Gravedad', SEV[inc.severidad]);
  fila(dl, 'Estado', inc.falsaAlarma ? 'falsa alarma' : inc.estado);
  fila(dl, 'Equipo atacado', inc.host);
  fila(dl, 'IP atacante', inc.ip ? `${inc.ip} · ${inv.origen || ''}` : null);
  fila(dl, 'Nombre (DNS)', inv.dnsInverso?.join(', '));
  fila(dl, 'Ubicación', inv.ubicacion ? [inv.ubicacion.ciudad, inv.ubicacion.pais, inv.ubicacion.proveedor].filter(Boolean).join(' · ') : null);
  fila(dl, 'Reputación', inv.reputacion ? `${inv.reputacion.puntaje}/100 · ${inv.reputacion.reportes} reportes (AbuseIPDB)` : null);
  fila(dl, 'Usuarios', inc.usuarios?.join(', '));
  fila(dl, 'Eventos', `${inc.eventos} · de ${fecha(inc.primerEvento)} a ${fecha(inc.ultimoEvento)}`);
  fila(dl, 'Técnica', inv.tecnica ? `${inv.tecnica.id} ${inv.tecnica.nombre}` : inc.mitre);
  fila(dl, 'Historial de la IP', inv.historial ? `${inv.historial.incidentes} incidente(s), bloqueada ${inv.historial.vecesBloqueada} vez/veces, equipos: ${inv.historial.equiposAtacados.join(', ')}` : null);
  const partes = [dl];
  const lista = (titulo, items, ordenada) => { if (items?.length) partes.push(el('h3', { texto: titulo }), el(ordenada ? 'ol' : 'ul', { clase: 'plano' }, items.map((t) => el('li', { texto: t })))); };
  lista('Qué hacer', inv.pasos || [inc.recomendacion], true);
  lista('Acciones tomadas', (inc.acciones || []).map((a) => `${fecha(a.fecha)} — ${a.texto}`));
  lista('Notas', inc.notas);
  partes.push(el('h3', { texto: 'Evidencia' }), el('pre', { texto: (inc.evidencia || []).join('\n') || '—' }));
  $('dCuerpo').replaceChildren(...partes);
  $('dDesbloquear').hidden = !(inc.ip && estado.bloqueos.some((b) => b.ip === inc.ip));
  if (!$('detalle').open) $('detalle').showModal();
}

$('dCerrar').addEventListener('click', () => $('detalle').close());
$('detalle').addEventListener('close', () => { abierto = null; history.replaceState(null, '', location.pathname); });
document.querySelectorAll('[data-estado]').forEach((b) => b.addEventListener('click', async () => {
  if (!abierto) return;
  try { await api(`/api/incidentes/${abierto.id}`, { method: 'POST', body: JSON.stringify({ estado: b.dataset.estado }) }); await cargar(); await verIncidente(abierto.id); } catch (e) { alert(e.message); }
}));
$('dDesbloquear').addEventListener('click', async () => { if (abierto?.ip) { await desbloquear(abierto.ip); if (abierto) await verIncidente(abierto.id); } });
$('dInforme').addEventListener('click', async () => {
  try {
    const texto = await api(`/api/incidentes/${abierto.id}/informe`);
    const a = el('a', { href: URL.createObjectURL(new Blob([texto], { type: 'text/plain' })), download: `informe-${abierto.id}.txt` });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { alert(e.message); }
});
$('formNota').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!abierto || !$('nota').value.trim()) return;
  try { await api(`/api/incidentes/${abierto.id}`, { method: 'POST', body: JSON.stringify({ nota: $('nota').value }) }); $('nota').value = ''; await verIncidente(abierto.id); } catch (e) { alert(e.message); }
});

if (token) cargar().catch(() => salir()); else salir();
setInterval(() => { if (token && !document.hidden) cargar().catch(() => {}); }, 5000);
