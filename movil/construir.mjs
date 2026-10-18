// Arma www/ (lo que Capacitor mete en el APK): un solo app.js con la capa de
// Moodle de ../src y la página. Los módulos de Node que usa src/ se cambian
// por equivalentes para la WebView (fuente/shims).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(aqui, 'www');
const shims = path.join(aqui, 'fuente', 'shims');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(aqui, 'fuente', 'app.js')],
  outfile: path.join(www, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  minify: !process.argv.includes('--sin-minificar'),
  sourcemap: false,
  legalComments: 'none',
  // src/sesion.js y src/cliente.js leen process.env y process.platform.
  banner: { js: "globalThis.process ??= { env: {}, platform: 'android' };" },
  alias: {
    'node:fs': path.join(shims, 'fs.js'),
    'node:path': path.join(shims, 'path.js'),
    'node:os': path.join(shims, 'os.js'),
    'node:crypto': path.join(shims, 'otros.js'),
    'node:stream': path.join(shims, 'otros.js'),
    'node:stream/promises': path.join(shims, 'otros.js'),
    'node:zlib': path.join(shims, 'otros.js'),
  },
  logLevel: 'warning',
});

for (const f of ['index.html', 'estilos.css']) fs.copyFileSync(path.join(aqui, 'fuente', f), path.join(www, f));
fs.copyFileSync(path.join(aqui, '..', 'widget', 'icono', 'icono.png'), path.join(www, 'icono.png'));

console.log(`www/ listo (${Math.round(fs.statSync(path.join(www, 'app.js')).size / 1024)} KB de JS)`);
