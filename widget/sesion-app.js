// La sesión de Moodle de la app.
//
// Dos cosas distintas:
// - El token de servicios web (src/sesion.js): con él se leen tareas,
//   cursos y mensajes. Se pide una vez con usuario y contraseña en la ventana
//   «Iniciar sesión» de la app; la contraseña no se guarda.
// - El navegador de la app (una partición persistente de Electron): ahí se
//   abren las páginas de Moodle (una tarea, la entrega). Se inicia sesión en
//   él con los mismos datos en ese momento, y si después caduca se usa el
//   inicio automático de la app móvil de Moodle (tool_mobile).

import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { descargar, nombreSeguro, olvidarUsuario } from '../src/cliente.js';
import { DIR_DATOS, borrarSesion, comprobarMoodle, guardarSesion, leerSesion, normalizarUrl, pedirToken } from '../src/sesion.js';

export const ESCUELA_POR_DEFECTO = 'https://plataforma.uii.edu.mx/moodle';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PARTICION = 'persist:moodle';
const ARCHIVO_AJUSTES = path.join(DIR_DATOS, 'ajustes.json');
const CARPETA_DESCARGAS = 'Insti Today';

let icono = null;
export function configurar({ iconoVentanas }) {
  icono = iconoVentanas;
}

// ---- Ajustes: escuela y cuenta ----

export function ajustes() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_AJUSTES, 'utf8'));
  } catch {
    return {};
  }
}

function guardarAjustes(cambios) {
  const nuevos = { ...ajustes(), ...cambios };
  fs.mkdirSync(DIR_DATOS, { recursive: true });
  fs.writeFileSync(ARCHIVO_AJUSTES, JSON.stringify(nuevos, null, 2));
  return nuevos;
}

export function escuela() {
  return normalizarUrl(ajustes().url || ESCUELA_POR_DEFECTO);
}

// El resto del código (src/) lee la escuela de INSTI_URL.
export function aplicarEscuela() {
  process.env.INSTI_URL = escuela();
}

export function cuenta() {
  // Sin token no hay cuenta, aunque los ajustes digan otra cosa.
  return leerSesion()?.token ? ajustes().cuenta || leerSesion()?.usuario || null : null;
}

// Comprueba que la dirección es un Moodle con servicios web antes de guardarla.
export async function cambiarEscuela(url) {
  let base;
  try {
    base = normalizarUrl(String(url).trim());
  } catch {
    return { ok: false, mensaje: 'Esa dirección no es válida.' };
  }
  let r;
  try {
    r = await comprobarMoodle(base, { fetch: (u, o) => sesion().fetch(u, o) });
  } catch {
    return { ok: false, mensaje: 'No pude abrir esa dirección. Revisa que sea la de tu plataforma Moodle.' };
  }
  if (!r.ok) return r;
  if (base !== escuela()) await cerrarSesion();
  guardarAjustes({ url: base });
  aplicarEscuela();
  return { ok: true, url: base };
}

// ---- El navegador de la app ----

let ses = null;
export function sesion() {
  if (ses) return ses;
  ses = session.fromPartition(PARTICION);
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|insti-today|Insti Today|bb-today)\/\S+/gi, ''));
  ses.on('will-download', (_e, item) => {
    const carpeta = path.join(app.getPath('downloads'), CARPETA_DESCARGAS);
    fs.mkdirSync(carpeta, { recursive: true });
    item.setSavePath(rutaLibre(carpeta, nombreSeguro(item.getFilename())));
    item.once('done', (_ev, estado) => {
      if (estado === 'completed') shell.openPath(item.getSavePath());
    });
  });
  return ses;
}

function rutaLibre(carpeta, nombre) {
  const ext = path.extname(nombre);
  const raiz = path.basename(nombre, ext);
  let candidato = path.join(carpeta, nombre);
  for (let n = 1; fs.existsSync(candidato); n++) candidato = path.join(carpeta, `${raiz} (${n})${ext}`);
  return candidato;
}

// Las consultas a los servicios web también pasan por la red de Electron
// (respeta el proxy del sistema), pero sin cookies: van con el token.
export function pedir(url, opciones) {
  return sesion().fetch(url, { ...opciones, credentials: 'omit' });
}

function ventanaMoodle(opciones = {}) {
  return new BrowserWindow({
    width: 1180,
    height: 860,
    icon: icono,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...opciones,
    webPreferences: { partition: PARTICION, contextIsolation: true, sandbox: true },
  });
}

// El clic viene del widget, que no toma el foco; sin esto Windows puede
// dejar la ventana nueva escondida detrás de lo que estés usando.
function alFrente(v) {
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (v.isMinimized()) v.restore();
  v.show();
  v.setAlwaysOnTop(true);
  v.focus();
  v.moveTop();
  setTimeout(() => {
    if (!v.isDestroyed()) v.setAlwaysOnTop(false);
  }, 1200);
}

// ¿El navegador de la app tiene sesión abierta en Moodle? /my/ redirige al
// login si no.
async function navegadorConSesion() {
  try {
    const r = await sesion().fetch(`${escuela()}/my/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (r.status >= 300 && r.status < 400) return !/\/login\//.test(r.headers.get('location') || '');
    return r.status === 200;
  } catch {
    return false;
  }
}

// Inicia sesión en el navegador de la app con el formulario normal de
// Moodle, en una ventana invisible. No es grave si falla: al abrir una
// página, Moodle la pedirá.
async function entrarEnNavegador(usuario, contrasena) {
  const oculta = ventanaMoodle({ show: false });
  try {
    await oculta.loadURL(`${escuela()}/login/index.php`).catch(() => {});
    const enviado = await oculta.webContents
      .executeJavaScript(
        `(() => {
          const f = document.querySelector('form#login, form[action*="login/index.php"]');
          const u = f && f.querySelector('input[name=username]');
          const p = f && f.querySelector('input[name=password]');
          if (!u || !p) return false;
          u.value = ${JSON.stringify(String(usuario))};
          p.value = ${JSON.stringify(String(contrasena))};
          f.submit();
          return true;
        })()`,
      )
      .catch(() => false);
    if (!enviado) return false;
    const limite = Date.now() + 20_000;
    while (Date.now() < limite) {
      await new Promise((ok) => setTimeout(ok, 800));
      const url = oculta.webContents.getURL();
      if (url && !/\/login\/index\.php/.test(url)) return true;
    }
    return false;
  } finally {
    oculta.destroy();
  }
}

// Inicio automático de la app móvil de Moodle: con el token privado se pide
// una llave de un solo uso y con ella Moodle abre la sesión del navegador.
// Moodle sólo da una llave cada 6 minutos y sólo a «apps de Moodle».
async function urlAutologin(destino) {
  const s = leerSesion();
  if (!s?.token || !s.privatetoken) return null;
  try {
    const r = await sesion().fetch(`${escuela()}/webservice/rest/server.php?moodlewsrestformat=json`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MoodleMobile Insti Today' },
      body: new URLSearchParams({ wstoken: s.token, wsfunction: 'tool_mobile_get_autologin_key', privatetoken: s.privatetoken }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
    if (!d?.key || !d?.autologinurl) return null;
    const u = new URL(d.autologinurl);
    u.searchParams.set('userid', s.userid);
    u.searchParams.set('key', d.key);
    // autologin.php lee «urltogo»; sin él lleva a la página principal.
    u.searchParams.set('urltogo', destino);
    return u.href;
  } catch {
    return null;
  }
}

// ---- Iniciar sesión ----

let ventanaLogin = null;
let entrando = null;
let alTerminarLogin = null;

ipcMain.handle('acceso:info', (e) => {
  if (!ventanaLogin || e.sender !== ventanaLogin.webContents) return null;
  const base = escuela();
  return { escuela: base, host: new URL(base).host, cuenta: ajustes().cuenta || '' };
});

ipcMain.handle('acceso:cancelar', (e) => {
  if (ventanaLogin && e.sender === ventanaLogin.webContents) ventanaLogin.close();
});

ipcMain.handle('acceso:entrar', async (e, usuario, contrasena) => {
  if (!ventanaLogin || e.sender !== ventanaLogin.webContents) return { ok: false, mensaje: 'Ventana no válida.' };
  usuario = String(usuario || '').trim();
  if (!usuario || !contrasena) return { ok: false, mensaje: 'Escribe tu usuario y tu contraseña.' };
  const base = escuela();
  try {
    const hacerFetch = (u, o) => sesion().fetch(u, { ...o, credentials: 'omit' });
    const { token, privatetoken } = await pedirToken(base, usuario, contrasena, { fetch: hacerFetch });
    const r = await hacerFetch(`${base}/webservice/rest/server.php?moodlewsrestformat=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ wstoken: token, wsfunction: 'core_webservice_get_site_info' }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const info = await r.json();
    if (info?.exception) throw new Error(info.message || 'Moodle rechazó el token.');
    guardarSesion({ url: base, token, privatetoken, userid: info.userid, usuario: info.username, nombre: info.fullname, guardada: new Date().toISOString() });
    olvidarUsuario();
    guardarAjustes({ cuenta: info.username });
    // El navegador de la app, en segundo plano.
    entrarEnNavegador(usuario, contrasena).catch(() => {});
    alTerminarLogin?.({ userName: info.username, nombre: info.fullname });
    return { ok: true, nombre: info.firstname || info.fullname };
  } catch (err) {
    return { ok: false, mensaje: err.message };
  }
});

// Abre la ventana de inicio de sesión de la app. Devuelve el usuario, o null
// si se cerró antes.
export function iniciarSesion() {
  if (entrando) {
    if (ventanaLogin) alFrente(ventanaLogin);
    return entrando;
  }
  entrando = new Promise((resolver) => {
    ventanaLogin = new BrowserWindow({
      width: 420,
      height: 560,
      resizable: false,
      maximizable: false,
      minimizable: false,
      title: 'Iniciar sesión · Insti Today',
      icon: icono,
      autoHideMenuBar: true,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f7',
      webPreferences: { preload: path.join(DIR, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    ventanaLogin.loadFile(path.join(DIR, 'acceso.html'));
    ventanaLogin.once('ready-to-show', () => alFrente(ventanaLogin));
    // Enlaces (¿olvidaste tu contraseña?) en el navegador normal.
    ventanaLogin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    ventanaLogin.webContents.on('will-navigate', (ev, url) => {
      if (!url.startsWith('file:')) {
        ev.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });

    let terminado = false;
    const terminar = (usuario) => {
      if (terminado) return;
      terminado = true;
      alTerminarLogin = null;
      const v = ventanaLogin;
      ventanaLogin = null;
      // Deja ver «Listo» un momento antes de cerrar.
      if (usuario && v && !v.isDestroyed()) setTimeout(() => !v.isDestroyed() && v.destroy(), 900);
      else if (v && !v.isDestroyed()) v.destroy();
      resolver(usuario);
    };
    alTerminarLogin = terminar;
    ventanaLogin.on('closed', () => terminar(null));
  }).finally(() => (entrando = null));
  return entrando;
}

// Para las pruebas automáticas (INSTI_PRUEBA_ENTRAR).
export function ventanaDeLogin() {
  return ventanaLogin;
}

export function estaEntrando() {
  return !!entrando;
}

// El token de Moodle no rota: si deja de servir, hay que entrar de nuevo.
export async function renovarSilencioso() {
  return false;
}

export async function cerrarSesion() {
  await sesion().clearStorageData();
  olvidarUsuario();
  guardarAjustes({ cuenta: null });
  borrarSesion();
}

export async function comprobarAlActualizar() {}

// ---- Abrir cosas de Moodle ----

let navegador = null;

// Las páginas de Moodle se abren en el navegador de la app, donde ya hay
// sesión. Si caducó, se intenta el inicio automático antes de abrir.
export async function abrirEnMoodle(url) {
  let destino;
  try {
    destino = new URL(url);
  } catch {
    return null;
  }
  const base = new URL(escuela());
  if (destino.origin !== base.origin) {
    shell.openExternal(destino.href);
    return null;
  }
  if (!navegador || navegador.isDestroyed()) {
    navegador = ventanaMoodle({ title: 'Moodle · Insti Today' });
    navegador.webContents.setWindowOpenHandler(({ url: nueva }) => {
      try {
        if (new URL(nueva).origin === base.origin) {
          return { action: 'allow', overrideBrowserWindowOptions: { icon, autoHideMenuBar: true, webPreferences: { partition: PARTICION } } };
        }
      } catch {}
      shell.openExternal(nueva);
      return { action: 'deny' };
    });
  }
  alFrente(navegador);
  let cargar = destino.href;
  if (!(await navegadorConSesion())) cargar = (await urlAutologin(destino.href)) || destino.href;
  if (!navegador.isDestroyed()) navegador.loadURL(cargar).catch(() => {});
  return navegador;
}

// Nombre heredado de BB Today: main.js lo usa así y espera la ventana al
// instante. abrirEnMoodle la crea antes de su primera espera; la carga sigue
// en segundo plano. Para direcciones de fuera de Moodle no hay ventana.
export function abrirEnBlackboard(url) {
  let interna = false;
  try {
    interna = new URL(url).origin === new URL(escuela()).origin;
  } catch {}
  abrirEnMoodle(url);
  return interna && navegador && !navegador.isDestroyed() ? navegador : null;
}

// Un archivo se descarga con el token a Descargas/Insti Today/<curso> y se
// abre con su programa.
export async function abrirArchivo({ url, nombre, curso }) {
  const carpeta = path.join(app.getPath('downloads'), CARPETA_DESCARGAS, nombreSeguro(curso || ''));
  const { ruta } = await descargar(url, carpeta, nombre);
  const error = await shell.openPath(ruta);
  if (error) shell.showItemInFolder(ruta);
  return { ruta };
}
