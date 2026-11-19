# Registro Escolar

Sistema para que los centros educativos (escuelas y liceos) pongan las notas en la computadora o el celular,
pasen lista y saquen los boletines. Es un proyecto aparte de Mi Luz RD; solo comparte la carpeta.

Sigue la forma de calificar del boletín dominicano por competencias:

- Cada asignatura tiene las **4 competencias fundamentales** (C1 a C4), con nota en **P1, P2, P3 y P4**
  y una **recuperación pedagógica (RP)** por período. Si hay RP, cuenta la nota más alta.
- **PC** = promedio de cada competencia · **C.F.** = promedio de las 4 competencias.
- Si la C.F. es menor de **70**: **completiva** (50 % C.F. + 50 % C.C.F.), luego **extraordinaria**
  (30 % C.F. + 70 % C.Ex.) y luego **evaluación especial**. Condición final: **A** (aprobado) o **R** (reprobado).
- Primer ciclo de primaria e inicial: modelo **cualitativo** (L = Logrado, EP = En proceso, I = Iniciado).
- También hay un modelo de **una nota por período**, para centros que no usan competencias.

La nota mínima, los porcentajes, los nombres de las competencias y las fechas de los períodos se cambian en
**Centro educativo**, por si la ordenanza de evaluación cambia o el centro usa otras reglas. Conviene revisarlos
con la ordenanza vigente del MINERD antes de usarlo en serio.

## Quién hace qué

| Usuario | Puede |
|---|---|
| **Dirección** | Todo: datos del centro, cursos, asignaturas, docentes, estudiantes, cuentas de familias, abrir y cerrar períodos, corregir cualquier nota, reportes, bitácora, copias de seguridad, año escolar nuevo. |
| **Docente** | Poner las notas de **sus** asignaturas (mientras el período esté abierto), pasar lista en sus cursos. Si es **titular** de un curso, imprime los boletines y ve el cuadro de calificaciones de ese curso. |
| **Familia** | Ver el boletín y la asistencia de sus hijos. No puede cambiar nada. |

## Lo que trae

- **Calificaciones**: planilla por asignatura y período. Se escribe la nota, Enter, y pasa al siguiente estudiante;
  se guarda sola. Se puede copiar una columna de Excel y pegarla. Las notas por debajo de 70 salen en rojo.
  Pestañas: P1–P4, **Calificación final** (PC, C.F., completiva, extraordinaria, especial, condición, observación)
  y **Registro completo** (todo el año en una hoja, para imprimir).
- **Cierre de períodos**: cuando la dirección cierra el P1, ningún docente puede cambiar esas notas.
- **Asistencia**: pasar lista por curso y día (Presente, Ausente, Tardanza, Excusa) y resumen con porcentaje por período.
- **Boletines**: uno por estudiante o todo el curso de una vez, cada uno en una hoja horizontal.
  Con «Guardar como PDF» en la ventana de imprimir salen en PDF.
- **Reportes**: cuadro de calificaciones del curso (sábana), estudiantes en riesgo con el teléfono del tutor,
  resumen por curso y asistencia baja. Todo se descarga para Excel (CSV) o se imprime.
- **Estudiantes**: inscribir uno por uno o pegar la lista entera desde Excel (Apellidos, Nombres, Sexo, Fecha de nacimiento, ID, Tutor, Teléfono).
- **Bitácora**: quién cambió cada nota, cuándo y de cuánto a cuánto.
- **Año escolar nuevo**: guarda el año que termina y deja el sistema limpio, con los mismos cursos y usuarios.

## Cómo usarlo

Se necesita una computadora en el centro con **Node.js** instalado (https://nodejs.org, versión 18 o más nueva).
No hace falta instalar nada más ni tener internet.

1. Doble clic en `Abrir-Registro-Escolar.bat` (en Windows) o, en una terminal dentro de esta carpeta: `node servidor.js`.
2. Se abre el navegador. La primera vez pide crear la cuenta de la dirección. Para solo verlo funcionar,
   toca **Probar con datos de ejemplo** (usuario `direccion`, clave `direccion123`; docente `lperez` / `docente123`;
   familia `familia` / `familia123`). Los nombres del ejemplo son inventados.
3. Los docentes entran desde su celular o computadora, conectados al **mismo WiFi**, con la dirección que muestra la
   ventana negra en «Otras computadoras y celulares» (por ejemplo `http://192.168.1.20:8091`).
4. Deja la ventana negra abierta mientras se use el sistema.

Para que las familias lo vean desde su casa, el servidor tiene que estar en internet (un servidor en la nube o
un VPS con HTTPS). El programa es el mismo; solo cambia dónde corre.

## Dónde quedan los datos

Todo queda en la carpeta `datos/` de esta carpeta (`datos/escuela.json`), en la computadora del centro.
Cada día se guarda una copia en `datos/respaldos/` (las últimas 30). Además, en **Centro educativo → Descargar copia de todo**
se baja un archivo que conviene guardar en una memoria USB o en la nube de vez en cuando.
La carpeta `datos/` no se sube a GitHub.

Las claves se guardan cifradas (scrypt). Después de 8 intentos fallidos, ese equipo espera 5 minutos para volver a probar.
Cuando la dirección crea un usuario o le cambia la clave, la persona tiene que ponerse una clave propia al entrar.
