// Cursos del semestre y resumen de calificaciones, leídos de Moodle.
// Las fechas viajan en ISO (UTC); quien las muestre las pasa a hora local.

import { htmlATexto, iso, usuarioActual, ws, wsOpcional } from './cliente.js';
import { urlBase } from './sesion.js';

const SEIS_MESES = 183 * 24 * 3600 * 1000;

// "Cálculo Vectorial_ING_2026A" → "Cálculo Vectorial". Los nombres de Moodle
// suelen venir limpios; esto sólo quita sufijos de grupo pegados con «_».
export const nombreCorto = (nombre) => htmlATexto(String(nombre || '')).texto.split('_')[0].trim();

// Cursos en curso. Primero se pide a Moodle la misma clasificación que usa
// el tablero («En progreso»); si la escuela no la permite, se calcula con las
// fechas de inicio y fin.
export async function cursosActuales() {
  const u = await usuarioActual();
  const enCurso = await wsOpcional(
    'core_course_get_enrolled_courses_by_timeline_classification',
    { classification: 'inprogress', limit: 0, offset: 0 },
    null,
  );
  let cursos = enCurso?.courses;
  if (!Array.isArray(cursos)) {
    const todos = await ws('core_enrol_get_users_courses', { userid: u.userid });
    const ahora = Date.now();
    cursos = todos.filter((c) => {
      const inicio = (c.startdate || 0) * 1000;
      const fin = (c.enddate || 0) * 1000;
      if (c.visible === 0 || c.hidden) return false;
      if (inicio > ahora) return false;
      if (fin) return ahora <= fin;
      // Sin fecha de fin: se toma como del semestre si empezó hace poco.
      return ahora - inicio < SEIS_MESES;
    });
  }
  return cursos
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: String(c.id),
      idMoodle: Number(c.id),
      nombre: nombreCorto(c.fullname || c.displayname || c.shortname),
      completo: c.fullname || c.shortname || '',
      inicio: iso(c.startdate),
      fin: iso(c.enddate),
      enlace: c.viewurl || `${urlBase()}/course/view.php?id=${c.id}`,
    }));
}
