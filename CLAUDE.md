# Insti Today

Lee [AGENTS.md](AGENTS.md) completo antes de trabajar. Contiene el mapa del
proyecto, dónde vive la app instalada, lo que no es obvio de las ventanas,
invariantes, cómo publicar y cómo probar.

Lo esencial:

- La app de escritorio está hecha en **Rust con Tauri 2** (`src-tauri/`), sólo para
  Windows. Las páginas (`widget/*.html`) son las de antes y hablan con Rust por
  `widget/puente.js` (`window.agenda` → `llamar(canal, args)`).
- Electron, las funciones de IA y el servidor MCP se quitaron: no volver a añadirlos.
- `src/*.js` es la capa de Moodle en JS que sólo usa la app de Android (`movil/`). Un
  cambio en la forma de los datos va en Rust y en JS.
- Sólo lectura en Moodle; el token nunca viaja a las ventanas.
- Compilar: toolchain `x86_64-pc-windows-gnu` (`.cargo/config.toml`). Probar:
  `npm run probar`; la app con `npm run app` y una carpeta `INSTI_DATOS` temporal.
- Nada se publica (release, etiqueta, push a `main`) sin que la persona lo pida. La
  llave de firma de las actualizaciones (`%USERPROFILE%\.tauri\insti-today.key`) no va
  al repositorio.
- Commits sólo a nombre de la persona, sin mencionar a Claude.
