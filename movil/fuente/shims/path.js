// Lo poco de node:path que usa src/, con «/».
export const sep = '/';
export function join(...partes) {
  return partes.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}
export function extname(ruta) {
  const m = /(\.[^./]*)$/.exec(String(ruta).split('/').pop());
  return m ? m[1] : '';
}
export function basename(ruta, ext) {
  const nombre = String(ruta).split('/').pop();
  return ext && nombre.endsWith(ext) ? nombre.slice(0, -ext.length) : nombre;
}
export function dirname(ruta) {
  return String(ruta).split('/').slice(0, -1).join('/') || '/';
}

export default { sep, join, extname, basename, dirname };
