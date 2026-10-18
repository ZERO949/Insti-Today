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

// Calificaciones de un curso con el reporte del usuario. «total» es el total
// del curso que calcula Moodle (con sus ponderaciones), no un promedio propio.
async function notasCurso(curso, userid) {
  const r = await wsOpcional('gradereport_user_get_grade_items', { courseid: curso.idMoodle, userid }, null);
  const items = r?.usergrades?.[0]?.gradeitems || [];
  const actividades = [];
  let total = null;
  for (const it of items) {
    if (it.itemtype === 'course') {
      total = { texto: it.gradeformatted || null, porcentaje: it.percentageformatted || null, valor: it.graderaw ?? null, sobre: it.grademax ?? null };
      continue;
    }
    if (it.itemtype === 'category') continue;
    const calificada = it.graderaw !== null && it.graderaw !== undefined;
    actividades.push({
      id: String(it.cmid || it.id),
      nombre: it.itemname || '(sin nombre)',
      modulo: it.itemmodule || null,
      sobre: it.grademax ?? null,
      estado: calificada ? 'calificada' : it.gradedatesubmitted ? 'entregada' : 'pendiente',
      nota: calificada ? it.graderaw : null,
      texto: it.gradeformatted && it.gradeformatted !== '-' ? it.gradeformatted : null,
      porcentaje: it.percentageformatted && it.percentageformatted !== '-' ? it.percentageformatted : null,
      calificada_en: iso(it.gradedategraded),
      retroalimentacion: it.feedback ? htmlATexto(it.feedback).texto.slice(0, 600) : undefined,
    });
  }
  return { total, actividades };
}

// Resumen del semestre (lo usa el servidor MCP): cursos, calificaciones y
// anuncios del foro de avisos.
export async function resumen() {
  const u = await usuarioActual();
  const cursos = await cursosActuales();
  const ids = cursos.map((c) => c.idMoodle);
  const foros = ids.length ? await wsOpcional('mod_forum_get_forums_by_courses', { courseids: ids }, []) : [];
  const salida = await Promise.all(
    cursos.map(async (c) => {
      const { total, actividades } = await notasCurso(c, u.userid);
      const avisos = foros.find((f) => f.course === c.idMoodle && f.type === 'news');
      const discusiones = avisos
        ? (await wsOpcional('mod_forum_get_forum_discussions', { forumid: avisos.id, sortorder: -1, page: 0, perpage: 10 }, { discussions: [] })).discussions || []
        : [];
      return {
        id: c.id,
        nombre: c.nombre,
        enlace: c.enlace,
        total,
        actividades,
        anuncios: discusiones.map((d) => ({ titulo: d.subject || d.name, fecha: iso(d.created || d.timemodified), texto: htmlATexto(d.message).texto.slice(0, 600) })),
      };
    }),
  );
  salida.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return { usuario: u.fullname || u.username, generado: new Date().toISOString(), cursos: salida };
}
