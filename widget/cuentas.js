// Varias cuentas de Moodle en la misma computadora.
//
// La cuenta activa vive donde siempre (sesion.json, agenda.json… en la
// carpeta de datos), así src/, el servidor MCP y el resto de la app no
// cambian. Las demás esperan guardadas en cuentas/<id>/; cambiar de cuenta es
// mover sus archivos de un lado a otro. Cada cuenta tiene además su propio
// navegador (partición de Electron), para que las cookies de Moodle no se
// mezclen, y un color para reconocerla de un vistazo.
//
// cuentas.json: { activa, pendiente, lista: [{ id, usuario, nombre, url, color, particion }] }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIR_DATOS, leerSesion, normalizarUrl } from '../src/sesion.js';

const ARCHIVO = path.join(DIR_DATOS, 'cuentas.json');
const DIR_GUARDADAS = path.join(DIR_DATOS, 'cuentas');
const ARCHIVO_AJUSTES = path.join(DIR_DATOS, 'ajustes.json');
// La primera cuenta usa la partición de siempre: no hay que volver a entrar.
export const PARTICION_ORIGINAL = 'persist:moodle';

// Lo que es de cada cuenta. Las preferencias (tema, IA, avisos…) son de todas.
const ARCHIVOS = ['sesion.json', 'agenda.json', 'mensajes.json', 'mensajes-vistos.json', 'respuestas.json', 'claude-estado.json', 'entregas.json', 'avisados.json', 'imagenes'];
// Y de ajustes.json: la escuela, el usuario, las tareas quitadas y las materias ocultas.
const AJUSTES_CUENTA = ['url', 'cuenta', 'descartadas', 'ocultar'];
const ARCHIVO_AJUSTES_CUENTA = 'ajustes-cuenta.json';

export const COLORES = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#40c8e0', '#ffcc00', '#a2845e'];

function leerJson(archivo, porDefecto) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch {
    return porDefecto;
  }
}

function escribirJson(archivo, valor) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify(valor, null, 2));
}

const clave = (url, usuario) => {
  try {
    return `${normalizarUrl(url)}|${String(usuario || '').toLowerCase()}`;
  } catch {
    return `|${String(usuario || '').toLowerCase()}`;
  }
};

// El registro. La primera vez se arma con la sesión que ya había.
function registro() {
  const r = leerJson(ARCHIVO, null);
  if (r && Array.isArray(r.lista)) return r;
  const s = leerSesion();
  const nuevo = { activa: null, pendiente: null, lista: [] };
  if (s?.token) {
    const id = nuevoId();
    nuevo.lista.push({ id, usuario: s.usuario, nombre: s.nombre || s.usuario, url: s.url, color: COLORES[0], particion: PARTICION_ORIGINAL });
    nuevo.activa = id;
  }
  escribirJson(ARCHIVO, nuevo);
  return nuevo;
}

const guardarRegistro = (r) => escribirJson(ARCHIVO, r);
const nuevoId = () => crypto.randomBytes(5).toString('hex');
const colorLibre = (lista) => COLORES.find((c) => !lista.some((x) => x.color === c)) || COLORES[lista.length % COLORES.length];

export function lista() {
  const r = registro();
  return r.lista.map((c) => ({ ...c, activa: c.id === r.activa }));
}

export function activa() {
  const r = registro();
  return r.lista.find((c) => c.id === r.activa) || null;
}

// La partición del navegador de la cuenta activa (o de la que se está añadiendo).
export function particion() {
  const r = registro();
  return (r.lista.find((c) => c.id === r.activa) || r.pendiente)?.particion || PARTICION_ORIGINAL;
}

// ---- Mover los archivos de una cuenta ----

function quitar(ruta) {
  fs.rmSync(ruta, { recursive: true, force: true });
}

function mover(desde, hacia) {
  quitar(hacia);
  try {
    fs.renameSync(desde, hacia);
  } catch {
    // Otro disco o un archivo abierto: se copia.
    fs.cpSync(desde, hacia, { recursive: true });
    quitar(desde);
  }
}

// La cuenta activa se guarda en cuentas/<id>/ y su lugar queda vacío.
function guardarActiva(r) {
  if (!r.activa) return;
  const dir = path.join(DIR_GUARDADAS, r.activa);
  fs.mkdirSync(dir, { recursive: true });
  for (const nombre of ARCHIVOS) {
    const ruta = path.join(DIR_DATOS, nombre);
    if (fs.existsSync(ruta)) mover(ruta, path.join(dir, nombre));
    else quitar(path.join(dir, nombre));
  }
  const ajustes = leerJson(ARCHIVO_AJUSTES, {});
  escribirJson(path.join(dir, ARCHIVO_AJUSTES_CUENTA), Object.fromEntries(AJUSTES_CUENTA.map((k) => [k, ajustes[k] ?? null])));
  for (const k of AJUSTES_CUENTA) if (k !== 'url') delete ajustes[k];
  escribirJson(ARCHIVO_AJUSTES, ajustes);
  r.activa = null;
}

// Los archivos de cuentas/<id>/ pasan a la carpeta de datos.
function traer(r, id) {
  const dir = path.join(DIR_GUARDADAS, id);
  for (const nombre of ARCHIVOS) {
    const guardado = path.join(dir, nombre);
    if (fs.existsSync(guardado)) mover(guardado, path.join(DIR_DATOS, nombre));
    else quitar(path.join(DIR_DATOS, nombre));
  }
  const propios = leerJson(path.join(dir, ARCHIVO_AJUSTES_CUENTA), {});
  const ajustes = leerJson(ARCHIVO_AJUSTES, {});
  for (const k of AJUSTES_CUENTA) {
    if (propios[k] !== null && propios[k] !== undefined) ajustes[k] = propios[k];
    else if (k !== 'url') delete ajustes[k];
  }
  // La escuela de la cuenta manda sobre la que quedó guardada.
  const c = r.lista.find((x) => x.id === id);
  if (c?.url) ajustes.url = c.url;
  escribirJson(ARCHIVO_AJUSTES, ajustes);
  quitar(dir);
  r.activa = id;
  r.pendiente = null;
}

// ---- Lo que usa la app ----

export function cambiar(id) {
  const r = registro();
  if (!r.lista.some((c) => c.id === id)) throw new Error('Esa cuenta ya no existe.');
  if (r.activa === id) return activa();
  guardarActiva(r);
  traer(r, id);
  guardarRegistro(r);
  return activa();
}

// Antes de abrir el inicio de sesión para otra cuenta: la activa se guarda y
// la nueva tendrá su propio navegador.
export function prepararNueva() {
  const r = registro();
  guardarActiva(r);
  const id = nuevoId();
  r.pendiente = { id, particion: `persist:moodle-${id}` };
  guardarRegistro(r);
  return r.pendiente;
}

// Se cerró el inicio de sesión sin entrar: vuelve la cuenta de antes.
export function cancelarNueva(anterior) {
  const r = registro();
  r.pendiente = null;
  if (anterior && r.lista.some((c) => c.id === anterior)) traer(r, anterior);
  guardarRegistro(r);
}

// Tras entrar con usuario y contraseña. Puede ser la misma cuenta que volvió
// a entrar, la primera, o una nueva. Devuelve { cuenta, borrarParticion }:
// si la cuenta ya estaba guardada aparte, se queda con la sesión nueva y el
// navegador viejo sobra.
export function registrar({ usuario, nombre, url }) {
  const r = registro();
  const k = clave(url, usuario);
  let borrarParticion = null;
  const actual = r.lista.find((c) => c.id === r.activa);
  if (actual && clave(actual.url, actual.usuario) === k) {
    Object.assign(actual, { usuario, nombre, url });
    guardarRegistro(r);
    return { cuenta: actual, borrarParticion };
  }
  if (actual) guardarActiva(r);
  const repetida = r.lista.find((c) => clave(c.url, c.usuario) === k);
  const id = r.pendiente?.id || nuevoId();
  const part = r.pendiente?.particion || (r.lista.length ? `persist:moodle-${id}` : PARTICION_ORIGINAL);
  let color = colorLibre(r.lista);
  if (repetida) {
    color = repetida.color;
    if (repetida.particion !== part) borrarParticion = repetida.particion;
    quitar(path.join(DIR_GUARDADAS, repetida.id));
    r.lista = r.lista.filter((c) => c !== repetida);
  }
  const cuenta = { id, usuario, nombre: nombre || usuario, url, color, particion: part };
  r.lista.push(cuenta);
  r.activa = id;
  r.pendiente = null;
  guardarRegistro(r);
  return { cuenta, borrarParticion };
}

export function cambiarColor(id, color) {
  if (!COLORES.includes(color)) return;
  const r = registro();
  const c = r.lista.find((x) => x.id === id);
  if (c) c.color = color;
  guardarRegistro(r);
}

// Quita una cuenta. Si era la activa, sus archivos ya los borró quien cierra
// la sesión y pasa a la siguiente (si hay). Devuelve la partición a vaciar y
// la cuenta que quedó activa.
export function quitarCuenta(id) {
  const r = registro();
  const c = r.lista.find((x) => x.id === id);
  if (!c) return { particion: null, siguiente: activa() };
  r.lista = r.lista.filter((x) => x !== c);
  if (r.activa === id) {
    r.activa = null;
    for (const nombre of ARCHIVOS) quitar(path.join(DIR_DATOS, nombre));
    const ajustes = leerJson(ARCHIVO_AJUSTES, {});
    for (const k of AJUSTES_CUENTA) if (k !== 'url') delete ajustes[k];
    escribirJson(ARCHIVO_AJUSTES, ajustes);
    if (r.lista.length) traer(r, r.lista[0].id);
  } else {
    quitar(path.join(DIR_GUARDADAS, id));
  }
  guardarRegistro(r);
  return { particion: c.particion, siguiente: r.lista.find((x) => x.id === r.activa) || null };
}
