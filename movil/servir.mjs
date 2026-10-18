// Para probar la app en un navegador sin teléfono: sirve www/ y, en la misma
// dirección, el Moodle falso de ../tools (así no hace falta CORS).
//
//   npm run construir && npm run servir
//   → http://127.0.0.1:5180 · plataforma: http://127.0.0.1:5180/moodle · alumno / secreto

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iniciar } from '../tools/moodle-falso.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(aqui, 'www');
const PUERTO = Number(process.argv[2]) || 5180;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const { servidor: moodle } = await iniciar(0);
const puertoMoodle = moodle.address().port;

http
  .createServer((req, res) => {
    if (req.url.startsWith('/moodle')) {
      const pase = http.request({ host: '127.0.0.1', port: puertoMoodle, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PUERTO}` } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(pase);
      return;
    }
    const ruta = path.join(www, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
    if (!ruta.startsWith(www) || !fs.existsSync(ruta)) {
      res.writeHead(404);
      return res.end('No existe');
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(ruta).pipe(res);
  })
  .listen(PUERTO, '127.0.0.1', () => console.log(`http://127.0.0.1:${PUERTO} · Moodle de prueba: http://127.0.0.1:${PUERTO}/moodle (alumno / secreto)`));
