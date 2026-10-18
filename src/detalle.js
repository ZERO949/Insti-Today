// Detalle de una tarea para la vista previa del widget: instrucciones,
// archivos y una muestra de cada archivo.
//
// Las instrucciones y los archivos propios de la tarea vienen en la agenda.
// Los archivos «de al lado» (recursos y carpetas de la misma sección) se
// piden en el momento con core_course_get_contents.

import zlib from 'node:zlib';
import { leerBytes, wsOpcional, ws } from './cliente.js';
import { urlBase } from './sesion.js';

const MAX_ARCHIVOS = 8;
const CACHE_MS = 15 * 60_000;
const cache = new Map();

const EXT_CODIGO = /\.(txt|c|cc|cpp|h|hpp|py|java|js|ts|cs|md|csv|json|sql|html|css|m|r|asm)$/i;

// Archivos de un módulo de Moodle (recurso, carpeta, libro…).
function archivosModulo(modulo, origen) {
  return (modulo?.contents || [])
    .filter((f) => f.type === 'file' && f.fileurl && f.filename && f.filename !== '.')
    .map((f) => ({ nombre: f.filename, bytes: f.filesize || undefined, mime: f.mimetype || undefined, url: f.fileurl, origen }));
}

async function archivosRelacionados(cursoId, relacionados = [], estricto = false) {
  if (!relacionados.length) return [];
  const pedirContenido = () => ws('core_course_get_contents', { courseid: Number(cursoId) });
  const secciones = estricto ? await pedirContenido() : await wsOpcional('core_course_get_contents', { courseid: Number(cursoId) }, []);
  const modulos = new Map();
  for (const s of secciones || []) for (const m of s.modules || []) modulos.set(String(m.id), m);
  return relacionados.flatMap((r) => archivosModulo(modulos.get(String(r.id)), r.carpeta ? r.titulo : 'Misma sección'));
}

// Las muestras se piden aparte y llegan cuando están: una presentación de
// varios MB no debe retrasar las instrucciones. Se guardan por archivo, sin
// la firma de la URL, que cambia en cada consulta.
// Las muestras de PDF llegan con el archivo entero (para dibujar su primera
// página); en cuanto la vista previa la dibuja, se cambian por esa imagen.
// Además todo tiene tope: lo más viejo sale primero.
const cacheMuestras = new Map();
const TOPE_MUESTRAS = 24 * 1024 * 1024; // caracteres en base64, ~18 MB
const TOPE_DETALLES = 60;
const claveMuestra = (archivo) => `${archivo.nombre}|${String(archivo.url).split('?')[0]}`;
const pesoMuestra = (m) => (m?.datos?.length || 0) + (m?.src?.length || 0) + 512;

function recortarCaches() {
  const ahora = Date.now();
  for (const [k, v] of cacheMuestras) if (ahora - v.cuando > 6 * CACHE_MS) cacheMuestras.delete(k);
  let total = 0;
  for (const v of cacheMuestras.values()) total += pesoMuestra(v.muestra);
  for (const [k, v] of cacheMuestras) {
    if (total <= TOPE_MUESTRAS) break;
    total -= pesoMuestra(v.muestra);
    cacheMuestras.delete(k);
  }
  for (const [k, v] of cache) if (ahora - v.cuando > CACHE_MS) cache.delete(k);
  while (cache.size > TOPE_DETALLES) cache.delete(cache.keys().next().value);
}

export function guardarMiniaturaPdf(archivo, src) {
  const guardada = cacheMuestras.get(claveMuestra(archivo));
  if (!guardada || typeof src !== 'string' || !src.startsWith('data:image/')) return;
  guardada.muestra = { tipo: 'pdf', src, bytes: guardada.muestra.bytes };
}

export async function muestraDe(archivo, miniatura) {
  const clave = claveMuestra(archivo);
  const guardada = cacheMuestras.get(clave);
  if (guardada && Date.now() - guardada.cuando < 6 * CACHE_MS) return guardada.muestra;
  const resultado = await Promise.race([
    muestra(archivo, miniatura).catch(() => null),
    new Promise((ok) => setTimeout(() => ok(null), 45_000)),
  ]);
  if (resultado) {
    cacheMuestras.set(clave, { cuando: Date.now(), muestra: { ...resultado, bytes: archivo.bytes } });
    recortarCaches();
  }
  return resultado && { ...resultado, bytes: archivo.bytes };
}

// Lector mínimo de ZIP: el directorio central da los nombres y, si hace
// falta, se descomprime una entrada concreta (para leer .docx y .pptx).
export function leerZip(buf) {
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) return null;
  const total = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const entradas = [];
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + largoNombre);
    entradas.push({ nombre, metodo, comprimido, local });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  const extraer = (nombre) => {
    const e = entradas.find((x) => x.nombre === nombre);
    if (!e || buf.readUInt32LE(e.local) !== 0x04034b50) return null;
    const inicio = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const datos = buf.subarray(inicio, inicio + e.comprimido);
    return e.metodo === 0 ? datos : e.metodo === 8 ? zlib.inflateRawSync(datos) : null;
  };
  return { entradas, extraer };
}

export function textoXml(xml, etiquetaParrafo) {
  return xml
    .replace(new RegExp(`</${etiquetaParrafo}>`, 'g'), '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function muestra(archivo, miniatura) {
  const nombre = archivo.nombre || '';
  const mime = archivo.mime || '';
  const esImagen = /^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(nombre);
  const esZip = /\.zip$/i.test(nombre) || /zip/.test(mime);
  const esOffice = /\.(docx|pptx)$/i.test(nombre);
  const esCodigo = EXT_CODIGO.test(nombre) || /^text\//.test(mime);
  const esPdf = /\.pdf$/i.test(nombre) || mime === 'application/pdf';
  if (!esImagen && !esZip && !esOffice && !esCodigo && !esPdf) return null;

  const max = esImagen ? 6e6 : esCodigo ? 300e3 : esPdf ? 10e6 : 12e6;
  const r = await leerBytes(archivo.url, max);
  if (!r) return null;
  archivo.bytes ??= r.datos.length;

  // La primera página la dibuja la vista previa con pdf.js.
  if (esPdf) return { tipo: 'pdf', datos: r.datos.toString('base64') };
  if (esImagen) return { tipo: 'imagen', src: miniatura ? miniatura(r.datos) : `data:${mime || 'image/png'};base64,${r.datos.toString('base64')}` };
  if (esCodigo) {
    const lineas = r.datos.toString('utf8').replace(/\r/g, '').split('\n');
    return { tipo: 'codigo', lineas: lineas.slice(0, 12), resto: Math.max(0, lineas.length - 12) };
  }
  const zip = leerZip(r.datos);
  if (!zip) return null;
  if (/\.docx$/i.test(nombre)) {
    const xml = zip.extraer('word/document.xml');
    return xml ? { tipo: 'texto', texto: textoXml(xml.toString('utf8'), 'w:p').slice(0, 400) } : null;
  }
  if (/\.pptx$/i.test(nombre)) {
    const xml = zip.extraer('ppt/slides/slide1.xml');
    const diapositivas = zip.entradas.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.nombre)).length;
    return xml ? { tipo: 'texto', texto: textoXml(xml.toString('utf8'), 'a:p').slice(0, 300), nota: `${diapositivas} diapositivas` } : null;
  }
  const archivos = zip.entradas.map((e) => e.nombre).filter((n) => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(n));
  return { tipo: 'zip', archivos: archivos.slice(0, 8), resto: Math.max(0, archivos.length - 8) };
}

export async function detalle(cursoId, tarea, { estricto = false } = {}) {
  // La tarea de prueba de la app no existe en Moodle.
  if (String(cursoId).endsWith('-prueba')) return { instrucciones: tarea.instrucciones || '', archivos: [] };
  const clave = `${urlBase()}|${cursoId}|${tarea.id}`;
  const guardado = !estricto && cache.get(clave);
  if (guardado && Date.now() - guardado.cuando < CACHE_MS) return guardado.datos;

  const propios = tarea.adjuntos || [];
  const deSeccion = await archivosRelacionados(cursoId, tarea.relacionados, estricto);

  // Sin duplicados, primero los de la tarea.
  const vistos = new Set();
  const archivos = [...propios, ...deSeccion]
    .filter((a) => a.nombre && !vistos.has(String(a.url).split('?')[0]) && vistos.add(String(a.url).split('?')[0]))
    .slice(0, estricto ? undefined : MAX_ARCHIVOS);

  const datos = { instrucciones: tarea.instrucciones || '', archivos };
  if (!estricto) cache.set(clave, { cuando: Date.now(), datos });
  recortarCaches();
  return datos;
}
