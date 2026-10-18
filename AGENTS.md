# Insti Today: guía para agentes

Insti Today es una app Electron para estudiantes con **Moodle** (por defecto la
Plataforma UII, https://plataforma.uii.edu.mx/moodle, Moodle 5.1): widget de
escritorio, app completa y servidor MCP opcional. Es un fork de BB Today
(Blackboard) de Ironmistyfox, licencia MIT. Todo el código, textos y
comentarios se escriben en español.

## Lo que cambió respecto a BB Today

- La capa de datos (`src/`) habla con los servicios web REST de Moodle
  (`/webservice/rest/server.php`, servicio `moodle_mobile_app`) con un token
  que se pide a `/login/token.php`. Nunca se guarda la contraseña.
- La forma de los datos que recibe el widget es la misma que en BB Today
  (`agenda()` → `{ usuario, cuenta, generado, cursos: [{ id, nombre, tareas }], materias }`),
  por eso `widget/main.js` y los HTML casi no cambiaron. Campos nuevos en cada
  tarea: `modulo` (assign/quiz/forum/…), `enlaceEntrega`, `adjuntos`, `abre`, `cierre`.
- Los ids de tarea son el `cmid` de Moodle (string); los de curso, el id del curso (string).
- Entregar: `widget/entrega.js` abre `action=editsubmission` y suelta los archivos
  con `Input.dispatchDragEvent` (CDP) sobre `.filemanager`. La persona pulsa
  «Guardar cambios».
- Actualizaciones (`widget/actualizaciones.js`, desde la 0.1.3): la app lee los
  releases del repositorio público `ZERO949/Insti-Today`. Al haber versión nueva
  pregunta con un aviso (`preguntarVersionNueva` en `main.js`); si se acepta,
  descarga, reinstala encima y se reabre. La 0.1.2 y anteriores no buscan
  actualizaciones: se instalan a mano una vez.
- Se quitaron el sitio web, la publicación y el contador de BB Today.
- Las funciones de IA siguen desactivadas como en BB Today 1.2.7 (`src/mantenimiento.js`).

## Repositorio y versiones

- Código y releases en https://github.com/ZERO949/Insti-Today (público, rama `main`).
  `gh` tiene sesión con la cuenta ZERO949.
- Los commits van sólo a nombre de `Alvaro Uriel Perez Martinez
  <132710856+ZERO949@users.noreply.github.com>` (configurado en el repositorio).
  Nunca añadir `Co-Authored-By`, «Generated with Claude Code» ni otra mención a
  Claude en commits, PR o releases.
- Publicar una versión:
  1. Subir `version` en `package.json` y añadir la entrada en `CHANGELOG.md`.
  2. Commit, `git tag vX.Y.Z`, `git push`, `git push --tags`. La etiqueta tiene que
     existir antes de publicar: electron-builder crea el release desde dos tareas a
     la vez y, sin etiqueta, GitHub rechaza una con «Published releases must have a
     valid tag» (pasó con la 0.1.3).
  3. `$env:GH_TOKEN = gh auth token; npm run publicar` (sólo Windows).
  4. Comprobar que el release tiene `Insti-Today-Setup.exe`, su `.blockmap` y
     `latest.yml` con la versión nueva; sin `latest.yml` la app no ve la versión.
- Antes de subir algo, revisar que no van tokens, sesiones (`sesion*.json`) ni
  `local.properties`; el repositorio es público.

## App de Android (`movil/`)

- Capacitor 8. `movil/fuente/app.js` importa `src/agenda.js`, `src/mensajes.js`,
  `src/detalle.js`, `src/cliente.js` y `src/sesion.js` tal cual; `construir.mjs` los
  empaqueta y cambia `node:fs`, `node:path`… por `fuente/shims` (la sesión y
  `ajustes.json` viven en `localStorage`). Si `src/` empieza a usar otro módulo de
  Node, hay que añadir su equivalente ahí.
- La red va por `CapacitorHttp` (`fuente/nativo.js` → `configurarTransporte`), sin CORS.
- `npm run servir` sirve `www/` y el Moodle falso en el mismo origen para probar en
  un navegador.

## Invariantes

- Sólo lectura en Moodle. Nada se entrega, publica ni marca como leído por la app.
- El token sólo se añade a direcciones del mismo origen que la plataforma
  (`urlConToken` en `src/cliente.js`) y nunca viaja al renderer.
- Las funciones de Moodle que una escuela no permita se toleran con `wsOpcional`;
  una sesión inválida (`invalidtoken`) siempre se propaga como estado 401.

## Pruebas

- `node tools/probar-moodle.mjs`: capa de Moodle contra `tools/moodle-falso.mjs`.
- Con interfaz (Linux: `xvfb-run`): `BB_CAPTURA=…png INSTI_PRUEBA_ENTRAR=alumno:secreto
  INSTI_PRUEBA_ENTREGA="Práctica 5: Herencia" electron . --no-sandbox`, con
  `INSTI_DATOS` en una carpeta temporal y `ajustes.json` apuntando al Moodle falso.
- No probar entregas con una cuenta real sin una tarea elegida por su dueño.
- Las pruebas `tools/probar-*.mjs` heredadas de BB Today (paquete, interacciones,
  avisos…) usan `tools/datos-ejemplo.mjs` y no se han revisado para esta versión.
