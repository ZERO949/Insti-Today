// Puente mínimo entre las páginas y el proceso de Rust: el mismo window.agenda
// que daba preload.cjs en Electron. Se inyecta antes que la página, sólo en las
// ventanas propias (las de Moodle no tienen acceso).
(() => {
  if (!window.__TAURI_INTERNALS__ || window.agenda) return;
  const llamar = (canal, ...args) => window.__TAURI_INTERNALS__.invoke('llamar', { canal, args });
  const enviar = (canal, ...args) => void llamar(canal, ...args).catch(() => {});
  // El evento puede llegar antes de que cargue la API de eventos: se espera a ella.
  const al = (canal, fn) => {
    const escuchar = () => window.__TAURI__.event.listen(canal, (e) => fn(e.payload));
    if (window.__TAURI__?.event) escuchar();
    else addEventListener('DOMContentLoaded', escuchar, { once: true });
  };
  const ua = navigator.userAgent;

  window.agenda = {
    plataforma: /Windows/.test(ua) ? 'win32' : /Mac/.test(ua) ? 'darwin' : 'linux',
    obtener: () => llamar('agenda:obtener'),
    actualizar: () => llamar('agenda:actualizar'),
    entrar: () => llamar('agenda:entrar'),
    abrir: (url) => llamar('agenda:abrir', url),
    escuela: (url) => llamar('agenda:escuela', url),
    teclado: (activo) => llamar('agenda:teclado', activo),
    abrirArchivo: (archivo) => llamar('archivo:abrir', archivo),
    ocultar: () => llamar('agenda:ocultar'),
    alto: (px) => llamar('agenda:alto', px),
    vista: {
      cerrar: () => llamar('vista:cerrar'),
      mostrar: (datos) => llamar('vista:mostrar', datos),
      soltar: () => llamar('vista:soltar'),
      mantener: () => llamar('vista:mantener'),
      tarjeta: (rect) => llamar('vista:tarjeta', rect),
      raton: (sobre) => llamar('vista:raton', sobre),
      precargar: (lista) => llamar('vista:precargar', lista),
      calentar: () => llamar('vista:calentar'),
      miniaturaPdf: (archivo, src) => llamar('vista:miniaturaPdf', archivo, src),
      alDatos: (fn) => al('vista:datos', fn),
      alMuestra: (fn) => al('vista:muestra', fn),
      alCerrar: (fn) => al('vista:cerrar', () => fn()),
      alCerrada: (fn) => al('vista:cerrada', () => fn()),
    },
    config: {
      obtener: () => llamar('config:obtener'),
      guardar: (cambios) => llamar('config:guardar', cambios),
      materias: (ocultas) => llamar('config:materias', ocultas),
      inicio: (activo) => llamar('config:inicio', activo),
      esquina: () => llamar('config:esquina'),
      salirCuenta: () => llamar('config:salir-cuenta'),
      entrar: () => llamar('config:entrar'),
      cambiarCuenta: (id) => llamar('cuentas:cambiar', id),
      agregarCuenta: () => llamar('cuentas:agregar'),
      quitarCuenta: (id) => llamar('cuentas:quitar', id),
      colorCuenta: (id, color) => llamar('cuentas:color', id, color),
      alCambiar: (fn) => al('config:estado', fn),
    },
    actualizacion: {
      instalar: () => llamar('actualizacion:instalar'),
      buscar: () => llamar('actualizacion:buscar'),
      descargar: () => llamar('actualizacion:descargar'),
    },
    tareas: {
      descartar: (tarea) => llamar('tareas:descartar', tarea),
      restaurar: (id) => llamar('tareas:restaurar', id),
      posponer: (tarea, hasta) => llamar('tareas:posponer', tarea, hasta),
      volver: (id) => llamar('tareas:volver', id),
    },
    tema: () => llamar('tema:actual'),
    app: {
      abrir: (seccion, tareaId) => llamar('app:abrir', seccion, tareaId),
      detalle: (cursoId, tareaId) => llamar('app:detalle', cursoId, tareaId),
      alIr: (fn) => al('app:ir', ([seccion, tareaId, guia]) => fn(seccion, tareaId, guia)),
    },
    mensajes: {
      vistos: (ids) => llamar('mensajes:vistos', ids),
      abrir: (url) => llamar('mensajes:abrir', url),
    },
    entrega: {
      obtener: (tareaId) => llamar('entrega:obtener', tareaId),
      adjuntar: (tareaId, ruta, si) => llamar('entrega:adjuntar', tareaId, ruta, si),
      adjuntarTodo: (tareaId) => llamar('entrega:adjuntarTodo', tareaId),
      subir: (tareaId, rutas) => llamar('entrega:subir', tareaId, rutas),
      quitarTuyo: (tareaId, ruta) => llamar('entrega:quitarTuyo', tareaId, ruta),
      texto: (tareaId, texto) => llamar('entrega:texto', tareaId, texto),
      abrirArchivo: (tareaId, ruta) => llamar('entrega:abrirArchivo', tareaId, ruta),
      mostrarArchivo: (tareaId, ruta) => llamar('entrega:mostrarArchivo', tareaId, ruta),
      entregar: (tareaId) => llamar('entrega:entregar', tareaId),
      cancelar: (tareaId) => llamar('entrega:cancelar', tareaId),
      // Los archivos soltados llegan con su ruta por el evento insti:soltar (ver abajo).
      rutaDe: () => null,
    },
    arrastre: {
      obtener: () => llamar('arrastre:obtener'),
      iniciar: (i) => enviar('arrastre:iniciar', i),
      cerrar: () => llamar('arrastre:cerrar'),
      ajustar: (alto) => enviar('arrastre:ajustar', alto),
      colocar: (i) => enviar('arrastre:colocar', i),
      alAviso: (fn) => al('arrastre:aviso', fn),
    },
    web: (ruta) => llamar('abrir:web', ruta),
    acceso: {
      info: () => llamar('acceso:info'),
      entrar: (usuario, contrasena) => llamar('acceso:entrar', usuario, contrasena),
      cancelar: () => llamar('acceso:cancelar'),
    },
    alCambiar: (fn) => al('agenda:estado', fn),
    alEscritorio: (fn) => al('agenda:escritorio', fn),
  };

  // Archivos soltados desde el Explorador: el sistema los da con su ruta.
  al('tauri://drag-drop', (e) => dispatchEvent(new CustomEvent('insti:soltar', { detail: e.paths || [] })));

  // Las zonas con -webkit-app-region: drag mueven la ventana (Tauri no lee esa propiedad).
  addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    for (let el = e.target; el && el.nodeType === 1; el = el.parentElement) {
      if (el.matches('button, a, input, textarea, select, [contenteditable]')) return;
      const zona = getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region');
      if (zona === 'no-drag') return;
      if (zona === 'drag') {
        e.preventDefault();
        enviar('ventana:arrastrar');
        return;
      }
    }
  });
})();
