/* Mi Luz RD — mide tu consumo con fotos del contador.
   Todo se guarda en el teléfono (IndexedDB). No se envía nada a internet. */
'use strict';

// ---------- Tarifas oficiales BTS-1 ----------
// Fuente: Resolución SIE-121-2026-TF, tarifas de transición oct–dic 2026 (pág. 8).
const TARIFF_SOURCE = 'Resolución SIE-121-2026-TF (octubre–diciembre 2026)';
const OFFICIAL_TARIFFS = {
  edesur:   { fixedLow: 42.10, fixedHigh: 128.59, r1: 6.05, r2: 8.59, r3: 12.89, r4: 13.09 },
  edenorte: { fixedLow: 40.33, fixedHigh: 126.81, r1: 5.97, r2: 8.51, r3: 13.83, r4: 14.04 },
  edeeste:  { fixedLow: 41.34, fixedHigh: 127.83, r1: 6.17, r2: 8.71, r3: 13.04, r4: 13.26 },
};
const DIST_NAMES = { edesur: 'Edesur', edenorte: 'Edenorte', edeeste: 'Edeeste', otra: 'Tarifa propia' };
const DAY = 86400000;

// ---------- Utilidades ----------
const $ = (s) => document.querySelector(s);
const fmtN = (n, d = 0) => Number(n).toLocaleString('es-DO', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtRD = (n) => 'RD$ ' + fmtN(n, 2);
const fmtKwh = (n) => fmtN(n, n < 100 ? 1 : 0) + ' kWh';
const fmtDate = (t, opts = { day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('es-DO', opts);
const fmtDateTime = (t) => new Date(t).toLocaleString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const parseNum = (s) => {
  if (s == null) return NaN;
  s = String(s).trim().replace(/\s/g, '');
  if (!s) return NaN;
  // "12.345,6" o "12,345.6" o "12345,6"
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{3}$/.test(s) && s.length > 4 ? s.replace(/,/g, '') : s.replace(',', '.');
  return Number(s);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const dateOnlyToTime = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };
const timeToDateOnly = (t) => toLocalInput(t).slice(0, 10);

// ---------- Base de datos (IndexedDB) ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mi-luz-rd', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('readings', { keyPath: 'id' });
        db.createObjectStore('bills', { keyPath: 'id' });
        db.createObjectStore('kv');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  put(store, v, key) { return this.tx(store, 'readwrite', (s) => s.put(v, key)); },
  del(store, key) { return this.tx(store, 'readwrite', (s) => s.delete(key)); },
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); },
  clear(store) { return this.tx(store, 'readwrite', (s) => s.clear()); },
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Estado ----------
const state = {
  readings: [], // {id, time, value, photo(Blob)|null}
  bills: [],    // {id, start, end, kwh, amount, prev, curr}
  settings: null,
  periodOffset: 0,
};
const defaultSettings = () => ({ cutDay: 1, distributor: 'edesur', tariff: { ...OFFICIAL_TARIFFS.edesur }, tariffSource: TARIFF_SOURCE });

async function loadAll() {
  state.readings = (await DB.all('readings')).sort((a, b) => a.time - b.time);
  state.bills = (await DB.all('bills')).sort((a, b) => b.end - a.end);
  state.settings = (await DB.get('kv', 'settings')) || defaultSettings();
}
const saveSettings = () => DB.put('kv', state.settings, 'settings');

// ---------- Cálculo de tarifa ----------
function costOf(kwh, t = state.settings.tariff) {
  kwh = Math.max(0, kwh);
  const lines = [];
  let energy = 0;
  if (kwh > 700) {
    energy = kwh * t.r4;
    lines.push([`${fmtN(kwh)} kWh × ${fmtN(t.r4, 2)} (más de 700: todos a este precio)`, energy]);
  } else {
    const tiers = [[200, t.r1, '0–200'], [100, t.r2, '201–300'], [400, t.r3, '301–700']];
    let left = kwh;
    for (const [size, rate, name] of tiers) {
      const q = Math.min(left, size);
      if (q <= 0) break;
      lines.push([`${fmtN(q, q % 1 ? 1 : 0)} kWh × ${fmtN(rate, 2)} (escalón ${name})`, q * rate]);
      energy += q * rate;
      left -= q;
    }
  }
  const fixed = kwh > 100 ? t.fixedHigh : t.fixedLow;
  lines.push([`Cargo fijo (${kwh > 100 ? 'más de 100 kWh' : 'hasta 100 kWh'})`, fixed]);
  return { total: energy + fixed, energy, fixed, lines };
}

// ---------- Lecturas: energía en cualquier momento (interpolación) ----------
function energyAt(t) {
  const R = state.readings;
  if (!R.length || t < R[0].time || t > R[R.length - 1].time) return null;
  for (let i = 0; i < R.length; i++) {
    if (R[i].time === t) return R[i].value;
    if (R[i].time > t) {
      const a = R[i - 1], b = R[i];
      return a.value + (b.value - a.value) * (t - a.time) / (b.time - a.time);
    }
  }
  return R[R.length - 1].value;
}

// ---------- Períodos de facturación ----------
function cutDate(y, m, day) {
  const dim = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, dim)).getTime();
}
function periodFor(offset = 0) {
  const now = new Date();
  const day = state.settings.cutDay;
  let y = now.getFullYear(), m = now.getMonth();
  if (Date.now() < cutDate(y, m, day)) m -= 1; // aún no llega el corte de este mes
  m += offset;
  const s = new Date(y, m, 1); // normaliza año/mes
  y = s.getFullYear(); m = s.getMonth();
  return { start: cutDate(y, m, day), end: cutDate(y, m + 1, day) };
}

function periodStats(start, end) {
  const R = state.readings;
  const inside = R.filter((r) => r.time >= start && r.time <= end);
  const hasBefore = R.some((r) => r.time <= start);
  const hasAfter = R.some((r) => r.time >= end);
  const periodDays = (end - start) / DAY;
  const tb = hasBefore ? start : (inside.length ? inside[0].time : null);
  const te = hasAfter ? end : (inside.length ? inside[inside.length - 1].time : null);
  if (tb == null || te == null || te <= tb) {
    return { ok: false, periodDays, count: inside.length };
  }
  const consumed = energyAt(te) - energyAt(tb);
  const days = (te - tb) / DAY;
  const rate = consumed / days;
  const complete = tb === start && te === end;
  const projected = complete ? consumed : rate * periodDays;
  return { ok: true, tb, te, consumed, days, rate, projected, complete, periodDays, count: inside.length, startsLate: tb - start > DAY };
}

// ---------- Pantalla Inicio ----------
function renderHome() {
  const { start, end } = periodFor(state.periodOffset);
  const now = Date.now();
  const isCurrent = state.periodOffset === 0;
  const dayN = Math.min(Math.floor((Math.min(now, end) - start) / DAY) + 1, Math.round((end - start) / DAY));
  $('#periodLabel').innerHTML = `${fmtDate(start)} → ${fmtDate(end)}` +
    `<small>${isCurrent ? `Período actual · día ${dayN} de ${Math.round((end - start) / DAY)}` : (start > now ? 'Período futuro' : 'Período anterior')}</small>`;
  $('#nextP').disabled = state.periodOffset >= 0;
  $('#distLabel').textContent = DIST_NAMES[state.settings.distributor] || '';

  const st = periodStats(start, end);
  const box = $('#summary');
  if (!state.readings.length) {
    box.innerHTML = `<div class="card info"><h3>¿Cómo se usa?</h3>
      <p>1. Ve a <b>Ajustes</b> y pon el día de corte de tu factura y tu distribuidora.</p>
      <p>2. Cada día, toca <b>📷 Anotar lectura</b> y tómale una foto al contador. La app lee el número; si se equivoca, lo corriges.</p>
      <p>3. Aquí verás cuánto llevas gastado en el mes y cuánto te debería salir la factura.</p></div>`;
    renderChart(start, end, null);
    renderDaily(start, end);
    return;
  }
  if (!st.ok) {
    box.innerHTML = `<div class="card info">${st.count === 1
      ? 'Tienes 1 lectura en este período. Con la lectura de mañana ya verás tu consumo.'
      : 'No hay suficientes lecturas en este período para calcular el consumo. Necesitas al menos dos fotos.'}</div>`;
    renderChart(start, end, null);
    renderDaily(start, end);
    return;
  }
  const c = costOf(st.consumed);
  const p = costOf(st.projected);
  const t = state.settings.tariff;
  let alerts = '';
  if (!st.complete && st.projected > 700 && st.consumed <= 700) {
    alerts += `<div class="alert bad">⚠️ A este ritmo vas a pasar de <b>700 kWh</b>. Si pasas de 700, <b>todos</b> los kWh se cobran a RD$ ${fmtN(t.r4, 2)}, no solo los de arriba.</div>`;
  } else if (!st.complete && st.projected > 300 && st.consumed <= 300) {
    alerts += `<div class="alert warn">A este ritmo pasarás de 300 kWh: lo que gastes de ahí en adelante cuesta RD$ ${fmtN(t.r3, 2)} por kWh.</div>`;
  }
  if (st.startsLate) {
    alerts += `<div class="alert warn">Tu primera foto de este período es del ${fmtDate(st.tb)}, no del día de corte. Los kWh cuentan desde esa foto; la proyección sí estima el mes completo.</div>`;
  }
  const lastR = state.readings.filter((r) => r.time <= end).slice(-1)[0];
  box.innerHTML = `
    <div class="stats">
      <div class="stat hero">
        <div class="k">${st.complete ? 'Consumo del período' : 'Llevas gastado en este período'}</div>
        <div class="v">${fmtKwh(st.consumed)}</div>
        <div class="s">≈ ${fmtRD(c.total)} con la tarifa BTS-1 · del ${fmtDate(st.tb)} al ${fmtDate(st.te)}</div>
      </div>
      <div class="stat"><div class="k">Promedio por día</div><div class="v">${fmtN(st.rate, 1)}</div><div class="s">kWh por día</div></div>
      <div class="stat"><div class="k">${st.complete ? 'Total del período' : 'Al cierre (proyección)'}</div><div class="v">${fmtN(st.projected)}</div><div class="s">kWh</div></div>
      <div class="stat hero" style="background:var(--card);color:var(--text);border:1px solid var(--line)">
        <div class="k" style="color:var(--muted)">${st.complete ? 'Factura que te corresponde' : 'Factura estimada al corte'} (${fmtDate(end)})</div>
        <div class="v">${fmtRD(p.total)}</div>
        <details><summary class="hint">Ver cómo se calcula</summary>
          <table class="breakdown">${p.lines.map(([k, v]) => `<tr><td>${k}</td><td>${fmtN(v, 2)}</td></tr>`).join('')}
          <tr class="total"><td>Total</td><td>${fmtRD(p.total)}</td></tr></table>
          <p class="hint">Tarifa: ${esc(state.settings.tariffSource || 'personalizada')}. No incluye deudas atrasadas ni otros cargos.</p>
        </details>
      </div>
    </div>
    ${estimateCard(st, end, p)}
    ${alerts}
    ${lastR ? `<p class="hint">Última lectura: <b>${fmtN(lastR.value, lastR.value % 1 ? 1 : 0)}</b> el ${fmtDateTime(lastR.time)}</p>` : ''}`;
  renderChart(start, end, st);
  renderDaily(start, end);
}

// Consumo por día entre cada par de fotos del período.
function intervalsIn(start, end) {
  const pts = state.readings.filter((r) => r.time >= start && r.time <= end).map((r) => ({ time: r.time, value: r.value, photo: true }));
  if (state.readings.some((r) => r.time < start) && energyAt(start) != null && (!pts.length || pts[0].time - start > 3600000)) {
    pts.unshift({ time: start, value: energyAt(start), photo: false });
  }
  const rows = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const kwh = b.value - a.value, days = (b.time - a.time) / DAY;
    total += kwh;
    rows.push({ from: a, to: b, kwh, days, perDay: days > 0 ? kwh / days : 0, total });
  }
  return rows;
}

// Texto claro del estimado: "gastas X por día; si sigues así, el mes sale en Y kWh = RD$ Z".
function estimateCard(st, end, p) {
  if (st.complete) return '';
  const rows = intervalsIn(st.tb - 1, end).filter((r) => r.days >= 0.5);
  let steady = '';
  if (rows.length >= 2) {
    const rates = rows.map((r) => r.perDay);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const cv = mean > 0 ? Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length) / mean : 0;
    steady = cv < 0.2
      ? `✅ Tu consumo es <b>parejo</b> (entre ${fmtN(Math.min(...rates), 1)} y ${fmtN(Math.max(...rates), 1)} kWh por día), así que el estimado es confiable.`
      : cv < 0.4
        ? `Tu consumo varía un poco de un día a otro (entre ${fmtN(Math.min(...rates), 1)} y ${fmtN(Math.max(...rates), 1)} kWh por día). El estimado es aproximado.`
        : `⚠️ Tu consumo cambia mucho de un día a otro (entre ${fmtN(Math.min(...rates), 1)} y ${fmtN(Math.max(...rates), 1)} kWh por día). Toma la foto todos los días para afinar el estimado.`;
  } else {
    steady = 'Con más fotos (una cada día) el estimado se vuelve más exacto.';
  }
  const daysLeft = Math.max(0, (end - st.te) / DAY);
  return `<div class="card estimate">
    <h3>📅 Estimado del mes</h3>
    <p>Desde ${st.startsLate ? 'tu primera foto' : 'el corte'} (${fmtDate(st.tb)}) llevas <b>${fmtKwh(st.consumed)}</b> en ${fmtN(st.days, 1)} días.
    Gastas en promedio <b>${fmtN(st.rate, 1)} kWh por día</b>.</p>
    <p>Si sigues así, en el mes completo (${fmtN(st.periodDays, 0)} días) gastarás unos <b>${fmtN(st.projected)} kWh</b>
    y la factura del ${fmtDate(end)} te saldría en unos <b>${fmtRD(p.total)}</b>.</p>
    <p class="hint">Faltan ${fmtN(daysLeft, 0)} días para el corte: unos ${fmtN(st.rate * daysLeft)} kWh más.
    ${st.startsLate ? `Como empezaste a tomar fotos el ${fmtDate(st.tb)}, el estimado del mes también cuenta los días antes de tu primera foto con el mismo promedio.` : ''}</p>
    <p class="hint">${steady}</p>
  </div>`;
}

function renderDaily(start, end) {
  const el = $('#daily');
  const rows = intervalsIn(start, end);
  if (!rows.length) { el.innerHTML = '<p class="empty">Con dos fotos o más verás aquí cuánto gastas cada día y la suma del mes.</p>'; return; }
  el.innerHTML = `<table class="daily">
    <thead><tr><th>Foto</th><th>Lectura</th><th>Gastado</th><th>Por día</th><th>Suma</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${fmtDate(r.to.time)}</td>
      <td>${fmtN(r.to.value, r.to.value % 1 ? 1 : 0)}</td>
      <td>${r.kwh < 0 ? '⚠️ ' : '+'}${fmtN(r.kwh, 1)}</td>
      <td>${r.days >= 0.5 ? fmtN(r.perDay, 1) : '—'}</td>
      <td><b>${fmtN(r.total, 0)}</b></td></tr>`).reverse().join('')}</tbody>
  </table>
  <p class="hint">"Gastado" es lo que subió el contador desde la foto anterior${rows[0].from.photo ? '' : ` (la primera fila cuenta desde el día de corte, ${fmtDate(start)})`}. "Suma" es el total acumulado del período.</p>`;
}

function renderChart(start, end, st) {
  const el = $('#chart');
  if (!st) { el.innerHTML = '<p class="empty">Aquí aparecerá una barra por cada día.</p>'; return; }
  const days = Math.round((end - start) / DAY);
  const data = [];
  for (let i = 0; i < days; i++) {
    const a = start + i * DAY, b = a + DAY;
    const ea = energyAt(Math.max(a, st.tb)), eb = energyAt(Math.min(b, st.te));
    if (ea == null || eb == null || Math.min(b, st.te) <= Math.max(a, st.tb)) { data.push(null); continue; }
    const frac = (Math.min(b, st.te) - Math.max(a, st.tb)) / DAY;
    // ¿hubo foto ese día o es un reparto entre fotos?
    const photo = state.readings.some((r) => r.time >= a && r.time < b);
    data.push({ v: eb - ea, frac, photo });
  }
  const W = 320, H = 140, pad = 18;
  const max = Math.max(1, ...data.filter(Boolean).map((d) => d.v)) * 1.15;
  const bw = (W - pad) / days;
  let bars = '';
  data.forEach((d, i) => {
    if (!d) return;
    const h = (d.v / max) * (H - 24);
    bars += `<rect class="bar${d.photo ? '' : ' est'}" x="${pad + i * bw + 1}" y="${H - 14 - h}" width="${Math.max(1, bw - 2)}" height="${h}"><title>${fmtDate(start + i * DAY)}: ${fmtN(d.v, 1)} kWh</title></rect>`;
  });
  let labels = '';
  for (let i = 0; i < days; i += Math.ceil(days / 6)) labels += `<text class="axis" x="${pad + i * bw}" y="${H - 2}">${new Date(start + i * DAY).getDate()}</text>`;
  const avgY = H - 14 - (st.rate / max) * (H - 24);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumo por día">
    <text class="axis" x="0" y="10">${fmtN(max / 1.15, 0)}</text>${bars}
    <line class="avg" x1="${pad}" x2="${W}" y1="${avgY}" y2="${avgY}"/>${labels}</svg>
    <p class="hint">Barras de color fuerte: días con foto. Color suave: días sin foto (se reparte el consumo entre dos fotos). Línea amarilla: promedio.</p>`;
}

// ---------- Pantalla Lecturas ----------
const thumbURLs = [];
function renderReadings() {
  thumbURLs.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const el = $('#readingsList');
  if (!state.readings.length) { el.innerHTML = '<p class="empty">Todavía no hay lecturas.</p>'; return; }
  const R = state.readings;
  el.innerHTML = R.map((r, i) => {
    const prev = R[i - 1];
    let delta = '';
    if (prev) {
      const d = r.value - prev.value, days = (r.time - prev.time) / DAY;
      delta = `<div class="delta${d < 0 ? ' neg' : ''}"><b>${d < 0 ? '⚠️ ' : '+'}${fmtN(d, 1)}</b>kWh en ${days < 1.5 ? fmtN(days * 24, 0) + ' h' : fmtN(days, 1) + ' días'}</div>`;
    }
    let img = '<div class="noimg">✍️</div>';
    if (r.photo) { const u = URL.createObjectURL(r.photo); thumbURLs.push(u); img = `<img src="${u}" alt="">`; }
    return `<div class="reading" data-id="${r.id}">${img}<div class="main"><div class="val">${fmtN(r.value, r.value % 1 ? 1 : 0)}</div><div class="when">${fmtDateTime(r.time)}</div></div>${delta}</div>`;
  }).reverse().join('');
}

// ---------- Pantalla Facturas ----------
function renderBills() {
  const el = $('#billsList');
  if (!state.bills.length) { el.innerHTML = '<p class="empty">Todavía no has anotado ninguna factura.</p>'; return; }
  el.innerHTML = state.bills.map((b) => {
    const mineStart = energyAt(b.start), mineEnd = energyAt(b.end);
    const mine = mineStart != null && mineEnd != null ? mineEnd - mineStart : null;
    const costBilledKwh = costOf(b.kwh).total;
    const rows = [];
    rows.push(`<div class="h"></div><div class="h n">Factura</div><div class="h n">Mi medición</div>`);
    rows.push(`<div>kWh</div><div class="n">${fmtN(b.kwh)}</div><div class="n">${mine != null ? fmtN(mine) : '—'}</div>`);
    rows.push(`<div>Monto</div><div class="n">${fmtN(b.amount, 2)}</div><div class="n">${mine != null ? fmtN(costOf(mine).total, 2) : '—'}</div>`);
    if (b.curr != null && !isNaN(b.curr)) {
      rows.push(`<div>Lectura al ${fmtDate(b.end)}</div><div class="n">${fmtN(b.curr)}</div><div class="n">${mineEnd != null ? fmtN(mineEnd) : '—'}</div>`);
    }
    const msgs = [];
    if (mine == null) {
      msgs.push(`<div class="alert warn">Tus fotos no cubren todo ese período (necesitas una foto antes del ${fmtDate(b.start)} y otra después del ${fmtDate(b.end)}), así que no se puede comparar el consumo.</div>`);
    } else {
      const diff = b.kwh - mine, pct = mine > 0 ? diff / mine * 100 : 0;
      const money = costBilledKwh - costOf(mine).total; // lo que cuestan los kWh de más
      if (Math.abs(pct) <= 5) msgs.push(`<div class="alert good">✅ Los kWh coinciden con tu medición (diferencia ${fmtN(diff)} kWh, ${fmtN(pct, 1)}%).</div>`);
      else if (diff > 0) msgs.push(`<div class="alert bad">⚠️ Te facturaron <b>${fmtN(diff)} kWh más</b> de lo que mediste (${fmtN(pct, 0)}% más). Eso son unos <b>${fmtRD(money)}</b> de más.</div>`);
      else msgs.push(`<div class="alert warn">Te facturaron ${fmtN(-diff)} kWh menos de lo que mediste. Puede ser una lectura estimada; el mes que viene te lo pueden cobrar.</div>`);
    }
    const tdiff = b.amount - costBilledKwh;
    if (Math.abs(tdiff) > Math.max(5, costBilledKwh * 0.02)) {
      msgs.push(`<div class="alert ${tdiff > 0 ? 'bad' : 'warn'}">Por ${fmtN(b.kwh)} kWh, la tarifa da ${fmtRD(costBilledKwh)}, pero la factura dice ${fmtRD(b.amount)} (${tdiff > 0 ? '+' : ''}${fmtRD(tdiff)}). Revisa si el monto incluye deudas, recargos u otros cargos, o si la tarifa cambió.</div>`);
    } else {
      msgs.push(`<p class="hint">El monto coincide con la tarifa BTS-1 para ${fmtN(b.kwh)} kWh (${fmtRD(costBilledKwh)}).</p>`);
    }
    if (b.curr != null && !isNaN(b.curr) && mineEnd != null && Math.abs(b.curr - mineEnd) > Math.max(10, (mine || 0) * 0.05)) {
      msgs.push(`<div class="alert warn">La lectura de la factura (${fmtN(b.curr)}) no se parece a la de tus fotos para ese día (${fmtN(mineEnd)}). Quizás la lectura fue <b>estimada</b> y nadie leyó el contador.</div>`);
    }
    return `<div class="card bill"><div class="title"><h3>${fmtDate(b.start)} → ${fmtDate(b.end, { day: 'numeric', month: 'short', year: 'numeric' })}</h3>
      <button class="secondary" data-edit-bill="${b.id}">Editar</button></div>
      <div class="cmp">${rows.join('')}</div>${msgs.join('')}
      <div class="row2">
        <button class="primary" data-report-bill="${b.id}" ${mine == null ? 'disabled' : ''}>📄 Informe PDF</button>
        ${b.attachment ? `<button class="secondary" data-view-bill="${b.id}">📎 Ver factura</button>` : ''}
      </div></div>`;
  }).join('');
}

// ---------- Ajustes ----------
function renderSettings() {
  const s = state.settings;
  $('#cutDay').value = s.cutDay;
  $('#distributor').value = s.distributor;
  for (const k of ['fixedLow', 'fixedHigh', 'r1', 'r2', 'r3', 'r4']) $('#t_' + k).value = s.tariff[k];
  $('#tariffSource').textContent = s.tariffSource ? `Valores de: ${s.tariffSource}.` : 'Tarifa personalizada (cambiada a mano).';
  $('#btnResetTariff').hidden = !OFFICIAL_TARIFFS[s.distributor];
  $('#ownerName').value = s.ownerName || '';
  $('#ownerNic').value = s.ownerNic || '';
  $('#ownerAddress').value = s.ownerAddress || '';
}
function bindSettings() {
  $('#cutDay').addEventListener('change', async (e) => {
    const v = Math.round(Number(e.target.value));
    if (!(v >= 1 && v <= 31)) { e.target.value = state.settings.cutDay; return; }
    state.settings.cutDay = v; state.periodOffset = 0; await saveSettings(); renderAll();
  });
  $('#distributor').addEventListener('change', async (e) => {
    const d = e.target.value;
    state.settings.distributor = d;
    if (OFFICIAL_TARIFFS[d]) { state.settings.tariff = { ...OFFICIAL_TARIFFS[d] }; state.settings.tariffSource = TARIFF_SOURCE; }
    await saveSettings(); renderAll();
  });
  for (const k of ['fixedLow', 'fixedHigh', 'r1', 'r2', 'r3', 'r4']) {
    $('#t_' + k).addEventListener('change', async (e) => {
      const v = parseNum(e.target.value);
      if (!(v >= 0)) { e.target.value = state.settings.tariff[k]; return; }
      state.settings.tariff[k] = v;
      const off = OFFICIAL_TARIFFS[state.settings.distributor];
      state.settings.tariffSource = off && Object.keys(off).every((x) => off[x] === state.settings.tariff[x]) ? TARIFF_SOURCE : '';
      await saveSettings(); renderAll();
    });
  }
  $('#btnResetTariff').addEventListener('click', async () => {
    const off = OFFICIAL_TARIFFS[state.settings.distributor];
    if (!off) return;
    state.settings.tariff = { ...off }; state.settings.tariffSource = TARIFF_SOURCE;
    await saveSettings(); renderAll();
  });
  for (const k of ['ownerName', 'ownerNic', 'ownerAddress']) {
    $('#' + k).addEventListener('change', async (e) => { state.settings[k] = e.target.value.trim(); await saveSettings(); if (typeof renderPortal === 'function') renderPortal(); });
  }
  $('#btnExport').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', importData);
  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODAS las lecturas, fotos y facturas de este teléfono? No se puede deshacer.')) return;
    await DB.clear('readings'); await DB.clear('bills');
    await loadAll(); renderAll();
  });
}

// ---------- Copia de seguridad ----------
const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
async function exportData() {
  const readings = [];
  for (const r of state.readings) readings.push({ ...r, photo: r.photo ? await blobToDataURL(r.photo) : null });
  const bills = [];
  for (const b of state.bills) {
    const a = b.attachment;
    bills.push({ ...b, attachment: a ? { ...a, blob: await blobToDataURL(a.blob), preview: a.preview ? await blobToDataURL(a.preview) : null } : null });
  }
  const data = { app: 'mi-luz-rd', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, readings, bills };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `mi-luz-copia-${timeToDateOnly(Date.now())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Copia de Mi Luz RD' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importData(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'mi-luz-rd') throw new Error('No es una copia de Mi Luz RD');
    if (!confirm(`Esta copia tiene ${data.readings.length} lecturas y ${data.bills.length} facturas. Se reemplazará lo que hay en este teléfono. ¿Continuar?`)) return;
    await DB.clear('readings'); await DB.clear('bills');
    for (const r of data.readings) {
      const photo = r.photo ? await (await fetch(r.photo)).blob() : null;
      await DB.put('readings', { ...r, photo });
    }
    for (const b of data.bills) {
      const a = b.attachment;
      const toBlob = async (u) => (u ? (await fetch(u)).blob() : null);
      await DB.put('bills', { ...b, attachment: a ? { ...a, blob: await toBlob(a.blob), preview: await toBlob(a.preview) } : null });
    }
    if (data.settings) await DB.put('kv', data.settings, 'settings');
    await loadAll(); renderAll();
    alert('Listo: datos recuperados.');
  } catch (err) {
    alert('No se pudo leer la copia: ' + err.message);
  }
}

// ---------- Lector de números (OCR) ----------
let ocrWorker = null, ocrWorkerPromise = null;
function getWorker(onProgress) {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (!ocrWorkerPromise) {
    const base = new URL('vendor/', location.href).href;
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      gzip: true,
      workerBlobURL: false,
      logger: (m) => onProgress && onProgress(m),
    }).then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: '0123456789', classify_bln_numeric_mode: '1' });
      ocrWorker = w; return w;
    }).catch((e) => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

// Prepara una versión en blanco y negro del recorte para que se lea mejor.
function makeVariants(img, rect) {
  const sx = rect ? rect.x : 0, sy = rect ? rect.y : 0;
  const sw = rect ? rect.w : img.naturalWidth, sh = rect ? rect.h : img.naturalHeight;
  // Tamaño de trabajo: líneas de unos 100 px de alto para un recorte, máx 1600 px de ancho.
  let scale = rect ? Math.min(4, Math.max(0.5, 110 / sh)) : Math.min(1, 1600 / sw);
  if (sw * scale > 2000) scale = 2000 / sw;
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas'); c.width = w + 40; c.height = h + 40;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, sx, sy, sw, sh, 20, 20, w, h);
  const id = g.getImageData(20, 20, w, h), d = id.data;
  const gray = new Uint8ClampedArray(w * h);
  let mn = 255, mx = 0;
  for (let i = 0; i < w * h; i++) { const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; gray[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = Math.max(1, mx - mn);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) { gray[i] = (gray[i] - mn) * 255 / range; hist[gray[i]]++; }
  // Umbral de Otsu
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = gray.length - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = i; } }
  const out = (fn) => {
    const cc = document.createElement('canvas'); cc.width = c.width; cc.height = c.height;
    const gg = cc.getContext('2d'); gg.fillStyle = '#fff'; gg.fillRect(0, 0, cc.width, cc.height);
    const o = gg.createImageData(w, h);
    for (let i = 0; i < gray.length; i++) { const v = fn(gray[i]); o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = v; o.data[i * 4 + 3] = 255; }
    gg.putImageData(o, 20, 20); return cc;
  };
  return [
    out((v) => v),                       // gris con contraste
    out((v) => (v > thr ? 255 : 0)),     // números oscuros sobre fondo claro
    out((v) => (v > thr ? 0 : 255)),     // números claros sobre fondo oscuro (contadores de rueditas)
  ];
}

function pickCandidate(cands, prevValue, prevTime, time) {
  cands = cands.filter((c) => c.digits.length >= 3 && c.digits.length <= 8);
  if (!cands.length) return null;
  if (prevValue != null) {
    const days = Math.max(0.5, (time - prevTime) / DAY);
    const plausible = cands.filter((c) => { const v = Number(c.digits); return v >= prevValue && v - prevValue <= 120 * days + 50; });
    if (plausible.length) return { ...plausible.sort((a, b) => b.conf - a.conf || Number(a.digits) - Number(b.digits))[0], plausible: true };
    // ¿Será que la última rueda es decimal? Prueba quitando el último dígito.
    const dec = cands.map((c) => ({ ...c, digits: c.digits.slice(0, -1) + '.' + c.digits.slice(-1) }))
      .filter((c) => { const v = Number(c.digits); return v >= prevValue && v - prevValue <= 120 * days + 50; });
    if (dec.length) return { ...dec.sort((a, b) => b.conf - a.conf)[0], plausible: true };
  }
  // Sin lectura anterior: los números del contador suelen ser los más grandes de la foto.
  const score = (c) => Math.max(c.conf, 1) * Math.min(c.digits.length, 6) * (c.h || 1) ** 2;
  const best = cands.sort((a, b) => score(b) - score(a))[0];
  return { ...best, plausible: prevValue == null && best.conf >= 60 };
}

async function runOcr(img, rect, ctx) {
  const status = $('#ocrStatus');
  status.textContent = '⏳ Preparando el lector de números (la primera vez tarda un poco)…';
  const w = await getWorker((m) => {
    if (m.status && m.status.includes('loading') && m.progress != null) status.textContent = `⏳ Cargando lector… ${Math.round(m.progress * 100)}%`;
  });
  status.textContent = '🔍 Leyendo el número…';
  const variants = makeVariants(img, rect);
  const cands = [];
  for (const v of variants) {
    await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: rect ? '7' : '11' });
    const { data } = await w.recognize(v);
    if (rect) {
      const digits = (data.text || '').replace(/\D/g, '');
      if (digits) cands.push({ digits, conf: data.confidence || 0 });
    } else {
      for (const wd of data.words || []) {
        const digits = (wd.text || '').replace(/\D/g, '');
        const h = wd.bbox ? wd.bbox.y1 - wd.bbox.y0 : 1;
        if (digits) cands.push({ digits, conf: wd.confidence || 0, h });
      }
    }
  }
  const best = pickCandidate(cands, ctx.prevValue, ctx.prevTime, ctx.time);
  return best;
}

// ---------- Diálogo de lectura ----------
const dlg = { el: null, editing: null, photoBlob: null, photoURL: null, rect: null, sel: null };

function prevReadingBefore(t, excludeId) {
  const R = state.readings.filter((r) => r.id !== excludeId && r.time < t);
  return R[R.length - 1] || null;
}
function updateReadingHint() {
  const v = parseNum($('#readingValue').value);
  const t = new Date($('#readingDate').value).getTime();
  const prev = prevReadingBefore(t, dlg.editing && dlg.editing.id);
  const el = $('#readingHint');
  if (!prev) { el.textContent = 'Es tu primera lectura.'; el.style.color = ''; return; }
  const days = (t - prev.time) / DAY;
  let txt = `Lectura anterior: ${fmtN(prev.value, prev.value % 1 ? 1 : 0)} (${fmtDateTime(prev.time)}).`;
  el.style.color = '';
  if (!isNaN(v)) {
    const d = v - prev.value;
    if (d < 0) { txt += ' ⚠️ Este número es MENOR que el anterior; revísalo.'; el.style.color = 'var(--bad)'; }
    else { txt += ` Consumo: ${fmtN(d, 1)} kWh` + (days >= 0.5 ? ` (${fmtN(d / days, 1)} por día).` : '.'); if (days > 0.5 && d / days > 120) { txt += ' Parece demasiado; revisa el número.'; el.style.color = 'var(--warn)'; } }
  }
  el.textContent = txt;
}

async function shrinkPhoto(file) {
  const bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1600, s = Math.min(1, max / Math.max(bmp.naturalWidth, bmp.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.naturalWidth * s); c.height = Math.round(bmp.naturalHeight * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  URL.revokeObjectURL(bmp.src);
  return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.82));
}

function setPhoto(blob) {
  if (dlg.photoURL) URL.revokeObjectURL(dlg.photoURL);
  dlg.photoBlob = blob; dlg.rect = null; dlg.rectByUser = false;
  $('#selBox').hidden = true;
  if (!blob) { $('#photoArea').hidden = true; dlg.photoURL = null; return Promise.resolve(); }
  dlg.photoURL = URL.createObjectURL(blob);
  const img = $('#photoImg');
  $('#photoArea').hidden = false;
  return new Promise((res) => { img.onload = () => res(); img.src = dlg.photoURL; });
}

async function doOcr() {
  const img = $('#photoImg');
  if (!dlg.photoBlob || !img.naturalWidth) return;
  const t = new Date($('#readingDate').value).getTime() || Date.now();
  const prev = prevReadingBefore(t, dlg.editing && dlg.editing.id);
  $('#btnOcr').disabled = true;
  try {
    const best = await runOcr(img, dlg.rect, { prevValue: prev && prev.value, prevTime: prev && prev.time, time: t });
    const ask = '👆 Pasa el dedo sobre los números del contador para encerrarlos y lo leo otra vez.';
    if (best && (best.plausible || dlg.rectByUser)) {
      $('#readingValue').value = best.digits.replace(/^0+(?=\d)/, '');
      $('#ocrStatus').textContent = `✅ Leí: ${best.digits}. Compáralo con la foto y corrígelo si hace falta.`;
      if (best.plausible && dlg.rectByUser) saveLastRect();
    } else if (best) {
      $('#ocrStatus').textContent = `🤔 Creo que dice ${best.digits}, pero no estoy seguro. ${ask}`;
    } else {
      $('#ocrStatus').textContent = `🤔 No encontré el número. ${ask} También puedes escribirlo tú.`;
    }
    updateReadingHint();
  } catch (e) {
    console.error(e);
    $('#ocrStatus').textContent = 'No se pudo usar el lector de números (' + e.message + '). Escribe el número a mano.';
  } finally {
    $('#btnOcr').disabled = false;
  }
}

function openReadingDialog(r = null) {
  dlg.editing = r;
  $('#dlgLecturaTitle').textContent = r ? 'Editar lectura' : 'Nueva lectura';
  $('#readingValue').value = r ? String(r.value) : '';
  $('#readingDate').value = toLocalInput(r ? r.time : Date.now());
  $('#ocrStatus').textContent = r ? '' : 'Toma una foto del contador de cerca, que se vean bien los números.';
  $('#btnDeleteLectura').hidden = !r;
  setPhoto(r ? r.photo : null);
  updateReadingHint();
  dlg.el.showModal();
}

async function onPhotoChosen(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  $('#ocrStatus').textContent = '⏳ Abriendo la foto…';
  const blob = await shrinkPhoto(f);
  await setPhoto(blob);
  // Usa la misma zona de los números que la última vez (si la hay).
  const lr = state.settings.lastRect;
  if (lr) {
    const img = $('#photoImg');
    dlg.rect = { x: lr.x * img.naturalWidth, y: lr.y * img.naturalHeight, w: lr.w * img.naturalWidth, h: lr.h * img.naturalHeight };
    dlg.rectByUser = false;
    showRectBox();
  }
  // Si la foto es de la galería y es de otro día, usa su fecha.
  if (!dlg.editing && f.lastModified && Math.abs(Date.now() - f.lastModified) > 3600000 && f.lastModified < Date.now()) {
    $('#readingDate').value = toLocalInput(f.lastModified);
  }
  doOcr();
}

// La imagen usa object-fit: contain; calcula la zona real de la foto dentro del recuadro.
function contentBox(r) {
  const img = $('#photoImg');
  const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  return { ox: (r.width - w) / 2, oy: (r.height - h) / 2, s };
}
function showRectBox() {
  const img = $('#photoImg'), box = $('#selBox');
  if (!dlg.rect || !img.naturalWidth) { box.hidden = true; return; }
  const cb = contentBox(img.getBoundingClientRect());
  Object.assign(box.style, { left: cb.ox + dlg.rect.x * cb.s + 'px', top: cb.oy + dlg.rect.y * cb.s + 'px', width: dlg.rect.w * cb.s + 'px', height: dlg.rect.h * cb.s + 'px' });
  box.hidden = false;
}
function saveLastRect() {
  const img = $('#photoImg');
  if (!dlg.rect || !img.naturalWidth) return;
  state.settings.lastRect = { x: dlg.rect.x / img.naturalWidth, y: dlg.rect.y / img.naturalHeight, w: dlg.rect.w / img.naturalWidth, h: dlg.rect.h / img.naturalHeight };
  saveSettings();
}

function bindCrop() {
  const wrap = $('#cropwrap'), box = $('#selBox'), img = $('#photoImg');
  let start = null;
  const pos = (e) => { const r = img.getBoundingClientRect(); return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height), r }; };
  wrap.addEventListener('pointerdown', (e) => { if (!img.naturalWidth) return; wrap.setPointerCapture(e.pointerId); start = pos(e); box.hidden = true; });
  wrap.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = pos(e);
    const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y), w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    box.hidden = w < 8 || h < 8;
  });
  const end = (e) => {
    if (!start) return;
    const p = pos(e), r = p.r, cb = contentBox(r);
    const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y), w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    start = null;
    if (w < 15 || h < 8) { dlg.rect = null; box.hidden = true; return; }
    const nx = Math.max(0, (x - cb.ox) / cb.s), ny = Math.max(0, (y - cb.oy) / cb.s);
    dlg.rect = { x: nx, y: ny, w: Math.min(img.naturalWidth - nx, w / cb.s), h: Math.min(img.naturalHeight - ny, h / cb.s) };
    if (dlg.rect.w < 5 || dlg.rect.h < 5) { dlg.rect = null; box.hidden = true; return; }
    dlg.rectByUser = true;
    // Sin lectura anterior no se puede comprobar el número: guarda la zona igual.
    if (!state.readings.length) saveLastRect();
    doOcr();
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', () => { start = null; });
}

function bindReadingDialog() {
  dlg.el = $('#dlgLectura');
  $('#camInput').addEventListener('change', onPhotoChosen);
  $('#galInput').addEventListener('change', onPhotoChosen);
  $('#btnOcr').addEventListener('click', doOcr);
  $('#readingValue').addEventListener('input', updateReadingHint);
  $('#readingDate').addEventListener('change', updateReadingHint);
  $('#btnCancelLectura').addEventListener('click', () => dlg.el.close());
  $('#formLectura').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = parseNum($('#readingValue').value);
    const time = new Date($('#readingDate').value).getTime();
    if (!(value >= 0)) { alert('Escribe el número del contador.'); return; }
    if (!time) { alert('Pon la fecha.'); return; }
    const prev = prevReadingBefore(time, dlg.editing && dlg.editing.id);
    if (prev && value < prev.value && !confirm('Este número es menor que la lectura anterior. ¿Guardarlo de todos modos?')) return;
    const r = { id: dlg.editing ? dlg.editing.id : newId(), time, value, photo: dlg.photoBlob || null };
    await DB.put('readings', r);
    dlg.el.close();
    await loadAll(); renderAll();
  });
  $('#btnDeleteLectura').addEventListener('click', async () => {
    if (!dlg.editing || !confirm('¿Borrar esta lectura y su foto?')) return;
    await DB.del('readings', dlg.editing.id);
    dlg.el.close();
    await loadAll(); renderAll();
  });
  bindCrop();
}

// ---------- Diálogo de factura ----------
let editingBill = null;
function openBillDialog(b = null) {
  editingBill = b;
  const { start, end } = periodFor(-1);
  $('#b_start').value = timeToDateOnly(b ? b.start : start);
  $('#b_end').value = timeToDateOnly(b ? b.end : end);
  $('#b_kwh').value = b ? b.kwh : '';
  $('#b_amount').value = b ? b.amount : '';
  $('#b_prev').value = b && b.prev != null ? b.prev : '';
  $('#b_curr').value = b && b.curr != null ? b.curr : '';
  $('#btnDeleteFactura').hidden = !b;
  billState.attachment = b && b.attachment ? b.attachment : null;
  showBillAttachment();
  $('#pasteArea').hidden = true; $('#billText').value = '';
  $('#billStatus').textContent = b ? '' : 'Sube la foto o el PDF de la factura y la app llena los datos. También puedes escribirlos.';
  $('#dlgFactura').showModal();
}
function bindBillDialog() {
  const d = $('#dlgFactura');
  $('#btnCancelFactura').addEventListener('click', () => { billState.queue = []; billState.queueTotal = 0; d.close(); });
  $('#formFactura').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = {
      id: editingBill ? editingBill.id : newId(),
      start: dateOnlyToTime($('#b_start').value), end: dateOnlyToTime($('#b_end').value),
      kwh: parseNum($('#b_kwh').value), amount: parseNum($('#b_amount').value),
      prev: parseNum($('#b_prev').value), curr: parseNum($('#b_curr').value),
      attachment: billState.attachment || null,
    };
    if (isNaN(b.prev)) b.prev = null;
    if (isNaN(b.curr)) b.curr = null;
    if (!(b.end > b.start)) { alert('La fecha "hasta" debe ser después de "desde".'); return; }
    if (!(b.kwh >= 0) || !(b.amount >= 0)) { alert('Escribe los kWh y el monto de la factura.'); return; }
    await DB.put('bills', b);
    d.close();
    await loadAll(); renderAll();
    if (typeof nextQueuedBill === 'function') nextQueuedBill(); // varias facturas subidas a la vez
  });
  $('#btnDeleteFactura').addEventListener('click', async () => {
    if (!editingBill || !confirm('¿Borrar esta factura?')) return;
    await DB.del('bills', editingBill.id);
    d.close();
    await loadAll(); renderAll();
  });
  $('#billsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const ds = btn.dataset;
    if (ds.editBill) openBillDialog(state.bills.find((b) => b.id === ds.editBill));
    if (ds.viewBill) {
      const a = state.bills.find((b) => b.id === ds.viewBill).attachment;
      const url = URL.createObjectURL(a.blob);
      const w = window.open(url, '_blank');
      if (!w) { const l = document.createElement('a'); l.href = url; l.download = a.name || 'factura'; l.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
    if (ds.reportBill) {
      const old = btn.textContent; btn.disabled = true; btn.textContent = '⏳ Preparando…';
      try { await reportForBill(state.bills.find((b) => b.id === ds.reportBill)); }
      catch (err) { console.error(err); alert('No se pudo hacer el PDF: ' + err.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    }
  });
}

// ---------- Navegación ----------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + name));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo(0, 0);
}
function renderAll() { renderHome(); renderReadings(); renderBills(); renderSettings(); if (typeof renderCalc === 'function') renderCalc(); if (typeof renderHistory === 'function') renderHistory(); }

// ---------- Inicio de la app ----------
let deferredInstall = null;
async function main() {
  await DB.open();
  await loadAll();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#btnNueva').addEventListener('click', () => openReadingDialog());
  $('#btnNueva2').addEventListener('click', () => openReadingDialog());
  $('#btnFactura').addEventListener('click', () => openBillDialog());
  $('#prevP').addEventListener('click', () => { state.periodOffset--; renderHome(); });
  $('#nextP').addEventListener('click', () => { if (state.periodOffset < 0) { state.periodOffset++; renderHome(); } });
  $('#readingsList').addEventListener('click', (e) => {
    const el = e.target.closest('.reading');
    if (el) openReadingDialog(state.readings.find((r) => r.id === el.dataset.id));
  });
  bindReadingDialog();
  bindBillDialog();
  bindSettings();
  initInforme();
  renderAll();

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#btnInstall').hidden = true; });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((s) => { $('#storageInfo').textContent = `Espacio usado en el teléfono: ${fmtN(s.usage / 1048576, 1)} MB.`; }).catch(() => {});
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}
// Los scripts "defer" corren antes de DOMContentLoaded: así informe.js ya está cargado al iniciar.
document.addEventListener('DOMContentLoaded', () => {
  main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('afterbegin', `<p class="alert bad">Error al iniciar: ${esc(e.message)}</p>`); });
});
