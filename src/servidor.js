#!/usr/bin/env node
// Servidor MCP de Moodle por stdio. Todo lo que no sea el protocolo va a
// stderr: escribir en stdout rompería la conexión.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { carpetaDescargas, configurarTransporte, descargar, htmlATexto, usuarioActual, ws } from './cliente.js';
import { urlBase } from './sesion.js';
import { agenda } from './agenda.js';
import { cursosActuales, resumen } from './datos.js';
import { registrarHerramientasBBToday } from './herramientas-bbtoday.js';

// Arrancado por la app de Claude desde Insti Today (BB_MCP_APP=1): la sesión
// la mantiene Insti Today; si caducó, no se puede renovar desde aquí.
if (process.env.BB_MCP_APP) {
  configurarTransporte({ mensajeSesion: 'La sesión de Moodle se cerró. Abre Insti Today e inicia sesión de nuevo.' });
}

const servidor = new McpServer({ name: 'insti-today', version: '0.1.2' });
const curso = z.string().describe('Id numérico del curso de Moodle. Sale de listar_cursos.');

// Desde Insti Today sólo existen las herramientas de sus tareas: Claude no
// puede recorrer otros cursos ni ver calificaciones.
function herramienta(nombre, descripcion, esquema, fn) {
  if (process.env.BB_MCP_APP) return;
  servidor.registerTool(nombre, { description: descripcion, inputSchema: esquema, annotations: { readOnlyHint: true } }, async (args) => {
    try {
      const resultado = await fn(args);
      const texto = typeof resultado === 'string' ? resultado : JSON.stringify(resultado, null, 2);
      return { content: [{ type: 'text', text: texto }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  });
}

// Las fechas se muestran en la hora local de esta máquina.
const fecha = (f) => (f ? new Date(f).toLocaleString('sv-SE').slice(0, 16) : undefined);

herramienta('quien_soy', 'Usuario con el que está iniciada la sesión de Moodle.', {}, async () => {
  const u = await usuarioActual();
  return { moodle: urlBase(), sitio: u.sitename, usuario: u.username, nombre: u.fullname, id: u.userid, version: u.release };
});

herramienta('listar_cursos', 'Cursos en progreso del semestre.', {}, async () => cursosActuales());

herramienta('agenda', 'Todas las tareas, exámenes y foros con fecha de los cursos actuales, con su estado.', {}, async () => {
  const a = await agenda();
  return a.cursos.map((c) => ({
    curso: c.nombre,
    id: c.id,
    tareas: c.tareas.map((t) => ({ id: t.id, tipo: t.tipo, titulo: t.titulo, entrega: fecha(t.entrega), estado: t.estado, seccion: t.ruta?.[0], enlace: t.enlace })),
  }));
});

herramienta('resumen', 'Resumen del semestre: total de cada curso, calificaciones por actividad y avisos.', {}, async () => resumen());

herramienta(
  'leer_contenido',
  'Secciones y actividades de un curso, con los archivos de cada recurso (fileurl se descarga con descargar_enlace).',
  { curso },
  async ({ curso: c }) => {
    const secciones = await ws('core_course_get_contents', { courseid: Number(c) });
    return secciones.map((s) => ({
      seccion: htmlATexto(s.name).texto,
      resumen: htmlATexto(s.summary).texto.slice(0, 400) || undefined,
      actividades: (s.modules || []).map((m) => ({
        id: m.id,
        tipo: m.modname,
        nombre: m.name,
        visible: m.uservisible !== false,
        archivos: (m.contents || []).filter((f) => f.type === 'file').map((f) => ({ nombre: f.filename, bytes: f.filesize, fileurl: f.fileurl })),
      })),
    }));
  },
);

herramienta(
  'descargar_enlace',
  'Descarga un archivo de Moodle (una fileurl de pluginfile.php) al disco. Sólo acepta direcciones de tu propio Moodle.',
  {
    url: z.string().describe('URL completa del archivo en tu Moodle.'),
    carpeta: z.string().optional().describe('Carpeta de destino. Por defecto Descargas\\Insti Today.'),
  },
  async ({ url, carpeta }) => descargar(url, carpeta || carpetaDescargas()),
);

herramienta('consultar_notas', 'Tus calificaciones en un curso, actividad por actividad, con el total que calcula Moodle.', { curso }, async ({ curso: c }) => {
  const u = await usuarioActual();
  const r = await ws('gradereport_user_get_grade_items', { courseid: Number(c), userid: u.userid });
  return (r.usergrades?.[0]?.gradeitems || []).map((g) => ({
    actividad: g.itemtype === 'course' ? 'TOTAL DEL CURSO' : g.itemname,
    nota: g.gradeformatted,
    porcentaje: g.percentageformatted,
    rango: g.rangeformatted,
    entregada: fecha(g.gradedatesubmitted ? g.gradedatesubmitted * 1000 : null),
    comentario: g.feedback ? htmlATexto(g.feedback).texto : undefined,
  }));
});

registrarHerramientasBBToday(servidor);

await servidor.connect(new StdioServerTransport());
console.error('insti-today MCP listo');
