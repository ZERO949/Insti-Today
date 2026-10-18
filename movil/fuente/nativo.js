// Lo que en Android hace el teléfono: red sin CORS, abrir páginas y
// archivos, recordatorios y el botón «Atrás». En un navegador normal (para
// probar con `npm run servir`) cada cosa tiene un equivalente web.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileViewer } from '@capacitor/file-viewer';
import { LocalNotifications } from '@capacitor/local-notifications';

export const esNativo = Capacitor.isNativePlatform();

// fetch() por la red del teléfono: Moodle no tiene por qué aceptar CORS.
// Devuelve un Response normal para que src/cliente.js no note la diferencia.
export async function fetchNativo(url, opciones = {}) {
  if (!esNativo) return fetch(url, opciones);
  const r = await CapacitorHttp.request({
    url,
    method: opciones.method || 'GET',
    headers: opciones.headers || {},
    data: opciones.body,
    responseType: 'text',
    connectTimeout: 30_000,
    readTimeout: 60_000,
  });
  const sinCuerpo = [101, 204, 205, 304].includes(r.status);
  const cuerpo = sinCuerpo ? null : typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null);
  return new Response(cuerpo, { status: r.status, headers: r.headers || {} });
}

// Páginas de Moodle: en una pestaña de Chrome dentro de la app (conserva la
// sesión del navegador entre una y otra).
export async function abrirPagina(url) {
  if (esNativo) await Browser.open({ url });
  else window.open(url, '_blank', 'noopener');
}

// Baja un archivo de Moodle a la caché de la app y lo abre con la app que
// el teléfono tenga para ese tipo (visor de PDF, Word, Galería…).
export async function abrirArchivo(url, nombre) {
  if (!esNativo) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const limpio = String(nombre || 'archivo').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
  const ruta = `archivos/${Date.now()}-${limpio}`;
  const r = await Filesystem.downloadFile({ url, path: ruta, directory: Directory.Cache, recursive: true });
  const local = (r.path || (await Filesystem.getUri({ path: ruta, directory: Directory.Cache })).uri).replace(/^file:\/\//, '');
  try {
    await FileViewer.openDocumentFromLocalPath({ path: decodeURI(local) });
  } catch (e) {
    throw new Error(/activity|no app|not found/i.test(e.message) ? 'No hay una app en el teléfono que abra este tipo de archivo.' : e.message);
  }
}

// Los archivos bajados se borran al abrir la app (ya se abrieron).
export async function limpiarArchivos() {
  if (!esNativo) return;
  await Filesystem.rmdir({ path: 'archivos', directory: Directory.Cache, recursive: true }).catch(() => {});
}

// ---- Recordatorios ----

export async function permisoAvisos(pedir = false) {
  if (!esNativo) return 'web';
  let p = await LocalNotifications.checkPermissions();
  if (p.display === 'prompt' || p.display === 'prompt-with-rationale') {
    if (!pedir) return 'preguntar';
    p = await LocalNotifications.requestPermissions();
  }
  return p.display === 'granted' ? 'si' : 'no';
}

// Cambia todos los recordatorios programados por los de `avisos`
// ([{ id, titulo, cuerpo, cuando, enlace }]). El sistema los muestra aunque
// la app esté cerrada.
export async function programarAvisos(avisos) {
  if (!esNativo) return;
  const pendientes = await LocalNotifications.getPending();
  if (pendientes.notifications.length) await LocalNotifications.cancel({ notifications: pendientes.notifications.map((n) => ({ id: n.id })) });
  if (!avisos.length || (await permisoAvisos()) !== 'si') return;
  await LocalNotifications.schedule({
    notifications: avisos.map((a) => ({
      id: a.id,
      title: a.titulo,
      body: a.cuerpo,
      schedule: { at: new Date(a.cuando), allowWhileIdle: true },
      extra: { tarea: a.tarea },
    })),
  });
}

export function alTocarAviso(fn) {
  if (esNativo) LocalNotifications.addListener('localNotificationActionPerformed', (e) => fn(e.notification?.extra?.tarea));
}

// ---- Ciclo de vida ----

export function alVolver(fn) {
  if (esNativo) App.addListener('resume', fn);
  else document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && fn());
}

// «Atrás» de Android: `fn` devuelve true si lo usó (cerró algo). Si no, la
// app se va al fondo como cualquier otra.
export function alAtras(fn) {
  if (esNativo) App.addListener('backButton', () => fn() || App.minimizeApp());
}

export async function version() {
  if (!esNativo) return 'web';
  const i = await App.getInfo();
  return i.version;
}
