// Prueba de la capa de Moodle contra el Moodle falso, sin Electron.
//   node tools/probar-moodle.mjs
// Usa una carpeta de datos temporal: no toca tu sesión real.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { iniciar } from './moodle-falso.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insti-prueba-'));
process.env.INSTI_DATOS = tmp;
process.env.INSTI_DESCARGAS = path.join(tmp, 'descargas');
const { servidor, url, llamadas } = await iniciar(0);
process.env.INSTI_URL = url;

const { iniciarSesion, comprobarMoodle, normalizarUrl, pedirToken, leerSesion } = await import('../src/sesion.js');
const { agenda } = await import('../src/agenda.js');
const { mensajes } = await import('../src/mensajes.js');
const { detalle, muestraDe } = await import('../src/detalle.js');
const { descargar, aplanar, olvidarUsuario, configurarTransporte } = await import('../src/cliente.js');
const { resumen } = await import('../src/datos.js');

let ok = 0;
const prueba = async (nombre, fn) => {
  try {
    await fn();
    ok++;
    console.log(`✓ ${nombre}`);
  } catch (e) {
    console.error(`✗ ${nombre}\n  ${e.stack}`);
    process.exitCode = 1;
  }
};

await prueba('normaliza direcciones con subcarpeta', () => {
  assert.equal(normalizarUrl('https://plataforma.uii.edu.mx/moodle/login/index.php?loginredirect=1'), 'https://plataforma.uii.edu.mx/moodle');
  assert.equal(normalizarUrl('plataforma.uii.edu.mx/moodle/'), 'https://plataforma.uii.edu.mx/moodle');
  assert.equal(normalizarUrl('https://moodle.escuela.mx/my/'), 'https://moodle.escuela.mx');
});

await prueba('aplana parámetros como Moodle', () => {
  assert.equal(decodeURIComponent(aplanar({ courseids: [11, 12], options: { ids: [3] }, x: true }).toString()), 'courseids[0]=11&courseids[1]=12&options[ids][0]=3&x=1');
});

await prueba('reconoce un Moodle con servicios web', async () => {
  assert.deepEqual(await comprobarMoodle(`${url}/login/index.php`), { ok: true, url });
});

await prueba('contraseña incorrecta da un mensaje claro', async () => {
  await assert.rejects(pedirToken(url, 'alumno', 'mala'), /incorrectos/);
});

await prueba('inicia sesión y guarda sólo el token', async () => {
  const info = await iniciarSesion(url, 'alumno', 'secreto');
  assert.equal(info.username, 'alumno');
  const s = leerSesion();
  assert.ok(s.token && s.privatetoken && s.userid === 501);
  assert.ok(!JSON.stringify(s).includes('secreto'), 'la contraseña no debe guardarse');
});

let datos;
await prueba('agenda: cursos actuales, sin el semestre pasado', async () => {
  datos = await agenda();
  assert.deepEqual(datos.cursos.map((c) => c.nombre), ['Cálculo Vectorial', 'Ingeniería de Software', 'Programación Orientada a Objetos', 'Sustentabilidad']);
  assert.equal(datos.usuario, 'Alvaro');
  assert.equal(datos.cuenta, 'alumno');
});

const tarea = (titulo) => datos.cursos.flatMap((c) => c.tareas.map((t) => ({ ...t, cursoId: c.id }))).find((t) => t.titulo === titulo);

await prueba('agenda: tareas con estado, fechas y enlaces', () => {
  const t24 = tarea('Tarea 2.4 - Regla de la cadena');
  assert.equal(t24.estado, 'pendiente');
  assert.equal(t24.tipo, 'tarea');
  assert.ok(t24.entrega && new Date(t24.entrega).getHours() === 23);
  assert.deepEqual(t24.ruta, ['Unidad 2: Derivadas parciales']);
  assert.match(t24.enlace, /\/mod\/assign\/view\.php\?id=1104$/);
  assert.match(t24.enlaceEntrega, /action=editsubmission/);
  assert.equal(tarea('Tarea 2.3 - Derivadas parciales').estado, 'entregada');
  assert.equal(tarea('Proyecto final').entrega, null);
  const req = tarea('Entregable 2: Requerimientos (Proyecto 3)');
  assert.equal(req.tardia, true, 'acepta tardía antes del corte');
  assert.equal(tarea('Reporte de campo: Plantando Vida').enlaceEntrega, undefined);
});

await prueba('agenda: material de la misma sección', () => {
  const t24 = tarea('Tarea 2.4 - Regla de la cadena');
  assert.deepEqual(t24.relacionados, [{ id: '1105', titulo: 'Ejercicios 2.4 - Regla de la cadena', carpeta: false }]);
  assert.equal(t24.adjuntos.length, 2);
});

await prueba('agenda: exámenes, foros y otras actividades', () => {
  const ex = tarea('Examen parcial 2');
  assert.equal(ex.tipo, 'examen');
  assert.equal(ex.bloqueada, true);
  assert.equal(tarea('Quiz 4: Polimorfismo').estado, 'pendiente');
  assert.equal(tarea('Foro: Reflexión sobre reciclaje').tipo, 'foro');
  const leccion = tarea('Lección: Casos de uso');
  assert.ok(leccion && leccion.modulo === 'lesson');
  // El evento de calendario de una tarea no se duplica.
  assert.equal(datos.cursos.find((c) => c.nombre === 'Ingeniería de Software').tareas.length, 2);
});

await prueba('agenda: no vuelve a preguntar por lo ya entregado', async () => {
  const antes = llamadas.filter((l) => l.nombre === 'mod_assign_get_submission_status').length;
  configurarTransporte({}); // vacía la caché de lecturas
  const otra = await agenda({ anterior: datos });
  const despues = llamadas.filter((l) => l.nombre === 'mod_assign_get_submission_status').length;
  const asignaciones = otra.cursos.flatMap((c) => c.tareas).filter((t) => t.modulo === 'assign');
  assert.equal(despues - antes, asignaciones.filter((t) => t.estado !== 'entregada').length);
  assert.equal(otra.cursos.flatMap((c) => c.tareas).find((t) => t.titulo === 'Tarea 2.3 - Derivadas parciales').estado, 'entregada');
  assert.equal(otra.completa, datos.completa);
  // Pasadas 12 h se revisan todas otra vez.
  configurarTransporte({});
  const vieja = { ...datos, completa: new Date(Date.now() - 13 * 3600e3).toISOString() };
  const antes2 = llamadas.filter((l) => l.nombre === 'mod_assign_get_submission_status').length;
  const completa = await agenda({ anterior: vieja });
  assert.equal(llamadas.filter((l) => l.nombre === 'mod_assign_get_submission_status').length - antes2, asignaciones.length);
  assert.notEqual(completa.completa, vieja.completa);
});

await prueba('agenda: un fallo de red no deja un curso vacío', async () => {
  let fallar = true;
  configurarTransporte({
    fetch: (url, opciones) => {
      if (fallar && url.includes('wsfunction=mod_assign_get_assignments')) {
        fallar = false;
        return Promise.reject(new TypeError('fetch failed'));
      }
      return fetch(url, opciones);
    },
  });
  await assert.rejects(agenda(), (e) => e.estado === 0);
  configurarTransporte({ fetch: null });
});

await prueba('detalle: archivos de la tarea y de la sección', async () => {
  const t24 = tarea('Tarea 2.4 - Regla de la cadena');
  const d = await detalle(t24.cursoId, t24);
  assert.match(d.instrucciones, /Resuelve los ejercicios/);
  assert.deepEqual(d.archivos.map((a) => a.nombre), ['Ejercicios 2.4.pdf', 'diagrama.png', 'Regla de la Cadena.pdf']);
  assert.ok(!d.archivos.some((a) => a.url.includes('token=')), 'el token no viaja en los datos');
});

await prueba('muestras: PDF, imagen, zip y código', async () => {
  const t24 = tarea('Tarea 2.4 - Regla de la cadena');
  const d = await detalle(t24.cursoId, t24);
  const pdf = await muestraDe(d.archivos[0]);
  assert.equal(pdf.tipo, 'pdf');
  assert.ok(Buffer.from(pdf.datos, 'base64').toString('latin1').startsWith('%PDF'));
  const img = await muestraDe(d.archivos[1]);
  assert.equal(img.tipo, 'imagen');
  const p5 = tarea('Práctica 5: Herencia');
  const d5 = await detalle(p5.cursoId, p5);
  const z = await muestraDe(d5.archivos[0]);
  assert.deepEqual(z.archivos, ['practica5/Animal.java', 'practica5/Perro.java', 'practica5/LEEME.txt']);
  const codigo = await muestraDe(d5.archivos[1]);
  assert.equal(codigo.tipo, 'codigo');
  assert.match(codigo.lineas[0], /class Main/);
});

await prueba('descarga con el token', async () => {
  const p5 = tarea('Práctica 5: Herencia');
  const { ruta, bytes } = await descargar(p5.adjuntos[1].url, path.join(tmp, 'descargas'));
  assert.equal(path.basename(ruta), 'Main.java');
  assert.ok(bytes > 50);
});

await prueba('mensajes, avisos y notificaciones', async () => {
  const { lista, fallidos } = await mensajes(datos.cursos);
  assert.equal(fallidos, 0);
  const tipos = lista.map((m) => `${m.tipo}:${m.de}`);
  assert.ok(tipos.includes('mensaje:Mtra. Laura Gómez'));
  assert.ok(tipos.includes('anuncio:Cambio de salón'));
  assert.ok(tipos.some((t) => t.startsWith('notificacion:🔔 Calificación')));
  assert.ok(!tipos.some((t) => t.includes('Nuevo aviso')), 'las notificaciones de foro no se duplican');
  assert.ok(!lista.some((m) => m.texto === 'Gracias!'), 'no se muestran tus propios mensajes');
  assert.equal(lista.find((m) => m.de === 'Diana López').curso, 'Equipo Proyecto 3');
  for (let i = 1; i < lista.length; i++) assert.ok(Date.parse(lista[i - 1].cuando) >= Date.parse(lista[i].cuando));
});

await prueba('resumen con calificaciones', async () => {
  const r = await resumen();
  const calc = r.cursos.find((c) => c.nombre === 'Cálculo Vectorial');
  assert.equal(calc.total.texto, '9.50');
  assert.equal(calc.anuncios[0].titulo, 'Cambio de salón');
});

await prueba('token inválido = sesión caducada (401)', async () => {
  const s = leerSesion();
  fs.writeFileSync(path.join(tmp, 'sesion.json'), JSON.stringify({ ...s, token: 'malo' }));
  olvidarUsuario();
  await assert.rejects(agenda(), (e) => e.estado === 401);
  fs.writeFileSync(path.join(tmp, 'sesion.json'), JSON.stringify(s));
});

const nombres = new Set(llamadas.map((l) => l.nombre));
console.log(`\n${ok} pruebas bien · funciones de Moodle usadas: ${[...nombres].sort().join(', ')}`);
servidor.close();
fs.rmSync(tmp, { recursive: true, force: true });
