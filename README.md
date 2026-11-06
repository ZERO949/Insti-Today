# Insti Today

Tus pendientes de **Moodle**, a la vista. Un widget de escritorio para Windows
que reúne tus tareas, exámenes, foros con fecha, mensajes, avisos y
notificaciones de la plataforma de tu escuela. Hecho para la
[Plataforma UII](https://plataforma.uii.edu.mx/moodle), sirve para cualquier
Moodle que tenga activa la app móvil.

Basado en [BB Today](https://github.com/Ironmistyfox/bb-today) (Blackboard) de
Ironmistyfox, bajo licencia [MIT](LICENSE). Proyecto independiente, sin
afiliación con Moodle HQ ni con la UII.

## Qué puedes hacer

- Ver lo que vence hoy, lo que viene y lo vencido que aún acepta entrega tardía.
- Leer instrucciones y previsualizar PDF, imágenes, Word, PowerPoint, ZIP y código
  (los adjuntos de la tarea y el material que el profesor dejó en la misma sección).
- Ver mensajes, avisos del foro «Avisos» y notificaciones (calificaciones, etc.).
- Preparar una entrega: la app abre la página oficial de la tarea y **suelta tus
  archivos en el selector de archivos de Moodle**. «Guardar cambios» lo pulsas tú.
- Abrir cualquier tarea en Moodle sin volver a escribir tu contraseña.

## Cómo funciona con Moodle

La app usa los **servicios web de Moodle**, los mismos que usa la app móvil
oficial (`moodle_mobile_app`). La Plataforma UII los tiene activos (Moodle 5.1).

- **Inicio de sesión:** escribes tu usuario y contraseña en la ventana de la app;
  van directo a `/login/token.php` de tu Moodle, que devuelve un *token*. Sólo se
  guarda el token (en `%APPDATA%\insti-today`), nunca la contraseña.
- **Lectura:** cursos en progreso, `mod_assign` (tareas y si ya entregaste),
  `mod_quiz` (exámenes e intentos), foros con fecha, la línea de tiempo del
  calendario (lecciones, talleres…), contenido del curso, calificaciones y mensajería.
- **Abrir páginas:** el navegador interno de la app inicia sesión con el mismo
  formulario de Moodle; si después caduca, usa el inicio automático de la app móvil.
- **Entregar:** abre `mod/assign/view.php?id=…&action=editsubmission` y arrastra tus
  archivos al selector de Moodle. No envía nada por su cuenta.

Si tu escuela usa otro Moodle: en el widget, «cambiar» debajo del botón de iniciar
sesión y pega la dirección de tu plataforma.

## Instalar

**Windows:** descarga `Insti-Today-Setup.exe` del último
[release](https://github.com/ZERO949/Insti-Today/releases/latest) y ábrelo (~4 MB).
Windows puede avisar que la app no está firmada: «Más información → Ejecutar de
todas formas». Si ya tenías la versión anterior, el instalador la reemplaza y
conserva tu sesión y tus ajustes.

**Android (APK):** instala `Insti-Today-Android.apk` en el teléfono (Android 7 o
posterior). Android pedirá permitir «instalar apps de origen desconocido» para la
app con la que lo abras (Archivos, Drive…). La app de Android lee tus pendientes,
sus archivos, mensajes y avisos, y te recuerda las tareas antes de que venzan;
«Entregar en Moodle» abre la página oficial de la tarea.

## Desarrollo

Rust (toolchain `x86_64-pc-windows-gnu` o `msvc`) y Node.js 22 o posterior.

```text
npm ci
npm run app                    # abre la app (Tauri, modo desarrollo)
npm run moodle-falso           # un Moodle de prueba en http://127.0.0.1:8765/moodle (alumno / secreto)
npm run probar                 # pruebas de Rust y de la capa de Moodle en JS
npm run empaquetar             # → src-tauri/target/release/bundle/nsis/ (instalador de ~4 MB)
```

Para probar la app contra el Moodle falso sin tocar tus datos reales:

```text
INSTI_DATOS=/tmp/insti npm run app
# en el widget: «cambiar» → 127.0.0.1:8765/moodle → Iniciar sesión → alumno / secreto
```

### App de Android (`movil/`)

Es una app de Capacitor que reutiliza la capa de Moodle en JS de `src/` (empaquetada con
esbuild; los módulos de Node se cambian por los de `movil/fuente/shims`). Hace falta
el JDK (17 o posterior) y el SDK de Android (`ANDROID_HOME`, por defecto `~/Android/Sdk`).

```text
cd movil
npm ci
npm run construir && npm run servir   # probar en el navegador con el Moodle falso: http://127.0.0.1:5180
npm run apk                           # → dist/Insti-Today-Android.apk (firmado para depuración)
```

### Mapa del código

| Archivo | Qué hace |
| --- | --- |
| `src-tauri/src/moodle.rs` | Dirección del Moodle, token, cliente REST, descargas con token |
| `src-tauri/src/agenda.rs` | Tareas, exámenes, foros y calendario; vista previa; mensajes |
| `src-tauri/src/app_logica.rs` | Revisar Moodle, avisos, vista previa, cuentas, puente con las páginas |
| `src-tauri/src/ventanas.rs` | Ventanas, anclado al escritorio, navegador de Moodle |
| `src-tauri/src/entrega.rs` | Tus archivos y «Entregar en Moodle» |
| `src-tauri/src/sistema.rs` | Bandeja, avisos de Windows, actualizaciones |
| `widget/*.html`, `widget/puente.js` | El widget y la app (heredados de BB Today) |
| `src/*.js` | La capa de Moodle en JS (la usa la app de Android) |
| `tools/moodle-falso.mjs` | Moodle de prueba |

### Actualizaciones automáticas

La app busca versiones nuevas en los releases del repositorio **público**
`ZERO949/Insti-Today` (`latest.json`, firmado). Cuando hay una, aparece un aviso con
«Descargar e instalar»: la app se cierra, el instalador reemplaza la versión anterior y
se vuelve a abrir. Cómo publicar: ver [AGENTS.md](AGENTS.md#repositorio-y-versiones).

## Privacidad

La app sólo habla con tu Moodle: no tiene servidor propio ni analíticas. El aviso
completo está en [`widget/privacidad.html`](widget/privacidad.html).
