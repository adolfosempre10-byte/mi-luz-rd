// Cálculo de calificaciones según el modelo del boletín por competencias:
//  - Cada asignatura tiene 4 bloques de competencias fundamentales (C1–C4), cada uno con nota en P1–P4
//    y una Recuperación Pedagógica (RP) opcional por período. Si hay RP, cuenta la mayor de las dos.
//  - PC (promedio de la competencia) = promedio de los 4 períodos.
//  - C.F. (calificación final del área) = promedio de los 4 PC.
//  - Si C.F. < nota mínima: Completiva  → (C.F.·pesoCompletiva% + C.C.F.·resto%)
//                            Extraordinaria → (C.F.·pesoExtraordinaria% + C.Ex.·resto%)
//                            Evaluación especial → la nota de esa evaluación.
// Los porcentajes y la nota mínima se cambian en "Centro educativo" por si la ordenanza vigente cambia.
'use strict';
const Calc = (() => {
  const redondo = x => Math.round(x);
  const prom = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const num = v => (v === undefined || v === null || v === '') ? null : Number(v);

  function efectiva(reg, comp, p) {
    if (!reg) return null;
    const c = num(reg[`c${comp}${p}`]), r = num(reg[`r${comp}${p}`]);
    if (c == null) return r;
    return r != null ? Math.max(c, r) : c;
  }

  const bloques = modelo => modelo === 'periodos' ? 1 : 4;

  // Resultado de una asignatura para un estudiante.
  function area(reg, modelo, centro) {
    const min = centro.notaMinima ?? 70;
    if (modelo === 'cualitativo') {
      const q = [0, 1, 2, 3].map(c => [0, 1, 2, 3].map(p => reg ? reg[`q${c}${p}`] || null : null));
      return { cualitativo: true, q, condicion: '', texto: '' };
    }
    const nb = bloques(modelo);
    const pc = [], pcCompleto = [];
    for (let c = 0; c < nb; c++) {
      const per = [0, 1, 2, 3].map(p => efectiva(reg, c, p));
      const a = prom(per);
      pc.push(a == null ? null : redondo(a));
      pcCompleto.push(per.every(x => x != null));
    }
    const a = prom(pc);
    const cf = a == null ? null : redondo(a);
    const completo = pcCompleto.every(Boolean);
    const r = { pc, pcCompleto, cf, completo, ccf: num(reg?.ccf), cex: num(reg?.cex), ce: num(reg?.ce),
      cfc: null, cfe: null, final: null, condicion: '', instancia: '', texto: '' };
    if (!completo) { r.texto = cf == null ? 'Sin notas' : (cf < min ? 'En riesgo' : 'En curso'); r.riesgo = cf != null && cf < min; return r; }
    if (cf >= min) return Object.assign(r, { final: cf, condicion: 'A', instancia: 'Ordinaria', texto: 'Aprobado' });
    const pC = (centro.pesoCompletiva ?? 50) / 100;
    if (r.ccf == null) return Object.assign(r, { condicion: 'P', instancia: 'Completiva', texto: 'Va a completiva', riesgo: true });
    r.cfc = redondo(cf * pC + r.ccf * (1 - pC));
    if (r.cfc >= min) return Object.assign(r, { final: r.cfc, condicion: 'A', instancia: 'Completiva', texto: 'Aprobado en completiva' });
    const pE = (centro.pesoExtraordinaria ?? 30) / 100;
    if (r.cex == null) return Object.assign(r, { condicion: 'P', instancia: 'Extraordinaria', texto: 'Va a extraordinaria', riesgo: true });
    r.cfe = redondo(cf * pE + r.cex * (1 - pE));
    if (r.cfe >= min) return Object.assign(r, { final: r.cfe, condicion: 'A', instancia: 'Extraordinaria', texto: 'Aprobado en extraordinaria' });
    if (r.ce == null) return Object.assign(r, { condicion: 'P', instancia: 'Especial', texto: 'Va a evaluación especial', riesgo: true });
    if (r.ce >= min) return Object.assign(r, { final: r.ce, condicion: 'A', instancia: 'Especial', texto: 'Aprobado en evaluación especial' });
    return Object.assign(r, { final: r.ce, condicion: 'R', instancia: 'Especial', texto: 'Reprobado', riesgo: true });
  }

  // Promedio de un período (todas las competencias) para la vista por período.
  function promedioPeriodo(reg, modelo, p) {
    const a = prom([...Array(bloques(modelo)).keys()].map(c => efectiva(reg, c, p)));
    return a == null ? null : redondo(a);
  }

  // Resumen de asistencia de un estudiante: total y por período.
  function asistencia(asis, cursoId, estId, periodos) {
    const res = { total: nuevo(), per: periodos.map(nuevo) };
    function nuevo() { return { dias: 0, P: 0, A: 0, T: 0, E: 0, pct: null }; }
    for (const [k, dia] of Object.entries(asis || {})) {
      const [cid, fecha] = k.split('|');
      if (cid !== cursoId) continue;
      const m = dia[estId] || 'P';
      const suma = t => { t.dias++; t[m]++; };
      suma(res.total);
      periodos.forEach((p, i) => { if (p.desde && p.hasta && fecha >= p.desde && fecha <= p.hasta) suma(res.per[i]); });
    }
    for (const t of [res.total, ...res.per]) t.pct = t.dias ? redondo(100 * (t.P + t.T) / t.dias) : null;
    return res;
  }

  return { efectiva, area, promedioPeriodo, asistencia, bloques, prom, redondo };
})();
if (typeof module !== 'undefined') module.exports = Calc;
