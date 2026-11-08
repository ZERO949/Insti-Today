# Insti Today: guía para agentes

Insti Today es una app de escritorio (Rust + Tauri 2, WebView2) para estudiantes con
**Moodle** (por defecto la Plataforma UII, https://plataforma.uii.edu.mx/moodle,
Moodle 5.1): widget de escritorio y app completa. Es un fork de BB Today
(Blackboard) de Ironmistyfox, licencia MIT. Todo el código, textos y comentarios se
escriben en español.

## Mapa

- `src-tauri/` — el proceso de la app, en Rust:
  - `moodle.rs`: sesión (token de `/login/token.php`, la contraseña nunca se guarda),
    cliente REST (`ws`, `ws_opcional`, caché de 30 s, cola de 8), descargas con token.
  - `agenda.rs`: tareas, exámenes, foros y calendario → la lista; detalle y muestras
    de archivos (vista previa); mensajes, anuncios y notificaciones.
  - `datos.rs`: carpeta de datos, `ajustes.json` (preferencias, tareas quitadas…),
    varias cuentas (`cuentas.json`, `cuentas/<id>/`).
  - `app_logica.rs`: lo que hacía `main.js` de Electron: revisar Moodle cada hora,
    avisos, vista previa, cuentas, inicio de sesión y el puente `llamar`.
  - `ventanas.rs`: las ventanas, el anclado al escritorio (Win32), el navegador de
    Moodle (el mismo WebView2 de la app) y el CDP para soltar archivos.
  - `entrega.rs`: tus archivos por tarea y «Entregar en Moodle».
  - `sistema.rs`: bandeja, avisos de Windows, diálogos, abrir con Windows, actualizaciones.
- `widget/` — las páginas (HTML/CSS/JS). `widget/puente.js` se inyecta en cada ventana
  propia y da el mismo `window.agenda` que daba `preload.cjs`: cada método llama
  `llamar(canal, args)` en Rust y los eventos llegan con `emit_to`. Las ventanas de
  Moodle (páginas de internet) no tienen acceso al puente (`capabilities/ventanas.json`).
  `widget/vendor/` lo copia `tools/vendor.mjs` de node_modules (pdf.js, fuente Inter);
  no va en git.
- `src/*.js` — la misma capa de Moodle en JS. **Sólo la usa la app de Android**
  (`movil/`); el escritorio usa la de Rust. Un cambio en la forma de los datos va en
  los dos lados.

La forma de los datos que recibe el widget es la de BB Today
(`{ usuario, cuenta, generado, cursos: [{ id, nombre, tareas }], materias }`). Los ids de
tarea son el `cmid` de Moodle (string); los de curso, el id del curso (string).

La carpeta de datos es la misma que en la versión de Electron
(`%APPDATA%\insti-today`, o `INSTI_DATOS`): al actualizar no hay que volver a entrar.
Sólo las cookies del navegador interno de Moodle empiezan de cero (se recuperan con el
inicio automático de la app móvil de Moodle; también al pasar a la 0.3.5, que borra la
carpeta `navegador/` de antes). Rust escribe los JSON compactos y con
las claves en orden alfabético.

## Dónde vive la app instalada

- Programa: `%LOCALAPPDATA%\Insti Today\insti-today.exe` (instalador por usuario).
  Acceso directo: `Menú Inicio\Programs\Insti Today.lnk`; abrir con Windows: valor
  «Insti Today» en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- WebView2 de las ventanas propias y de Moodle: `%LOCALAPPDATA%\mx.institoday.app`. De
  qué cuenta son las cookies de cada Moodle: `navegador.json` en la carpeta de datos.
- Archivos de cada tarea: `Documentos\Insti Today\<materia>\<tarea>\tuyos`
  (`BB_CARPETA_TAREAS` cambia la base). Lo que se descarga de Moodle:
  `Descargas\Insti Today\<materia>`. Son de la persona, no son restos de la app.

## Ventanas: lo que no es obvio

- Tauri (tao) reescribe el estilo extendido de una ventana cada vez que se muestra,
  se oculta o deja pasar el ratón. Para que el widget, la vista previa y la ventanita
  de archivos no salgan en Alt+Tab ni en Win+Tab, `ventanas.rs` las subclasifica y
  fuerza `WS_EX_TOOLWINDOW` en `WM_STYLECHANGING` (`sin_alt_tab`). La subclase se pone
  desde el hilo principal (`run_on_main_thread`).
- Todas las ventanas, también las de Moodle, crean WebView2 con los mismos argumentos (`ARGUMENTOS`:
  sin GPU, sin oclusión ni frenado de temporizadores, porque el widget vive tapado). Si
  dos WebView2 con argumentos distintos comparten carpeta, la segunda falla con
  «The requested resource is in use» (0x800700AA); `main.rs` reintenta 10 s y, si no,
  avisa y sale.
- Vidrio líquido: el widget dibuja el fondo de pantalla (`TranscodedWallpaper`, por el
  protocolo asset) donde está la ventana; la ventana de Insti Today es transparente y
  `material_app` le pone el acrílico del sistema cuando el tema es Vidrio con
  «Vidrio líquido» (experimental). El acrílico sólo se ve con la ventana activa.
- La vista previa deja pasar el ratón salvo sobre la tarjeta: Rust pregunta dónde está
  el puntero cada 50 ms (`vigilar_vista`) en vez de esperar eventos de la página.
- Crear ventanas desde un comando síncrono o desde un evento del hilo principal
  bloquea en Windows: hacerlo desde una tarea async (`spawn`).
- Tauri no entiende `-webkit-app-region: drag`; `puente.js` lo traduce a
  `start_dragging`. Los archivos soltados llegan por `tauri://drag-drop` y `puente.js`
  los pasa como el evento `insti:soltar`.
- Las ventanas de Moodle llevan `disable_drag_drop_handler`: con el manejador de Tauri
  los archivos soltados no llegan a la página y Moodle no los recibe. `SIN_AVISOS`
  quita su «¿Salir del sitio?» (salía al cerrar la ventana, que navega a about:blank)
  y no deja que un archivo soltado fuera del recuadro se abra en la ventana.
- La ventanita «Tu entrega» es transparente y sin sombra, como el widget: con la
  sombra de Tauri o el acrílico, Windows le dibuja un marco claro. Arrastrar un
  archivo de ella es un arrastre del sistema (`SHDoDragDrop`, como `startDrag` de
  Electron); tocarlo lo suelta en Moodle por CDP.

## Iniciar sesión en Moodle: cómo funciona

Hay dos sesiones distintas y no se mezclan:

1. **La de la app** (servicios web REST): `acceso.html` manda usuario y contraseña a
   `/login/token.php`; se guardan sólo `token` y `privatetoken` en `sesion.json`. Todo
   lo que revisa la app en segundo plano usa el token. Si Moodle lo rechaza
   (`invalidtoken`…), el estado pasa a `caducada` y hay que volver a entrar.
2. **La del navegador de Moodle** (la ventana «Moodle · Insti Today», para «Abrir en
   Moodle» y «Entregar en Moodle»): cookies en el WebView2 de la app, que ya está
   corriendo por el widget (hasta la 0.3.4 cada cuenta tenía su carpeta y la ventana
   tardaba ~0.45 s en abrir y ocupaba ~150 MB; ahora ~0.13 s y ~25 MB). Las cookies son
   de una cuenta a la vez: `navegador.json` dice de cuál, y `cookies_de_la_cuenta` las
   borra antes de abrir Moodle o de entrar si son de otra (con dos cuentas en la misma
   escuela, cambiar de cuenta pide el inicio automático). `borrar_navegador` borra sólo
   las cookies de Moodle de esa cuenta: `clear_all_browsing_data` borraría también lo
   de las páginas propias. Al entrar, `entrar_en_navegador` llena el formulario
   normal de Moodle en una ventana invisible.

Al abrir una página (`abrir_en_moodle` en `ventanas.rs`):

- La página se carga en seguida, sin revisar antes la sesión (hasta la 0.3.3 se pedía
  `/my/` aparte y eso hacía lenta cada apertura). Cerrar la ventana de Moodle sólo la
  esconde (y la deja en `about:blank`): la siguiente apertura no espera a WebView2.
  Por eso «Moodle se cerró» es `!is_visible()`, no que la ventana no exista.
- Si la página pedida termina de cargar en `/login/` (`PENDIENTE` en `on_page_load`),
  la sesión venció: `entrar_solo` pide una llave con `tool_mobile_get_autologin_key`
  (User-Agent `MoodleMobile`, con el `privatetoken`) y navega a
  `admin/tool/mobile/autologin.php?userid&key&urltogo`. Sólo cuando el inicio de sesión
  ya terminó de cargar: ninguna otra página de Moodle puede cargar a la vez, crea una
  sesión vacía cuya cookie pisa la buena (por eso falló la 0.3.1). Sólo se intenta una
  vez por apertura; sin llave se queda en el inicio de sesión.
- Al terminar de cargar cada página, `conservar_sesion` vuelve a guardar las cookies
  de sesión de Moodle con fecha (30 días). No en la página de inicio de sesión que
  dispara `entrar_solo`: guardaría la cookie vacía encima de la nueva.

Lo que ya rompió el inicio de sesión (0.3.1 a 0.3.3):

- **WebView2 guarda las cookies de sesión sólo en memoria.** `MoodleSession` no tiene
  fecha; al salir de la app (o al destruir la ventana de Moodle) termina su proceso de
  WebView2 y se borra.
  Electron sí las conservaba. Sin `conservar_sesion`, cada vez que se abre la ventana
  hace falta el inicio automático.
- **Moodle da una sola llave de inicio automático cada 6 minutos** por usuario
  (`autologinkeygenerationlockout`; el límite es el mismo para la app oficial de
  Moodle). La llave dura 60 s, es de un solo uso y va ligada a la IP; no funciona sin
  https ni con administradores. Es el respaldo para cuando la sesión venció en el
  servidor, no algo que se pueda pedir en cada apertura: si falla, la ventana acaba
  en el inicio de sesión de Moodle.
- **La ruta de la cookie:** Moodle pone `MoodleSession` en la ruta de la plataforma
  con «/» al final (`/moodle/`), y esa ruta no coincide con `/moodle`. Las cookies se
  leen en `escuela()` + «/» (`raiz_de_cookies`). La UII las pone en `/`.
- `cookies_for_url` y `set_cookie` bloquean WebView2 si se llaman dentro de un evento
  (`on_page_load`) o de un comando síncrono: llamarlas desde una tarea async.

Para investigar un caso real:

- `registro.log` de la carpeta de datos anota `inicio automático: <errorcode>` cuando
  Moodle no da la llave.
- Los nombres, rutas y si son persistentes las cookies del navegador de Moodle se
  leen en `%LOCALAPPDATA%\mx.institoday.app\EBWebView\Default\Network\Cookies` (SQLite; copiarlo
  antes porque está abierto). Los valores van cifrados: no leerlos.
- El Moodle falso imita la ruta `/moodle/` y el límite de 6 minutos. La prueba que
  importa: abrir una tarea, cerrar la ventana de Moodle, esperar a que salga su
  `msedgewebview2.exe` y abrir otra. La segunda vez no debe pedir llave.

## Se quitó (0.3)

Electron, las funciones de IA (Resolver con Claude/ChatGPT/Codex, respuestas, revisión,
«Cómo se hace»), el servidor MCP y sus pruebas. La entrega sólo trabaja con tus
archivos (`tuyos/`). No hay versión de Mac ni Linux por ahora: el código de Rust es
casi todo multiplataforma, pero el anclado, los avisos y el CDP son de Windows y no se
han probado en otro sistema.

## Repositorio y versiones

- Código y releases en https://github.com/ZERO949/Insti-Today (público, rama `main`).
  `gh` tiene sesión con la cuenta ZERO949.
- Los commits van sólo a nombre de `Alvaro Uriel Perez Martinez
  <132710856+ZERO949@users.noreply.github.com>`. Nunca añadir `Co-Authored-By`,
  «Generated with Claude Code» ni otra mención a Claude en commits, PR o releases.
- Compilar en Windows: Rust con el toolchain `x86_64-pc-windows-gnu` (TDM-GCC sirve;
  `.cargo/config.toml` usa las bibliotecas mingw que trae Rust).
- Las actualizaciones van firmadas. La llave privada está en
  `%USERPROFILE%\.tauri\insti-today.key` (sin contraseña) y **no va al repositorio**;
  la pública está en `tauri.conf.json`. Si se pierde la privada, las apps instaladas no
  aceptan versiones nuevas: hay que guardarla en un lugar seguro.
- Publicar una versión:
  1. Subir `version` en `package.json` y añadir la entrada en `CHANGELOG.md`.
  2. Commit, `git tag vX.Y.Z`, `git push`, `git push --tags`.
  3. En PowerShell:
     `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\insti-today.key; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''; npm run empaquetar; npm run publicar`
  4. El release debe tener `Insti-Today-Setup.exe`, `latest.json` (lo lee esta versión)
     y `latest.yml` (lo lee la de Electron ≤ 0.2.8 para pasar a ésta).
- El instalador (NSIS, ~4 MB, por usuario) muestra como editor «Insti Today»: no lleva
  el nombre del autor ni la mención a BB Today (el aviso MIT queda en `LICENSE`).
- Si encuentra la versión de Electron la desinstala (`src-tauri/nsis/migrar.nsh`):
  conserva sus datos, hereda «abrir con Windows», quita el acceso del escritorio que
  deja la instalación silenciosa y abre la app. El desinstalador de Electron se llama
  con `_?=<carpeta>`: sin eso se copia a TEMP, `ExecWait` vuelve al instante y seguía
  trabajando después, borrando el acceso directo nuevo (los dos se llaman
  «Insti Today.lnk»). Probado el 2026-11-05 instalando la 0.2.8 de Electron y encima
  ésta, en silencio.
- Antes de subir algo, revisar que no van tokens, sesiones (`sesion*.json`), la llave
  de firma ni `local.properties`; el repositorio es público.

## App de Android (`movil/`)

- Capacitor 8. `movil/fuente/app.js` importa `src/agenda.js`, `src/mensajes.js`,
  `src/detalle.js`, `src/cliente.js` y `src/sesion.js` tal cual; `construir.mjs` los
  empaqueta y cambia `node:fs`, `node:path`… por `fuente/shims` (la sesión y
  `ajustes.json` viven en `localStorage`).
- La red va por `CapacitorHttp` (`fuente/nativo.js` → `configurarTransporte`), sin CORS.
- `npm run servir` sirve `www/` y el Moodle falso en el mismo origen para probar en
  un navegador.

## Invariantes

- Sólo lectura en Moodle. Nada se entrega, publica ni marca como leído por la app.
- El token sólo se añade a direcciones del mismo origen que la plataforma
  (`url_con_token` en `moodle.rs`) y nunca viaja a las ventanas.
- Las funciones de Moodle que una escuela no permita se toleran con `ws_opcional`;
  una sesión inválida (`invalidtoken`) siempre se propaga como estado 401.

## Pruebas

- `npm run probar`: pruebas de Rust y de la capa JS contra `tools/moodle-falso.mjs`.
- Con interfaz, sin tocar tus datos: `npm run moodle-falso` y, en otra terminal,
  `INSTI_DATOS=<carpeta temporal> BB_CARPETA_TAREAS=<otra> npm run app`; en el widget
  «cambiar» → `127.0.0.1:8765/moodle` → alumno / secreto. `BB_CAPTURA_SIN_RED=1` usa
  sólo la agenda guardada. Las variables `BB_CAPTURA`, `INSTI_PRUEBA_*` y
  `BB_PRUEBA_HOVER` eran de Electron y ya no existen.
- Con `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` las páginas
  propias se revisan y fotografían con playwright (`chromium.connectOverCDP`) y se
  llama `window.agenda.*` como lo haría la página. playwright-core ya no es dependencia
  del proyecto: instalarlo en una carpeta aparte. Las ventanas de Moodle también salen
  ahí (comparten el WebView2 de la app).
- Paridad con la capa JS: correr `agenda()` y `mensajes()` de `src/` con el mismo
  `INSTI_DATOS` y comparar con `agenda.json`/`mensajes.json` que escribió Rust (sin
  `generado`/`completa`; `null` = ausente). El 2026-11-05 dieron iguales con el Moodle
  falso y con la cuenta real (238 tareas, 22 mensajes).
- Sólo corre una copia a la vez (single-instance por identificador): con la app
  instalada abierta, una compilación de prueba sólo le muestra el widget y se cierra.
  Cerrar antes la instalada (bandeja → Salir). Si se mata un proceso con `taskkill /F`,
  matar también sus `msedgewebview2.exe` (los que llevan `mx.institoday.app` en la línea
  de comandos), o la siguiente copia no puede crear su WebView2. Para probar sin cerrar
  la instalada: `npx tauri dev --config '{"identifier":"mx.institoday.prueba"}'` con
  `INSTI_DATOS` temporal.
- Una compilación `--release` con una carpeta de datos sin `inicio-instalado` se
  registra para abrir con Windows (como la instalada): crear antes ese archivo en la
  carpeta de prueba, o borrar luego el valor «Insti Today» de `Run`.
- No probar entregas, ni quitar tareas, con una cuenta real sin una tarea elegida por
  su dueño. Leer de la cuenta real (para comparar) sí se puede: es lo que hace la app.
- Sin control de la pantalla (computer use): la persona lo pidió. Lo visual que no se
  ve desde las páginas (bandeja, avisos, vidrio, Win+Tab) se le pide a ella.
