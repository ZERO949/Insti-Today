// Un Moodle falso para probar Insti Today sin cuenta real.
//
//   node tools/moodle-falso.mjs [puerto]       → http://127.0.0.1:8765/moodle
//   usuario: alumno · contraseña: secreto
//
// Imita lo que usa la app: /login/token.php, los servicios web REST
// (/webservice/rest/server.php), los archivos (/webservice/pluginfile.php),
// el login normal del navegador, el inicio automático de la app móvil y una
// página de entrega con selector de archivos que acepta arrastrar y soltar.
// Las fechas se calculan desde «ahora» para que siempre haya algo que vence
// hoy, mañana y algo atrasado.

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = '/moodle';
const USUARIO = 'alumno';
const CONTRASENA = 'secreto';
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const PRIVADO = 'privado-123';
const COOKIE = 'MoodleSession=sesion-de-prueba';
const YO = 501;

const s = (ms) => Math.floor(ms / 1000);
const ahora = Date.now();
const H = 3600e3;
const D = 24 * H;
// Hoy a las 23:59 hora local.
const hoy2359 = (() => {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.getTime();
})();

// ---- Archivos ----

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// ZIP sin comprimir, suficiente para la vista previa.
function zip(archivos) {
  const locales = [];
  const centrales = [];
  let offset = 0;
  for (const [nombre, texto] of Object.entries(archivos)) {
    const datos = Buffer.from(texto);
    const n = Buffer.from(nombre);
    const crc = crc32(datos);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(datos.length, 18); l.writeUInt32LE(datos.length, 22); l.writeUInt16LE(n.length, 26);
    locales.push(l, n, datos);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(datos.length, 20); c.writeUInt32LE(datos.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    centrales.push(c, n);
    offset += 30 + n.length + datos.length;
  }
  const central = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(archivos).length, 8); fin.writeUInt16LE(Object.keys(archivos).length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, central, fin]);
}
function pdf(lineas) {
  const contenido = `BT /F1 18 Tf 60 740 Td ${lineas.map((l, i) => `${i ? '0 -28 Td ' : ''}(${l.replace(/[()\\]/g, '')}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let salida = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(salida.length); salida += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = salida.length;
  salida += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  salida += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(salida, 'latin1');
}
const ICONO = (() => {
  try {
    return fs.readFileSync(new URL('../widget/icono/icono.png', import.meta.url));
  } catch {
    return Buffer.alloc(0);
  }
})();

const ARCHIVOS = {
  '/11/mod_assign/introattachment/0/Ejercicios 2.4.pdf': { tipo: 'application/pdf', datos: pdf(['Ejercicios 2.4', 'Regla de la cadena', '1. Sea f(x,y) = x^2 y, x = cos t, y = sin t']) },
  '/11/mod_assign/intro/diagrama.png': { tipo: 'image/png', datos: ICONO },
  '/12/mod_resource/content/1/Regla de la Cadena.pdf': { tipo: 'application/pdf', datos: pdf(['Regla de la cadena', 'Apuntes de clase']) },
  '/21/mod_assign/introattachment/0/practica5.zip': { tipo: 'application/zip', datos: zip({ 'practica5/Animal.java': 'public class Animal {}\n', 'practica5/Perro.java': 'public class Perro extends Animal {}\n', 'practica5/LEEME.txt': 'Completa los métodos.\n' }) },
  '/21/mod_assign/introattachment/0/Main.java': { tipo: 'text/x-java', datos: Buffer.from('public class Main {\n  public static void main(String[] args) {\n    Animal a = new Perro();\n    System.out.println(a);\n  }\n}\n') },
};
const url = (base, ruta) => `${base}${RAIZ}/webservice/pluginfile.php${ruta.split('/').map(encodeURIComponent).join('/')}`;
const fileinfo = (base, ruta, extra = {}) => ({ filename: ruta.split('/').pop(), filepath: '/', filesize: ARCHIVOS[ruta].datos.length, fileurl: url(base, ruta), mimetype: ARCHIVOS[ruta].tipo, ...extra });

// ---- Datos ----

const CURSOS = [
  { id: 11, fullname: 'Cálculo Vectorial', shortname: 'CALVEC-2026B', startdate: s(ahora - 40 * D), enddate: s(ahora + 80 * D) },
  { id: 12, fullname: 'Programación Orientada a Objetos', shortname: 'POO-2026B', startdate: s(ahora - 40 * D), enddate: s(ahora + 80 * D) },
  { id: 13, fullname: 'Ingeniería de Software', shortname: 'INGSW-2026B', startdate: s(ahora - 40 * D), enddate: s(ahora + 80 * D) },
  { id: 14, fullname: 'Sustentabilidad', shortname: 'SUST-2026B', startdate: s(ahora - 40 * D), enddate: s(ahora + 80 * D) },
  // Un curso de un semestre pasado: no debe aparecer.
  { id: 9, fullname: 'Álgebra Lineal', shortname: 'ALG-2026A', startdate: s(ahora - 260 * D), enddate: s(ahora - 100 * D) },
];

function asignaciones(base) {
  return [
    { id: 1, cmid: 1104, course: 11, name: 'Tarea 2.4 - Regla de la cadena', duedate: s(hoy2359), cutoffdate: 0, allowsubmissionsfromdate: s(ahora - 5 * D), timemodified: s(ahora - 5 * D), nosubmissions: 0,
      intro: `<p>Resuelve los ejercicios del PDF adjunto mostrando el procedimiento completo.</p><p><img src="${url(base, '/11/mod_assign/intro/diagrama.png')}" alt="diagrama"></p>`,
      introattachments: [fileinfo(base, '/11/mod_assign/introattachment/0/Ejercicios 2.4.pdf')], estado: 'new' },
    { id: 2, cmid: 1103, course: 11, name: 'Tarea 2.3 - Derivadas parciales', duedate: s(ahora - 3 * D), cutoffdate: 0, allowsubmissionsfromdate: s(ahora - 12 * D), timemodified: s(ahora - 12 * D), nosubmissions: 0,
      intro: '<p>Ejercicios 1 a 10 del libro.</p>', introattachments: [], estado: 'submitted' },
    { id: 3, cmid: 2105, course: 12, name: 'Práctica 5: Herencia', duedate: s(ahora + D + 2 * H), cutoffdate: s(ahora + 3 * D), allowsubmissionsfromdate: s(ahora - 4 * D), timemodified: s(ahora - 4 * D), nosubmissions: 0,
      intro: '<p>Implementa la jerarquía <b>Animal → Perro</b> y sube tus archivos <code>.java</code>.</p>',
      introattachments: [fileinfo(base, '/21/mod_assign/introattachment/0/practica5.zip'), fileinfo(base, '/21/mod_assign/introattachment/0/Main.java')], estado: 'draft' },
    { id: 4, cmid: 2120, course: 12, name: 'Proyecto final', duedate: 0, cutoffdate: 0, allowsubmissionsfromdate: 0, timemodified: s(ahora - 20 * D), nosubmissions: 0, intro: '<p>Propuesta del proyecto final en equipo.</p>', introattachments: [], estado: 'new' },
    { id: 5, cmid: 3102, course: 13, name: 'Entregable 2: Requerimientos (Proyecto 3)', duedate: s(ahora - D), cutoffdate: s(ahora + 2 * D), allowsubmissionsfromdate: s(ahora - 10 * D), timemodified: s(ahora - 10 * D), nosubmissions: 0,
      intro: '<p>Documento de requerimientos del sistema de arrendamiento de consultorios.</p>', introattachments: [], estado: 'new' },
    { id: 6, cmid: 4101, course: 14, name: 'Reporte de campo: Plantando Vida', duedate: s(ahora + 5 * D), cutoffdate: 0, allowsubmissionsfromdate: 0, timemodified: s(ahora - 2 * D), nosubmissions: 1,
      intro: '<p>Se entrega impreso en clase.</p>', introattachments: [], estado: 'new' },
  ];
}
const EXAMENES = [
  { id: 41, coursemodule: 1110, course: 11, name: 'Examen parcial 2', intro: '<p>Unidad 2 completa. Duración: 90 minutos.</p>', timeopen: s(ahora + 2 * D), timeclose: s(ahora + 2 * D + 2 * H), visible: 1 },
  { id: 42, coursemodule: 2110, course: 12, name: 'Quiz 4: Polimorfismo', intro: '<p>10 preguntas de opción múltiple.</p>', timeopen: s(ahora - D), timeclose: s(ahora + 6 * H), visible: 1 },
];
const FOROS = [
  { id: 71, cmid: 1100, course: 11, type: 'news', name: 'Avisos', intro: '', duedate: 0, cutoffdate: 0 },
  { id: 72, cmid: 2100, course: 12, type: 'news', name: 'Avisos', intro: '', duedate: 0, cutoffdate: 0 },
  { id: 73, cmid: 3100, course: 13, type: 'news', name: 'Avisos', intro: '', duedate: 0, cutoffdate: 0 },
  { id: 74, cmid: 4100, course: 14, type: 'news', name: 'Avisos', intro: '', duedate: 0, cutoffdate: 0 },
  { id: 75, cmid: 4105, course: 14, type: 'general', name: 'Foro: Reflexión sobre reciclaje', intro: '<p>Comparte tu reflexión y comenta a dos compañeros.</p>', duedate: s(ahora + 3 * D), cutoffdate: 0 },
];
const DISCUSIONES = {
  71: [{ id: 901, discussion: 901, name: 'Cambio de salón', subject: 'Cambio de salón', message: '<p>La clase del jueves será en el <b>aula 12</b>.</p>', created: s(ahora - 5 * H), userfullname: 'Dr. Ramírez' }],
  72: [{ id: 902, discussion: 902, name: 'Material de la práctica 5', subject: 'Material de la práctica 5', message: '<p>Ya está el zip con el código base.</p>', created: s(ahora - 2 * D), userfullname: 'Ing. Torres' }],
  73: [],
  74: [{ id: 904, discussion: 904, name: 'Visita al Instituto Matthew Lipman', subject: 'Visita al Instituto Matthew Lipman', message: '<p>Recuerden llevar el material reciclado.</p>', created: s(ahora - 26 * H), userfullname: 'Mtra. Gómez' }],
};

function contenidos(base, curso) {
  const m = (id, name, modname, extra = {}) => ({ id, name, modname, instance: id, visible: 1, uservisible: true, url: `${base}${RAIZ}/mod/${modname}/view.php?id=${id}`, ...extra });
  const archivo = (ruta) => ({ type: 'file', ...fileinfo(base, ruta) });
  const secciones = {
    11: [
      { id: 110, name: 'General', modules: [m(1100, 'Avisos', 'forum')] },
      { id: 111, name: 'Unidad 2: Derivadas parciales', modules: [
        m(1103, 'Tarea 2.3 - Derivadas parciales', 'assign'),
        m(1105, 'Ejercicios 2.4 - Regla de la cadena', 'resource', { contents: [archivo('/12/mod_resource/content/1/Regla de la Cadena.pdf')] }),
        m(1104, 'Tarea 2.4 - Regla de la cadena', 'assign'),
        m(1110, 'Examen parcial 2', 'quiz'),
      ] },
    ],
    12: [{ id: 120, name: 'Unidad 3: Herencia y polimorfismo', modules: [m(2100, 'Avisos', 'forum'), m(2105, 'Práctica 5: Herencia', 'assign'), m(2110, 'Quiz 4: Polimorfismo', 'quiz'), m(2120, 'Proyecto final', 'assign')] }],
    13: [{ id: 130, name: 'Proyecto 3', modules: [m(3100, 'Avisos', 'forum'), m(3102, 'Entregable 2: Requerimientos (Proyecto 3)', 'assign'), m(3110, 'Lección: Casos de uso', 'lesson')] }],
    14: [{ id: 140, name: 'Módulo 5', modules: [m(4100, 'Avisos', 'forum'), m(4101, 'Reporte de campo: Plantando Vida', 'assign'), m(4105, 'Foro: Reflexión sobre reciclaje', 'forum')] }],
  };
  return secciones[curso] || [];
}

function eventos(base) {
  return [
    { courseid: 13, events: [
      { id: 7001, name: 'Lección: Casos de uso cierra', activityname: 'Lección: Casos de uso', modulename: 'lesson', instance: 3, timesort: s(ahora + 4 * D), timestart: s(ahora + 4 * D), url: `${base}${RAIZ}/mod/lesson/view.php?id=3110`, description: '<p>Completa la lección antes de la entrega 3.</p>', action: { name: 'Ver', actionable: true } },
      { id: 7002, name: 'Entregable 2 vence', modulename: 'assign', instance: 5, timesort: s(ahora - D), url: `${base}${RAIZ}/mod/assign/view.php?id=3102`, action: { actionable: true } },
    ] },
  ];
}

// ---- Servicios web ----

// courseids[0]=11&options[ids][0]=3 → { courseids: [11], options: { ids: [3] } }
function desaplanar(params) {
  const raiz = {};
  for (const [clave, valor] of params) {
    const partes = clave.replace(/\]/g, '').split('[');
    let nodo = raiz;
    partes.forEach((p, i) => {
      const ultimo = i === partes.length - 1;
      const siguienteEsIndice = !ultimo && /^\d+$/.test(partes[i + 1]);
      if (ultimo) nodo[p] = valor;
      else nodo = nodo[p] ??= siguienteEsIndice ? [] : {};
    });
  }
  return raiz;
}

const intentos = new Map([[41, []], [42, []]]);
const llamadas = [];

function funcion(nombre, a, base) {
  const ids = (a.courseids || []).map(Number);
  switch (nombre) {
    case 'core_webservice_get_site_info':
      return { sitename: 'Plataforma UII (prueba)', username: USUARIO, firstname: 'Alvaro', lastname: 'Pérez', fullname: 'Alvaro Pérez', userid: YO, siteurl: `${base}${RAIZ}`, release: '5.1 (Build: 20251006)', version: '2025100600.06', functions: [] };
    case 'core_course_get_enrolled_courses_by_timeline_classification': {
      const t = s(Date.now());
      const lista = CURSOS.filter((c) => c.startdate <= t && (!c.enddate || c.enddate >= t));
      return { courses: lista.map((c) => ({ ...c, displayname: c.fullname, viewurl: `${base}${RAIZ}/course/view.php?id=${c.id}`, hidden: false, visible: true })), nextoffset: lista.length };
    }
    case 'core_enrol_get_users_courses':
      return CURSOS.map((c) => ({ ...c, visible: 1 }));
    case 'mod_assign_get_assignments': {
      const todas = asignaciones(base);
      return { courses: ids.map((id) => ({ id, fullname: CURSOS.find((c) => c.id === id)?.fullname, assignments: todas.filter((x) => x.course === id).map(({ estado, ...x }) => x) })), warnings: [] };
    }
    case 'mod_assign_get_submission_status': {
      const x = asignaciones(base).find((y) => y.id === Number(a.assignid));
      if (!x) return { exception: 'invalid_parameter_exception', errorcode: 'invalidparameter', message: 'No existe' };
      return { lastattempt: { submission: { status: x.estado }, gradingstatus: x.id === 2 ? 'graded' : 'notgraded', locked: false, cansubmit: true, canedit: true }, warnings: [] };
    }
    case 'mod_quiz_get_quizzes_by_courses':
      return { quizzes: EXAMENES.filter((q) => ids.includes(q.course)), warnings: [] };
    case 'mod_quiz_get_user_attempts':
      return { attempts: intentos.get(Number(a.quizid)) || [], warnings: [] };
    case 'mod_forum_get_forums_by_courses':
      return FOROS.filter((f) => ids.includes(f.course));
    case 'mod_forum_get_forum_discussions':
      return { discussions: DISCUSIONES[Number(a.forumid)] || [], warnings: [] };
    case 'core_calendar_get_action_events_by_courses':
      return { groupedbycourse: eventos(base).filter((g) => ids.includes(g.courseid)) };
    case 'core_course_get_contents':
      return contenidos(base, Number(a.courseid));
    case 'core_message_get_conversations':
      return { conversations: [
        { id: 31, name: '', type: 1, isread: false, unreadcount: 1, members: [{ id: 77, fullname: 'Mtra. Laura Gómez' }], messages: [{ id: 5001, useridfrom: 77, text: '<p>Alvaro, ¿me confirmas el grupo para la visita del viernes?</p>', timecreated: s(ahora - 3 * H) }] },
        { id: 32, name: 'Equipo Proyecto 3', type: 2, isread: true, unreadcount: 0, members: [{ id: 78, fullname: 'Diana López' }], messages: [{ id: 5002, useridfrom: 78, text: 'Ya subí el diagrama de casos de uso a la carpeta.', timecreated: s(ahora - 20 * H) }] },
        { id: 33, name: '', type: 1, isread: true, members: [{ id: YO, fullname: 'Alvaro Pérez' }], messages: [{ id: 5003, useridfrom: YO, text: 'Gracias!', timecreated: s(ahora - 30 * H) }] },
      ] };
    case 'message_popup_get_popup_notifications':
      return { notifications: [
        { id: 8001, subject: 'Calificación: Tarea 2.3 - Derivadas parciales', smallmessage: 'Tu entrega fue calificada: 9.5 / 10', component: 'mod_assign', timecreated: s(ahora - 6 * H), read: false, contexturl: `${base}${RAIZ}/mod/assign/view.php?id=1103` },
        { id: 8002, subject: 'Nuevo aviso: Cambio de salón', smallmessage: 'Dr. Ramírez publicó en Avisos', component: 'mod_forum', timecreated: s(ahora - 5 * H), read: false },
      ], unreadcount: 2 };
    case 'gradereport_user_get_grade_items':
      return { usergrades: [{ courseid: Number(a.courseid), userid: YO, gradeitems: [
        { id: 1, itemname: 'Tarea 2.3 - Derivadas parciales', itemtype: 'mod', itemmodule: 'assign', cmid: 1103, graderaw: 9.5, grademax: 10, gradeformatted: '9.50', percentageformatted: '95.00 %', gradedategraded: s(ahora - 6 * H) },
        { id: 2, itemname: 'Total del curso', itemtype: 'course', graderaw: 9.5, grademax: 10, gradeformatted: '9.50', percentageformatted: '95.00 %' },
      ] }], warnings: [] };
    case 'tool_mobile_get_autologin_key':
      if (a.privatetoken !== PRIVADO) return { exception: 'moodle_exception', errorcode: 'invalidprivatetoken', message: 'Token privado inválido' };
      return { key: 'llave-de-un-uso', autologinurl: `${base}${RAIZ}/admin/tool/mobile/autologin.php`, warnings: [] };
    default:
      return { exception: 'dml_missing_record_exception', errorcode: 'invalidrecord', message: `Función no disponible en el Moodle falso: ${nombre}` };
  }
}

// ---- Páginas ----

const pagina = (titulo, cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title>
<style>body{font:15px system-ui;margin:0;background:#f4f6fb;color:#1d2433}header{background:#063B91;color:#fff;padding:12px 20px;font-weight:600}main{padding:24px;max-width:760px}
.filemanager-container{border:2px dashed #8aa3cf;border-radius:10px;min-height:160px;padding:16px;background:#fff}.fp-file{padding:6px 10px;margin:4px 0;background:#e8eefb;border-radius:6px}
.dndupload-message{color:#667;font-size:13px}button{background:#063B91;color:#fff;border:0;border-radius:6px;padding:8px 14px}</style></head>
<body><header>Plataforma UII · Moodle (prueba)</header><main>${cuerpo}</main></body></html>`;

function conSesion(req) {
  return (req.headers.cookie || '').includes(COOKIE);
}

export function iniciar(puerto = 8765) {
  const servidor = http.createServer(async (req, res) => {
    const base = `http://${req.headers.host}`;
    const u = new URL(req.url, base);
    let cuerpo = '';
    for await (const trozo of req) cuerpo += trozo;
    const params = new URLSearchParams(req.method === 'POST' && /form-urlencoded/.test(req.headers['content-type'] || '') ? cuerpo : '');
    for (const [k, v] of u.searchParams) if (!params.has(k)) params.append(k, v);
    const json = (datos, estado = 200) => { res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(datos)); };
    const html = (texto, estado = 200, extra = {}) => { res.writeHead(estado, { 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(texto); };
    const ir = (destino, extra = {}) => { res.writeHead(303, { Location: destino, ...extra }); res.end(); };
    const ruta = u.pathname;

    if (ruta === `${RAIZ}/login/token.php`) {
      if (!params.get('username')) return json({ error: 'Falta un parámetro requerido (username)', errorcode: 'missingparam' });
      if (params.get('username') !== USUARIO || params.get('password') !== CONTRASENA) return json({ error: 'Datos de acceso inválidos. Por favor, inténtelo otra vez.', errorcode: 'invalidlogin' });
      return json({ token: TOKEN, privatetoken: PRIVADO });
    }
    if (ruta === `${RAIZ}/webservice/rest/server.php`) {
      const a = desaplanar([...params].filter(([k]) => !['wstoken', 'wsfunction', 'moodlewsrestformat'].includes(k)));
      const nombre = params.get('wsfunction');
      llamadas.push({ nombre, args: a });
      if (params.get('wstoken') !== TOKEN) return json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Token no válido - token no encontrado' });
      return json(funcion(nombre, a, base));
    }
    if (ruta.startsWith(`${RAIZ}/webservice/pluginfile.php/`)) {
      if (u.searchParams.get('token') !== TOKEN) return json({ error: 'Token inválido', errorcode: 'invalidtoken' }, 403);
      const archivo = ARCHIVOS[decodeURIComponent(ruta.slice(`${RAIZ}/webservice/pluginfile.php`.length))];
      if (!archivo) return html('No encontrado', 404);
      res.writeHead(200, { 'Content-Type': archivo.tipo, 'Content-Length': archivo.datos.length });
      return res.end(archivo.datos);
    }
    if (ruta === `${RAIZ}/login/index.php`) {
      if (req.method === 'POST') {
        if (params.get('username') === USUARIO && params.get('password') === CONTRASENA) return ir(`${RAIZ}/my/`, { 'Set-Cookie': `${COOKIE}; Path=${RAIZ}; HttpOnly` });
        return html(pagina('Acceso', '<p>Datos inválidos</p>'), 200);
      }
      return html(pagina('Acceso', `<form id="login" method="post" action="${RAIZ}/login/index.php"><p><input name="username" id="username" placeholder="Usuario"></p><p><input name="password" id="password" type="password" placeholder="Contraseña"></p><button id="loginbtn">Acceder</button></form>`));
    }
    if (ruta === `${RAIZ}/admin/tool/mobile/autologin.php`) {
      if (u.searchParams.get('key') !== 'llave-de-un-uso') return html('Llave inválida', 403);
      return ir(u.searchParams.get('urltogo') || `${RAIZ}/my/`, { 'Set-Cookie': `${COOKIE}; Path=${RAIZ}; HttpOnly` });
    }
    if (ruta === `${RAIZ}/_subido`) {
      llamadas.push({ nombre: '_subido', args: JSON.parse(cuerpo || '[]') });
      return json({ ok: true });
    }
    if (ruta === `${RAIZ}/_llamadas`) return json(llamadas);
    // Todo lo demás pide sesión del navegador.
    if (!conSesion(req)) return ir(`${RAIZ}/login/index.php`);
    if (ruta === `${RAIZ}/my/` || ruta === `${RAIZ}/my/index.php`) return html(pagina('Área personal', '<h1>Área personal</h1>'));
    if (ruta === `${RAIZ}/mod/assign/view.php`) {
      const cmid = u.searchParams.get('id');
      const x = asignaciones(base).find((y) => String(y.cmid) === cmid);
      if (!x) return html(pagina('No existe', '<p>No existe</p>'), 404);
      if (u.searchParams.get('action') === 'editsubmission') {
        // Como en Moodle real, la página trae otros selectores (uno oculto y el de otro campo).
        return html(pagina(x.name, `<h2>${x.name}</h2><form method="post"><div class="filemanager" style="display:none"></div>
          <div id="fitem_id_files_filemanager"><label>Archivos enviados</label>
          <div class="filemanager"><div class="filemanager-container"><div class="fp-content"></div><div class="dndupload-message">Puede arrastrar y soltar archivos aquí para añadirlos</div></div></div></div>
          <div id="fitem_id_otro"><label>Otro campo</label><div class="filemanager"><div class="fp-content"></div></div></div>
          <p><button type="button">Guardar cambios</button></p></form>
          <script>
            const c = document.querySelector('.filemanager-container');
            ['dragenter','dragover'].forEach((t) => c.addEventListener(t, (e) => e.preventDefault()));
            c.addEventListener('drop', (e) => {
              e.preventDefault();
              const nombres = [...e.dataTransfer.files].map((f) => f.name);
              setTimeout(() => {
                for (const n of nombres) { const d = document.createElement('div'); d.className = 'fp-file'; d.innerHTML = '<span class="fp-filename"></span>'; d.firstChild.textContent = n; document.querySelector('.fp-content').append(d); }
                fetch('${RAIZ}/_subido', { method: 'POST', body: JSON.stringify(nombres) });
              }, 700);
            });
          </script>`));
      }
      return html(pagina(x.name, `<h2>${x.name}</h2>${x.intro}<p><a href="?id=${cmid}&action=editsubmission">Agregar entrega</a></p>`));
    }
    return html(pagina('Moodle', `<p>${ruta}</p>`));
  });
  return new Promise((ok) => servidor.listen(puerto, '127.0.0.1', () => ok({ servidor, url: `http://127.0.0.1:${servidor.address().port}${RAIZ}`, llamadas })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url: direccion } = await iniciar(Number(process.argv[2]) || 8765);
  console.log(`Moodle falso en ${direccion} · usuario: ${USUARIO} · contraseña: ${CONTRASENA}`);
}
