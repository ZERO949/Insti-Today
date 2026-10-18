// Dónde vive la sesión y cómo se obtiene.
//
// La sesión es un token de los servicios web de Moodle (el mismo que usa la
// app oficial de Moodle). Se pide UNA vez con tu usuario y contraseña a
// /login/token.php de tu propia plataforma; la contraseña nunca se guarda,
// sólo el token, en la carpeta de datos de la app (fuera de OneDrive).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// La carpeta de datos: %APPDATA%\insti-today en Windows,
// ~/Library/Application Support/Insti Today en Mac y ~/.config/insti-today
// en Linux. INSTI_DATOS (o BB_DATOS, por compatibilidad) apunta a otra.
export const DIR_DATOS =
  process.env.INSTI_DATOS ||
  process.env.BB_DATOS ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Insti Today')
    : path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'insti-today'));
const ARCHIVO_SESION = path.join(DIR_DATOS, 'sesion.json');

// El servicio de la app móvil: casi todas las escuelas lo tienen activo.
export const SERVICIO = 'moodle_mobile_app';

// Moodle puede vivir en una subcarpeta (https://plataforma.uii.edu.mx/moodle).
// Se queda con origen + carpeta y quita lo que se haya copiado de más
// (/login/index.php, /my/, ?loginredirect=1…).
export function normalizarUrl(url) {
  const u = new URL(String(url).includes('://') ? url : `https://${url}`);
  let ruta = u.pathname
    .replace(/\/(login|my|course|mod|admin|user|calendar|message|grade|webservice|lib|theme|pluginfile\.php)(\/.*)?$/i, '')
    .replace(/\/index\.php$/i, '')
    .replace(/\/+$/, '');
  return `${u.origin}${ruta}`;
}

export function leerSesion() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_SESION, 'utf8'));
  } catch {
    return null;
  }
}

export function guardarSesion(sesion) {
  fs.mkdirSync(DIR_DATOS, { recursive: true });
  fs.writeFileSync(ARCHIVO_SESION, JSON.stringify(sesion, null, 2), { mode: 0o600 });
}

export function borrarSesion() {
  try {
    fs.rmSync(ARCHIVO_SESION, { force: true });
  } catch {}
}

export function urlBase() {
  const url = process.env.INSTI_URL || process.env.BB_URL || leerSesion()?.url;
  if (!url) {
    throw new Error('No sé cuál es tu Moodle. Ejecuta `npm run login -- https://plataforma.tu-escuela.edu.mx/moodle` o define INSTI_URL.');
  }
  return normalizarUrl(url);
}

export function token() {
  const s = leerSesion();
  if (!s?.token) return null;
  // Un token de otra plataforma no sirve en esta.
  try {
    if (normalizarUrl(s.url) !== urlBase()) return null;
  } catch {
    return null;
  }
  return s.token;
}

// Pide el token a /login/token.php. Devuelve { token, privatetoken } o lanza
// un Error con un mensaje en español listo para mostrar.
export async function pedirToken(url, usuario, contrasena, { fetch: hacerFetch = fetch } = {}) {
  const base = normalizarUrl(url);
  let r;
  try {
    r = await hacerFetch(`${base}/login/token.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ username: String(usuario).trim(), password: String(contrasena), service: SERVICIO }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`No hay conexión con tu Moodle (${e.name === 'TimeoutError' ? 'tardó demasiado' : e.message}).`);
  }
  let datos;
  try {
    datos = await r.json();
  } catch {
    throw new Error('Tu Moodle respondió algo que no es JSON. Revisa la dirección de la plataforma.');
  }
  if (datos?.token) return { token: datos.token, privatetoken: datos.privatetoken || null };
  const codigo = datos?.errorcode || '';
  const mensajes = {
    invalidlogin: 'Usuario o contraseña incorrectos.',
    enablewsdescription: 'Tu escuela no tiene activados los servicios web de Moodle. Pide a soporte que activen «Servicios para móviles».',
    servicenotavailable: 'Tu escuela no tiene activo el servicio de la app de Moodle.',
    sitemaintenance: 'La plataforma está en mantenimiento. Intenta más tarde.',
    usernotconfirmed: 'Tu cuenta aún no está confirmada en Moodle.',
    forcepasswordchangenotice: 'Moodle te pide cambiar la contraseña. Entra una vez en el navegador, cámbiala y vuelve a intentar.',
    restoredaccountresetpassword: 'Moodle te pide restablecer la contraseña. Hazlo en el navegador y vuelve a intentar.',
  };
  throw new Error(mensajes[codigo] || datos?.error || `Moodle no dio un token (${codigo || r.status}).`);
}

// Comprueba que una dirección es un Moodle con servicios web: token.php sin
// usuario responde «missingparam» si están activos.
export async function comprobarMoodle(url, { fetch: hacerFetch = fetch } = {}) {
  const base = normalizarUrl(url);
  const r = await hacerFetch(`${base}/login/token.php?service=${SERVICIO}`, { signal: AbortSignal.timeout(15_000) });
  const datos = await r.json().catch(() => null);
  if (!datos || typeof datos !== 'object') return { ok: false, mensaje: 'No parece un Moodle. Copia la dirección que ves al entrar a tu plataforma.' };
  if (datos.errorcode === 'enablewsdescription') return { ok: false, mensaje: 'Ese Moodle no tiene activados los servicios web (los usa la app móvil).' };
  return { ok: true, url: base };
}

// Para la línea de comandos (npm run login) y el servidor MCP.
export async function iniciarSesion(url, usuario, contrasena) {
  const base = normalizarUrl(url);
  const { token: t, privatetoken } = await pedirToken(base, usuario, contrasena);
  const r = await fetch(`${base}/webservice/rest/server.php?moodlewsrestformat=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ wstoken: t, wsfunction: 'core_webservice_get_site_info' }).toString(),
  });
  const info = await r.json();
  if (info?.exception) throw new Error(info.message || 'Moodle rechazó el token.');
  guardarSesion({ url: base, token: t, privatetoken, userid: info.userid, usuario: info.username, nombre: info.fullname, guardada: new Date().toISOString() });
  return info;
}
