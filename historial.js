/* Mi Luz RD — historial de facturas.
   1) Botón para abrir la oficina virtual de la distribuidora con el NIC copiado.
   2) Revisión de todas las facturas guardadas: lecturas que no siguen, kWh que no salen de las lecturas,
      días cobrados dos veces, meses inflados y montos que no cuadran con la tarifa.
   3) Informe PDF del historial. */
'use strict';

// Oficinas virtuales (verificadas el 8 nov 2026: las tres piden usuario y contraseña; no hay consulta pública por NIC).
const PORTALS = {
  edesur: { name: 'Edesur', url: 'https://ov.edesur.com.do/' },
  edenorte: { name: 'Edenorte', url: 'https://ofv.edenorte.com.do/' },
  edeeste: { name: 'Edeeste', url: 'https://oficinavirtual.edeeste.com.do/' },
};
// Desde cuándo rige la tarifa oficial cargada en la app (SIE-121-2026-TF).
const TARIFF_FROM = new Date(2026, 9, 1).getTime();

const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const okNum = (v) => v != null && !isNaN(v);
const dShort = (t) => fmtDate(t, { day: 'numeric', month: 'short', year: 'numeric' });

function analyzeHistory() {
  const bills = [...state.bills].sort((a, b) => a.start - b.start);
  const rows = bills.map((b) => ({ b, days: Math.max(1, Math.round((b.end - b.start) / DAY)), issues: [], extra: 0 }));
  rows.forEach((r) => { r.perDay = r.b.kwh / r.days; });

  rows.forEach((r, i) => {
    const b = r.b, prevRow = rows[i - 1];
    const add = (level, text, money = 0) => { r.issues.push({ level, text, money }); if (level === 'bad') r.extra = Math.max(r.extra, money); };

    // 1) kWh = lectura actual − lectura anterior
    if (okNum(b.prev) && okNum(b.curr)) {
      const fromReadings = b.curr - b.prev;
      const d = b.kwh - fromReadings;
      if (fromReadings < 0) add('warn', `La lectura actual (${fmtN(b.curr)}) es menor que la anterior (${fmtN(b.prev)}). Puede ser cambio de contador; pregunte en la distribuidora.`);
      else if (Math.abs(d) > 1) {
        const money = d > 0 ? costOf(b.kwh).total - costOf(fromReadings).total : 0;
        add(d > 0 ? 'bad' : 'warn', `Cobran ${fmtN(b.kwh)} kWh, pero las lecturas de la misma factura dan ${fmtN(fromReadings)} kWh (${fmtN(b.curr)} − ${fmtN(b.prev)})${d > 0 ? `: ${fmtN(d)} kWh de más, unos ${fmtRD(money)}` : ''}.`, money);
      }
    }

    if (prevRow) {
      const p = prevRow.b;
      // 2) Fechas: días cobrados dos veces o días sin factura
      const overlap = Math.round((p.end - b.start) / DAY);
      if (overlap > 1) add('warn', `Esta factura empieza el ${dShort(b.start)}, pero la anterior terminó el ${dShort(p.end)}: ${overlap} días aparecen en las dos facturas.`);
      else if (overlap < -3) add('info', `Entre la factura anterior (terminó ${dShort(p.end)}) y esta hay ${-overlap} días sin factura anotada.`);

      // 3) La lectura anterior debe ser la lectura actual de la factura pasada
      if (okNum(b.prev) && okNum(p.curr) && Math.abs(overlap) <= 3) {
        const gap = b.prev - p.curr;
        if (gap < -1) {
          const dup = Math.min(-gap, b.kwh);
          const money = costOf(b.kwh).total - costOf(b.kwh - dup).total;
          add('bad', `La lectura anterior de esta factura (${fmtN(b.prev)}) es menor que la lectura con que cerró la factura pasada (${fmtN(p.curr)}): <b>${fmtN(-gap)} kWh se cobraron dos veces</b>, unos ${fmtRD(money)}.`, money);
        } else if (gap > 1) {
          add('warn', `La lectura anterior de esta factura (${fmtN(b.prev)}) no sigue de la factura pasada (${fmtN(p.curr)}): ${fmtN(gap)} kWh quedaron fuera de las dos. Pregunte si se los van a cobrar aparte.`);
        }
      }
    }

    // 4) Monto contra la tarifa
    const tariffCost = costOf(b.kwh).total;
    const td = b.amount - tariffCost;
    if (Math.abs(td) > Math.max(5, tariffCost * 0.02)) {
      if (b.end >= TARIFF_FROM) {
        add(td > 0 ? 'bad' : 'warn', `Por ${fmtN(b.kwh)} kWh la tarifa BTS-1 da ${fmtRD(tariffCost)}, pero cobraron ${fmtRD(b.amount)} (${td > 0 ? '+' : ''}${fmtRD(td)}). Si el monto incluye deudas, recargos u otros cargos, réstelos al anotar la factura.`, Math.max(0, td));
      } else {
        add('info', `Con la tarifa de hoy, ${fmtN(b.kwh)} kWh costarían ${fmtRD(tariffCost)} y cobraron ${fmtRD(b.amount)}. La tarifa de esa fecha puede haber sido distinta, así que esto es solo de referencia.`);
      }
    }

    // 5) Comparación con las fotos del contador
    const m0 = energyAt(b.start), m1 = energyAt(b.end);
    if (m0 != null && m1 != null) {
      const mine = m1 - m0, d = b.kwh - mine;
      r.mine = mine;
      if (d > Math.max(3, mine * 0.05)) {
        const money = costOf(b.kwh).total - costOf(mine).total;
        add('bad', `Según sus fotos del contador gastó ${fmtN(mine)} kWh y le cobraron ${fmtN(b.kwh)}: <b>${fmtN(d)} kWh de más</b>, unos ${fmtRD(money)}.`, money);
      } else if (d < -Math.max(3, mine * 0.05)) {
        add('warn', `Le cobraron ${fmtN(-d)} kWh menos de lo que marcan sus fotos: puede ser lectura estimada; el resto se lo pueden cobrar después.`);
      }
    }
  });

  // 6) Meses fuera de lo normal (necesita al menos 4 facturas)
  if (rows.length >= 4) {
    rows.forEach((r, i) => {
      const others = rows.filter((x) => x !== r).map((x) => x.perDay);
      const med = median(others);
      if (med <= 0) return;
      const ratio = r.perDay / med;
      r.ratio = ratio;
      if (ratio >= 1.6) {
        const prevLow = rows[i - 1] && rows[i - 1].perDay / med <= 0.6;
        r.issues.push({ level: 'warn', text: `Este mes salió en ${fmtN(r.perDay, 1)} kWh por día, ${fmtN(ratio, 1)} veces lo normal en su historial (${fmtN(med, 1)} kWh/día).${prevLow ? ' El mes anterior salió muy bajo: eso pasa cuando un mes se <b>estima</b> sin leer el contador y al siguiente se cobra la diferencia junta (y con la tarifa más cara).' : ' Si en su casa no cambió nada, pida que revisen la lectura.'}` });
        if (prevLow) {
          // Lo que cuesta de más cobrar los dos meses por separado en vez de repartido parejo.
          const a = rows[i - 1].b, b = r.b;
          const total = a.kwh + b.kwh;
          const evenA = total * rows[i - 1].days / (rows[i - 1].days + r.days);
          const charged = costOf(a.kwh).total + costOf(b.kwh).total;
          const fair = costOf(evenA).total + costOf(total - evenA).total;
          if (charged - fair > 5) {
            r.issues.push({ level: 'warn', text: `Si esos ${fmtN(total)} kWh se hubieran repartido parejo entre los dos meses, habría pagado ${fmtRD(fair)} en vez de ${fmtRD(charged)}: <b>${fmtRD(charged - fair)} de más</b> por la acumulación${b.end < TARIFF_FROM ? ' (calculado con la tarifa de hoy; con la de esa fecha la cifra cambia un poco)' : ''}.`, money: charged - fair });
            r.extra = Math.max(r.extra, charged - fair);
          }
        }
      } else if (ratio <= 0.5) {
        r.issues.push({ level: 'info', text: `Este mes salió muy bajo (${fmtN(r.perDay, 1)} kWh/día contra ${fmtN(med, 1)} normal). Si no estuvo fuera de casa, puede ser una lectura estimada.` });
      }
    });
  }

  const totalKwh = rows.reduce((s, r) => s + r.b.kwh, 0);
  const totalAmount = rows.reduce((s, r) => s + r.b.amount, 0);
  const totalExtra = rows.reduce((s, r) => s + r.extra, 0);
  const medPerDay = rows.length ? median(rows.map((r) => r.perDay)) : 0;
  return { rows, totalKwh, totalAmount, totalExtra, medPerDay };
}

// ---------- Pantalla ----------
function renderPortal() {
  const p = PORTALS[state.settings.distributor];
  $('#h_nic').value = state.settings.ownerNic || '';
  $('#btnPortal').textContent = p ? `🔎 Copiar NIC y abrir la Oficina Virtual de ${p.name}` : '🔎 Elija su distribuidora en Ajustes';
  $('#btnPortal').disabled = !p;
}

function renderHistory() {
  if (!$('#history')) return;
  renderPortal();
  const el = $('#history');
  if (state.bills.length < 2) {
    el.innerHTML = `<div class="card"><h3>📊 Revisar el historial</h3><p class="hint">Anote al menos 2 facturas (mejor 6 o 12 meses) y aquí verá si la distribuidora calculó bien: lecturas que no siguen, kWh de más, meses inflados y montos que no cuadran con la tarifa.</p></div>`;
    return;
  }
  const h = analyzeHistory();
  const bad = h.rows.filter((r) => r.extra > 0.5).length;
  const warn = h.rows.filter((r) => r.issues.some((i) => i.level === 'warn')).length;
  const maxPD = Math.max(...h.rows.map((r) => r.perDay), 1);
  const head = h.totalExtra > 0.5
    ? `<div class="alert bad big-alert">Posible cobro de más en el historial<b>${fmtRD(h.totalExtra)}</b><span>en ${bad} de ${h.rows.length} facturas</span></div>`
    : warn
      ? `<div class="alert warn">No encontré cobros de más seguros, pero hay ${warn} factura(s) para revisar.</div>`
      : `<div class="alert good">✅ Las ${h.rows.length} facturas cuadran entre sí y con la tarifa.</div>`;
  const list = h.rows.slice().reverse().map((r) => {
    const lvl = r.extra > 0.5 ? 'bad' : r.issues.some((i) => i.level === 'warn') ? 'warn' : r.issues.length ? 'info' : 'good';
    const icon = { bad: '⚠️', warn: '🔸', info: 'ℹ️', good: '✅' }[lvl];
    const issues = r.issues.length
      ? r.issues.map((i) => `<div class="alert ${i.level === 'info' ? 'info-soft' : i.level}">${i.text}</div>`).join('')
      : '<p class="hint">Todo cuadra.</p>';
    return `<details class="hist-row ${lvl}"><summary>
        <span class="hm">${icon} ${fmtDate(r.b.end, { month: 'short', year: 'numeric' })}</span>
        <span class="hbar"><i style="width:${Math.max(3, r.perDay / maxPD * 100)}%"></i></span>
        <span class="hv">${fmtN(r.b.kwh)} kWh<br><small>${fmtRD(r.b.amount)}</small></span></summary>
        <p class="hint">${dShort(r.b.start)} → ${dShort(r.b.end)} · ${r.days} días · ${fmtN(r.perDay, 1)} kWh/día${okNum(r.b.prev) && okNum(r.b.curr) ? ` · lecturas ${fmtN(r.b.prev)} → ${fmtN(r.b.curr)}` : ''}</p>
        ${issues}</details>`;
  }).join('');
  el.innerHTML = `<div class="card"><h3>📊 Revisión del historial</h3>${head}
    <p class="hint">${h.rows.length} facturas · ${fmtN(h.totalKwh)} kWh · ${fmtRD(h.totalAmount)} cobrados · lo normal en su casa: ${fmtN(h.medPerDay, 1)} kWh por día. Toque un mes para ver el detalle.</p>
    ${list}
    <button class="primary" id="btnHistPdf">📄 Informe PDF del historial</button>
    <p class="hint">Las facturas sin lecturas (anterior y actual) se revisan menos. Anótelas siempre que la factura las traiga.</p></div>`;
  $('#btnHistPdf').addEventListener('click', historyPdf);
}

// ---------- Informe PDF del historial ----------
async function historyPdf() {
  const btn = $('#btnHistPdf');
  btn.disabled = true; btn.textContent = '⏳ Preparando…';
  try {
    const h = analyzeHistory(), s = state.settings;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 16, brand = [21, 94, 117];
    let y = 0;
    const T = (t, x, yy, o) => doc.text(pdfTxt(t), x, yy, o);
    const ensure = (n) => { if (y + n > H - 18) { doc.addPage(); y = 20; } };
    const strip = (t) => String(t).replace(/<[^>]+>/g, '');
    const para = (t, size = 9.5, color = [60, 60, 60], bold = false) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(pdfTxt(strip(t)), W - 2 * M);
      ensure(lines.length * size * 0.45 + 2); doc.text(lines, M, y); y += lines.length * size * 0.42 + 2;
    };
    const h2 = (t) => { ensure(14); y += 3; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...brand); T(t, M, y); y += 2; doc.setDrawColor(...brand); doc.setLineWidth(0.4); doc.line(M, y, W - M, y); y += 6; };

    doc.setFillColor(...brand); doc.rect(0, 0, W, 26, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
    T('Revisión del historial de facturas', M, 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    T('Verificación de la facturación eléctrica', M, 19);
    T('Generado el ' + fmtStamp(Date.now()), W - M, 19, { align: 'right' });
    y = 35;
    const first = h.rows[0].b, last = h.rows[h.rows.length - 1].b;
    [['Cliente', s.ownerName || '-'], ['NIC / Contrato', s.ownerNic || '-'], ['Dirección', s.ownerAddress || '-'],
      ['Distribuidora', DIST_NAMES[s.distributor] || '-'],
      ['Facturas revisadas', `${h.rows.length}, del ${fmtLong(first.start)} al ${fmtLong(last.end)}`],
      ['Tarifa usada', 'BTS-1 residencial - ' + (s.tariffSource || 'valores ajustados por el cliente')]].forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30); T(k + ':', M, y);
      doc.setFont('helvetica', 'normal'); const l = doc.splitTextToSize(pdfTxt(v), W - 2 * M - 40); doc.text(l, M + 40, y); y += l.length * 4.4 + 1;
    });

    y += 3;
    const boxH = 22;
    doc.setFillColor(h.totalExtra > 0.5 ? 254 : 220, h.totalExtra > 0.5 ? 226 : 252, h.totalExtra > 0.5 ? 226 : 231);
    doc.roundedRect(M, y, W - 2 * M, boxH, 3, 3, 'F');
    doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    T(`Total facturado: ${fmtN(h.totalKwh)} kWh - ${fmtRD(h.totalAmount)}`, M + 5, y + 7);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    T(h.totalExtra > 0.5 ? `Posible cobro de más: ${fmtRD(h.totalExtra)}` : 'No se encontraron cobros de más seguros', M + 5, y + 16);
    y += boxH + 6;

    h2('Facturas');
    const widths = [34, 22, 24, 28, 26, W - 2 * M - 134];
    const head = ['Período', 'Días', 'kWh', 'Monto RD$', 'kWh/día', 'Lecturas'];
    const drawHead = () => {
      doc.setFillColor(235, 243, 246); doc.rect(M, y - 4.5, W - 2 * M, 6.5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(40, 40, 40);
      let x = M + 1.5; head.forEach((t, i) => { T(t, x, y); x += widths[i]; }); y += 6.5;
    };
    ensure(14); drawHead();
    h.rows.forEach((r) => {
      if (y + 6.5 > H - 18) { doc.addPage(); y = 20; drawHead(); }
      const mark = r.extra > 0.5 ? ' (!)' : '';
      const cells = [`${fmtDate(r.b.start, { day: '2-digit', month: '2-digit', year: '2-digit' })} - ${fmtDate(r.b.end, { day: '2-digit', month: '2-digit', year: '2-digit' })}${mark}`,
        String(r.days), fmtN(r.b.kwh), fmtN(r.b.amount, 2), fmtN(r.perDay, 1), okNum(r.b.prev) && okNum(r.b.curr) ? `${fmtN(r.b.prev)} -> ${fmtN(r.b.curr)}` : '-'];
      doc.setFont('helvetica', mark ? 'bold' : 'normal'); doc.setFontSize(8.5); doc.setTextColor(30, 30, 30);
      let x = M + 1.5; cells.forEach((c, i) => { T(c, x, y); x += widths[i]; });
      doc.setDrawColor(220, 220, 220); doc.setLineWidth(0.2); doc.line(M, y + 2, W - M, y + 2);
      y += 6.5;
    });

    h2('Hallazgos');
    const withIssues = h.rows.filter((r) => r.issues.length);
    if (!withIssues.length) para('Todas las facturas cuadran entre sí y con la tarifa.');
    withIssues.forEach((r) => {
      para(`${fmtLong(r.b.start)} al ${fmtLong(r.b.end)} (${fmtN(r.b.kwh)} kWh, ${fmtRD(r.b.amount)})`, 10, [30, 30, 30], true);
      r.issues.forEach((i) => para(`${i.level === 'bad' ? '[Cobro de más] ' : i.level === 'warn' ? '[Revisar] ' : '[Nota] '}${i.text}`, 9.2));
      y += 1;
    });

    h2('Cómo se revisó');
    [
      'Cada factura se comparó consigo misma (kWh cobrados contra lectura actual menos lectura anterior) y con la factura anterior (la lectura anterior de una factura debe ser la lectura final de la pasada, y los períodos no deben repetirse).',
      `El monto se comparó con la tarifa BTS-1 (${s.tariffSource || 'valores del cliente'}). Para facturas anteriores a esa tarifa la comparación es solo de referencia y no se suma al cobro de más.`,
      'Un mes con más de 1.6 veces el consumo diario normal del historial se marca para revisar; si viene después de un mes muy bajo, suele ser una lectura estimada seguida de un cobro acumulado, que sale más caro por los escalones de la tarifa.',
      'Cuando hay fotos del contador del cliente en las fechas de la factura, también se compara con lo medido en las fotos.',
      'El "posible cobro de más" suma, por factura, el mayor de los montos de más encontrados (no se suman dos veces). Los datos de las facturas los anotó el cliente a partir de sus facturas.',
      'El cliente puede presentar este informe en la oficina comercial de su distribuidora y, si no queda conforme, en Protecom (Superintendencia de Electricidad).',
    ].forEach((t) => para('- ' + t, 9));

    // Imágenes de las facturas que las tengan
    for (const r of h.rows) {
      const a = r.b.attachment;
      if (!a || !a.preview) continue;
      try {
        const im = await imageInfo(a.preview);
        doc.addPage(); y = 20;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...brand);
        T(`Factura ${fmtLong(r.b.start)} al ${fmtLong(r.b.end)}`, M, y); y += 5;
        const sc = Math.min((W - 2 * M) / im.w, (H - y - 16) / im.h);
        doc.addImage(im.url, 'JPEG', M, y, im.w * sc, im.h * sc);
      } catch (e) { /* sin imagen */ }
    }

    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
      T(`Mi Luz RD - Historial de facturas${s.ownerNic ? ' - NIC ' + s.ownerNic : ''}`, M, H - 8);
      T(`Página ${i} de ${n}`, W - M, H - 8, { align: 'right' });
    }
    await deliverPdf(doc.output('blob'), `historial-luz-${s.ownerNic || 'facturas'}.pdf`);
  } catch (e) { console.error(e); alert('No se pudo hacer el PDF: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '📄 Informe PDF del historial'; }
}

// ---------- Varias facturas a la vez ----------
// Se revisa una por una: al guardar una, se abre la siguiente.
function startBillQueue(files) {
  billState.queue = files.slice(1);
  billState.queueTotal = files.length;
  handleBillFile(files[0]).then(queueNote);
}
function queueNote() {
  if (!billState.queueTotal || billState.queueTotal < 2) return;
  const n = billState.queueTotal - billState.queue.length;
  $('#billStatus').textContent = `Factura ${n} de ${billState.queueTotal}. ` + $('#billStatus').textContent;
}
function nextQueuedBill() {
  if (!billState.queue || !billState.queue.length) { billState.queueTotal = 0; return; }
  const f = billState.queue.shift();
  openBillDialog();
  handleBillFile(f).then(queueNote);
}

// ---------- Inicio ----------
function initHistorial() {
  $('#h_nic').addEventListener('change', async (e) => {
    state.settings.ownerNic = e.target.value.trim(); await saveSettings(); renderSettings();
  });
  $('#btnPortal').addEventListener('click', async () => {
    const p = PORTALS[state.settings.distributor];
    if (!p) return;
    const nic = ($('#h_nic').value || '').trim();
    let copied = false;
    if (nic) { try { await navigator.clipboard.writeText(nic); copied = true; } catch (e) { /* sin permiso */ } }
    $('#portalStatus').textContent = nic
      ? (copied ? `✅ NIC ${nic} copiado. Péguelo donde la página lo pida.` : `Su NIC es ${nic}.`)
      : 'Escriba su NIC arriba para tenerlo a mano.';
    window.open(p.url, '_blank', 'noopener');
  });
  $('#billFile').multiple = true;
}
