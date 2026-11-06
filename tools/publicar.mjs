// node tools/publicar.mjs → crea el release vX.Y.Z (versión de package.json) con:
//   Insti-Today-Setup.exe  el instalador (el mismo nombre de siempre: el enlace de descarga no cambia)
//   latest.json            lo que lee el actualizador de esta versión (con la firma)
//   latest.yml             lo que lee la versión de Electron (≤ 0.2.8) para pasar a ésta
// Antes: `npm run empaquetar` con TAURI_SIGNING_PRIVATE_KEY (ver AGENTS.md) y la etiqueta subida.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const exe = `src-tauri/target/release/bundle/nsis/Insti Today_${version}_x64-setup.exe`;
const nombre = 'Insti-Today-Setup.exe';
const url = `https://github.com/ZERO949/Insti-Today/releases/download/v${version}/${nombre}`;
const datos = fs.readFileSync(exe);
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync(exe, `dist/${nombre}`);
fs.writeFileSync('dist/latest.json', JSON.stringify({
  version, pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: fs.readFileSync(`${exe}.sig`, 'utf8'), url } },
}, null, 2));
const sha512 = createHash('sha512').update(datos).digest('base64');
fs.writeFileSync('dist/latest.yml', `version: ${version}\nfiles:\n  - url: ${nombre}\n    sha512: ${sha512}\n    size: ${datos.length}\npath: ${nombre}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`);
execFileSync('gh', ['release', 'create', `v${version}`, `dist/${nombre}`, 'dist/latest.json', 'dist/latest.yml', '--repo', 'ZERO949/Insti-Today', '--title', `Insti Today ${version}`, '--notes', `Insti Today ${version}`], { stdio: 'inherit' });
