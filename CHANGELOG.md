# Cambios

## 0.2.1 · 2026-10-21

- En la ventanita de la entrega basta con tocar un archivo (o «Todos a la vez») para
  ponerlo en Moodle; ya no hace falta mantener pulsado y arrastrar, que en el touchpad
  de una laptop se cortaba a veces. Arrastrar sigue funcionando.
- Si Moodle aún está subiendo un archivo, la app espera a que termine antes de soltar
  otro, para no subirlo dos veces.

## 0.2.0 · 2026-10-21

- Al entregar, si un archivo ya lo entregaste con otra de tus cuentas, la app pregunta
  «¿Seguro?» antes de abrir Moodle y te dice con qué cuenta, en qué tarea y cuándo. La
  comparación es por contenido (aunque le cambies el nombre) y se queda en tu
  computadora: Moodle no se entera.
- La ventanita de archivos para la entrega en Moodle toma el alto que necesita; ya no
  se corta la lista.

## 0.1.10 · 2026-10-20

- Cuenta queda más simple: sólo tus cuentas de Moodle y las actualizaciones. Se quitaron
  las secciones Ayuda y Privacidad; la guía sigue abriéndose al empezar y el aviso de
  privacidad completo sigue en la web.

## 0.1.9 · 2026-10-19

- Cambiar de cuenta es más sencillo: mantén pulsado tu icono y desliza hacia abajo
  (siguiente cuenta) o hacia arriba (anterior); al soltar cambia una sola cuenta, por
  lejos que deslices. Mantener pulsado ya no abre la lista y, si regresas el dedo al
  punto de partida, no cambia. Un toque sigue abriendo la lista de cuentas.

## 0.1.8 · 2026-10-18

- Varias cuentas de Moodle en la misma computadora, cada una con su color. Junto al
  buscador está tu icono: un toque muestra tus cuentas; mantenlo pulsado y desliza
  hacia arriba o hacia abajo para cambiar al soltar. Cada cuenta conserva sus
  tareas, tareas quitadas, materias ocultas, respuestas de IA y su propia sesión
  del navegador de Moodle. Se añaden, se cambian de color y se quitan en Cuenta;
  también se cambia desde el menú de la bandeja.

## 0.1.7 · 2026-10-18

- «Abrir en Moodle» lleva directo a la tarea desde el primer clic. Antes, si el
  navegador de la app no tenía sesión, abría la página principal de Moodle y había
  que cerrarla y volver a pulsar. También en la app de Android.

## 0.1.6 · 2026-10-18

- La barra lateral de la ventana se pliega con un clic y queda sólo con los iconos.
  El número de pendientes pasa a ser una burbuja sobre el icono y la app recuerda si
  la dejaste plegada.

## 0.1.5 · 2026-10-17

- El instalador de Windows ahora es un asistente: puedes elegir la carpeta donde se
  instala. Las actualizaciones se instalan en la misma carpeta.

## 0.1.4 · 2026-10-17

- El instalador de Windows pesa menos de 1 MB: descarga la app al instalarse (necesita
  internet). La app instalada es la misma y se sigue actualizando con el aviso.

## 0.1.3 · 2026-10-17

- Actualizaciones: cuando hay una versión nueva aparece un aviso con «Descargar e
  instalar». La app la descarga, reemplaza la versión anterior (tu sesión y tus
  ajustes se conservan) y vuelve a abrirse. Con «Más tarde» queda el botón en el
  widget y en Cuenta → Actualizaciones.
- Esta versión se instala a mano una vez; las siguientes llegan con el aviso.

## 0.1.2 · 2026-10-15

- Revisar Moodle es 2-4 veces más rápido: las tareas se piden curso por curso y
  con más consultas a la vez, y las que ya estaban entregadas no se vuelven a
  consultar una por una (cada 12 h se revisan todas).
- Un fallo de red o del servidor de Moodle durante la revisión ya no deja un
  curso sin tareas: se conservan los datos anteriores con el aviso de sin conexión.

## 0.1.1 · 2026-10-15

- Windows: el widget ya no se esconde con «Mostrar escritorio» (Win+D).

## 0.1.0 · 2026-10-12

Primera versión de Insti Today, a partir de BB Today 1.2.7.

- Lee Moodle por sus servicios web (servicio de la app móvil) en lugar de la API de Blackboard.
- Inicio de sesión con usuario y contraseña de la plataforma; sólo se guarda el token.
- Plataforma UII como escuela predeterminada; se puede cambiar a cualquier Moodle.
- Tareas (con estado de entrega, prórrogas y fecha de corte), exámenes, foros con fecha
  y actividades de la línea de tiempo.
- Material de la misma sección emparejado por número (p. ej. «Ejercicios 2.4» ↔ «Tarea 2.4»).
- Mensajes, avisos del foro «Avisos» y notificaciones.
- Entrega: suelta tus archivos en el selector de archivos de Moodle.
- Navegador interno con sesión propia e inicio automático de la app móvil de Moodle.
- Nuevo icono; actualizaciones automáticas apagadas hasta configurar un repositorio propio.
- Moodle falso y pruebas (`tools/moodle-falso.mjs`, `tools/probar-moodle.mjs`).

El historial de BB Today está en [docs/CHANGELOG-bb-today.md](docs/CHANGELOG-bb-today.md).
