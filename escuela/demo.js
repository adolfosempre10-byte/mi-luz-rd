// Valores iniciales del centro y datos de ejemplo (nombres inventados) para probar el sistema.
'use strict';

function centroPorDefecto() {
  return {
    nombre: 'Mi Centro Educativo', codigo: '', regional: '', distrito: '', director: '', direccion: '', telefono: '', sector: 'Público',
    anoEscolar: '2026-2027',
    notaMinima: 70, pesoCompletiva: 50, pesoExtraordinaria: 30, asistenciaMinima: 80,
    competencias: [
      'Comunicativa',
      'Pensamiento Lógico, Creativo y Crítico; Resolución de Problemas',
      'Científica y Tecnológica; Ambiental y de la Salud',
      'Ética y Ciudadana; Desarrollo Personal y Espiritual',
    ],
    periodos: [
      { nombre: 'P1', desde: '2026-08-24', hasta: '2026-10-30' },
      { nombre: 'P2', desde: '2026-11-02', hasta: '2027-01-22' },
      { nombre: 'P3', desde: '2027-01-25', hasta: '2027-03-26' },
      { nombre: 'P4', desde: '2027-04-05', hasta: '2027-06-18' },
    ],
    cerrados: [false, false, false, false, false],
  };
}

function crearDatosDeEjemplo(nuevoId, hashClave) {
  // Generador fijo para que el ejemplo salga siempre igual.
  let s = 20262027;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const elige = a => a[Math.floor(rnd() * a.length)];

  const centro = Object.assign(centroPorDefecto(), {
    nombre: 'Centro Educativo Ejemplo', codigo: '00000', regional: '10 - Santo Domingo', distrito: '10-01',
    director: 'Lic. Ana Martínez', direccion: 'Calle Principal #1', telefono: '809-000-0000', cerrados: [true, false, false, false, false],
  });
  const usuario = (nombre, user, clave, rol, extra = {}) => Object.assign({ id: nuevoId(), nombre, usuario: user, rol, activo: true, estudianteIds: [] }, hashClave(clave), extra);
  const dir = usuario('Lic. Ana Martínez', 'direccion', 'direccion123', 'admin');
  const docentes = [
    usuario('Prof. Luis Pérez', 'lperez', 'docente123', 'docente'),
    usuario('Profa. Carmen Rosario', 'crosario', 'docente123', 'docente'),
    usuario('Prof. José Familia', 'jfamilia', 'docente123', 'docente'),
    usuario('Profa. María Jiménez', 'mjimenez', 'docente123', 'docente'),
  ];
  const cursos = [
    { id: nuevoId(), nivel: 'secundaria', grado: 1, seccion: 'A', tanda: 'Matutina', modelo: 'competencias', titularId: docentes[0].id },
    { id: nuevoId(), nivel: 'secundaria', grado: 2, seccion: 'A', tanda: 'Matutina', modelo: 'competencias', titularId: docentes[1].id },
    { id: nuevoId(), nivel: 'primaria', grado: 5, seccion: 'A', tanda: 'Vespertina', modelo: 'competencias', titularId: docentes[2].id },
    { id: nuevoId(), nivel: 'primaria', grado: 2, seccion: 'A', tanda: 'Vespertina', modelo: 'cualitativo', titularId: docentes[3].id },
  ];
  const sec = ['Lengua Española', 'Lenguas Extranjeras (Inglés)', 'Matemática', 'Ciencias Sociales', 'Ciencias de la Naturaleza', 'Educación Artística', 'Educación Física', 'Formación Integral Humana y Religiosa'];
  const pri = ['Lengua Española', 'Matemática', 'Ciencias Sociales', 'Ciencias de la Naturaleza', 'Educación Artística', 'Educación Física', 'Formación Integral Humana y Religiosa'];
  const cargas = [];
  cursos.forEach((c, ci) => {
    const lista = c.nivel === 'secundaria' ? sec : pri;
    lista.forEach((a, i) => {
      // En secundaria cada área tiene su profesor; en primaria el titular da casi todo.
      const doc = c.nivel === 'secundaria' ? docentes[(i + ci) % 2] : (i === 6 || i === 5 ? docentes[(ci + 1) % 4] : docentes[ci]);
      cargas.push({ id: nuevoId(), cursoId: c.id, asignatura: a, docenteId: doc.id, orden: i });
    });
  });

  const nomF = ['María', 'Ana', 'Yarelis', 'Rosa', 'Carla', 'Paola', 'Esther', 'Daniela', 'Nicole', 'Altagracia', 'Yuleisy', 'Laura', 'Génesis', 'Scarlet'];
  const nomM = ['Juan', 'Carlos', 'Luis', 'José', 'Miguel', 'Ángel', 'Rafael', 'Pedro', 'Jesús', 'Ramón', 'Wilson', 'Enmanuel', 'Starlin', 'Yeferson'];
  const ape = ['Pérez', 'Rodríguez', 'García', 'Martínez', 'Santana', 'Reyes', 'Jiménez', 'De la Cruz', 'Féliz', 'Peña', 'Batista', 'Mejía', 'Rosario', 'Encarnación', 'Vásquez', 'Polanco'];
  const estudiantes = [];
  for (const c of cursos) {
    for (let i = 0; i < 14; i++) {
      const f = rnd() < 0.5;
      const anoNac = 2026 - (c.nivel === 'secundaria' ? 11 + c.grado : 5 + c.grado);
      estudiantes.push({
        id: nuevoId(), cursoId: c.id, nombres: elige(f ? nomF : nomM), apellidos: `${elige(ape)} ${elige(ape)}`, sexo: f ? 'F' : 'M',
        fechaNac: `${anoNac}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
        idMinerd: String(Math.floor(rnd() * 9e8 + 1e8)), tutor: `${elige(rnd() < 0.6 ? nomF : nomM)} ${elige(ape)}`, telefono: `809-${String(Math.floor(rnd() * 900 + 100))}-${String(Math.floor(rnd() * 9000 + 1000))}`, activo: true,
      });
    }
  }

  // Notas: P1 completo para todos y P2 para la mitad de las asignaturas.
  const notas = {};
  for (const carga of cargas) {
    const curso = cursos.find(c => c.id === carga.cursoId);
    const conP2 = carga.orden % 2 === 0;
    for (const e of estudiantes.filter(e => e.cursoId === curso.id)) {
      const base = 58 + Math.floor(rnd() * 38);
      const reg = {};
      for (let comp = 0; comp < 4; comp++) {
        for (let p = 0; p < (conP2 ? 2 : 1); p++) {
          if (curso.modelo === 'cualitativo') { reg[`q${comp}${p}`] = base > 82 ? 'L' : base > 68 ? 'EP' : 'I'; continue; }
          const n = Math.max(40, Math.min(100, Math.round(base + (rnd() - 0.5) * 14)));
          reg[`c${comp}${p}`] = n;
          if (n < 70 && p === 0 && rnd() < 0.7) reg[`r${comp}${p}`] = Math.min(100, 70 + Math.floor(rnd() * 12));
        }
      }
      notas[`${carga.id}|${e.id}`] = reg;
    }
  }

  // Asistencia de unos días.
  const asistencia = {};
  const dias = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18'];
  for (const c of cursos) for (const d of dias) {
    const dia = { _: 1 };
    for (const e of estudiantes.filter(e => e.cursoId === c.id)) {
      const r = rnd();
      if (r < 0.06) dia[e.id] = 'A'; else if (r < 0.1) dia[e.id] = 'T'; else if (r < 0.12) dia[e.id] = 'E';
    }
    asistencia[`${c.id}|${d}`] = dia;
  }

  const primero = estudiantes.find(e => e.cursoId === cursos[0].id);
  const familia = usuario(`Familia de ${primero.nombres} ${primero.apellidos}`, 'familia', 'familia123', 'familia', { estudianteIds: [primero.id] });

  return { version: 1, centro, usuarios: [dir, ...docentes, familia], cursos, cargas, estudiantes, notas, asistencia, bitacora: [] };
}

module.exports = { centroPorDefecto, crearDatosDeEjemplo };
