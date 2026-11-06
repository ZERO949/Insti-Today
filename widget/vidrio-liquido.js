// Vidrio líquido (Ajustes → Experimental, con el tema Vidrio): la gota de vidrio
// que se desliza a una fila del widget o de la ventana de Insti Today. Se estira
// al viajar, rebota al llegar y su canto dobla lo que pasa debajo, como la
// burbuja de la barra de pestañas de Android. Todo va por eventos y animaciones
// del compositor: quieta no gasta nada.
//
// crearGota(contenedor, { radio, burbuja }) → { mover(fila), soltar() }. El
// contenedor tiene que estar posicionado; la gota se pinta con la clase .gota de
// cada página. Con burbuja, el rebote de la app de Android y una lente más suave.

(() => {
  const quieto = matchMedia('(prefers-reduced-motion: reduce)');
  const SVG = 'http://www.w3.org/2000/svg';
  let capa = null;
  let cuenta = 0;

  // Un filtro por gota (cada una tiene su mapa): feImage es el mapa (rojo = x,
  // verde = y) y feDisplacementMap empuja; quieta tiene scale 0.
  function filtro() {
    if (!capa) {
      capa = document.createElementNS(SVG, 'svg');
      capa.setAttribute('width', '0');
      capa.setAttribute('height', '0');
      capa.setAttribute('aria-hidden', 'true');
      capa.style.position = 'absolute';
      document.body.append(capa);
    }
    const id = `lente-gota-${++cuenta}`;
    const f = document.createElementNS(SVG, 'filter');
    f.id = id;
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' })) f.setAttribute(k, v);
    const mapa = document.createElementNS(SVG, 'feImage');
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'mapa' })) mapa.setAttribute(k, v);
    const empuje = document.createElementNS(SVG, 'feDisplacementMap');
    for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'mapa', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G' })) empuje.setAttribute(k, v);
    f.append(mapa, empuje);
    capa.append(f);
    return { id, mapa, empuje };
  }

  // Mapa de la lente a la medida de la gota: cerca del canto cada punto toma el
  // color de un poco más adentro; el centro no se mueve. Uno por tamaño.
  const mapas = new Map();
  function dibujarMapa(w, h, radio) {
    const clave = `${w}x${h}x${radio}`;
    if (mapas.has(clave)) return mapas.get(clave);
    const lienzo = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = lienzo.getContext('2d');
    const img = ctx.createImageData(w, h);
    const r = Math.min(radio, w / 2, h / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Punto más cercano del rectángulo interior (las esquinas son redondas).
        const dx = Math.min(Math.max(x + 0.5, r), w - r) - (x + 0.5);
        const dy = Math.min(Math.max(y + 0.5, r), h - r) - (y + 0.5);
        const dist = Math.hypot(dx, dy) || 1;
        const adentro = r - dist;
        const fuerza = adentro < 0 ? 0 : Math.max(0, 1 - adentro / r) ** 2;
        const i = (y * w + x) * 4;
        img.data[i] = 128 + 127 * fuerza * (dx / dist);
        img.data[i + 1] = 128 + 127 * fuerza * (dy / dist);
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    mapas.set(clave, lienzo.toDataURL());
    return mapas.get(clave);
  }

  window.crearGota = (contenedor, { radio = 11, burbuja = false } = {}) => {
    // [ancho y alto al estirarse, al pasarse, píxeles que se pasa, ms, lente]
    const [estira, pasa, sobra, ms, dobla] = burbuja ? [[0.9, 1.4], [1.05, 0.88], 5, 540, 12] : [[0.97, 1.16], [1.01, 0.95], 3, 420, 20];
    const lente = filtro();
    const gota = Object.assign(document.createElement('i'), { className: 'gota' });
    gota.setAttribute('aria-hidden', 'true');
    gota.style.setProperty('--lente', `url(#${lente.id})`);
    let en = null;
    let anim = null;
    let paso = 0;

    // Cambia poco a poco cuánto dobla la lente (0 = vidrio liso).
    function fijar(objetivo, ms) {
      cancelAnimationFrame(paso);
      const desde = Number(lente.empuje.getAttribute('scale')) || 0;
      const t0 = performance.now();
      const avanzar = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        lente.empuje.setAttribute('scale', desde + (objetivo - desde) * k);
        if (k < 1) paso = requestAnimationFrame(avanzar);
      };
      paso = requestAnimationFrame(avanzar);
    }

    function mover(fila) {
      if (!fila || fila === en) return;
      // La página puede rehacer el contenedor con innerHTML y llevarse la gota.
      if (!contenedor.contains(gota)) {
        contenedor.prepend(gota);
        en = null;
      }
      const y = fila.offsetTop;
      const h = fila.offsetHeight;
      // Leer dónde va (también a media animación) antes de cancelarla.
      const antes = en ? new DOMMatrix(getComputedStyle(gota).transform).m42 : null;
      const hAntes = gota.offsetHeight;
      anim?.cancel();
      const clave = `${fila.offsetWidth}x${h}`;
      if (lente.mapa.dataset.medida !== clave) {
        lente.mapa.setAttribute('href', dibujarMapa(fila.offsetWidth, h, radio));
        lente.mapa.setAttribute('width', fila.offsetWidth);
        lente.mapa.setAttribute('height', h);
        lente.mapa.dataset.medida = clave;
      }
      gota.style.left = `${fila.offsetLeft}px`;
      gota.style.width = `${fila.offsetWidth}px`;
      gota.style.transform = `translateY(${y}px)`;
      gota.style.height = `${h}px`;
      gota.classList.add('ve');
      en = fila;
      if (antes === null || antes === y || quieto.matches) return;
      const d = y - antes;
      fijar(dobla, 80);
      const esta = gota.animate(
        [
          { transform: `translateY(${antes}px)`, height: `${hAntes}px` },
          { transform: `translateY(${antes + d * 0.55}px) scale(${estira})`, offset: 0.45 },
          { transform: `translateY(${y + Math.sign(d) * sobra}px) scale(${pasa})`, offset: 0.75 },
          { transform: `translateY(${y}px)`, height: `${h}px` },
        ],
        { duration: ms, easing: 'cubic-bezier(.3, .7, .2, 1)' },
      );
      anim = esta;
      esta.onfinish = () => anim === esta && fijar(0, 220);
    }

    function soltar() {
      gota.classList.remove('ve', 'pulsada');
      en = null;
    }

    contenedor.addEventListener('pointerdown', () => gota.classList.contains('ve') && gota.classList.add('pulsada'));
    for (const tipo of ['pointerup', 'pointercancel']) contenedor.addEventListener(tipo, () => gota.classList.remove('pulsada'));
    return { mover, soltar };
  };
})();
