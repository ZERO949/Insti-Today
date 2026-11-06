// Las ventanas: el widget anclado al escritorio, la vista previa a su lado,
// Insti Today completo, el inicio de sesión, la ventanita de archivos y el
// navegador de Moodle de cada cuenta.

use crate::{app, datos, moodle};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex, time::Duration};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WIDGET: &str = "widget";
pub const VISTA: &str = "vista";
pub const APP: &str = "app";
pub const ACCESO: &str = "acceso";
pub const ARRASTRE: &str = "arrastre";
pub const MOODLE: &str = "moodle";

// Puente entre las páginas y Rust: el mismo window.agenda que daba preload.cjs.
const PUENTE: &str = include_str!("../../widget/puente.js");

pub fn ventana(etiqueta: &str) -> Option<WebviewWindow> {
    app().get_webview_window(etiqueta)
}

pub fn emitir(etiqueta: &str, canal: &str, datos: Value) {
    use tauri::Emitter;
    if let Some(w) = ventana(etiqueta) {
        let _ = w.emit_to(etiqueta, canal, datos);
    }
}

// El widget vive al fondo, casi siempre tapado: sin esto WebView2 lo trata como
// oculto, deja de dibujarlo y frena sus temporizadores (la vista previa no
// aparecía). Sin GPU: el widget casi no se mueve y ese proceso era el que más
// memoria ocupaba. Todas las ventanas propias comparten estos argumentos.
const ARGUMENTOS: &str = "--disable-gpu --disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

fn local(etiqueta: &str, pagina: &str) -> WebviewWindowBuilder<'static, tauri::Wry, tauri::AppHandle> {
    WebviewWindowBuilder::new(app(), etiqueta, WebviewUrl::App(pagina.into())).additional_browser_args(ARGUMENTOS).initialization_script(PUENTE).on_new_window(|url, _| {
        // Los enlaces se abren en Moodle o en el navegador, nunca dentro de la ventana.
        tauri::async_runtime::spawn(async move { abrir_externo(url.as_str()).await });
        tauri::webview::NewWindowResponse::Deny
    })
}

// Un archivo de la computadora, para las páginas (imágenes, fondo de pantalla).
pub fn url_local(p: &Path) -> String {
    let _ = app().asset_protocol_scope().allow_file(p);
    let codificada: String = url::form_urlencoded::byte_serialize(p.to_string_lossy().as_bytes()).collect::<String>().replace('+', "%20");
    if cfg!(windows) { format!("http://asset.localhost/{codificada}") } else { format!("asset://localhost/{codificada}") }
}

// ---- Anclado al escritorio ----
//
// El widget vive debajo de todas las aplicaciones y nunca tapa ninguna
// (always_on_bottom). En Windows su dueño es la ventana del escritorio
// (Progman): así «Mostrar escritorio» (Win+D) no la esconde. La vista previa
// va justo encima del widget, también por debajo del resto.

#[cfg(windows)]
mod nativo {
    use windows::{
        core::w,
        Win32::{Foundation::HWND, UI::WindowsAndMessaging::*},
    };

    const QUIETO: SET_WINDOW_POS_FLAGS = SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0);

    pub fn al_fondo(h: HWND) {
        unsafe {
            // Se vuelve a buscar cada vez: si el Explorador se reinicia, Progman cambia.
            if let Ok(escritorio) = FindWindowW(w!("Progman"), None) {
                if GetWindowLongPtrW(h, GWLP_HWNDPARENT) != escritorio.0 as isize {
                    SetWindowLongPtrW(h, GWLP_HWNDPARENT, escritorio.0 as isize);
                }
            }
            let _ = SetWindowPos(h, Some(HWND_BOTTOM), 0, 0, 0, 0, QUIETO);
        }
    }

    // Debajo de la ventana que está justo encima del widget = pegada a él.
    pub fn encima(vista: HWND, widget: HWND) {
        unsafe {
            let anterior = GetWindow(widget, GW_HWNDPREV).ok().filter(|h| !h.0.is_null()).unwrap_or(HWND_BOTTOM);
            let _ = SetWindowPos(vista, Some(anterior), 0, 0, 0, 0, QUIETO);
        }
    }

    // Fuera de Alt+Tab y de la vista de tareas (Win+Tab), como type: 'toolbar' en
    // Electron. Tauri reescribe el estilo extendido cada vez que la ventana se
    // muestra o deja pasar el ratón, así que se fuerza en cada cambio.
    unsafe extern "system" fn sin_alt_tab_proc(h: HWND, msg: u32, w: windows::Win32::Foundation::WPARAM, l: windows::Win32::Foundation::LPARAM, _: usize, _: usize) -> windows::Win32::Foundation::LRESULT {
        if msg == WM_STYLECHANGING && w.0 as i32 == GWL_EXSTYLE.0 {
            let s = &mut *(l.0 as *mut STYLESTRUCT);
            s.styleNew = (s.styleNew | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
        }
        windows::Win32::UI::Shell::DefSubclassProc(h, msg, w, l)
    }

    pub fn sin_alt_tab(h: HWND) {
        unsafe {
            let _ = windows::Win32::UI::Shell::SetWindowSubclass(h, Some(sin_alt_tab_proc), 1, 0);
            SetWindowLongPtrW(h, GWL_EXSTYLE, GetWindowLongPtrW(h, GWL_EXSTYLE));
            let _ = SetWindowPos(h, None, 0, 0, 0, 0, SET_WINDOW_POS_FLAGS(QUIETO.0 | SWP_NOZORDER.0 | SWP_FRAMECHANGED.0));
        }
    }

    pub fn alto_contraste() -> bool {
        use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
        let mut hc = HIGHCONTRASTW { cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32, ..Default::default() };
        unsafe { SystemParametersInfoW(SPI_GETHIGHCONTRAST, hc.cbSize, Some(&mut hc as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok() && hc.dwFlags.0 & HCF_HIGHCONTRASTON.0 != 0 }
    }
}

pub fn al_fondo() {
    #[cfg(windows)]
    if let Some(h) = ventana(WIDGET).and_then(|w| w.hwnd().ok()) {
        nativo::al_fondo(h);
    }
    encima_del_widget();
}

pub fn encima_del_widget() {
    #[cfg(windows)]
    if let (Some(v), Some(w)) = (ventana(VISTA).and_then(|v| v.hwnd().ok()), ventana(WIDGET).and_then(|w| w.hwnd().ok())) {
        nativo::encima(v, w);
    }
}

// La subclase tiene que ponerla el hilo dueño de la ventana.
fn sin_alt_tab(w: &WebviewWindow) {
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        let h = h.0 as isize;
        let _ = w.run_on_main_thread(move || nativo::sin_alt_tab(windows::Win32::Foundation::HWND(h as *mut _)));
    }
    #[cfg(not(windows))]
    let _ = w;
}

pub fn alto_contraste() -> bool {
    #[cfg(windows)]
    return nativo::alto_contraste();
    #[cfg(not(windows))]
    false
}

// ---- Geometría (todo en píxeles físicos) ----

#[derive(Clone, Copy, Debug, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn de(w: &WebviewWindow) -> Rect {
        let (p, s) = (w.outer_position().unwrap_or_default(), w.outer_size().unwrap_or_default());
        Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 }
    }

    pub fn contiene(&self, x: f64, y: f64, holgura: f64) -> bool {
        x >= self.x - holgura && x <= self.x + self.w + holgura && y >= self.y - holgura && y <= self.y + self.h + holgura
    }
}

// Área de trabajo del monitor donde está la ventana, y su escala.
pub fn area(w: &WebviewWindow) -> (Rect, f64) {
    let m = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
    match m {
        Some(m) => {
            let a = m.work_area();
            (Rect { x: a.position.x as f64, y: a.position.y as f64, w: a.size.width as f64, h: a.size.height as f64 }, m.scale_factor())
        }
        None => (Rect { x: 0.0, y: 0.0, w: 1280.0, h: 800.0 }, 1.0),
    }
}

pub fn monitor_entero(w: &WebviewWindow) -> Option<Rect> {
    let m = w.current_monitor().ok().flatten()?;
    Some(Rect { x: m.position().x as f64, y: m.position().y as f64, w: m.size().width as f64, h: m.size().height as f64 })
}

pub fn poner(w: &WebviewWindow, r: Rect) {
    let _ = w.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32));
    let _ = w.set_size(PhysicalSize::new(r.w.round() as u32, r.h.round() as u32));
}

// ---- El widget ----

pub const ANCHO: f64 = 280.0;
pub const ANCHO_MIN: f64 = 220.0;
pub const ANCHO_MAX: f64 = 480.0;

pub fn crear_widget(zoom: f64) -> tauri::Result<WebviewWindow> {
    // Se guardan la posición y el ancho (px lógicos); la altura la decide la lista.
    let guardada = datos::leer(&datos::ruta("posicion.json"));
    let monitores = app().available_monitors().unwrap_or_default();
    let visible = guardada.as_ref().is_some_and(|g| {
        let (x, y) = (g["x"].as_f64().unwrap_or(-1e9), g["y"].as_f64().unwrap_or(-1e9));
        monitores.iter().any(|m| {
            let (a, f) = (m.work_area(), m.scale_factor());
            let (ax, ay, aw, ah) = (a.position.x as f64 / f, a.position.y as f64 / f, a.size.width as f64 / f, a.size.height as f64 / f);
            x >= ax - 50.0 && y >= ay - 50.0 && x < ax + aw && y < ay + ah
        })
    });
    // Un ancho guardado fuera de rango vuelve al normal.
    let ancho = guardada.as_ref().and_then(|g| g["width"].as_f64()).filter(|w| visible && (ANCHO_MIN..=ANCHO_MAX).contains(w)).unwrap_or(ANCHO);
    app::con(|r| r.ancho_widget = ancho);
    let (x, y) = match (visible, guardada) {
        (true, Some(g)) => (g["x"].as_f64().unwrap(), g["y"].as_f64().unwrap()),
        _ => {
            let p = app().primary_monitor().ok().flatten();
            let (a, f) = p.map(|m| (*m.work_area(), m.scale_factor())).unwrap_or((tauri::PhysicalRect { position: PhysicalPosition::new(0, 0), size: PhysicalSize::new(1280, 800) }, 1.0));
            ((a.position.x as f64 + a.size.width as f64) / f - ancho - 16.0, a.position.y as f64 / f + 16.0)
        }
    };
    let w = local(WIDGET, "index.html")
        .title("Insti Today")
        .position(x, y)
        .inner_size(ancho, 80.0)
        .min_inner_size(ANCHO_MIN, 40.0)
        .max_inner_size(ANCHO_MAX, 10_000.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .maximizable(false)
        .minimizable(false)
        // Sin activarse al clic: el sistema no la sube por encima de nada.
        .focusable(false)
        .focused(false)
        .always_on_bottom(true)
        .visible(false)
        .build()?;
    sin_alt_tab(&w);
    let _ = w.set_zoom(zoom);
    Ok(w)
}

// ---- La vista previa ----

pub const ANCHO_VISTA: f64 = 360.0;
pub const MARGEN_VISTA: f64 = 14.0; // aire transparente alrededor para la sombra

pub fn crear_vista(zoom: f64) -> tauri::Result<WebviewWindow> {
    let w = local(VISTA, "vista-previa.html")
        .title("Insti Today · vista previa")
        .inner_size(ANCHO_VISTA + 2.0 * MARGEN_VISTA, 600.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .focused(false)
        .visible(false)
        .build()?;
    sin_alt_tab(&w);
    let _ = w.set_zoom(zoom);
    // Lo transparente deja pasar el ratón; la tarjeta lo atrapa cuando el puntero está encima.
    let _ = w.set_ignore_cursor_events(true);
    Ok(w)
}

// Columna al costado del widget, de todo el alto del área de trabajo. Sólo se
// mueve si de verdad cambió.
pub fn colocar_vista(zoom: f64) -> Option<Rect> {
    let (v, w) = (ventana(VISTA)?, ventana(WIDGET)?);
    let b = Rect::de(&w);
    let (a, f) = area(&w);
    let z = zoom * f;
    let ancho = ((ANCHO_VISTA + 2.0 * MARGEN_VISTA) * z).round();
    let margen = (MARGEN_VISTA * z).round();
    // A la izquierda del widget si cabe; si no, a la derecha.
    let mut x = b.x - ancho + margen - 6.0 * f;
    if x + margen < a.x {
        x = b.x + b.w + 6.0 * f - margen;
    }
    let deseado = Rect { x: x.round(), y: a.y, w: ancho, h: a.h };
    let actual = Rect::de(&v);
    if (actual.x - deseado.x).abs() > 1.0 || (actual.y - deseado.y).abs() > 1.0 || (actual.w - deseado.w).abs() > 1.0 || (actual.h - deseado.h).abs() > 1.0 {
        poner(&v, deseado);
    }
    Some(deseado)
}

// ---- Insti Today completo ----

pub fn crear_app(seccion: &str, tarea: Option<&str>, guia: bool) -> tauri::Result<WebviewWindow> {
    let mut pagina = format!("app.html?seccion={}", url::form_urlencoded::byte_serialize(seccion.as_bytes()).collect::<String>());
    if let Some(t) = tarea {
        pagina += &format!("&tarea={}", url::form_urlencoded::byte_serialize(t.as_bytes()).collect::<String>());
    }
    if guia {
        pagina += "&guia=1";
    }
    let (ancho, alto) = ventana(WIDGET)
        .map(|w| {
            let (a, f) = area(&w);
            ((a.w / f - 80.0).min(1040.0), (a.h / f - 60.0).min(720.0))
        })
        .unwrap_or((1040.0, 720.0));
    // Transparente siempre: el vidrio líquido se enciende y apaga sin reabrirla (material_app).
    let w = local(APP, &pagina).title("Insti Today").inner_size(ancho, alto).min_inner_size(760.0, 520.0).center().transparent(true).build()?;
    material_app(&w);
    Ok(w)
}

// Vidrio líquido en la ventana de Insti Today (Windows): el acrílico del sistema
// desenfoca lo que hay detrás y la página lo deja ver (data-liquido en app.html).
// Oscuro a la fuerza: el tema Vidrio es oscuro y el acrílico sigue al sistema.
pub fn material_app(w: &WebviewWindow) {
    let p = app::con(|r| r.estado["prefs"].clone());
    let liquida = cfg!(windows) && p["experimental"] == true && p["tema"] == "vidrio" && p["vidrioLiquido"] == true;
    if liquida {
        use tauri::window::{Effect, EffectsBuilder};
        let _ = w.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
        let _ = w.set_theme(Some(tauri::Theme::Dark));
    } else {
        let _ = w.set_effects(None);
        let _ = w.set_theme(None);
    }
}

pub fn crear_acceso() -> tauri::Result<WebviewWindow> {
    local(ACCESO, "acceso.html").title("Iniciar sesión · Insti Today").inner_size(420.0, 560.0).resizable(false).maximizable(false).minimizable(false).center().build()
}

pub fn crear_privacidad() -> tauri::Result<WebviewWindow> {
    if let Some(w) = ventana("privacidad") {
        let _ = w.set_focus();
        return Ok(w);
    }
    local("privacidad", "privacidad.html").title("Aviso de privacidad · Insti Today").inner_size(640.0, 720.0).center().build()
}

// Ventanita siempre encima con los archivos de la entrega, para soltarlos en
// Moodle si no se pusieron solos.
pub fn crear_arrastre(n: usize) -> tauri::Result<WebviewWindow> {
    if let Some(w) = ventana(ARRASTRE) {
        let _ = w.destroy();
    }
    let (ancho, alto) = (300.0, (100.0 + (n + if n > 1 { 1 } else { 0 }) as f64 * 48.0).min(420.0));
    let (x, y) = ventana(WIDGET)
        .map(|w| {
            let (a, f) = area(&w);
            ((a.x + a.w) / f - ancho - 18.0, (a.y + a.h) / f - alto - 18.0)
        })
        .unwrap_or((40.0, 40.0));
    local(ARRASTRE, "arrastrar.html?destino=Moodle")
        .title("Tu entrega")
        .position(x, y)
        .inner_size(ancho, alto)
        .decorations(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .inspect(sin_alt_tab)
}

// El clic viene del widget, que no toma el foco; sin esto Windows puede dejar
// la ventana nueva escondida detrás de lo que estés usando.
pub fn al_frente(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();
    let w = w.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let _ = w.set_always_on_top(false);
    });
}

// ---- El navegador de Moodle ----
//
// Las páginas de Moodle (una tarea, la entrega) se abren en el navegador de
// la app, con la sesión de la cuenta activa: cada cuenta tiene su carpeta de
// WebView2. No tiene acceso al puente: es una página de internet.

static PARTICION_ABIERTA: Mutex<Option<String>> = Mutex::new(None);

fn constructor_moodle(etiqueta: &str, url: url::Url) -> WebviewWindowBuilder<'static, tauri::Wry, tauri::AppHandle> {
    let particion = datos::particion();
    let origen = url.origin();
    WebviewWindowBuilder::new(app(), etiqueta, WebviewUrl::External(url))
        .data_directory(datos::dir_navegador(&particion))
        .on_new_window(move |nueva, _| {
            if nueva.origin() == origen {
                return tauri::webview::NewWindowResponse::Allow;
            }
            abrir_navegador(nueva.as_str());
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, evento| {
            match evento {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let carpeta = descargas().join("Insti Today");
                    let _ = std::fs::create_dir_all(&carpeta);
                    let nombre = destination.file_name().map(|n| n.to_string_lossy().into_owned()).or_else(|| url.path_segments()?.next_back().map(String::from)).unwrap_or("archivo".into());
                    *destination = moodle::ruta_libre(&carpeta, &moodle::nombre_seguro(&nombre));
                }
                tauri::webview::DownloadEvent::Finished { path: Some(p), success: true, .. } => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app().opener().open_path(p.to_string_lossy(), None::<&str>);
                }
                _ => {}
            }
            true
        })
}

pub fn descargas() -> std::path::PathBuf {
    app().path().download_dir().unwrap_or_else(|_| datos::inicio().join("Downloads"))
}

pub fn abrir_navegador(url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = app().opener().open_url(url, None::<&str>);
    }
}

// La ventana de Moodle abierta es de otra cuenta: se cierra.
pub fn cerrar_navegador_ajeno() {
    let abierta = PARTICION_ABIERTA.lock().unwrap().clone();
    if let Some(w) = ventana(MOODLE) {
        if abierta.as_deref() != Some(datos::particion().as_str()) {
            let _ = w.destroy();
        }
    }
}

// ¿El navegador de la app tiene sesión abierta en Moodle?
fn con_sesion(w: &WebviewWindow) -> bool {
    url::Url::parse(&moodle::escuela()).ok().and_then(|u| w.cookies_for_url(u).ok()).is_some_and(|c| c.iter().any(|c| c.name().starts_with("MoodleSession")))
}

// Abre una página de Moodle en el navegador de la app (las de fuera, en el
// navegador normal). Si no hay sesión, se intenta el inicio automático.
pub async fn abrir_en_moodle(url: &str) -> Option<WebviewWindow> {
    let destino = url::Url::parse(url).ok()?;
    let base = url::Url::parse(&moodle::escuela()).ok()?;
    if destino.origin() != base.origin() {
        abrir_navegador(destino.as_str());
        return None;
    }
    cerrar_navegador_ajeno();
    let w = match ventana(MOODLE) {
        Some(w) => w,
        None => {
            let w = constructor_moodle(MOODLE, base.clone()).title("Moodle · Insti Today").inner_size(1180.0, 860.0).build().ok()?;
            *PARTICION_ABIERTA.lock().unwrap() = Some(datos::particion());
            w
        }
    };
    al_frente(&w);
    let mut cargar = destino.to_string();
    if !con_sesion(&w) {
        cargar = moodle::url_autologin(destino.as_str()).await.unwrap_or(cargar);
    }
    let _ = w.navigate(url::Url::parse(&cargar).ok()?);
    Some(w)
}

pub async fn abrir_externo(url: &str) {
    abrir_en_moodle(url).await;
}

// Ejecuta un script en una ventana y devuelve su resultado.
pub async fn ejecutar(w: &WebviewWindow, js: &str) -> Option<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(js, move |r| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(r);
        }
    })
    .ok()?;
    let r = tokio::time::timeout(Duration::from_secs(10), rx).await.ok()?.ok()?;
    serde_json::from_str(&r).ok()
}

// Inicia sesión en el navegador de la app con el formulario normal de Moodle,
// en una ventana invisible. No es grave si falla: al abrir una página,
// Moodle la pedirá.
pub async fn entrar_en_navegador(usuario: String, contrasena: String) {
    let Ok(login) = url::Url::parse(&format!("{}/login/index.php", moodle::escuela())) else { return };
    let Ok(w) = constructor_moodle("moodle-entrar", login).visible(false).build() else { return };
    tokio::time::sleep(Duration::from_secs(3)).await;
    let script = format!(
        "(() => {{ const f = document.querySelector('form#login, form[action*=\"login/index.php\"]'); const u = f && f.querySelector('input[name=username]'); const p = f && f.querySelector('input[name=password]'); if (!u || !p) return false; u.value = {}; p.value = {}; f.submit(); return true; }})()",
        json!(usuario),
        json!(contrasena)
    );
    let mut enviado = false;
    for _ in 0..10 {
        if ejecutar(&w, &script).await == Some(json!(true)) {
            enviado = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if enviado {
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(800)).await;
            if w.url().is_ok_and(|u| !u.path().ends_with("/login/index.php")) {
                break;
            }
        }
    }
    let _ = w.destroy();
}

// Vacía el navegador de una cuenta (sus cookies de Moodle).
pub fn borrar_navegador(particion: &str) {
    if PARTICION_ABIERTA.lock().unwrap().as_deref() == Some(particion) {
        if let Some(w) = ventana(MOODLE) {
            let _ = w.clear_all_browsing_data();
            let _ = w.destroy();
        }
    }
    let dir = datos::dir_navegador(particion);
    // WebView2 suelta sus archivos un momento después de cerrar la ventana.
    tauri::async_runtime::spawn(async move {
        for _ in 0..10 {
            if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

// ---- Soltar archivos en Moodle (Chrome DevTools Protocol de WebView2) ----

#[cfg(windows)]
pub async fn cdp(w: &WebviewWindow, metodo: &str, parametros: Value) -> Result<(), String> {
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2};
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let (metodo, parametros) = (metodo.to_string(), parametros.to_string());
    w.with_webview(move |pw| unsafe {
        let enviar = |r| {
            let _ = tx.send(r);
        };
        let core: ICoreWebView2 = match pw.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => return enviar(Err(e.to_string())),
        };
        let tx = Mutex::new(Some(enviar));
        let manejador = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |r, _json| {
            if let Some(f) = tx.lock().unwrap().take() {
                f(r.map_err(|e| e.to_string()));
            }
            Ok(())
        }));
        let _ = core.CallDevToolsProtocolMethod(&windows::core::HSTRING::from(metodo), &windows::core::HSTRING::from(parametros), &manejador);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), rx).await.map_err(|_| "Moodle no respondió".to_string())?.map_err(|_| "Moodle no respondió".to_string())?
}

#[cfg(not(windows))]
pub async fn cdp(_: &WebviewWindow, _: &str, _: Value) -> Result<(), String> {
    Err("Soltar archivos sólo funciona en Windows por ahora.".into())
}
