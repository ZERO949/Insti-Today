// En Android no hay disco de Node: los pocos archivos que usa src/ (la
// sesión, los ajustes) viven en el almacenamiento privado de la WebView.
const clave = (ruta) => `insti:archivo:${ruta}`;

export function readFileSync(ruta) {
  const valor = localStorage.getItem(clave(ruta));
  if (valor === null) {
    const e = new Error(`ENOENT: ${ruta}`);
    e.code = 'ENOENT';
    throw e;
  }
  return valor;
}
export function writeFileSync(ruta, datos) {
  localStorage.setItem(clave(ruta), String(datos));
}
export function rmSync(ruta) {
  localStorage.removeItem(clave(ruta));
}
export function existsSync(ruta) {
  return localStorage.getItem(clave(ruta)) !== null;
}
export function mkdirSync() {}
export function renameSync() {}
export function statSync() {
  return { size: 0 };
}
export function createWriteStream() {
  throw new Error('No disponible en Android.');
}

export default { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, statSync, createWriteStream };
