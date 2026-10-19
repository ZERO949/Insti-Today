# Cambios

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
