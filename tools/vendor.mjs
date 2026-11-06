// Copia a widget/vendor lo que las páginas usan de node_modules (Tauri sólo
// empaqueta widget/). widget/vendor no va en git.
import fs from 'node:fs';
const raiz = new URL('../', import.meta.url);
const copiar = [
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ...['latin-opsz-normal', 'latin-ext-opsz-normal', 'latin-opsz-italic'].map((n) => [`node_modules/@fontsource-variable/inter/files/inter-${n}.woff2`, `inter-${n}.woff2`]),
];
fs.mkdirSync(new URL('widget/vendor/', raiz), { recursive: true });
for (const [de, a] of copiar) fs.copyFileSync(new URL(de, raiz), new URL(`widget/vendor/${a}`, raiz));
