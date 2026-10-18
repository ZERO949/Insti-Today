// Mensajes, avisos y notificaciones de Moodle, para la bolita del widget.
//
// - Mensajes: las conversaciones de la mensajería de Moodle.
// - Anuncios: el foro «Avisos» de cada curso.
// - Notificaciones: las de la campanita (calificaciones, entregas, etc.),
//   sin las de foros, que ya salen como anuncios.
// Sólo se leen: marcar como visto pasa en la app, no en Moodle.

import { htmlATexto, iso, usuarioActual, wsOpcional } from './cliente.js';
import { urlBase } from './sesion.js';

const MAX = 40;
const extracto = (html) => htmlATexto(String(html || '')).texto.replace(/\s+/g, ' ').trim().slice(0, 280);

async function conversaciones(yo) {
  const base = urlBase();
  const r = await wsOpcional('core_message_get_conversations', { userid: yo.userid, limitfrom: 0, limitnum: 15 }, null);
  if (!r) throw new Error('No se pudieron leer los mensajes.');
  const lista = [];
  for (const c of r.conversations || []) {
    // type 3: conversación contigo mismo (notas personales).
    if (c.type === 3) continue;
    const nombres = new Map((c.members || []).map((m) => [m.id, m.fullname]));
    const curso = c.type === 2 ? c.name || 'Grupo' : 'Mensaje directo';
    for (const m of c.messages || []) {
      if (m.useridfrom === yo.userid) continue;
      lista.push({
        id: `m:${m.id}`,
        tipo: 'mensaje',
        curso,
        de: nombres.get(m.useridfrom) || c.name || 'Moodle',
        texto: extracto(m.text),
        cuando: iso(m.timecreated),
        leidoEnBb: c.isread === true,
        enlace: `${base}/message/index.php?convid=${c.id}`,
      });
    }
  }
  return lista;
}

async function anuncios(cursos) {
  const ids = (cursos || []).map((c) => Number(c.id)).filter(Boolean);
  if (!ids.length) return [];
  const foros = await wsOpcional('mod_forum_get_forums_by_courses', { courseids: ids }, null);
  if (!foros) throw new Error('No se pudieron leer los anuncios.');
  const nombreDe = new Map((cursos || []).map((c) => [Number(c.id), c.nombre]));
  const base = urlBase();
  const listas = await Promise.all(
    foros
      .filter((f) => f.type === 'news')
      .map(async (f) => {
        const r = await wsOpcional('mod_forum_get_forum_discussions', { forumid: f.id, sortorder: -1, page: 0, perpage: 10 }, { discussions: [] });
        return (r.discussions || []).map((d) => ({
          id: `a:${d.discussion || d.id}`,
          tipo: 'anuncio',
          curso: nombreDe.get(f.course) || '',
          de: d.subject || d.name || 'Anuncio',
          texto: extracto(d.message),
          cuando: iso(d.created || d.timemodified || d.modified),
          leidoEnBb: false,
          enlace: `${base}/mod/forum/discuss.php?d=${d.discussion || d.id}`,
        }));
      }),
  );
  return listas.flat();
}

async function notificaciones(yo) {
  const r = await wsOpcional('message_popup_get_popup_notifications', { useridto: yo.userid, newestfirst: 1, limit: 20, offset: 0 }, null);
  if (!r) return [];
  return (r.notifications || [])
    .filter((n) => n.component !== 'mod_forum')
    .map((n) => ({
      id: `n:${n.id}`,
      tipo: 'notificacion',
      curso: '',
      de: `🔔 ${n.subject || 'Notificación'}`,
      texto: extracto(n.smallmessage || n.fullmessagehtml || n.fullmessage),
      cuando: iso(n.timecreated),
      leidoEnBb: n.read === true,
      enlace: n.contexturl || `${urlBase()}/message/output/popup/notifications.php`,
    }));
}

// Lo más reciente primero. «fallidos» cuenta las fuentes que no se pudieron
// leer, para no decir «no hay mensajes» cuando no se sabe.
export async function mensajes(cursos) {
  const yo = await usuarioActual();
  const resultados = await Promise.allSettled([conversaciones(yo), anuncios(cursos), notificaciones(yo)]);
  const todos = resultados.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const lista = todos
    .filter((m) => m.cuando)
    .sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando))
    .slice(0, MAX);
  return { lista, fallidos: resultados.filter((r) => r.status === 'rejected').length, total: resultados.length };
}
