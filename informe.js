/* Mi Luz RD — subir la factura, informe PDF con evidencia y calculadora.
   Usa las funciones y el estado de app.js. */
'use strict';

// ======================================================================
// 1) LEER LA FACTURA (foto, PDF o texto del correo)
// ======================================================================
const billState = { attachment: null }; // {blob, type, name, preview(Blob JPEG)|null}

async function readPdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href;
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(pdf.numPages, 4); i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // Junta los pedazos por renglón (misma altura en la página).
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
      text += items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ') + '\n';
    });
  }
  // Imagen de la primera página para el informe (y para leerla si el PDF es escaneado).
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: Math.min(2.5, 1800 / page.getViewport({ scale: 1 }).width) });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  const preview = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { text, canvas: c, preview };
}

async function ocrDocument(source, status) {
  const w = await getWorker((m) => {
    if (m.status && m.status.includes('loading') && m.progress != null) status(`⏳ Cargando lector… ${Math.round(m.progress * 100)}%`);
  });
  status('🔍 Leyendo la factura (puede tardar unos segundos)…');
  // Escala de grises, ancho ~2000 px.
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const s = Math.min(2.5, 2000 / sw);
  const c = document.createElement('canvas'); c.width = Math.round(sw * s); c.height = Math.round(sh * s);
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.3)'; g.drawImage(source, 0, 0, c.width, c.height);
  await w.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
  const { data } = await w.recognize(c);
  return data.text || '';
}

const MONTHS = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12 };
function parseBillText(raw) {
  const T = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const lines = T.split(/\r?\n/).map((s) => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const out = {};

  // --- Fechas ---
  const findDates = (s) => {
    const res = [];
    let m;
    const re1 = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g;
    while ((m = re1.exec(s))) {
      let [, d, mo, y] = m.map(Number); if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2015 && y <= 2040) res.push(new Date(y, mo - 1, d, 12).getTime());
    }
    const re2 = /(\d{1,2})\s*(?:DE\s+)?[\-\/.]?\s*(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|SET|OCT|NOV|DIC)[A-Z]*\.?\s*(?:DE\s+|DEL\s+)?[\-\/.,]?\s*(\d{4}|\d{2})(?!\d)/g;
    while ((m = re2.exec(s))) {
      let d = Number(m[1]), y = Number(m[3]); if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && y >= 2015 && y <= 2040) res.push(new Date(y, MONTHS[m[2]] - 1, d, 12).getTime());
    }
    return res;
  };
  for (let i = 0; i < lines.length; i++) {
    if (/PERIODO|DESDE|FECHA DE LECTURA|FECHAS DE LECTURA/.test(lines[i])) {
      const ds = findDates(lines[i] + ' ' + (lines[i + 1] || ''));
      if (ds.length >= 2) { out.start = Math.min(...ds.slice(0, 2)); out.end = Math.max(...ds.slice(0, 2)); break; }
    }
  }
  if (!out.start) {
    const all = [...new Set(findDates(lines.join('\n')))].sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const d = (all[j] - all[i]) / DAY;
      if (d >= 25 && d <= 40 && (!best || all[j] > best[1])) best = [all[i], all[j]];
    }
    if (best) { out.start = best[0]; out.end = best[1]; }
  }

  // --- Números ---
  const nums = (s) => (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => ({ raw: x, v: parseNum(x) })).filter((x) => !isNaN(x.v));
  const money = (s) => {
    const m = s.match(/(?:RD\$?|\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})(?!\d)/g);
    return m ? m.map((x) => parseNum(x.replace(/RD\$?|\$/g, ''))).filter((v) => !isNaN(v)) : [];
  };
  const isDateLike = (raw) => /^\d{1,2}[\/\-.]\d{1,2}/.test(raw);
  const readingNums = (s) => nums(s).filter((x) => !isDateLike(x.raw) && Number.isInteger(x.v) && x.v >= 100 && x.v < 10000000);

  // Lecturas anterior / actual
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/LECT/.test(L) && /ANTERIOR|ANT\b/.test(L) && /ACTUAL/.test(L)) {
      const n = readingNums(L.replace(/.*ACTUAL/, '')).concat(readingNums(lines[i + 1] || ''));
      if (n.length >= 2) { out.prev = n[0].v; out.curr = n[1].v; if (n[2] && n[2].v < n[1].v) out.kwh = n[2].v; }
      break;
    }
    if (/LECT/.test(L) && /ANTERIOR/.test(L) && out.prev == null) { const n = readingNums(L.replace(/.*ANTERIOR/, '')).concat(readingNums(lines[i + 1] || '')); if (n.length) out.prev = n[0].v; }
    if (/LECT/.test(L) && /ACTUAL/.test(L) && out.curr == null) { const n = readingNums(L.replace(/.*ACTUAL/, '')).concat(readingNums(lines[i + 1] || '')); if (n.length) out.curr = n[0].v; }
  }
  if (out.prev != null && out.curr != null && out.curr <= out.prev) { delete out.prev; delete out.curr; }

  // kWh consumidos
  if (out.kwh == null) {
    const cands = [];
    lines.forEach((L, i) => {
      if (!/KWH|KW-H|KW\.H/.test(L)) return;
      if (/PRECIO|TARIFA|RD\$\s*\/|\/\s*KWH|POR KWH/.test(L)) return;
      const score = /CONSUMO|ENERGIA|FACTURAD/.test(L) ? 2 : 1;
      for (const x of nums(L)) {
        if (isDateLike(x.raw) || x.v <= 0 || x.v > 20000 || x.v === out.prev || x.v === out.curr) continue;
        if (!Number.isInteger(x.v) && x.v < 20) continue; // precios como 6.05
        cands.push({ v: x.v, score, i });
      }
    });
    cands.sort((a, b) => b.score - a.score || a.i - b.i);
    if (cands.length) out.kwh = cands[0].v;
    else if (out.prev != null && out.curr != null) out.kwh = out.curr - out.prev;
  }

  // Montos
  const findMoney = (labels) => {
    for (const lab of labels) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(lab)) {
          const m = money(lines[i].slice(lines[i].indexOf(lab) + lab.length));
          if (m.length) return m[0];
          const n = money(lines[i + 1] || '');
          if (n.length) return n[0];
        }
      }
    }
    return null;
  };
  const month = findMoney(['TOTAL DEL MES', 'FACTURA DEL MES', 'CARGOS DEL MES', 'FACTURACION DEL MES', 'TOTAL FACTURADO', 'MONTO FACTURADO', 'IMPORTE DEL MES', 'TOTAL MES', 'MONTO DEL MES']);
  const total = findMoney(['TOTAL A PAGAR', 'MONTO A PAGAR', 'TOTAL GENERAL', 'NETO A PAGAR', 'TOTAL']);
  const debt = findMoney(['DEUDA ANTERIOR', 'BALANCE ANTERIOR', 'SALDO ANTERIOR', 'MONTO VENCIDO', 'DEUDA PENDIENTE']);
  if (month != null) out.amount = month;
  else if (total != null) { out.amount = debt ? Math.max(0, total - debt) : total; out.fromTotal = true; }
  if (debt) out.debt = debt;
  if (total != null) out.total = total;

  const nic = T.match(/\bNIC\b[^0-9\n]{0,15}(\d{5,12})/) || T.match(/CONTRATO[^0-9\n]{0,15}(\d{5,12})/);
  if (nic) out.nic = nic[1];
  return out;
}

function applyParsed(p, origin) {
  const set = (id, v) => { if (v != null && !isNaN(v)) $(id).value = v; };
  if (p.start) $('#b_start').value = timeToDateOnly(p.start);
  if (p.end) $('#b_end').value = timeToDateOnly(p.end);
  set('#b_kwh', p.kwh); set('#b_amount', p.amount != null ? p.amount.toFixed(2) : null);
  set('#b_prev', p.prev); set('#b_curr', p.curr);
  if (p.nic && !state.settings.ownerNic) { state.settings.ownerNic = p.nic; saveSettings(); renderSettings(); }
  const found = [], missing = [];
  (p.start ? found : missing).push('fechas');
  (p.kwh != null ? found : missing).push('kWh');
  (p.amount != null ? found : missing).push('monto');
  if (p.prev != null) found.push('lecturas');
  let msg = found.length
    ? `✅ Leí ${origin}: ${found.join(', ')}. Revisa que los números estén bien comparándolos con la factura.`
    : `🤔 No pude sacar los datos ${origin}. Escríbelos tú mirando la factura.`;
  if (missing.length && found.length) msg += ` Faltó: ${missing.join(', ')}.`;
  if (p.fromTotal && p.debt) msg += ` Al total a pagar le resté la deuda anterior (${fmtRD(p.debt)}).`;
  else if (p.fromTotal) msg += ' El monto es el "total a pagar": si incluye deudas atrasadas, réstalas.';
  $('#billStatus').textContent = msg;
}

async function handleBillFile(file) {
  const status = (t) => { $('#billStatus').textContent = t; };
  try {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      status('⏳ Abriendo el PDF…');
      const { text, canvas, preview } = await readPdf(file);
      billState.attachment = { blob: file, type: 'application/pdf', name: file.name, preview };
      showBillAttachment();
      let t = text;
      if (t.replace(/\s/g, '').length < 40) t = await ocrDocument(canvas, status); // PDF escaneado
      applyParsed(parseBillText(t), 'del PDF');
    } else if (file.type.startsWith('image/')) {
      status('⏳ Abriendo la foto…');
      const blob = await shrinkImage(file, 2200, 0.85);
      billState.attachment = { blob, type: 'image/jpeg', name: file.name, preview: blob };
      showBillAttachment();
      const img = await blobToImage(blob);
      applyParsed(parseBillText(await ocrDocument(img, status)), 'de la foto');
    } else if (file.type.startsWith('text/') || /\.(txt|eml)$/i.test(file.name)) {
      applyParsed(parseBillText(await file.text()), 'del correo');
    } else {
      status('Ese tipo de archivo no lo puedo leer. Sube una foto o el PDF de la factura.');
    }
  } catch (e) {
    console.error(e);
    status('No pude leer el archivo (' + e.message + '). Escribe los datos a mano.');
  }
}

function blobToImage(blob) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
}
async function shrinkImage(file, max, q) {
  const img = await blobToImage(file);
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', q));
}

let billAttachURL = null;
function showBillAttachment() {
  const a = billState.attachment;
  if (billAttachURL) { URL.revokeObjectURL(billAttachURL); billAttachURL = null; }
  $('#billAttach').hidden = !a;
  if (!a) return;
  if (a.preview) { billAttachURL = URL.createObjectURL(a.preview); $('#billAttachImg').src = billAttachURL; $('#billAttachImg').hidden = false; }
  else $('#billAttachImg').hidden = true;
  $('#billAttachName').textContent = '📎 ' + (a.name || 'Factura');
}

function initBillImport() {
  $('#billFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleBillFile(f); });
  $('#btnPasteBill').addEventListener('click', () => { $('#pasteArea').hidden = !$('#pasteArea').hidden; if (!$('#pasteArea').hidden) $('#billText').focus(); });
  $('#btnParseText').addEventListener('click', () => {
    const t = $('#billText').value;
    if (!t.trim()) { $('#billStatus').textContent = 'Pega primero el texto del correo.'; return; }
    applyParsed(parseBillText(t), 'del texto del correo');
  });
  $('#btnRemoveAttach').addEventListener('click', () => { billState.attachment = null; showBillAttachment(); });
}

// Archivo compartido desde otra app (por ejemplo, el PDF adjunto de Gmail → Compartir → Mi Luz RD).
async function checkSharedFile() {
  if (!location.search.includes('compartido')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('mi-luz-compartido');
    const fileRes = await cache.match('archivo');
    const textRes = await cache.match('texto');
    await cache.delete('archivo'); await cache.delete('texto');
    if (!fileRes && !textRes) return;
    showView('facturas');
    openBillDialog();
    if (fileRes) {
      const blob = await fileRes.blob();
      const name = decodeURIComponent(fileRes.headers.get('x-nombre') || 'factura');
      await handleBillFile(new File([blob], name, { type: blob.type || fileRes.headers.get('content-type') || '' }));
    } else {
      const t = await textRes.text();
      $('#pasteArea').hidden = false; $('#billText').value = t;
      applyParsed(parseBillText(t), 'del correo');
    }
  } catch (e) { console.warn('compartido', e); }
}

// ======================================================================
// 2) INFORME PDF CON EVIDENCIA
// ======================================================================
const pdfTxt = (s) => String(s).replace(/[   ]/g, ' ').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x00-\xFF]/g, '');
const fmtLong = (t) => new Date(t).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtStamp = (t) => new Date(t).toLocaleString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function nearestReading(t) {
  let best = null;
  for (const r of state.readings) if (!best || Math.abs(r.time - t) < Math.abs(best.time - t)) best = r;
  return best;
}
// Describe de dónde sale una lectura: foto exacta o reparto entre dos fotos.
function pointFromTime(t) {
  const v = energyAt(t);
  if (v == null) return null;
  const R = state.readings;
  const exact = R.find((r) => Math.abs(r.time - t) < 3 * 3600000);
  if (exact) return { time: exact.time, value: exact.value, reading: exact, how: `Foto del ${fmtStamp(exact.time)}` };
  const before = [...R].reverse().find((r) => r.time <= t), after = R.find((r) => r.time >= t);
  return { time: t, value: v, reading: null, dateOnly: true, how: `Calculado entre las fotos del ${fmtDate(before.time)} (${fmtN(before.value)}) y del ${fmtDate(after.time)} (${fmtN(after.value)})` };
}

function buildReport({ start, end, billed = null, attachment = null }) {
  if (!start || !end || end.value == null || start.value == null) throw new Error('Faltan las lecturas de inicio y fin.');
  const measured = end.value - start.value;
  const evidence = state.readings.filter((r) => r.time >= Math.min(start.time, end.time) - 5 * DAY && r.time <= Math.max(start.time, end.time) + 5 * DAY);
  return { start, end, measured, cost: costOf(measured), billed, billedCost: billed && billed.kwh != null ? costOf(billed.kwh) : null, evidence, attachment, created: Date.now() };
}

async function imageInfo(blob) {
  const url = await blobToDataURL(blob);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  return { url, w: img.naturalWidth, h: img.naturalHeight };
}

async function makePdf(rep) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 16;
  const brand = [21, 94, 117];
  const s = state.settings;
  let y = 0;
  const T = (txt, x, yy, opt) => doc.text(pdfTxt(txt), x, yy, opt);
  const ensure = (h) => { if (y + h > H - 18) { doc.addPage(); y = 20; } };
  const para = (txt, size = 9.5, color = [60, 60, 60]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(pdfTxt(txt), W - 2 * M);
    ensure(lines.length * size * 0.45 + 2);
    doc.text(lines, M, y); y += lines.length * size * 0.42 + 2;
  };
  const h2 = (txt) => { ensure(14); y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...brand); T(txt, M, y); y += 2; doc.setDrawColor(...brand); doc.setLineWidth(0.4); doc.line(M, y, W - M, y); y += 6; };
  const table = (head, rows, widths, opts = {}) => {
    const rowH = 6.5;
    const drawHead = () => {
      doc.setFillColor(235, 243, 246); doc.rect(M, y - 4.5, W - 2 * M, rowH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(40, 40, 40);
      let x = M + 1.5; head.forEach((h, i) => { T(h, opts.right && opts.right.includes(i) ? x + widths[i] - 3 : x, y, opts.right && opts.right.includes(i) ? { align: 'right' } : undefined); x += widths[i]; });
      y += rowH;
    };
    ensure(rowH * 2); drawHead();
    doc.setFont('helvetica', 'normal');
    rows.forEach((r, ri) => {
      const cells = r.cells || r;
      const wrapped = cells.map((c, i) => doc.splitTextToSize(pdfTxt(c), widths[i] - 3));
      const lines = Math.max(...wrapped.map((w) => w.length));
      const h = Math.max(rowH, lines * 3.8 + 2.5);
      if (y + h > H - 18) { doc.addPage(); y = 20; drawHead(); doc.setFont('helvetica', 'normal'); }
      if (r.bold) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5); doc.setTextColor(30, 30, 30);
      let x = M + 1.5;
      wrapped.forEach((w, i) => { const right = opts.right && opts.right.includes(i); doc.text(w, right ? x + widths[i] - 3 : x, y, right ? { align: 'right' } : undefined); x += widths[i]; });
      doc.setDrawColor(220, 220, 220); doc.setLineWidth(0.2); doc.line(M, y + h - 4.5, W - M, y + h - 4.5);
      y += h;
    });
    y += 2;
  };

  // --- Encabezado ---
  doc.setFillColor(...brand); doc.rect(0, 0, W, 26, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  T('Informe de consumo eléctrico', M, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  T('Verificación de la factura con fotos del contador', M, 19);
  T('Generado el ' + fmtStamp(rep.created), W - M, 19, { align: 'right' });
  y = 35;

  // --- Datos del cliente ---
  doc.setTextColor(30, 30, 30); doc.setFontSize(9.5);
  const info = [
    ['Cliente', s.ownerName || '-'], ['NIC / Contrato', s.ownerNic || '-'], ['Dirección', s.ownerAddress || '-'],
    ['Distribuidora', DIST_NAMES[s.distributor] || '-'], ['Tarifa', 'BTS-1 residencial - ' + (s.tariffSource || 'valores ajustados por el cliente')],
    ['Período analizado', `${fmtLong(rep.start.time)} al ${fmtLong(rep.end.time)} (${fmtN((rep.end.time - rep.start.time) / DAY, 1)} días)`],
  ];
  info.forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold'); T(k + ':', M, y);
    doc.setFont('helvetica', 'normal'); const l = doc.splitTextToSize(pdfTxt(v), W - 2 * M - 38); doc.text(l, M + 38, y); y += 5 * l.length;
  });
  y += 3;

  // --- Resumen ---
  const b = rep.billed;
  const boxH = b && b.amount != null ? 38 : 24;
  doc.setFillColor(245, 248, 250); doc.setDrawColor(...brand); doc.setLineWidth(0.5); doc.roundedRect(M, y, W - 2 * M, boxH, 2, 2, 'FD');
  let by = y + 8;
  const line = (label, value, color = [30, 30, 30], big = false) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(70, 70, 70); T(label, M + 5, by);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(big ? 14 : 11.5); doc.setTextColor(...color); T(value, W - M - 5, by, { align: 'right' });
    by += big ? 10 : 8;
  };
  line('Según las fotos del contador, debió pagar:', `${fmtRD(rep.cost.total)}  (${fmtN(rep.measured)} kWh)`);
  if (b && b.amount != null) {
    line('La distribuidora cobró:', `${fmtRD(b.amount)}${b.kwh != null ? `  (${fmtN(b.kwh)} kWh)` : ''}`);
    const diff = b.amount - rep.cost.total;
    const dk = b.kwh != null ? b.kwh - rep.measured : null;
    if (diff > 0.5) line('Diferencia cobrada de más:', `${fmtRD(diff)}${dk != null ? `  (${fmtN(dk)} kWh)` : ''}`, [185, 28, 28], true);
    else if (diff < -0.5) line('Diferencia cobrada de menos:', `${fmtRD(-diff)}${dk != null ? `  (${fmtN(-dk)} kWh)` : ''}`, [161, 98, 7], true);
    else line('Diferencia:', 'La factura coincide con la medición', [21, 128, 61], true);
  } else {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
    T(`Promedio: ${fmtN(rep.measured / Math.max(0.01, (rep.end.time - rep.start.time) / DAY), 1)} kWh por día.`, M + 5, by);
  }
  y += boxH + 6;

  // --- Lecturas ---
  h2('Lecturas del contador');
  const when = (p) => (p.dateOnly ? fmtDate(p.time, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : fmtStamp(p.time));
  const rRows = [
    ['Inicio', when(rep.start), fmtN(rep.start.value, rep.start.value % 1 ? 1 : 0), rep.start.how || 'Escrita por el cliente', b && b.prev != null ? fmtN(b.prev) : '-'],
    ['Fin', when(rep.end), fmtN(rep.end.value, rep.end.value % 1 ? 1 : 0), rep.end.how || 'Escrita por el cliente', b && b.curr != null ? fmtN(b.curr) : '-'],
    { cells: ['Consumo', '', fmtN(rep.measured, 1) + ' kWh', '', b && b.kwh != null ? fmtN(b.kwh) + ' kWh' : '-'], bold: true },
  ];
  table(['', 'Fecha', 'Lectura', 'De dónde sale', 'Según factura'], rRows, [18, 44, 22, 70, 30], { right: [2, 4] });

  // --- Cálculo ---
  h2('Cálculo con la tarifa BTS-1');
  para('Precios por escalón de consumo: 0-200 kWh, 201-300 kWh y 301-700 kWh. Si el consumo pasa de 700 kWh, todos los kWh se cobran al precio del último escalón. El cargo fijo depende de si el consumo es de hasta 100 kWh o mayor.', 8.5);
  table(['Consumo medido con las fotos', 'RD$'], rep.cost.lines.map(([k, v]) => [k, fmtN(v, 2)]).concat([{ cells: ['Total que debió pagar', fmtN(rep.cost.total, 2)], bold: true }]), [150, 34], { right: [1] });
  if (rep.billedCost && b) {
    table([`Lo que corresponde a los ${fmtN(b.kwh)} kWh de la factura`, 'RD$'], rep.billedCost.lines.map(([k, v]) => [k, fmtN(v, 2)]).concat([{ cells: ['Total según tarifa', fmtN(rep.billedCost.total, 2)], bold: true }]), [150, 34], { right: [1] });
    const extra = b.amount - rep.billedCost.total;
    if (Math.abs(extra) > Math.max(5, rep.billedCost.total * 0.02)) {
      para(`Nota: por ${fmtN(b.kwh)} kWh la tarifa da ${fmtRD(rep.billedCost.total)}, pero la factura indica ${fmtRD(b.amount)} (diferencia de ${fmtRD(extra)}). Puede deberse a deudas anteriores, recargos u otros cargos incluidos en el monto.`, 8.5, [120, 60, 0]);
    }
  }

  // --- Observaciones ---
  h2('Cómo se hizo la medición');
  para('El cliente tomó fotos del contador con su teléfono. Cada foto queda guardada con su fecha y hora, y la lectura se tomó de la foto. Cuando no hay una foto exactamente en la fecha de lectura de la factura, la lectura de ese día se calcula repartiendo el consumo de forma pareja entre las dos fotos más cercanas (antes y después).', 8.5);
  para('El monto calculado corresponde al cargo por energía y al cargo fijo de la tarifa BTS-1. No incluye deudas anteriores, recargos por mora ni otros cargos.', 8.5);
  para('Este informe puede presentarse junto con la reclamación en la oficina comercial de la distribuidora. Si el cliente no queda conforme con la respuesta, puede acudir a Protecom (Superintendencia de Electricidad).', 8.5);

  // --- Evidencia: lista ---
  if (rep.evidence.length) {
    h2('Evidencia: fotos del contador');
    const ev = rep.evidence;
    table(['#', 'Fecha y hora de la foto', 'Lectura', 'Subió desde la anterior'], ev.map((r, i) => {
      const p = ev[i - 1];
      return [String(i + 1), fmtStamp(r.time), fmtN(r.value, r.value % 1 ? 1 : 0), p ? `${fmtN(r.value - p.value, 1)} kWh en ${fmtN((r.time - p.time) / DAY, 1)} días` : '-'];
    }), [10, 70, 30, 74], { right: [2] });

    // --- Evidencia: fotos (las de inicio y fin primero) ---
    let photos = ev.filter((r) => r.photo);
    const key = [nearestReading(rep.start.time), nearestReading(rep.end.time)].filter((r) => r && r.photo);
    if (photos.length > 24) {
      const step = photos.length / 22;
      const sample = Array.from({ length: 22 }, (_, i) => photos[Math.floor(i * step)]);
      photos = [...new Set([...key, ...sample])].sort((a, b2) => a.time - b2.time);
    }
    if (photos.length) {
      doc.addPage(); y = 20;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...brand); T('Fotos del contador', M, y); y += 6;
      const cols = 2, gap = 6, cw = (W - 2 * M - gap) / cols, ch = 68;
      let col = 0;
      for (const r of photos) {
        if (y + ch + 10 > H - 14) { doc.addPage(); y = 20; col = 0; }
        const x = M + col * (cw + gap);
        try {
          const im = await imageInfo(r.photo);
          const sc = Math.min(cw / im.w, ch / im.h);
          const w = im.w * sc, h = im.h * sc;
          doc.setFillColor(20, 20, 20); doc.rect(x, y, cw, ch, 'F');
          doc.addImage(im.url, 'JPEG', x + (cw - w) / 2, y + (ch - h) / 2, w, h);
        } catch (e) { /* foto dañada: se omite */ }
        const isKey = key.includes(r);
        doc.setFont('helvetica', isKey ? 'bold' : 'normal'); doc.setFontSize(8.5); doc.setTextColor(30, 30, 30);
        T(`${fmtStamp(r.time)}  -  Lectura: ${fmtN(r.value, r.value % 1 ? 1 : 0)}${isKey ? (r === key[0] ? '  (inicio)' : '  (fin)') : ''}`, x, y + ch + 4.5);
        col++;
        if (col === cols) { col = 0; y += ch + 11; }
      }
      if (col) y += ch + 11;
    }
  }

  // --- Factura recibida ---
  if (rep.attachment && rep.attachment.preview) {
    try {
      const im = await imageInfo(rep.attachment.preview);
      doc.addPage(); y = 20;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...brand); T('Factura de la distribuidora', M, y); y += 5;
      const sc = Math.min((W - 2 * M) / im.w, (H - y - 16) / im.h);
      doc.addImage(im.url, 'JPEG', M, y, im.w * sc, im.h * sc);
    } catch (e) { /* sin imagen */ }
  }

  // --- Pie de página ---
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
    T(`Mi Luz RD - Informe de consumo${s.ownerNic ? ' - NIC ' + s.ownerNic : ''}`, M, H - 8);
    T(`Página ${i} de ${n}`, W - M, H - 8, { align: 'right' });
  }
  return doc.output('blob');
}

async function deliverPdf(blob, name) {
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Informe de consumo eléctrico' }); return 'compartido'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelado'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'descargado';
}

async function reportForBill(b) {
  const start = pointFromTime(b.start), end = pointFromTime(b.end);
  if (!start || !end) { alert(`Para hacer el informe necesitas fotos del contador de antes del ${fmtDate(b.start)} y de después del ${fmtDate(b.end)}.`); return; }
  const rep = buildReport({ start, end, billed: b, attachment: b.attachment || null });
  const blob = await makePdf(rep);
  await deliverPdf(blob, `informe-luz-${timeToDateOnly(b.start)}-a-${timeToDateOnly(b.end)}.pdf`);
}

// ======================================================================
// 3) CALCULADORA
// ======================================================================
function readingLabel(r) { return `${fmtDate(r.time, { day: 'numeric', month: 'short', year: 'numeric' })} ${new Date(r.time).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })} - ${fmtN(r.value, r.value % 1 ? 1 : 0)}${r.photo ? ' 📷' : ''}`; }

const calcURLs = {};
function calcPoint(which) {
  const sel = $(`#c_${which}`).value;
  if (sel === 'manual') {
    const v = parseNum($(`#c_${which}Val`).value), t = new Date($(`#c_${which}Date`).value).getTime();
    return isNaN(v) || !t ? null : { time: t, value: v, reading: null, how: 'Escrita por el cliente (sin foto)' };
  }
  const r = state.readings.find((x) => x.id === sel);
  return r ? { time: r.time, value: r.value, reading: r, how: r.photo ? `Foto del ${fmtStamp(r.time)}` : 'Lectura anotada sin foto' } : null;
}

function renderCalcOptions() {
  for (const which of ['start', 'end']) {
    const s = $(`#c_${which}`), prev = s.value;
    const opts = [...state.readings].reverse().map((r) => `<option value="${r.id}">${esc(readingLabel(r))}</option>`).join('');
    s.innerHTML = opts + '<option value="manual">✍️ Escribir a mano</option>';
    if (prev && [...s.options].some((o) => o.value === prev)) s.value = prev;
    else if (state.readings.length) {
      if (which === 'end') s.value = state.readings[state.readings.length - 1].id;
      else { const { start } = periodFor(0); s.value = (nearestReading(start) || state.readings[0]).id; }
    } else s.value = 'manual';
  }
}

function renderCalc() {
  if (!$('#c_start')) return;
  if ($('#c_start').options.length !== state.readings.length + 1) renderCalcOptions();
  const out = $('#c_result'), diffEl = $('#c_diff');
  for (const which of ['start', 'end']) {
    const manual = $(`#c_${which}`).value === 'manual';
    $(`#c_${which}Manual`).hidden = !manual;
    const p = manual ? null : calcPoint(which);
    const img = $(`#c_${which}Img`);
    if (calcURLs[which]) { URL.revokeObjectURL(calcURLs[which]); calcURLs[which] = null; }
    if (p && p.reading && p.reading.photo) { calcURLs[which] = URL.createObjectURL(p.reading.photo); img.src = calcURLs[which]; img.hidden = false; }
    else img.hidden = true;
  }
  const a = calcPoint('start'), b = calcPoint('end');
  if (!a || !b) { out.innerHTML = '<p class="hint">Elige la lectura inicial y la final.</p>'; diffEl.innerHTML = ''; $('#btnCalcPdf').disabled = true; return; }
  if (b.time <= a.time || b.value < a.value) { out.innerHTML = '<div class="alert warn">La lectura final debe ser más reciente y más alta que la inicial.</div>'; diffEl.innerHTML = ''; $('#btnCalcPdf').disabled = true; return; }
  const kwh = b.value - a.value, days = (b.time - a.time) / DAY, c = costOf(kwh);
  out.innerHTML = `<div class="stats">
      <div class="stat"><div class="k">Consumo</div><div class="v">${fmtN(kwh, kwh % 1 ? 1 : 0)}</div><div class="s">kWh en ${fmtN(days, 1)} días</div></div>
      <div class="stat"><div class="k">Por día</div><div class="v">${fmtN(kwh / days, 1)}</div><div class="s">kWh por día</div></div>
      <div class="stat hero"><div class="k">Según el contador debes pagar</div><div class="v">${fmtRD(c.total)}</div><div class="s">con la tarifa BTS-1</div></div>
    </div>
    <table class="breakdown">${c.lines.map(([k, v]) => `<tr><td>${k}</td><td>${fmtN(v, 2)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td>${fmtRD(c.total)}</td></tr></table>`;
  const billedAmount = parseNum($('#c_billAmount').value), billedKwh = parseNum($('#c_billKwh').value);
  if (!isNaN(billedAmount)) {
    const d = billedAmount - c.total;
    const dk = !isNaN(billedKwh) ? billedKwh - kwh : null;
    diffEl.innerHTML = d > 0.5
      ? `<div class="alert bad big-alert">Te cobraron de más:<b>${fmtRD(d)}</b>${dk != null ? `<span>${fmtN(dk)} kWh más de lo que marca tu contador</span>` : ''}</div>`
      : d < -0.5
        ? `<div class="alert warn big-alert">Te cobraron de menos:<b>${fmtRD(-d)}</b><span>Puede ser una lectura estimada; lo pueden cobrar después.</span></div>`
        : '<div class="alert good big-alert">✅ La factura coincide con tu contador.</div>';
  } else diffEl.innerHTML = '<p class="hint">Escribe lo que te cobró la distribuidora para ver la diferencia.</p>';
  $('#btnCalcPdf').disabled = false;
}

async function calcPdf() {
  const a = calcPoint('start'), b = calcPoint('end');
  if (!a || !b) return;
  const amount = parseNum($('#c_billAmount').value), kwh = parseNum($('#c_billKwh').value);
  const billed = isNaN(amount) ? null : { amount, kwh: isNaN(kwh) ? null : kwh, prev: null, curr: null };
  const btn = $('#btnCalcPdf'); btn.disabled = true; btn.textContent = '⏳ Preparando el PDF…';
  try {
    const blob = await makePdf(buildReport({ start: a, end: b, billed }));
    await deliverPdf(blob, `informe-luz-${timeToDateOnly(a.time)}-a-${timeToDateOnly(b.time)}.pdf`);
  } catch (e) { console.error(e); alert('No se pudo hacer el PDF: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '📄 Hacer informe PDF con las fotos'; }
}

function initCalc() {
  ['c_start', 'c_end'].forEach((id) => $('#' + id).addEventListener('change', () => {
    const which = id.slice(2);
    if ($('#' + id).value === 'manual' && !$(`#c_${which}Date`).value) $(`#c_${which}Date`).value = toLocalInput(Date.now());
    renderCalc();
  }));
  ['c_startVal', 'c_startDate', 'c_endVal', 'c_endDate', 'c_billAmount', 'c_billKwh'].forEach((id) => $('#' + id).addEventListener('input', renderCalc));
  $('#btnCalcPdf').addEventListener('click', calcPdf);
}

function initInforme() {
  initBillImport();
  initCalc();
  checkSharedFile();
}
