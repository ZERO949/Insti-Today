// npm run login -- https://plataforma.uii.edu.mx/moodle
//
// Pide tu usuario y contraseña de Moodle en la terminal y guarda SÓLO el
// token que Moodle devuelve (la contraseña no se guarda). Sirve para usar el
// servidor MCP sin abrir la app.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { iniciarSesion, leerSesion } from './sesion.js';

const url = process.argv[2] || process.env.INSTI_URL || leerSesion()?.url || 'https://plataforma.uii.edu.mx/moodle';
const rl = readline.createInterface({ input: stdin, output: stdout });
const usuario = await rl.question(`Usuario de ${url}: `);
// Sin eco al escribir la contraseña.
stdout.write('Contraseña: ');
const contrasena = await new Promise((ok) => {
  let texto = '';
  stdin.setRawMode?.(true);
  stdin.resume();
  const alTeclear = (d) => {
    const c = d.toString('utf8');
    if (c === '\r' || c === '\n') {
      stdin.setRawMode?.(false);
      stdin.removeListener('data', alTeclear);
      stdout.write('\n');
      ok(texto);
    } else if (c === '\u0003') process.exit(1);
    else if (c === '\u007f') texto = texto.slice(0, -1);
    else texto += c;
  };
  stdin.on('data', alTeclear);
});
rl.close();
try {
  const info = await iniciarSesion(url, usuario, contrasena);
  console.log(`Sesión guardada para ${info.fullname} (${info.username}) en ${info.sitename}.`);
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
