// node:crypto, node:stream, node:stream/promises y node:zlib: src/ sólo los
// usa para descargar a disco y leer .zip, cosas que la app de Android hace
// de otra forma.
const noDisponible = () => {
  throw new Error('No disponible en Android.');
};
export const randomUUID = () => crypto.randomUUID();
export const Readable = { fromWeb: noDisponible };
export const pipeline = noDisponible;
export const inflateRawSync = noDisponible;
export default { randomUUID, Readable, pipeline, inflateRawSync };
