// Actualizaciones desde los Releases de GitHub del repositorio configurado en
// package.json → build.publish (ZERO949/Insti-Today). Tiene que ser público:
// la app no lleva ningún token para leerlo.
//
// Cuando hay una versión nueva, la app pregunta (main.js → preguntarVersionNueva).
// Si la persona acepta, se descarga, se cierra, el instalador reemplaza la
// versión anterior (conservando sesión y ajustes) y vuelve a abrirse.
// Si algo falla, se puede reintentar desde Cuenta → Actualizaciones.

import { app } from 'electron';
import paquete from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { esVersionNueva } from './versiones.js';

const { autoUpdater } = paquete;
const CADA_MS = 4 * 60 * 60_000;
const ACTUALIZACIONES_ACTIVAS = true;
// La página del proyecto (package.json → homepage).
let pagina = 'https://github.com';
try {
  pagina = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).homepage || pagina;
} catch {}
export const PAGINA = pagina;

let estado = { estado: app.isPackaged && ACTUALIZACIONES_ACTIVAS ? 'inicial' : 'desarrollo', version: null, porcentaje: 0 };
let avisar = () => {};
let antesDeInstalar = () => {};

function cambiar(cambios) {
  estado = { ...estado, ...cambios };
  avisar(estado);
}

export function estadoActualizacion() {
  return estado;
}

// En Mac, macOS sólo deja que una app se reemplace sola si está firmada con
// una cuenta de desarrollador de Apple. Sin ella, la versión nueva no se
// descarga: se avisa y el botón lleva a la página.
// En Linux sólo la AppImage se reemplaza sola; el .deb se instala con el
// gestor de paquetes, así que también avisa y lleva a la página.
export const SOLO_AVISO = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);

export function iniciarActualizaciones({ alCambiar, antesDeSalir, registrar }) {
  avisar = alCambiar;
  antesDeInstalar = antesDeSalir;
  // En desarrollo (electron .) no hay instalador que actualizar.
  if (!ACTUALIZACIONES_ACTIVAS || !app.isPackaged || process.env.BB_CAPTURA_SIN_RED) return;
  // Una copia win-unpacked de pruebas no puede actualizarse con un NSIS:
  // instala en Programs, pero al reiniciar vuelve a abrir la copia antigua.
  if (process.platform === 'win32' && !fs.existsSync(path.join(path.dirname(process.execPath),'Uninstall Insti Today.exe'))) {
    cambiar({estado:'manual',version:null,detalle:'Esta es una copia portátil/de pruebas. Abre la versión instalada o instala la descarga de la web.'});
    return;
  }

  // Se descarga sólo cuando la persona acepta el aviso.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Las instalaciones públicas sólo buscan versiones estables.
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info() {}, warn() {}, debug() {}, error: (e) => registrar('actualización', e) };

  autoUpdater.on('checking-for-update', () => cambiar({ estado: 'buscando' }));
  autoUpdater.on('update-not-available', () => cambiar({ estado: 'al-dia', version:null, porcentaje:0, revisado: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => {
    if (!esVersionNueva(info.version,app.getVersion())) return cambiar({estado:'al-dia',version:null,porcentaje:0});
    cambiar({ estado: SOLO_AVISO ? 'aviso' : 'disponible', version: info.version, porcentaje: 0 });
  });
  autoUpdater.on('download-progress', (p) => cambiar({ estado: 'descargando', porcentaje: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    if (!esVersionNueva(info.version,app.getVersion())) return cambiar({estado:'al-dia',version:null,porcentaje:0});
    cambiar({ estado: 'lista', version: info.version, porcentaje: 100 });
    // Ya la pidió: se instala enseguida.
    instalarAhora();
  });
  autoUpdater.on('error', (e) => {
    registrar('actualización', e);
    // Si ya se sabía de una versión nueva, se puede volver a intentar.
    cambiar({ estado: !estado.version ? 'error' : SOLO_AVISO ? 'aviso' : 'disponible', porcentaje: 0 });
  });

  setTimeout(buscar, 30_000);
  setInterval(buscar, CADA_MS);
}

export function buscar() {
  if (!ACTUALIZACIONES_ACTIVAS || !app.isPackaged || process.env.BB_CAPTURA_SIN_RED || ['manual','descargando', 'lista', 'buscando'].includes(estado.estado)) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

// La persona aceptó el aviso (o pulsó el botón en Cuenta).
export function descargar() {
  if (estado.estado !== 'disponible' || !esVersionNueva(estado.version,app.getVersion())) return;
  cambiar({ estado: 'descargando', porcentaje: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
}

export function instalarAhora() {
  if (estado.estado !== 'lista' || !esVersionNueva(estado.version,app.getVersion())) return;
  antesDeInstalar();
  // Silencioso y vuelve a abrir la app al terminar.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
