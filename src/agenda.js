// Agenda del semestre leída de Moodle: tareas (assign), exámenes (quiz),
// foros con fecha y cualquier otra actividad con fecha que Moodle marque como
// pendiente en el calendario (lecciones, talleres, H5P…).
//
// De dónde sale cada cosa:
// - mod_assign_get_assignments + mod_assign_get_submission_status: fechas,
//   instrucciones, archivos y si ya entregaste.
// - mod_quiz_get_quizzes_by_courses + mod_quiz_get_user_attempts: exámenes y
//   si ya hiciste un intento.
// - mod_forum_get_forums_by_courses: foros con fecha de entrega.
// - core_calendar_get_action_events_by_courses: el resto de actividades
//   pendientes («Línea de tiempo» del tablero de Moodle).
// - core_course_get_contents: la sección donde está cada actividad y los
//   archivos que el profesor dejó al lado (p. ej. «Ejercicios 2.4» junto a
//   «Tarea 2.4»).

import fs from 'node:fs';
import path from 'node:path';
import { htmlATexto, iso, usuarioActual, wsOpcional } from './cliente.js';
import { DIR_DATOS, urlBase } from './sesion.js';
import { crearCola } from './red.js';
import { cursosActuales } from './datos.js';

const DIA = 864e5;
const enCola = crearCola(8);
// Cada cuánto se vuelve a preguntar por las tareas que ya estaban entregadas.
const REVISION_COMPLETA = 12 * 3600 * 1000;

// ---- Archivos de la misma sección ----

// Los profesores suelen subir el material al lado de la tarea, en la misma
// sección. Se emparejan por el número más específico del título.
const numeros = (t) => (String(t).match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, '.').replace(/^0+(?=\d)/, ''));
// Un número suelto («Tarea 1») es demasiado común: además tiene que
// coincidir la palabra que lo acompaña.
function claveDe(titulo) {
  const nums = numeros(titulo).sort((a, b) => b.length - a.length);
  if (!nums.length) return null;
  if (nums[0].includes('.')) return { numero: nums[0] };
  const m = new RegExp(`([a-záéíóúñ]+)[\\s_-]*0*${nums[0]}(?!\\d)`, 'i').exec(titulo);
  return m ? { numero: nums[0], palabra: m[1].toLowerCase() } : null;
}
function coincide(clave, titulo) {
  if (!clave.palabra) return numeros(titulo).includes(clave.numero);
  return new RegExp(`${clave.palabra}[\\s_-]*0*${clave.numero}(?!\\d)`, 'i').test(titulo);
}
const ES_MATERIAL = new Set(['resource', 'folder', 'page', 'book']);
function relacionados(titulo, cmid, hermanos) {
  const clave = claveDe(titulo);
  if (!clave) return [];
  return hermanos
    .filter((h) => h.id !== cmid && ES_MATERIAL.has(h.modname) && h.uservisible !== false)
    .filter((h) => coincide(clave, h.name))
    .map((h) => ({ id: String(h.id), titulo: h.name, carpeta: h.modname === 'folder' || h.modname === 'book' }));
}

// Mapa cmid → { seccion, hermanos } de un curso.
function mapaSecciones(secciones) {
  const mapa = new Map();
  for (const s of secciones || []) {
    const nombre = htmlATexto(s.name || '').texto;
    for (const m of s.modules || []) mapa.set(m.id, { seccion: nombre, hermanos: s.modules, modulo: m });
  }
  return mapa;
}

// ---- Archivos de las instrucciones ----

function archivosDe(lista = [], origen = 'De la tarea') {
  return (lista || [])
    .filter((f) => f && f.fileurl && f.filename && f.filename !== '.')
    .map((f) => ({ nombre: f.filename, bytes: f.filesize || undefined, mime: f.mimetype || undefined, url: f.fileurl, origen }));
}
// Imágenes o archivos incrustados en el HTML de la intro (pluginfile.php).
function incrustados(html, origen = 'De la tarea') {
  const salida = [];
  for (const m of String(html || '').matchAll(/\b(?:href|src)\s*=\s*["']([^"']*\/pluginfile\.php\/[^"']+)["']/gi)) {
    const url = m[1].replace(/&amp;/g, '&');
    const nombre = decodeURIComponent(url.split('?')[0].split('/').pop() || 'archivo');
    salida.push({ nombre, url, origen });
  }
  return salida;
}
const sinDuplicados = (lista) => {
  const vistos = new Set();
  return lista.filter((a) => {
    const k = String(a.url).split('?')[0];
    return !vistos.has(k) && vistos.add(k);
  });
};

function tipoDe(nombre, modulo) {
  if (modulo === 'quiz') return 'examen';
  if (modulo === 'forum') return 'foro';
  if (/^(feedback|choice|survey|questionnaire)$/.test(modulo)) return 'encuesta';
  if (/examen|\bparcial\b|quiz|\bexam\b|prueba/i.test(nombre)) return 'examen';
  return 'tarea';
}

// ---- Por tipo de actividad ----

// Una tarea entregada casi nunca deja de estarlo: si la revisión anterior ya
// la vio entregada, no se vuelve a preguntar (es una consulta por tarea).
const YA_ENTREGADA = { estado: 'entregada', borrador: false, prorroga: null, bloqueada: false };

async function estadoTarea(asig, entregadas) {
  if (entregadas?.has(String(asig.cmid))) return YA_ENTREGADA;
  const s = await enCola(() => wsOpcional('mod_assign_get_submission_status', { assignid: asig.id }, null));
  const intento = s?.lastattempt;
  const entrega = intento?.teamsubmission || intento?.submission;
  const calificada = intento?.gradingstatus === 'graded' || !!s?.feedback?.grade?.grade;
  let estado = 'pendiente';
  if (entrega?.status === 'submitted' || calificada) estado = 'entregada';
  // Sin entrega en línea (la tarea se entrega en papel): sólo cuenta si ya
  // la calificaron.
  if (asig.nosubmissions && !calificada) estado = 'pendiente';
  return {
    estado,
    borrador: entrega?.status === 'draft',
    prorroga: intento?.extensionduedate || null,
    bloqueada: intento?.locked === true,
  };
}

async function tareasAssign(curso, asignaciones, secciones, ahora, entregadas) {
  const base = urlBase();
  return Promise.all(
    asignaciones.map(async (a) => {
      const st = await estadoTarea(a, entregadas);
      const lugar = secciones.get(a.cmid);
      const vence = st.prorroga || a.duedate;
      const corte = a.cutoffdate || 0;
      const html = [a.intro, a.activity].filter(Boolean).join('\n');
      return {
        id: String(a.cmid),
        modulo: 'assign',
        instancia: a.id,
        titulo: a.name,
        ruta: lugar?.seccion ? [lugar.seccion] : [],
        tipo: tipoDe(a.name, 'assign'),
        entrega: iso(vence),
        cierre: iso(corte),
        estado: st.estado,
        borrador: st.borrador || undefined,
        bloqueada: st.bloqueada || (a.allowsubmissionsfromdate || 0) * 1000 > ahora,
        // Acepta entrega tardía si no hay fecha de corte o aún no llega.
        tardia: !a.nosubmissions && (!corte || corte * 1000 > ahora),
        sinEntregaEnLinea: !!a.nosubmissions || undefined,
        instrucciones: htmlATexto(html).texto || undefined,
        creada: iso(a.allowsubmissionsfromdate || a.timemodified) || undefined,
        adjuntos: sinDuplicados([...archivosDe(a.introattachments), ...archivosDe(a.activityattachments), ...incrustados(html)]),
        relacionados: lugar ? relacionados(a.name, a.cmid, lugar.hermanos) : [],
        enlace: `${base}/mod/assign/view.php?id=${a.cmid}`,
        enlaceEntrega: a.nosubmissions ? undefined : `${base}/mod/assign/view.php?id=${a.cmid}&action=editsubmission`,
      };
    }),
  );
}

async function tareasQuiz(curso, examenes, secciones, ahora) {
  const base = urlBase();
  return Promise.all(
    examenes.map(async (q) => {
      const r = await enCola(() => wsOpcional('mod_quiz_get_user_attempts', { quizid: q.id, status: 'all', includepreviews: 0 }, { attempts: [] }));
      const terminados = (r.attempts || []).filter((x) => x.state === 'finished');
      const lugar = secciones.get(q.coursemodule);
      return {
        id: String(q.coursemodule),
        modulo: 'quiz',
        instancia: q.id,
        titulo: q.name,
        ruta: lugar?.seccion ? [lugar.seccion] : [],
        tipo: 'examen',
        abre: iso(q.timeopen),
        entrega: iso(q.timeclose),
        estado: terminados.length ? 'entregada' : 'pendiente',
        bloqueada: (q.timeopen || 0) * 1000 > ahora,
        tardia: false,
        instrucciones: htmlATexto(q.intro).texto || undefined,
        creada: iso(q.timecreated || q.timeopen) || undefined,
        adjuntos: sinDuplicados([...archivosDe(q.introfiles), ...incrustados(q.intro)]),
        relacionados: lugar ? relacionados(q.name, q.coursemodule, lugar.hermanos) : [],
        enlace: `${base}/mod/quiz/view.php?id=${q.coursemodule}`,
      };
    }),
  );
}

function tareasForo(curso, foros, secciones, ahora) {
  const base = urlBase();
  return foros
    .filter((f) => f.duedate > 0)
    .map((f) => {
      const lugar = secciones.get(f.cmid);
      return {
        id: String(f.cmid),
        modulo: 'forum',
        instancia: f.id,
        titulo: f.name,
        ruta: lugar?.seccion ? [lugar.seccion] : [],
        tipo: 'foro',
        entrega: iso(f.duedate),
        cierre: iso(f.cutoffdate),
        // Moodle no dice al alumno si ya participó sin leer cada debate.
        estado: lugar?.modulo?.completiondata?.state >= 1 ? 'entregada' : 'pendiente',
        bloqueada: false,
        tardia: !f.cutoffdate || f.cutoffdate * 1000 > ahora,
        instrucciones: htmlATexto(f.intro).texto || undefined,
        adjuntos: sinDuplicados([...archivosDe(f.introfiles), ...incrustados(f.intro)]),
        relacionados: [],
        enlace: `${base}/mod/forum/view.php?id=${f.cmid}`,
      };
    });
}

// Actividades de otros módulos que el calendario marca como pendientes.
const CUBIERTOS = new Set(['assign', 'quiz', 'forum']);
function tareasCalendario(eventos, secciones) {
  const base = urlBase();
  const salida = [];
  const vistos = new Set();
  for (const ev of eventos || []) {
    if (CUBIERTOS.has(ev.modulename)) continue;
    const cmid = Number(/[?&]id=(\d+)/.exec(ev.url || '')?.[1]) || null;
    const clave = cmid || `ev${ev.id}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const lugar = cmid && secciones.get(cmid);
    const nombre = ev.activityname || lugar?.modulo?.name || ev.name;
    salida.push({
      id: String(clave),
      modulo: ev.modulename || 'evento',
      titulo: nombre,
      ruta: lugar?.seccion ? [lugar.seccion] : [],
      tipo: tipoDe(nombre, ev.modulename),
      entrega: iso(ev.timesort || ev.timestart),
      estado: 'pendiente',
      bloqueada: ev.action ? ev.action.actionable === false : false,
      tardia: false,
      instrucciones: htmlATexto(ev.description).texto || undefined,
      adjuntos: [],
      relacionados: [],
      enlace: ev.url || (cmid ? `${base}/mod/${ev.modulename}/view.php?id=${cmid}` : `${base}/calendar/view.php`),
    });
  }
  return salida;
}

// ---- Ajustes ----

// %APPDATA%\insti-today\ajustes.json → { "ocultar": ["Tutorías", ...] }
// Cada texto oculta los cursos cuyo nombre lo contenga.
const AJUSTES = path.join(DIR_DATOS, 'ajustes.json');
export function ajustes() {
  try {
    const a = JSON.parse(fs.readFileSync(AJUSTES, 'utf8'));
    return { ocultar: [], ...a };
  } catch {
    return { ocultar: [] };
  }
}

// ---- Todo junto ----

// `anterior` es la agenda de la revisión pasada (opcional): de ahí se toman
// las tareas que ya estaban entregadas, y cada 12 h se revisan todas.
export async function agenda({ anterior } = {}) {
  const u = await usuarioActual();
  const ocultar = (ajustes().ocultar || []).map((t) => String(t).toLowerCase());
  const actuales = await cursosActuales();
  const oculto = (c) => ocultar.some((t) => c.nombre.toLowerCase().includes(t) || c.completo.toLowerCase().includes(t));
  const visibles = actuales.filter((c) => !oculto(c));
  const ids = visibles.map((c) => c.idMoodle);
  const ahora = Date.now();
  const previa = anterior?.cuenta === u.username ? Date.parse(anterior.completa || anterior.generado) : NaN;
  const atajo = ahora - previa < REVISION_COMPLETA;
  const entregadas = atajo
    ? new Set((anterior.cursos || []).flatMap((c) => c.tareas.filter((t) => t.modulo === 'assign' && t.estado === 'entregada').map((t) => t.id)))
    : null;

  // Quizzes, foros y calendario se piden una vez para todos los cursos. Las
  // tareas, curso por curso (una sola consulta con todos tarda varias veces
  // más), y cada curso sigue en cuanto tiene lo suyo, sin esperar a los demás.
  const comunes = Promise.all([
    ids.length ? wsOpcional('mod_quiz_get_quizzes_by_courses', { courseids: ids }, { quizzes: [] }) : { quizzes: [] },
    ids.length ? wsOpcional('mod_forum_get_forums_by_courses', { courseids: ids }, []) : [],
    ids.length
      ? wsOpcional('core_calendar_get_action_events_by_courses', { courseids: ids, timefrom: Math.floor((ahora - 60 * DIA) / 1000), limitnum: 50 }, { groupedbycourse: [] })
      : { groupedbycourse: [] },
  ]);
  // Si falla, el error llega por el curso que lo espere.
  comunes.catch(() => {});

  const cursos = await Promise.all(
    visibles.map(async (c) => {
      const [asig, contenido] = await Promise.all([
        wsOpcional('mod_assign_get_assignments', { courseids: [c.idMoodle] }, { courses: [] }),
        enCola(() => wsOpcional('core_course_get_contents', { courseid: c.idMoodle }, [])),
      ]);
      const secciones = mapaSecciones(contenido);
      const misAsig = asig.courses?.find((x) => x.id === c.idMoodle)?.assignments || [];
      const [deAsig, [quizzes, foros, calendario]] = await Promise.all([tareasAssign(c, misAsig, secciones, ahora, entregadas), comunes]);
      const misQuiz = (quizzes.quizzes || []).filter((q) => q.course === c.idMoodle && q.visible !== false && q.visible !== 0);
      const misForos = (Array.isArray(foros) ? foros : []).filter((f) => f.course === c.idMoodle);
      const misEventos = (calendario.groupedbycourse || []).find((g) => Number(g.courseid) === c.idMoodle)?.events || [];
      // Fechas de relleno muy lejanas equivalen a «sin fecha».
      const limite = c.fin ? Date.parse(c.fin) + 30 * DIA : Infinity;
      const tareas = [
        ...deAsig,
        ...(await tareasQuiz(c, misQuiz, secciones, ahora)),
        ...tareasForo(c, misForos, secciones, ahora),
        ...tareasCalendario(misEventos, secciones),
      ].map((t) => {
        if (t.entrega && Date.parse(t.entrega) > limite) t.entrega = null;
        if (!t.relacionados?.length) delete t.relacionados;
        if (!t.adjuntos?.length) delete t.adjuntos;
        return t;
      });
      return { id: c.id, nombre: c.nombre, horario: null, inicio: c.inicio, fin: c.fin, enlace: c.enlace, tareas };
    }),
  );
  cursos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  // Para Configuración: todas las materias del semestre, también las ocultas.
  const materias = actuales
    .map((c) => ({ nombre: c.nombre, oculta: oculto(c) }))
    .filter((m, i, todas) => todas.findIndex((x) => x.nombre === m.nombre) === i)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return {
    usuario: u.firstname || u.fullname || u.username,
    cuenta: u.username,
    generado: new Date().toISOString(),
    // Cuándo se preguntó por última vez por todas las tareas.
    completa: atajo ? anterior.completa || anterior.generado : new Date(ahora).toISOString(),
    cursos,
    materias,
  };
}
