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
- Actualizaciones: la app lee los releases del repositorio público
  `ZERO949/Insti-Today`. Al haber versión
  nueva pregunta con un aviso; si se acepta, descarga, reinstala encima y se reabre.
- Se quitaron el sitio web, la publicación y el contador de BB Today.
- Las funciones de IA siguen desactivadas como en BB Today 1.2.7 (`src/mantenimiento.js`).

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
