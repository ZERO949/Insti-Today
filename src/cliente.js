// Cliente de los servicios web REST de Moodle, autenticado con el token del
// estudiante (el mismo que usa la app oficial de Moodle).
//
// Sólo LEE: ninguna función de aquí entrega, publica ni modifica nada en
// Moodle. Las entregas las termina la persona en la página oficial.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { token, urlBase } from './sesion.js';
import { crearCola, esperaReintento } from './red.js';

const enCola = crearCola(8);
let pausaHasta = 0;
const cacheLecturas = new Map();
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

export class ErrorMoodle extends Error {
  constructor(mensaje, estado, codigo) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}
// El resto de la app (heredado de BB Today) usa este nombre.
export { ErrorMoodle as ErrorBlackboard };

const SESION_CADUCADA = 'Tu sesión de Moodle caducó. Ejecuta `npm run login` o abre Insti Today e inicia sesión otra vez.';

// Por defecto se usa fetch de Node. La app de escritorio lo cambia por el de
// su propio navegador (respeta el proxy del sistema) y pone su mensaje.
let transporte = { fetch: null, renovar: async () => false, mensajeSesion: SESION_CADUCADA };
export function configurarTransporte(opciones) {
  transporte = { ...transporte, ...opciones };
  cacheLecturas.clear();
  pausaHasta = 0;
}
const hacerFetch = (url, opciones) => (transporte.fetch || fetch)(url, opciones);
const caducada = () => new ErrorMoodle(transporte.mensajeSesion, 401, 'invalidtoken');

async function consultar(ejecutar) {
  for (let intento = 0; ; intento++) {
    const r = await enCola(async () => {
      if (pausaHasta > Date.now()) await dormir(pausaHasta - Date.now());
      return ejecutar();
    });
    if (![429, 503].includes(r.status)) return r;
    const espera = esperaReintento(r.headers.get('retry-after'), intento);
    if (intento >= 2 || espera > 60000) return r;
    pausaHasta = Math.max(pausaHasta, Date.now() + espera);
    await r.body?.cancel();
  }
}

// Moodle recibe los parámetros como formulario con corchetes:
// { courseids: [3, 5] } → courseids[0]=3&courseids[1]=5
export function aplanar(valor, prefijo = '', salida = new URLSearchParams()) {
  if (valor === undefined || valor === null) return salida;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => aplanar(v, `${prefijo}[${i}]`, salida));
  } else if (typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) aplanar(v, prefijo ? `${prefijo}[${k}]` : k, salida);
  } else {
    salida.append(prefijo, typeof valor === 'boolean' ? (valor ? '1' : '0') : String(valor));
  }
  return salida;
}

const SESION_INVALIDA = new Set(['invalidtoken', 'accessexception', 'usernotfullysetup', 'tokennotfound']);

async function llamarCrudo(funcion, args = {}, { esperaMs = 45_000 } = {}) {
  const t = token();
  if (!t) throw caducada();
  const cuerpo = aplanar(args);
  cuerpo.set('wstoken', t);
  cuerpo.set('wsfunction', funcion);
  const url = `${urlBase()}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=${encodeURIComponent(funcion)}`;
  const r = await consultar(() =>
    hacerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: cuerpo.toString(),
      signal: AbortSignal.timeout(esperaMs),
    }),
  ).catch((e) => {
    throw new ErrorMoodle(`Sin conexión con Moodle (${e.name === 'TimeoutError' ? 'tardó demasiado' : e.message})`, 0);
  });
  if (!r.ok) throw new ErrorMoodle(`Moodle respondió ${r.status} [${funcion}]`, r.status);
  let datos;
  try {
    datos = await r.json();
  } catch {
    throw new ErrorMoodle(`Moodle no respondió JSON [${funcion}]`, r.status);
  }
  if (datos && typeof datos === 'object' && !Array.isArray(datos) && datos.exception) {
    if (SESION_INVALIDA.has(datos.errorcode)) throw caducada();
    const estado = datos.errorcode === 'nopermissions' || datos.errorcode === 'requireloginerror' ? 403 : 400;
    throw new ErrorMoodle(`${datos.message || 'Error de Moodle'} [${funcion}]`, estado, datos.errorcode);
  }
  return datos;
}

// Llama una función del servicio web. Las lecturas iguales en menos de 30 s
// salen de la caché (la agenda y el detalle piden lo mismo).
export async function ws(funcion, args = {}, { cache = true } = {}) {
  if (!cache) return llamarCrudo(funcion, args);
  const clave = `${urlBase()}|${funcion}|${JSON.stringify(args)}`;
  let entrada = cacheLecturas.get(clave);
  if (!entrada || Date.now() - entrada.cuando > 30000) {
    entrada = { cuando: Date.now(), promesa: llamarCrudo(funcion, args) };
    cacheLecturas.set(clave, entrada);
    entrada.promesa.catch(() => {
      if (cacheLecturas.get(clave) === entrada) cacheLecturas.delete(clave);
    });
    if (cacheLecturas.size > 300) cacheLecturas.delete(cacheLecturas.keys().next().value);
  }
  return structuredClone(await entrada.promesa);
}

// Igual que ws(), pero devuelve `porDefecto` si la función no existe o no
// está permitida en esta escuela (cada Moodle activa cosas distintas). Una
// sesión caducada sí se propaga, y también un fallo de red o del servidor:
// sin respuesta no se sabe qué hay, y un vacío pasaría por «no hay nada»
// (p. ej. un curso sin tareas en vez de los datos de la revisión anterior).
export async function wsOpcional(funcion, args, porDefecto) {
  try {
    return await ws(funcion, args);
  } catch (e) {
    if (e.estado === 401 || e.estado === 0 || e.estado === 429 || e.estado >= 500) throw e;
    return porDefecto;
  }
}

let yo = null;
export async function usuarioActual() {
  yo ??= await ws('core_webservice_get_site_info');
  return yo;
}
// Tras cerrar sesión o entrar con otra cuenta.
export function olvidarUsuario() {
  yo = null;
  cacheLecturas.clear();
}

// Los archivos de Moodle (pluginfile.php) se leen con el token. Sólo se le
// pone el token a direcciones de tu propia plataforma.
export function urlConToken(direccion) {
  const base = urlBase();
  const url = new URL(direccion, `${base}/`);
  if (url.origin !== new URL(base).origin) throw new ErrorMoodle(`Sólo se aceptan direcciones de ${base}.`);
  if (/\/pluginfile\.php\//.test(url.pathname)) {
    if (!/\/webservice\/pluginfile\.php\//.test(url.pathname)) url.pathname = url.pathname.replace('/pluginfile.php/', '/webservice/pluginfile.php/');
    const t = token();
    if (!t) throw caducada();
    url.searchParams.set('token', t);
  }
  return url.href;
}

async function bajar(direccion, esperaMs) {
  const r = await consultar(() => hacerFetch(urlConToken(direccion), { signal: AbortSignal.timeout(esperaMs) })).catch((e) => {
    throw new ErrorMoodle(`Sin conexión con Moodle (${e.message})`, 0);
  });
  // Un token inválido en pluginfile devuelve una página de error HTML o JSON.
  if (r.status === 401 || r.status === 403) throw caducada();
  if (!r.ok) throw new ErrorMoodle(r.status === 404 ? 'El archivo ya no existe en Moodle.' : `Moodle respondió ${r.status}`, r.status);
  const tipo = r.headers.get('content-type') || '';
  if (/json/.test(tipo)) {
    const datos = await r.json().catch(() => ({}));
    if (SESION_INVALIDA.has(datos.errorcode)) throw caducada();
    throw new ErrorMoodle(datos.message || 'Moodle no entregó el archivo.', 400, datos.errorcode);
  }
  return r;
}

// Descarga a memoria, para previsualizar. Si el archivo pasa de `maximo`
// bytes se corta la descarga y se devuelve null.
export async function leerBytes(direccion, maximo) {
  const r = await bajar(direccion, 60_000);
  const declarado = Number(r.headers.get('content-length'));
  if (declarado > maximo) {
    await r.body?.cancel();
    return null;
  }
  const trozos = [];
  let total = 0;
  for await (const trozo of r.body) {
    total += trozo.length;
    if (total > maximo) return null;
    trozos.push(Buffer.from(trozo));
  }
  return { datos: Buffer.concat(trozos), tipo: r.headers.get('content-type') || '' };
}

export function carpetaDescargas(subcarpeta = '') {
  const base = process.env.INSTI_DESCARGAS || path.join(os.homedir(), 'Downloads', 'Insti Today');
  return path.join(base, nombreSeguro(subcarpeta));
}

export function nombreSeguro(nombre) {
  return String(nombre).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
}

function rutaLibre(carpeta, nombre) {
  const ext = path.extname(nombre);
  const raiz = path.basename(nombre, ext);
  let candidato = path.join(carpeta, nombre);
  for (let n = 1; fs.existsSync(candidato); n++) candidato = path.join(carpeta, `${raiz} (${n})${ext}`);
  return candidato;
}

function nombreDeCabecera(disposicion) {
  if (!disposicion) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposicion);
  if (utf8) return decodeURIComponent(utf8[1]);
  const simple = /filename="?([^";]+)"?/i.exec(disposicion);
  return simple ? simple[1] : null;
}

export async function descargar(direccion, carpeta, nombrePreferido) {
  const r = await bajar(direccion, 180_000);
  const nombre = nombreSeguro(
    nombrePreferido ||
      nombreDeCabecera(r.headers.get('content-disposition')) ||
      decodeURIComponent(new URL(direccion, `${urlBase()}/`).pathname.split('/').pop()) ||
      'archivo',
  );
  fs.mkdirSync(carpeta, { recursive: true });
  const destino = rutaLibre(carpeta, nombre);
  const parcial = `${destino}.${randomUUID()}.parcial`;
  try {
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(parcial));
    fs.renameSync(parcial, destino);
  } finally {
    fs.rmSync(parcial, { force: true });
  }
  return { ruta: destino, bytes: fs.statSync(destino).size };
}

// Moodle devuelve HTML. Se pasa a texto plano conservando los enlaces.
export function htmlATexto(html) {
  if (!html) return { texto: '', enlaces: [] };
  const enlaces = [];
  for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    if (!m[1].startsWith('javascript:') && !m[1].startsWith('#')) enlaces.push(decodificar(m[1]));
  }
  const texto = decodificar(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|h[1-6]|li|tr|ul|ol|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { texto, enlaces: [...new Set(enlaces)] };
}

function decodificar(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&([a-zA-Z])(acute|grave|uml|circ|tilde|cedil);/g, (_, l, m) => {
      const marca = { acute: '́', grave: '̀', uml: '̈', circ: '̂', tilde: '̃', cedil: '̧' }[m];
      return (l + marca).normalize('NFC');
    })
    .replace(/&iquest;/g, '¿')
    .replace(/&iexcl;/g, '¡')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// Moodle da fechas en segundos Unix; la app las usa en ISO (UTC).
export const iso = (segundos) => (segundos && Number(segundos) > 0 ? new Date(Number(segundos) * 1000).toISOString() : null);
