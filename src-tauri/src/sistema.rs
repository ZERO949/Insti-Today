// Lo que toca el sistema: la bandeja, los avisos de Windows, los diálogos,
// abrir con Windows y las actualizaciones desde los releases de GitHub.

use crate::{app, app_logica as l, datos, ventanas};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub const PAGINA: &str = "https://plataforma.uii.edu.mx/moodle";

// ---- Avisos ----

pub type AlClic = Box<dyn Fn() + Send + Sync + 'static>;

pub fn avisar(titulo: &str, cuerpo: &str, al_clic: Option<AlClic>) {
    if std::env::var_os("BB_CAPTURA_SIN_RED").is_some() {
        return;
    }
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        // El instalador registra el id de la app; la versión de desarrollo usa el de PowerShell.
        let id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app().config().identifier.clone() };
        let mut t = Toast::new(&id).title(titulo).text1(cuerpo);
        if let Some(f) = al_clic {
            t = t.on_activated(move |_| {
                f();
                Ok(())
            });
        }
        if let Err(e) = t.show() {
            datos::registrar("aviso", e);
        }
    }
    #[cfg(not(windows))]
    let _ = (titulo, cuerpo, al_clic);
}

// ---- Diálogos ----

// Sí/no, sin bloquear la ventana. El widget está anclado al escritorio: un
// diálogo con él de padre quedaría escondido.
pub async fn confirmar(padre: Option<WebviewWindow>, titulo: &str, mensaje: &str, detalle: &str, si: &str, aviso: bool) -> bool {
    let (titulo, texto, si) = (titulo.to_string(), format!("{mensaje}\n\n{detalle}"), si.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app().dialog().message(texto).title(titulo).kind(if aviso { MessageDialogKind::Warning } else { MessageDialogKind::Info }).buttons(MessageDialogButtons::OkCancelCustom(si, "Cancelar".into()));
        if let Some(p) = padre.filter(|p| p.label() != ventanas::WIDGET) {
            d = d.parent(&p);
        }
        d.blocking_show()
    })
    .await
    .unwrap_or(false)
}

// ---- Abrir con el sistema ----

pub fn abre_al_iniciar() -> bool {
    app().autolaunch().is_enabled().unwrap_or(false)
}

pub fn abrir_al_iniciar(activo: bool) {
    let a = app().autolaunch();
    let r = if activo { a.enable() } else { a.disable() };
    if let Err(e) = r {
        datos::registrar("abrir al iniciar", e);
    }
}

// ---- La bandeja ----

fn menu() -> tauri::Result<Menu<tauri::Wry>> {
    let a = app();
    let m = Menu::new(a)?;
    m.append(&MenuItem::with_id(a, "abrir", "Abrir Insti Today", true, None::<&str>)?)?;
    m.append(&MenuItem::with_id(a, "widget", "Mostrar el widget", true, None::<&str>)?)?;
    m.append(&MenuItem::with_id(a, "actualizar", "Actualizar ahora", true, None::<&str>)?)?;
    m.append(&MenuItem::with_id(a, "ajustes", "Ajustes…", true, None::<&str>)?)?;
    m.append(&PredefinedMenuItem::separator(a)?)?;
    let cuenta = l::cuenta();
    if cuenta.is_some() {
        let lista = l::lista_cuentas();
        if lista.len() >= 2 {
            let sub = Submenu::new(a, "Cambiar de cuenta", true)?;
            for c in &lista {
                sub.append(&CheckMenuItem::with_id(a, format!("cuenta:{}", c["id"].as_str().unwrap_or("")), format!("{} ({})", c["nombre"].as_str().unwrap_or(""), c["usuario"].as_str().unwrap_or("")), true, c["activa"] == true, None::<&str>)?)?;
            }
            m.append(&sub)?;
        }
        m.append(&MenuItem::with_id(a, "otra", "Añadir otra cuenta…", true, None::<&str>)?)?;
    }
    match &cuenta {
        Some(c) => m.append(&MenuItem::with_id(a, "salir-cuenta", format!("Cerrar sesión ({c})"), true, None::<&str>)?)?,
        None => m.append(&MenuItem::with_id(a, "entrar", "Iniciar sesión en Moodle", true, None::<&str>)?)?,
    }
    m.append(&PredefinedMenuItem::separator(a)?)?;
    let etiqueta = if cfg!(windows) { "Abrir al iniciar Windows" } else { "Abrir al iniciar sesión" };
    m.append(&CheckMenuItem::with_id(a, "inicio", etiqueta, true, abre_al_iniciar(), None::<&str>)?)?;
    m.append(&PredefinedMenuItem::separator(a)?)?;
    m.append(&MenuItem::with_id(a, "salir", "Salir", true, None::<&str>)?)?;
    Ok(m)
}

pub fn crear_bandeja() -> tauri::Result<()> {
    let icono = app().default_window_icon().cloned().unwrap();
    TrayIconBuilder::with_id("bandeja")
        .icon(icono)
        .tooltip("Insti Today · pendientes de Moodle")
        .menu(&menu()?)
        .show_menu_on_left_click(false)
        .on_menu_event(|_, e| {
            let id = e.id().as_ref().to_string();
            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "abrir" => l::abrir_app("pendientes", None, false),
                    "widget" => l::mostrar_widget(),
                    "actualizar" => l::actualizar().await,
                    "ajustes" => l::abrir_app("ajustes", None, false),
                    "otra" => {
                        l::agregar_cuenta().await;
                    }
                    "salir-cuenta" => l::salir_de_cuenta().await,
                    "entrar" => l::entrar().await,
                    "inicio" => {
                        abrir_al_iniciar(!abre_al_iniciar());
                        renovar_bandeja();
                    }
                    "salir" => {
                        app::con(|r| r.salir = true);
                        app().exit(0);
                    }
                    c if c.starts_with("cuenta:") => {
                        l::cambiar_de_cuenta(&c[7..]).await;
                    }
                    _ => {}
                }
            });
        })
        // Un clic en el icono abre Insti Today completo.
        .on_tray_icon_event(|_, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                tauri::async_runtime::spawn(async { l::abrir_app("pendientes", None, false) });
            }
        })
        .build(app())?;
    Ok(())
}

pub fn renovar_bandeja() {
    if let (Some(t), Ok(m)) = (app().tray_by_id("bandeja"), menu()) {
        let _ = t.set_menu(Some(m));
    }
}

// ---- Actualizaciones ----
//
// La app lee los releases del repositorio público ZERO949/Insti-Today
// (latest.json, firmado). Al haber versión nueva pregunta; si se acepta,
// descarga, el instalador reemplaza la versión anterior y se reabre.

static PENDIENTE: Mutex<Option<tauri_plugin_updater::Update>> = Mutex::new(None);

pub fn estado_actualizacion() -> Value {
    app::con(|r| r.actualizacion.clone())
}

fn cambiar(cambios: Value) {
    let a = app::con(|r| {
        for (k, v) in cambios.as_object().unwrap() {
            r.actualizacion[k] = v.clone();
        }
        r.actualizacion.clone()
    });
    l::publicar(json!({ "actualizacion": a }));
}

pub fn iniciar_actualizaciones() {
    if cfg!(debug_assertions) || std::env::var_os("BB_CAPTURA_SIN_RED").is_some() {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            buscar().await;
            tokio::time::sleep(std::time::Duration::from_secs(4 * 3600)).await;
        }
    });
}

pub async fn buscar() {
    use tauri_plugin_updater::UpdaterExt;
    let e = estado_actualizacion()["estado"].as_str().unwrap_or("").to_string();
    if cfg!(debug_assertions) || ["descargando", "lista", "buscando"].contains(&e.as_str()) {
        return;
    }
    cambiar(json!({ "estado": "buscando" }));
    let r = match app().updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    match r {
        Ok(Some(u)) => {
            let version = u.version.clone();
            *PENDIENTE.lock().unwrap() = Some(u);
            cambiar(json!({ "estado": "disponible", "version": version, "porcentaje": 0 }));
            preguntar(&version).await;
        }
        Ok(None) => cambiar(json!({ "estado": "al-dia", "version": null, "porcentaje": 0, "revisado": datos::ahora_iso() })),
        Err(e) => {
            datos::registrar("actualización", &e);
            let hay = PENDIENTE.lock().unwrap().is_some();
            cambiar(json!({ "estado": if hay { "disponible" } else { "error" }, "porcentaje": 0 }));
        }
    }
}

// Se pregunta una vez por versión cada vez que se abre la app; con «Más
// tarde» queda el botón en Cuenta → Actualizaciones.
async fn preguntar(version: &str) {
    if !app::con(|r| r.preguntadas.insert(version.to_string())) {
        return;
    }
    let actual = app().package_info().version.to_string();
    let detalle = format!("Tienes la {actual}. Al descargarla, Insti Today se cierra un momento, reemplaza la versión anterior y vuelve a abrirse. Tu sesión y tus ajustes se conservan.");
    if confirmar(None, "Insti Today", &format!("Hay una versión nueva de Insti Today ({version})"), &detalle, "Descargar e instalar", false).await {
        descargar().await;
    }
}

pub async fn descargar() {
    let Some(u) = PENDIENTE.lock().unwrap().take() else { return };
    avisar("Descargando la versión nueva", "Insti Today se reiniciará sola al terminar.", None);
    cambiar(json!({ "estado": "descargando", "porcentaje": 0 }));
    let (mut bajado, mut ultimo) = (0usize, 0i64);
    let r = u
        .download_and_install(
            |trozo, total| {
                bajado += trozo;
                let p = total.map(|t| (bajado as f64 * 100.0 / t as f64).round() as i64).unwrap_or(0);
                if p != ultimo {
                    ultimo = p;
                    cambiar(json!({ "porcentaje": p }));
                }
            },
            || cambiar(json!({ "estado": "lista", "porcentaje": 100 })),
        )
        .await;
    match r {
        Ok(()) => {
            app::con(|r| r.salir = true);
            app().restart();
        }
        Err(e) => {
            datos::registrar("actualización", &e);
            *PENDIENTE.lock().unwrap() = Some(u);
            cambiar(json!({ "estado": "disponible", "porcentaje": 0 }));
        }
    }
}
