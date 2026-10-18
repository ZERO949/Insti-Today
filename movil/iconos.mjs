// Iconos de Android a partir de ../widget/icono/icono.svg: el del lanzador
// (normal, redondo y adaptable, con versión monocroma para los iconos con
// tema), la pantalla de arranque y el icono pequeño de las notificaciones.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(aqui, 'android', 'app', 'src', 'main', 'res');
const svg = fs.readFileSync(path.join(aqui, '..', 'widget', 'icono', 'icono.svg'), 'utf8');

const degradado = '<linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1757c4"/><stop offset="1" stop-color="#063b91"/></linearGradient>';
// El calendario con la palomita, sin el cuadro de fondo.
const dibujo = svg.slice(svg.indexOf('<rect x="222"'), svg.lastIndexOf('</svg>'));
const centrado = (escala) => `<g transform="translate(512 512) scale(${escala}) translate(-512 -527)">${dibujo}</g>`;
const lienzo = (cuerpo) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${degradado}</defs>${cuerpo}</svg>`);

const redondo = lienzo(`<circle cx="512" cy="512" r="500" fill="url(#fondo)"/>${centrado(0.86)}`);
const frente = lienzo(centrado(0.68));
// Silueta blanca: notificaciones e icono monocromo.
const trazos = '<rect x="3.5" y="5.5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><path d="m8.6 15.2 2.4 2.4 4.4-4.8"/>';
const estilo = (grosor) => `fill="none" stroke="#fff" stroke-width="${grosor}" stroke-linecap="round" stroke-linejoin="round"`;
const silueta = (grosor) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${estilo(grosor)}>${trazos}</svg>`);
// En el lienzo de 108 del icono adaptable, dentro de la zona segura.
const monocromo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="-10 -10 44 44" ${estilo(2)}>${trazos}</svg>`);

const DENSIDADES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const png = (entrada, lado, salida) => sharp(entrada, { density: 600 }).resize(lado, lado).png().toFile(salida);

for (const [nombre, f] of Object.entries(DENSIDADES)) {
  const mip = path.join(res, `mipmap-${nombre}`);
  const dib = path.join(res, `drawable-${nombre}`);
  fs.mkdirSync(mip, { recursive: true });
  fs.mkdirSync(dib, { recursive: true });
  await png(Buffer.from(svg), 48 * f, path.join(mip, 'ic_launcher.png'));
  await png(redondo, 48 * f, path.join(mip, 'ic_launcher_round.png'));
  await png(frente, 108 * f, path.join(mip, 'ic_launcher_foreground.png'));
  await png(monocromo, 108 * f, path.join(mip, 'ic_launcher_monochrome.png'));
  await png(silueta(2.2), 24 * f, path.join(dib, 'ic_stat_insti.png'));
}

// Fondo del icono adaptable: el mismo degradado.
fs.writeFileSync(
  path.join(res, 'drawable', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <gradient android:angle="315" android:startColor="#1757C4" android:endColor="#063B91" />
</shape>
`,
);
fs.rmSync(path.join(res, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true });
for (const n of ['ic_launcher', 'ic_launcher_round']) {
  fs.writeFileSync(
    path.join(res, 'mipmap-anydpi-v26', `${n}.xml`),
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`,
  );
}

// Pantalla de arranque (Android 11 o anterior): el icono sobre el azul de la marca.
for (const carpeta of fs.readdirSync(res).filter((c) => c.startsWith('drawable'))) {
  const archivo = path.join(res, carpeta, 'splash.png');
  if (!fs.existsSync(archivo)) continue;
  const { width, height } = await sharp(archivo).metadata();
  const lado = Math.round(Math.min(width, height) * 0.28);
  const icono = await sharp(Buffer.from(svg), { density: 600 }).resize(lado, lado).png().toBuffer();
  const salida = await sharp({ create: { width, height, channels: 4, background: '#0b47a8' } })
    .composite([{ input: icono, gravity: 'center' }])
    .png()
    .toBuffer();
  fs.writeFileSync(archivo, salida);
}

console.log('Iconos de Android listos');
