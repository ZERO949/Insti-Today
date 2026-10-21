// Entregar en Moodle: la app abre la página oficial de la entrega
// (mod/assign/view.php?id=…&action=editsubmission) en su navegador y suelta
// tus archivos en el selector de archivos de Moodle, como si los arrastraras.
// Quedan en el borrador de la entrega: «Guardar cambios» (y, si tu profesor
// lo pide, «Enviar tarea») lo pulsas tú.

import path from 'node:path';

// ¿Es la página de esta tarea en Moodle? (cualquier vista de la tarea).
export function esPaginaDeTarea(direccion, { enlace, tareaId }) {
  try {
    const url = new URL(direccion);
    const esperada = new URL(enlace);
    return (
      /^https?:$/.test(url.protocol) &&
      url.origin === esperada.origin &&
      /\/mod\/assign\/view\.php$/.test(url.pathname) &&
      url.searchParams.get('id') === String(tareaId)
    );
  } catch {
    return false;
  }
}

// La página donde se editan los archivos de la entrega.
export function esPaginaDeEdicion(direccion, destino) {
  if (!esPaginaDeTarea(direccion, destino)) return false;
  try {
    return new URL(direccion).searchParams.get('action') === 'editsubmission';
  } catch {
    return false;
  }
}

// El selector de archivos de la entrega. La página puede traer otros (ocultos o
// de otro campo): cuentan los visibles y, si aún hay varios, el de archivos de la tarea.
const ELEGIR = `const visibles = [...document.querySelectorAll('.filemanager')].filter((e) => e.getClientRects().length);
  const propios = visibles.filter((e) => e.closest('#fitem_id_files_filemanager'));
  const fm = propios.length === 1 ? propios : visibles;`;

// Lo que se ve dentro del selector de archivos de Moodle.
const LEER_ARCHIVOS = `(() => {
  ${ELEGIR}
  if (fm.length !== 1) return { campos: fm.length, nombres: [] };
  const nombres = [...fm[0].querySelectorAll('.fp-filename, .fp-filename-field .fp-filename')]
    .map((e) => e.textContent.trim()).filter(Boolean);
  return { campos: 1, nombres: [...new Set(nombres)], cargando: !!fm[0].querySelector('.dndupload-uploadinprogress, .dndupload-progressbars progress') };
})()`;

const RECTANGULO = `(() => {
  ${ELEGIR}
  const uno = fm.length === 1 ? fm[0] : null;
  const zona = uno && (uno.querySelector('.filemanager-container') || uno.querySelector('.fp-content') || uno);
  if (!zona) return null;
  zona.scrollIntoView({ block: 'center' });
  const r = zona.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 60)), ancho: r.width, alto: r.height };
})()`;

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// El navegador puede reutilizarse. Cada entrega es cancelable y está ligada a su tarea.
export function colocarArchivos(ventana, rutas, destino, notificar, { espera = 1500, limite = 300000 } = {}) {
  const wc = ventana.webContents;
  let terminado = false, reloj, ocupado = false, propio = false;
  let enEdicionDesde = 0;
  const fin = Date.now() + limite;
  const limpiar = () => {
    clearTimeout(reloj);
    wc.removeListener('did-navigate', navegar);
    wc.removeListener('did-navigate-in-page', navegar);
    ventana.removeListener('closed', cerrar);
    if (propio && wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch {} }
    propio = false;
  };
  const terminar = (fase, texto) => {
    if (terminado) return;
    terminado = true;
    limpiar();
    notificar({ fase, texto });
  };
  const cancelar = () => terminar('cancelada', 'Preparación cancelada. Tus archivos se conservan; puedes arrastrarlos manualmente.');
  // Cancela si, ya en la página de edición, te vas a otra parte de Moodle
  // que no es esta tarea. Las redirecciones al abrir (inicio de sesión,
  // inicio automático) no cuentan.
  let llego = false;
  const navegar = (_evento, url) => {
    if (esPaginaDeTarea(url, destino)) {
      if (esPaginaDeEdicion(url, destino)) llego = true;
      return;
    }
    let mismoSitio = false;
    try {
      mismoSitio = new URL(url).origin === new URL(destino.enlace).origin && !/\/login\/|\/admin\/tool\/mobile\//.test(new URL(url).pathname);
    } catch {}
    if (llego && mismoSitio) cancelar();
  };
  const cerrar = () => terminar('cancelada', 'Cerraste Moodle. Tus archivos y tu texto siguen guardados.');
  wc.on('did-navigate', navegar);
  wc.on('did-navigate-in-page', navegar);
  ventana.on('closed', cerrar);

  const soltar = async () => {
    const zona = await wc.executeJavaScript(RECTANGULO);
    if (!zona || zona.ancho < 20 || zona.alto < 20) return false;
    await dormir(300);
    const z = await wc.executeJavaScript(RECTANGULO);
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); propio = true; }
    const datos = { items: [], files: rutas, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      if (terminado || !esPaginaDeEdicion(wc.getURL(), destino)) return null;
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type, x: z.x, y: z.y, data: datos });
      await dormir(120);
    }
    return true;
  };

  const intentar = async () => {
    if (terminado || ocupado) return;
    if (ventana.isDestroyed()) return cerrar();
    if (Date.now() >= fin) return terminar('manual', 'No apareció el selector de archivos de Moodle. Arrastra los archivos desde la ventana de Insti Today.');
    ocupado = true;
    try {
      const url = wc.getURL();
      // En la vista de la tarea (sin editar) se lleva a la edición.
      if (esPaginaDeTarea(url, destino) && !esPaginaDeEdicion(url, destino) && !wc.isLoading() && destino.enlaceEntrega) {
        wc.loadURL(destino.enlaceEntrega).catch(() => {});
      } else if (esPaginaDeEdicion(url, destino) && !wc.isLoading()) {
        enEdicionDesde ||= Date.now();
        const antes = await wc.executeJavaScript(LEER_ARCHIVOS);
        if (terminado) return;
        if (antes.campos > 1) return terminar('manual', 'Hay varios selectores de archivos. Elige el correcto y arrastra tus archivos.');
        if (antes.campos === 0) {
          // Moodle tarda un poco en dibujar el selector; si nunca aparece, la
          // tarea sólo pide texto en línea.
          if (Date.now() - enEdicionDesde > 15_000) {
            return terminar('manual', 'Esta tarea no tiene selector de archivos (quizá sólo pide texto en línea). Copia tu texto en Moodle y guarda.');
          }
        } else if (antes.cargando) {
          // Moodle aún sube algo (quizá lo que arrastraste): se espera para no soltarlo dos veces.
        } else {
          const nombres = rutas.map((r) => path.basename(r));
          const faltan = nombres.filter((n) => !antes.nombres.includes(n));
          if (!faltan.length) return terminar('colocados', 'Tus archivos ya están en la entrega de Moodle. Revisa y pulsa «Guardar cambios» allí.');
          const soltado = await soltar();
          if (soltado === null) return cancelar();
          if (!soltado) return terminar('manual', 'No encontré dónde soltar los archivos. Arrástralos al recuadro de Moodle.');
          notificar({ fase: 'preparando', texto: 'Subiendo tus archivos al borrador de Moodle…' });
          // Moodle sube cada archivo y luego lo muestra en la lista.
          const hasta = Date.now() + 90_000;
          while (Date.now() < hasta) {
            await dormir(1000);
            if (terminado || ventana.isDestroyed() || !esPaginaDeEdicion(wc.getURL(), destino)) return terminado ? undefined : cancelar();
            const ahora = await wc.executeJavaScript(LEER_ARCHIVOS);
            if (nombres.every((n) => ahora.nombres.includes(n))) {
              return terminar('colocados', 'Archivos subidos al borrador de Moodle. Revisa la lista y pulsa «Guardar cambios» (y «Enviar tarea» si aparece).');
            }
          }
          return terminar('manual', 'Moodle no confirmó todos los archivos (puede pedir confirmar si ya existe uno con ese nombre). Revísalos o arrástralos manualmente.');
        }
      }
    } catch (e) {
      return terminar('manual', `No pude colocar los archivos: ${e.message}. Puedes arrastrarlos manualmente.`);
    } finally {
      ocupado = false;
      if (propio && wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch {} propio = false; }
    }
    if (!terminado) reloj = setTimeout(intentar, espera);
  };
  notificar({ fase: 'preparando', texto: 'Página abierta. Esperando el selector de archivos de Moodle…' });
  reloj = setTimeout(intentar, espera);
  return cancelar;
}
