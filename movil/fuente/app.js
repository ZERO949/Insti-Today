// Insti Today para Android: la agenda, los mensajes y los ajustes en una sola
// página. La capa de Moodle es la misma de la app de escritorio (src/); aquí
// sólo cambia cómo se dibuja y cómo se habla con el teléfono (nativo.js).

import fs from 'node:fs';
import path from 'node:path';
import { agenda, ajustes } from '../../src/agenda.js';
import { mensajes as leerMensajes } from '../../src/mensajes.js';
import { detalle } from '../../src/detalle.js';
import { configurarTransporte, olvidarUsuario, urlConToken, ws } from '../../src/cliente.js';
import { DIR_DATOS, borrarSesion, guardarSesion, leerSesion, normalizarUrl, pedirToken } from '../../src/sesion.js';
import * as nativo from './nativo.js';

const PLATAFORMA = 'plataforma.uii.edu.mx/moodle';
const DIA = 86_400_000;
const COLORES = ['#4f7cf0', '#f0743d', '#1fb589', '#a46cf0', '#d99a1e', '#ec5f98', '#2ea6cf', '#7cb342'];
const TIPOS = { pdf: '#e5534b', docx: '#2f6fd8', doc: '#2f6fd8', pptx: '#d2692b', ppt: '#d2692b', xlsx: '#2e9a5a', xls: '#2e9a5a', zip: '#8a6cd4', png: '#3aa0a8', jpg: '#3aa0a8', jpeg: '#3aa0a8' };
const PREFS = { avisos: true, avisoHoras: 3, diasAtras: 7, soloTardias: true, tema: 'sistema' };

let version = '';

configurarTransporte({ fetch: nativo.fetchNativo, mensajeSesion: 'Tu sesión de Moodle caducó. Vuelve a iniciar sesión.' });

// ---- Utilidades ----

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const inicioDia = (t) => new Date(t).setHours(0, 0, 0, 0);
const fmtHora = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' });
const fmtDia = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLargo = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

function leer(clave) {
  try {
    return JSON.parse(localStorage.getItem(`insti:${clave}`));
  } catch {
    return null;
  }
}
function escribir(clave, valor) {
  try {
    if (valor === undefined) localStorage.removeItem(`insti:${clave}`);
    else localStorage.setItem(`insti:${clave}`, JSON.stringify(valor));
  } catch {}
}

function hace(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} d`;
}

function peso(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// Texto plano con los enlaces tocables.
const enlazar = (texto) => esc(texto).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:)]/g, (u) => `<a href="#" data-web="${u}">${u}</a>`);

let avisoTimer = 0;
function toast(texto) {
  const t = $('#toast');
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---- Estado ----

const estado = {
  datos: leer('agenda'),
  mensajes: leer('mensajes'),
  vistos: new Set(leer('vistos') || []),
  quitadas: leer('quitadas') || [],
  prefs: { ...PREFS, ...leer('prefs') },
  pestana: 'pendientes',
  filtro: 'activas',
  filtroMensajes: 'todo',
  tarea: null, // { tarea, archivos, cargando }
  cargando: false,
  error: null,
  permiso: null,
};

function guardarPrefs(cambios) {
  estado.prefs = { ...estado.prefs, ...cambios };
  escribir('prefs', estado.prefs);
  aplicarTema();
}

function aplicarTema() {
  const t = estado.prefs.tema;
  if (t === 'sistema') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// Las materias ocultas viven en ajustes.json de src/agenda.js (en Android,
// en el almacenamiento de la app), así la agenda ya llega sin ellas.
const ARCHIVO_AJUSTES = path.join(DIR_DATOS, 'ajustes.json');
function ocultarMaterias(ocultas) {
  fs.writeFileSync(ARCHIVO_AJUSTES, JSON.stringify({ ...ajustes(), ocultar: ocultas }));
}

// ---- Sesión ----

async function entrar(url, usuario, contrasena) {
  const base = normalizarUrl(url);
  const { token, privatetoken } = await pedirToken(base, usuario, contrasena, { fetch: nativo.fetchNativo });
  guardarSesion({ url: base, token, privatetoken });
  olvidarUsuario();
  try {
    const info = await ws('core_webservice_get_site_info', {}, { cache: false });
    guardarSesion({ url: base, token, privatetoken, userid: info.userid, usuario: info.username, nombre: info.fullname, guardada: new Date().toISOString() });
  } catch (e) {
    borrarSesion();
    throw e;
  }
}

function salir(mensaje) {
  borrarSesion();
  olvidarUsuario();
  for (const k of ['agenda', 'mensajes', 'vistos', 'quitadas', 'avisados', 'programados']) escribir(k, undefined);
  Object.assign(estado, { datos: null, mensajes: null, vistos: new Set(), quitadas: [], tarea: null, error: null, pestana: 'pendientes' });
  nativo.programarAvisos([]).catch(() => {});
  pintarAcceso(mensaje);
}

// Abre una página de Moodle ya con la sesión iniciada, con la llave de un
// uso que da Moodle a su app móvil. Moodle sólo da una cada 6 minutos; si no
// la da, la página se abre normal (la pestaña suele conservar la sesión).
let ultimaLlave = 0;
async function abrirEnMoodle(destino) {
  const s = leerSesion();
  let url = destino;
  if (s?.privatetoken && Date.now() - ultimaLlave > 6 * 60_000) {
    try {
      const r = await nativo.fetchNativo(`${s.url}/webservice/rest/server.php?moodlewsrestformat=json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MoodleMobile Insti Today' },
        body: new URLSearchParams({ wstoken: s.token, wsfunction: 'tool_mobile_get_autologin_key', privatetoken: s.privatetoken }).toString(),
      });
      const d = await r.json();
      if (d?.key && d?.autologinurl) {
        const u = new URL(d.autologinurl);
        u.searchParams.set('userid', s.userid);
        u.searchParams.set('key', d.key);
        u.searchParams.set('urlrecipient', destino);
        url = u.href;
        ultimaLlave = Date.now();
      }
    } catch {}
  }
  await nativo.abrirPagina(url);
}

// ---- Datos ----

async function actualizar() {
  if (estado.cargando || !leerSesion()?.token) return;
  estado.cargando = true;
  pintar();
  try {
    const datos = await agenda();
    estado.datos = datos;
    estado.error = null;
    escribir('agenda', datos);
    programarAvisos();
    const m = await leerMensajes(datos.cursos).catch(() => null);
    if (m) {
      estado.mensajes = m;
      escribir('mensajes', m);
    }
  } catch (e) {
    if (e.estado === 401) return salir(e.message);
    estado.error = e.message;
  } finally {
    estado.cargando = false;
    if (leerSesion()?.token) pintar();
  }
}

function tareas() {
  const quitadas = new Set(estado.quitadas.map((q) => q.id));
  return (estado.datos?.cursos || []).flatMap((c, i) =>
    c.tareas
      .filter((t) => t.estado === 'pendiente' && !quitadas.has(t.id))
      .map((t) => ({ ...t, curso: c.nombre, cursoId: c.id, color: COLORES[i % COLORES.length], cuando: t.entrega ? Date.parse(t.entrega) : null })),
  );
}

function buscarTarea(id) {
  return tareas().find((t) => t.id === id) || null;
}

// Las vencidas que se enseñan en «Por entregar»: las de los últimos días y,
// si así se eligió, sólo las que aún aceptan entrega.
function vencidaVisible(t, ahora) {
  const p = estado.prefs;
  return p.diasAtras > 0 && ahora - t.cuando <= p.diasAtras * DIA && (t.tardia || !p.soloTardias);
}

function filtradas() {
  const ahora = Date.now();
  const todas = tareas();
  const porFecha = (a, b) => a.cuando - b.cuando;
  switch (estado.filtro) {
    case 'vencidas':
      return todas.filter((t) => t.cuando && t.cuando < ahora).sort((a, b) => b.cuando - a.cuando);
    case 'sinfecha':
      return todas.filter((t) => !t.cuando).sort((a, b) => (Date.parse(b.creada || 0) || 0) - (Date.parse(a.creada || 0) || 0));
    case 'todas':
      return [...todas.filter((t) => t.cuando).sort(porFecha), ...todas.filter((t) => !t.cuando)];
    default:
      return todas.filter((t) => t.cuando && (t.cuando >= ahora || vencidaVisible(t, ahora))).sort(porFecha);
  }
}

function grupoDe(t, ahora) {
  if (!t.cuando) return 'Sin fecha';
  if (t.cuando < ahora) return 'Vencidas';
  const dias = Math.round((inicioDia(t.cuando) - inicioDia(ahora)) / DIA);
  if (dias === 0) return 'Hoy';
  if (dias === 1) return 'Mañana';
  if (dias < 7) return 'Esta semana';
  return 'Más adelante';
}

function pastilla(t) {
  if (!t.cuando) return ['sin fecha', ''];
  const ahora = Date.now();
  if (t.cuando < ahora) {
    const d = Math.round((inicioDia(ahora) - inicioDia(t.cuando)) / DIA);
    return [d === 0 ? 'hoy, tarde' : d === 1 ? 'ayer' : `hace ${d} d`, t.tardia ? 'pronto' : 'mal'];
  }
  const h = (t.cuando - ahora) / 3_600_000;
  if (h < 6) return [h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.floor(h)} h`, 'mal'];
  if (inicioDia(t.cuando) === inicioDia(ahora)) return [fmtHora.format(t.cuando), 'pronto'];
  if (inicioDia(t.cuando) - inicioDia(ahora) === DIA) return [`mañana ${fmtHora.format(t.cuando)}`, ''];
  return [fmtDia.format(t.cuando), ''];
}

const NOMBRE_TIPO = { tarea: 'Tarea', examen: 'Examen', foro: 'Foro', encuesta: 'Encuesta' };

// ---- Recordatorios ----

// Una notificación por tarea pendiente, `avisoHoras` antes de que venza.
// Las que ya se avisaron no se repiten.
function idAviso(clave) {
  let h = 0;
  for (const c of clave) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (h & 0x7fffffff) || 1;
}

async function programarAvisos() {
  const p = estado.prefs;
  const ahora = Date.now();
  const antes = leer('programados') || {};
  const avisados = new Set(leer('avisados') || []);
  // Lo programado cuya hora ya pasó, ya sonó.
  for (const [clave, cuando] of Object.entries(antes)) if (cuando <= ahora) avisados.add(clave);
  const lista = [];
  const programados = {};
  if (p.avisos) {
    for (const t of tareas()) {
      if (!t.cuando || t.cuando <= ahora) continue;
      const clave = `${t.id}@${t.entrega}`;
      if (avisados.has(clave)) continue;
      let cuando = t.cuando - p.avisoHoras * 3_600_000;
      if (cuando <= ahora) {
        cuando = ahora + 3000;
        avisados.add(clave);
      } else programados[clave] = cuando;
      const horas = Math.max(1, Math.round((t.cuando - cuando) / 3_600_000));
      lista.push({
        id: idAviso(clave),
        tarea: t.id,
        cuando,
        titulo: `Vence en ${horas} h: ${t.titulo}`,
        cuerpo: `${t.curso} · ${fmtHora.format(t.cuando)}`,
      });
    }
  }
  lista.sort((a, b) => a.cuando - b.cuando);
  escribir('programados', programados);
  escribir('avisados', [...avisados].filter((c) => Date.parse(c.split('@')[1]) > ahora - 14 * DIA));
  try {
    await nativo.programarAvisos(lista.slice(0, 60));
  } catch (e) {
    console.warn('Recordatorios:', e);
  }
}

// ---- Pantallas ----

const ICONOS = {
  pendientes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/></svg>',
  mensajes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/></svg>',
  ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  recargar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/></svg>',
  atras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  externo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  subir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  mensaje: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/></svg>',
  anuncio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1ZM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>',
  notificacion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
};

function pintarAcceso(mensaje = '') {
  document.body.className = 'en-acceso';
  const guardada = leer('plataforma') || PLATAFORMA;
  $('#app').innerHTML = `
    <main class="acceso">
      <img class="logo" src="icono.png" alt="">
      <h1>Insti Today</h1>
      <p class="sub">Tus pendientes de Moodle, a la vista.</p>
      <form id="form-acceso" autocomplete="on">
        <div class="campo-plataforma">
          <span>Plataforma</span>
          <b id="plataforma-texto">${esc(guardada)}</b>
          <button type="button" class="enlace" id="cambiar-plataforma">Cambiar</button>
        </div>
        <label class="campo" hidden id="campo-plataforma"><span>Dirección de tu Moodle</span>
          <input name="plataforma" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(guardada)}"></label>
        <label class="campo"><span>Usuario</span>
          <input name="usuario" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="campo"><span>Contraseña</span>
          <input name="contrasena" type="password" autocomplete="current-password" required></label>
        <p class="error" id="error-acceso" ${mensaje ? '' : 'hidden'}>${esc(mensaje)}</p>
        <button class="boton primario grande" id="boton-entrar">Iniciar sesión</button>
      </form>
      <p class="nota">Tu contraseña va directo a tu Moodle, como con su app oficial, y no se guarda. Insti Today sólo guarda la llave de lectura que te da Moodle, en este teléfono.</p>
    </main>`;
  $('#cambiar-plataforma').onclick = () => {
    $('#campo-plataforma').hidden = false;
    $('.campo-plataforma').hidden = true;
    $('[name=plataforma]').focus();
  };
  $('#form-acceso').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const boton = $('#boton-entrar');
    const error = $('#error-acceso');
    boton.disabled = true;
    boton.textContent = 'Entrando…';
    error.hidden = true;
    try {
      await entrar(f.plataforma.value.trim() || PLATAFORMA, f.usuario.value, f.contrasena.value);
      escribir('plataforma', f.plataforma.value.trim() || PLATAFORMA);
      iniciar();
      // Se pide permiso para los recordatorios en cuanto hay algo que avisar.
      nativo.permisoAvisos(true).then((p) => (estado.permiso = p)).catch(() => {});
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      boton.disabled = false;
      boton.textContent = 'Iniciar sesión';
    }
  };
}

function pintarEsqueleto() {
  document.body.className = '';
  $('#app').innerHTML = `
    <header class="barra">
      <h1 id="titulo"></h1>
      <span class="estado" id="estado"></span>
      <button class="icono-boton" id="recargar" aria-label="Revisar Moodle">${ICONOS.recargar}</button>
    </header>
    <main id="contenido" class="contenido"></main>
    <nav class="pestanas">
      <button data-pestana="pendientes">${ICONOS.pendientes}<span>Pendientes</span><i class="globo" id="globo-pendientes" hidden></i></button>
      <button data-pestana="mensajes">${ICONOS.mensajes}<span>Mensajes</span><i class="globo" id="globo-mensajes" hidden></i></button>
      <button data-pestana="ajustes">${ICONOS.ajustes}<span>Ajustes</span></button>
    </nav>
    <section id="detalle" class="hoja" hidden></section>`;
  $('#recargar').onclick = () => actualizar();
  $('.pestanas').onclick = (e) => {
    const b = e.target.closest('[data-pestana]');
    if (!b) return;
    if (estado.pestana === b.dataset.pestana) $('#contenido').scrollTo({ top: 0, behavior: 'smooth' });
    estado.pestana = b.dataset.pestana;
    pintar();
    $('#contenido').scrollTop = 0;
  };
  $('#contenido').addEventListener('click', alTocar);
  $('#detalle').addEventListener('click', alTocar);
  $('#contenido').addEventListener('change', alCambiar);
  deslizarParaActualizar($('#contenido'));
}

function pintar() {
  if (!$('#contenido')) return;
  const titulos = { pendientes: 'Pendientes', mensajes: 'Mensajes', ajustes: 'Ajustes' };
  $('#titulo').textContent = titulos[estado.pestana];
  $('#recargar').classList.toggle('girando', estado.cargando);
  $('#estado').textContent = estado.cargando ? 'Revisando…' : estado.datos ? `Revisado ${hace(estado.datos.generado)}` : '';
  for (const b of document.querySelectorAll('[data-pestana]')) b.classList.toggle('activa', b.dataset.pestana === estado.pestana);

  const ahora = Date.now();
  const urgentes = tareas().filter((t) => t.cuando && t.cuando >= ahora && t.cuando - ahora < DIA).length;
  const g1 = $('#globo-pendientes');
  g1.hidden = !urgentes;
  g1.textContent = urgentes;
  const nuevos = (estado.mensajes?.lista || []).filter((m) => !estado.vistos.has(m.id) && !m.leidoEnBb).length;
  const g2 = $('#globo-mensajes');
  g2.hidden = !nuevos;
  g2.textContent = nuevos > 9 ? '9+' : nuevos;

  const c = $('#contenido');
  if (estado.pestana === 'pendientes') c.innerHTML = vistaPendientes();
  else if (estado.pestana === 'mensajes') c.innerHTML = vistaMensajes();
  else c.innerHTML = vistaAjustes();
}

function bannerError() {
  if (!estado.error) return '';
  return `<div class="banner">${esc(estado.error)}${estado.datos ? '<br><span>Se muestra lo último que se pudo leer.</span>' : ''}</div>`;
}

function vistaPendientes() {
  if (!estado.datos) {
    return `${bannerError()}<div class="vacio">${estado.cargando ? '<div class="girador"></div>Leyendo tus cursos de Moodle…' : 'Aún no hay datos. Toca ↻ para revisar Moodle.'}</div>`;
  }
  const chips = [
    ['activas', 'Por entregar'],
    ['vencidas', 'Vencidas'],
    ['sinfecha', 'Sin fecha'],
    ['todas', 'Todas'],
  ]
    .map(([v, t]) => `<button class="chip ${estado.filtro === v ? 'activo' : ''}" data-filtro="${v}">${t}</button>`)
    .join('');
  const lista = filtradas();
  const ahora = Date.now();
  let html = '';
  let grupo = null;
  for (const t of lista) {
    const g = estado.filtro === 'activas' || estado.filtro === 'todas' ? grupoDe(t, ahora) : null;
    if (g && g !== grupo) {
      html += `<h2 class="grupo-titulo ${g === 'Vencidas' ? 'mal' : ''}">${g === 'Vencidas' ? 'Vencidas · aún se aceptan' : g}</h2>`;
      grupo = g;
    }
    const [texto, clase] = pastilla(t);
    const detalles = [t.curso, NOMBRE_TIPO[t.tipo] || 'Actividad', t.borrador ? 'borrador guardado' : null, t.bloqueada ? 'aún no abre' : null].filter(Boolean);
    html += `<button class="fila" data-tarea="${esc(t.id)}">
      <i class="punto" style="background:${t.color}"></i>
      <span class="info"><b>${esc(t.titulo)}</b><span>${esc(detalles.join(' · '))}</span></span>
      <span class="pastilla ${clase}">${esc(texto)}</span>
    </button>`;
  }
  const vacios = {
    activas: '¡Nada pendiente! 🎉<br><span>No tienes entregas próximas en Moodle.</span>',
    vencidas: 'No tienes tareas vencidas sin entregar.',
    sinfecha: 'No hay tareas sin fecha pendientes.',
    todas: 'No hay tareas pendientes.',
  };
  return `${bannerError()}<div class="chips">${chips}</div>${html || `<div class="vacio">${vacios[estado.filtro]}</div>`}`;
}

function vistaMensajes() {
  const m = estado.mensajes;
  if (!m) return `${bannerError()}<div class="vacio">${estado.cargando ? '<div class="girador"></div>Leyendo mensajes…' : 'Aún no hay mensajes leídos. Toca ↻ para revisar Moodle.'}</div>`;
  const tipos = [
    ['todo', 'Todo'],
    ['mensaje', 'Mensajes'],
    ['anuncio', 'Avisos'],
    ['notificacion', 'Notificaciones'],
  ];
  const chips = tipos.map(([v, t]) => `<button class="chip ${estado.filtroMensajes === v ? 'activo' : ''}" data-filtro-mensajes="${v}">${t}</button>`).join('');
  const lista = m.lista.filter((x) => estado.filtroMensajes === 'todo' || x.tipo === estado.filtroMensajes);
  const hayNuevos = m.lista.some((x) => !estado.vistos.has(x.id) && !x.leidoEnBb);
  const filas = lista
    .map((x) => {
      const nuevo = !estado.vistos.has(x.id) && !x.leidoEnBb;
      return `<button class="mensaje ${nuevo ? 'nuevo' : ''}" data-mensaje="${esc(x.id)}">
        <span class="tipo-icono ${x.tipo}">${ICONOS[x.tipo] || ICONOS.mensaje}</span>
        <span class="info">
          <span class="arriba"><b>${esc(x.de.replace(/^🔔\s*/, ''))}</b><time>${esc(hace(x.cuando))}</time></span>
          ${x.curso ? `<span class="curso">${esc(x.curso)}</span>` : ''}
          <span class="texto">${esc(x.texto)}</span>
        </span>
      </button>`;
    })
    .join('');
  const aviso = m.fallidos ? `<div class="banner suave">No se pudo leer ${m.fallidos === 1 ? 'una de las fuentes' : 'algunas fuentes'} (tu escuela puede no permitirlo).</div>` : '';
  return `${bannerError()}${aviso}<div class="chips">${chips}${hayNuevos ? '<button class="chip enlace" data-todo-visto>Marcar todo visto</button>' : ''}</div>${filas || '<div class="vacio">Nada por aquí.</div>'}`;
}

function vistaAjustes() {
  const s = leerSesion() || {};
  const p = estado.prefs;
  const iniciales = (s.nombre || s.usuario || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
  const host = s.url ? s.url.replace(/^https?:\/\//, '') : '';
  const opcion = (valor, actual, texto) => `<option value="${valor}" ${String(valor) === String(actual) ? 'selected' : ''}>${texto}</option>`;
  const materias = (estado.datos?.materias || [])
    .map((m) => `<label class="materia"><input type="checkbox" data-materia="${esc(m.nombre)}" ${m.oculta ? '' : 'checked'}><span>${esc(m.nombre)}</span></label>`)
    .join('');
  const quitadas = estado.quitadas
    .map((q) => `<div class="quitada"><span><b>${esc(q.titulo)}</b><span>${esc(q.curso)}</span></span><button class="boton chico" data-devolver="${esc(q.id)}">Devolver</button></div>`)
    .join('');
  const permiso =
    estado.permiso === 'no' && p.avisos
      ? '<span class="mal">Android tiene bloqueadas las notificaciones de Insti Today. Actívalas en Ajustes del teléfono → Apps → Insti Today.</span>'
      : '<span>Una notificación por tarea, aunque la app esté cerrada.</span>';
  return `
    <h2 class="titulo-grupo">Cuenta</h2>
    <div class="grupo">
      <div class="opcion"><span class="avatar">${esc(iniciales)}</span><span class="texto"><b>${esc(s.nombre || s.usuario || '')}</b><span>${esc(s.usuario || '')} · ${esc(host)}</span></span></div>
      <div class="opcion"><button class="boton peligro" data-salir>Cerrar sesión</button></div>
    </div>

    <h2 class="titulo-grupo">Recordatorios</h2>
    <div class="grupo">
      <label class="opcion"><span class="texto"><b>Avisarme antes de que venza</b>${permiso}</span>
        <span class="interruptor"><input type="checkbox" data-pref="avisos" ${p.avisos ? 'checked' : ''}><i></i></span></label>
      <div class="opcion" ${p.avisos ? '' : 'hidden'}><span class="texto"><b>Con cuánta anticipación</b></span>
        <select data-pref="avisoHoras">${[1, 2, 3, 6, 12, 24].map((h) => opcion(h, p.avisoHoras, h === 24 ? '1 día' : `${h} h`)).join('')}</select></div>
    </div>

    <h2 class="titulo-grupo">Por entregar</h2>
    <div class="grupo">
      <div class="opcion"><span class="texto"><b>Vencidas en la lista</b><span>Las que se te pasaron y no entregaste</span></span>
        <select data-pref="diasAtras">${opcion(0, p.diasAtras, 'No mostrarlas')}${opcion(1, p.diasAtras, 'Último día')}${opcion(3, p.diasAtras, 'Últimos 3 días')}${opcion(7, p.diasAtras, 'Última semana')}${opcion(14, p.diasAtras, 'Últimas 2 semanas')}</select></div>
      <label class="opcion"><span class="texto"><b>Sólo si aún se pueden entregar</b><span>Oculta las vencidas sin entrega tardía</span></span>
        <span class="interruptor"><input type="checkbox" data-pref="soloTardias" ${p.soloTardias ? 'checked' : ''}><i></i></span></label>
    </div>

    ${materias ? `<h2 class="titulo-grupo">Materias</h2><div class="grupo"><div class="opcion columna"><span class="texto"><span>Desmarca las que no quieras ver</span></span><div class="materias">${materias}</div></div></div>` : ''}

    ${quitadas ? `<h2 class="titulo-grupo">Tareas quitadas</h2><div class="grupo"><div class="opcion columna">${quitadas}</div></div>` : ''}

    <h2 class="titulo-grupo">Apariencia</h2>
    <div class="grupo"><div class="opcion"><span class="texto"><b>Tema</b></span>
      <span class="segmentos">${[['sistema', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([v, t]) => `<button class="${p.tema === v ? 'activo' : ''}" data-tema="${v}">${t}</button>`).join('')}</span></div></div>

    <h2 class="titulo-grupo">Privacidad</h2>
    <div class="grupo"><div class="opcion columna privacidad">
      <p><b>Tu contraseña no se guarda.</b> Va directo a tu Moodle, como con su app móvil; la app sólo guarda la llave de lectura que Moodle le da, en este teléfono.</p>
      <p><b>Sólo lee.</b> Insti Today no entrega, publica ni marca nada en Moodle. «Entregar en Moodle» abre la página oficial y el envío lo haces tú.</p>
      <p><b>Sin servidor propio ni analítica.</b> La app sólo habla con tu Moodle. Los archivos que abres se bajan a la memoria temporal de la app.</p>
      <p><b>Para borrar todo:</b> «Cerrar sesión» elimina la sesión y los datos guardados.</p>
    </div></div>
    <p class="pie">Insti Today ${esc(version)} · basado en BB Today de Ironmistyfox (MIT)</p>`;
}

// ---- Detalle de una tarea ----

function abrirTarea(id) {
  const t = buscarTarea(id);
  if (!t) return toast('Esa tarea ya no está en tu lista.');
  estado.tarea = { tarea: t, archivos: t.adjuntos || [], cargando: !!t.relacionados?.length };
  pintarDetalle();
  const hoja = $('#detalle');
  hoja.hidden = false;
  hoja.scrollTop = 0;
  requestAnimationFrame(() => hoja.classList.add('abierta'));
  if (t.relacionados?.length) {
    detalle(t.cursoId, t)
      .then((d) => {
        if (estado.tarea?.tarea.id !== id) return;
        estado.tarea.archivos = d.archivos;
      })
      .catch(() => {})
      .finally(() => {
        if (estado.tarea?.tarea.id !== id) return;
        estado.tarea.cargando = false;
        pintarDetalle();
      });
  }
}

function cerrarTarea() {
  const hoja = $('#detalle');
  if (!estado.tarea || !hoja) return false;
  estado.tarea = null;
  hoja.classList.remove('abierta');
  setTimeout(() => {
    if (!estado.tarea) hoja.hidden = true;
  }, 260);
  return true;
}

function pintarDetalle() {
  const { tarea: t, archivos, cargando } = estado.tarea;
  const ahora = Date.now();
  const fechas = [];
  if (t.abre) fechas.push(['Abre', fmtLargo.format(Date.parse(t.abre))]);
  if (t.cuando) fechas.push([t.modulo === 'quiz' ? 'Cierra' : 'Vence', fmtLargo.format(t.cuando)]);
  else fechas.push(['Vence', 'Sin fecha de entrega']);
  if (t.cierre && Date.parse(t.cierre) !== t.cuando) fechas.push(['Fecha límite', fmtLargo.format(Date.parse(t.cierre))]);
  const etiquetas = [
    [NOMBRE_TIPO[t.tipo] || 'Actividad', ''],
    t.cuando && t.cuando < ahora ? (t.tardia ? ['Acepta entrega tardía', 'pronto'] : ['Vencida', 'mal']) : null,
    t.borrador ? ['Borrador guardado', 'pronto'] : null,
    t.bloqueada ? ['Aún no abre', ''] : null,
    t.sinEntregaEnLinea ? ['Se entrega fuera de Moodle', ''] : null,
  ].filter(Boolean);
  const filasArchivos = archivos
    .map((a, i) => {
      const ext = (a.nombre.split('.').pop() || '').toLowerCase();
      return `<button class="archivo" data-archivo="${i}">
        <span class="tipo" style="background:${TIPOS[ext] || '#8e8e93'}">${esc(ext.slice(0, 4).toUpperCase() || '?')}</span>
        <span class="info"><b>${esc(a.nombre)}</b><span>${esc([peso(a.bytes), a.origen].filter(Boolean).join(' · '))}</span></span>
      </button>`;
    })
    .join('');
  $('#detalle').innerHTML = `
    <header class="barra hoja-barra">
      <button class="icono-boton" data-cerrar aria-label="Atrás">${ICONOS.atras}</button>
      <span class="curso" style="color:${t.color}">${esc(t.curso)}</span>
    </header>
    <div class="hoja-cuerpo">
      <h1>${esc(t.titulo)}</h1>
      ${t.ruta?.length ? `<p class="ruta">${esc(t.ruta.join(' › '))}</p>` : ''}
      <div class="etiquetas">${etiquetas.map(([x, c]) => `<span class="etiqueta ${c}">${esc(x)}</span>`).join('')}</div>
      <dl class="fechas">${fechas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(mayus(v))}</dd>`).join('')}</dl>
      <div class="acciones">
        ${t.enlaceEntrega && !t.bloqueada ? `<button class="boton primario" data-moodle="${esc(t.enlaceEntrega)}">${ICONOS.subir}Entregar en Moodle</button>` : ''}
        <button class="boton ${t.enlaceEntrega && !t.bloqueada ? '' : 'primario'}" data-moodle="${esc(t.enlace)}">${ICONOS.externo}Abrir en Moodle</button>
      </div>
      <h2>Instrucciones</h2>
      <div class="instrucciones">${t.instrucciones ? enlazar(t.instrucciones) : '<span class="tenue">El profesor no escribió instrucciones.</span>'}</div>
      ${archivos.length || cargando ? `<h2>Archivos</h2>${filasArchivos}${cargando ? '<div class="cargando-archivos"><div class="girador chico"></div>Buscando material de la misma sección…</div>' : ''}` : ''}
      <button class="boton quitar" data-quitar="${esc(t.id)}">Quitar de mi lista</button>
    </div>`;
}

// ---- Eventos ----

async function alTocar(e) {
  const el = e.target.closest('button, a, [data-web]');
  if (!el) return;
  const d = el.dataset;
  if (d.web) {
    e.preventDefault();
    return nativo.abrirPagina(d.web);
  }
  if (d.tarea) return abrirTarea(d.tarea);
  if (d.filtro) {
    estado.filtro = d.filtro;
    return pintar();
  }
  if (d.filtroMensajes) {
    estado.filtroMensajes = d.filtroMensajes;
    return pintar();
  }
  if (d.cerrar !== undefined) return cerrarTarea();
  if (d.moodle) return abrirEnMoodle(d.moodle).catch((err) => toast(err.message));
  if (d.archivo !== undefined) {
    const a = estado.tarea?.archivos[Number(d.archivo)];
    if (!a || el.classList.contains('bajando')) return;
    el.classList.add('bajando');
    try {
      await nativo.abrirArchivo(urlConToken(a.url), a.nombre);
    } catch (err) {
      toast(`No se pudo abrir: ${err.message}`);
    } finally {
      el.classList.remove('bajando');
    }
    return;
  }
  if (d.quitar) {
    const t = estado.tarea?.tarea;
    if (!t) return;
    estado.quitadas = [...estado.quitadas.filter((q) => q.id !== t.id), { id: t.id, titulo: t.titulo, curso: t.curso }];
    escribir('quitadas', estado.quitadas);
    cerrarTarea();
    pintar();
    programarAvisos();
    return toast('Quitada. La puedes devolver en Ajustes.');
  }
  if (d.devolver) {
    estado.quitadas = estado.quitadas.filter((q) => q.id !== d.devolver);
    escribir('quitadas', estado.quitadas);
    pintar();
    return programarAvisos();
  }
  if (d.mensaje) {
    const m = estado.mensajes?.lista.find((x) => x.id === d.mensaje);
    if (!m) return;
    marcarVistos([m.id]);
    return abrirEnMoodle(m.enlace).catch((err) => toast(err.message));
  }
  if (d.todoVisto !== undefined) return marcarVistos((estado.mensajes?.lista || []).map((x) => x.id));
  if (d.tema) {
    guardarPrefs({ tema: d.tema });
    return pintar();
  }
  if (d.salir !== undefined) {
    if (confirm('¿Cerrar sesión? Se borran tu sesión y los datos guardados en este teléfono.')) salir();
  }
}

function marcarVistos(ids) {
  for (const id of ids) estado.vistos.add(id);
  // Sólo hace falta recordar los que siguen en la lista.
  const actuales = new Set((estado.mensajes?.lista || []).map((x) => x.id));
  estado.vistos = new Set([...estado.vistos].filter((id) => actuales.has(id)));
  escribir('vistos', [...estado.vistos]);
  pintar();
}

async function alCambiar(e) {
  const el = e.target;
  if (el.dataset.pref) {
    const k = el.dataset.pref;
    guardarPrefs({ [k]: el.type === 'checkbox' ? el.checked : Number(el.value) });
    if (k === 'avisos' && el.checked) estado.permiso = await nativo.permisoAvisos(true).catch(() => null);
    if (k === 'avisos' || k === 'avisoHoras') programarAvisos();
    return pintar();
  }
  if (el.dataset.materia !== undefined) {
    const ocultas = [...document.querySelectorAll('[data-materia]')].filter((x) => !x.checked).map((x) => x.dataset.materia);
    ocultarMaterias(ocultas);
    for (const m of estado.datos?.materias || []) m.oculta = ocultas.includes(m.nombre);
    actualizar();
  }
}

// Deslizar hacia abajo desde arriba de la lista: revisar Moodle.
function deslizarParaActualizar(el) {
  let inicio = null;
  el.addEventListener('touchstart', (e) => (inicio = el.scrollTop <= 0 ? e.touches[0].clientY : null), { passive: true });
  el.addEventListener(
    'touchmove',
    (e) => {
      if (inicio === null) return;
      const d = Math.max(0, Math.min(90, e.touches[0].clientY - inicio));
      document.body.style.setProperty('--tiron', `${d}px`);
      document.body.classList.toggle('tirando', d > 0);
    },
    { passive: true },
  );
  el.addEventListener('touchend', () => {
    const d = parseFloat(document.body.style.getPropertyValue('--tiron')) || 0;
    document.body.classList.remove('tirando');
    document.body.style.removeProperty('--tiron');
    if (inicio !== null && d >= 70) actualizar();
    inicio = null;
  });
}

// ---- Arranque ----

function iniciar() {
  pintarEsqueleto();
  pintar();
  const viejo = !estado.datos || Date.now() - Date.parse(estado.datos.generado) > 5 * 60_000;
  if (viejo) actualizar();
  nativo.permisoAvisos().then((p) => (estado.permiso = p)).catch(() => {});
}

aplicarTema();
nativo.limpiarArchivos();
nativo.alAtras(() => {
  if (cerrarTarea()) return true;
  if (!$('#contenido') || estado.pestana === 'pendientes') return false;
  estado.pestana = 'pendientes';
  pintar();
  return true;
});
nativo.alVolver(() => {
  if (!leerSesion()?.token || !estado.datos) return;
  if (Date.now() - Date.parse(estado.datos.generado) > 10 * 60_000) actualizar();
  else pintar();
});
nativo.alTocarAviso((id) => {
  if (!id || !leerSesion()?.token) return;
  estado.pestana = 'pendientes';
  pintar();
  abrirTarea(id);
});
nativo.version().then((v) => (version = v)).catch(() => {});

if (leerSesion()?.token) iniciar();
else pintarAcceso();
