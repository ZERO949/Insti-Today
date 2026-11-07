// Insti Today: tus pendientes de Moodle en el escritorio.
//
// Una ventana sin marco anclada al escritorio, fuera de la barra de tareas,
// con un icono en la bandeja. La primera vez sólo pide iniciar sesión; desde
// ahí arranca con el sistema y consulta Moodle cada hora.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agenda;
mod app;
mod app_logica;
mod datos;
mod entrega;
mod moodle;
mod sistema;
mod ventanas;

use serde_json::json;
use std::{collections::HashSet, sync::OnceLock};
use tauri::{AppHandle, RunEvent};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn app() -> &'static AppHandle {
    APP.get().expect("la app ya arrancó")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| app_logica::mostrar_widget()))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![app_logica::llamar])
        .setup(|a| {
            let _ = APP.set(a.handle().clone());
            arrancar();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo abrir Insti Today")
        .run(|_, e| {
            // Sin ventanas la app sigue en la bandeja; para salir está «Salir».
            if let RunEvent::ExitRequested { api, code: None, .. } = e {
                if !app::con(|r| r.salir) {
                    api.prevent_exit();
                }
            }
        });
}

// WebView2 puede estar ocupado un momento (otra copia que se está cerrando): se
// reintenta y, si no hay manera, se dice en vez de quedarse sin ventana.
async fn abrir_widget() {
    let zoom = app_logica::prefs()["tamano"].as_f64().unwrap_or(1.0);
    let mut intento = 0;
    let w = loop {
        match ventanas::crear_widget(zoom) {
            Ok(w) => break w,
            Err(e) if intento < 10 => {
                datos::registrar("widget", e);
                intento += 1;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => {
                datos::registrar("widget", &e);
                use tauri_plugin_dialog::DialogExt;
                app().dialog().message(format!("No se pudo abrir el widget ({e}). Cierra Insti Today desde la bandeja (o reinicia la computadora) y vuelve a abrirlo.")).title("Insti Today").blocking_show();
                app().exit(1);
                return;
            }
        }
    };
    w.on_window_event(app_logica::evento_widget);
    // Se muestra cuando la página ya pintó, sin parpadeo blanco.
    for _ in 0..50 {
        if ventanas::ejecutar(&w, "document.readyState").await == Some(json!("complete")) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    app_logica::mostrar_widget();
    app_logica::publicar(json!({}));
}

fn arrancar() {
    // Hasta la 0.3.4 Moodle tenía una carpeta de WebView2 por cuenta; ya usa la de la app.
    std::thread::spawn(|| std::fs::remove_dir_all(datos::ruta("navegador")));
    // Lo último que se vio, al instante, mientras llega lo nuevo.
    let leer_lista = |n: &str| datos::leer(&datos::ruta(n)).and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|x| x.as_str().map(String::from)).collect::<HashSet<_>>();
    app::con(|r| {
        r.vistos = leer_lista("mensajes-vistos.json");
        r.avisados = leer_lista("avisados.json");
        r.entregas = datos::leer(&datos::ruta("entregas.json")).unwrap_or(json!({}));
        r.estado["prefs"] = datos::prefs();
        r.estado["descartadas"] = json!(datos::descartadas());
        r.estado["pospuestas"] = json!(datos::pospuestas());
        r.estado["actualizacion"] = r.actualizacion.clone();
        r.estado["escuela"] = json!(moodle::escuela());
    });
    if app_logica::cuenta().is_some() {
        let mensajes = datos::leer(&datos::ruta("mensajes.json")).unwrap_or(json!([]));
        let agenda = datos::leer(&datos::ruta("agenda.json")).unwrap_or_default();
        app::con(|r| {
            r.estado["datos"] = agenda;
            r.estado["sesion"] = json!("lista");
        });
        app_logica::publicar(json!({ "mensajes": app_logica::con_visto(&mensajes) }));
    }

    // Sólo la versión instalada se registra para abrirse con el sistema, una vez;
    // después manda lo que la persona marque en la bandeja.
    let marca = datos::ruta("inicio-instalado");
    if !cfg!(debug_assertions) && !app_logica::sin_red() && !marca.exists() {
        sistema::abrir_al_iniciar(true);
        let _ = std::fs::create_dir_all(datos::dir());
        let _ = std::fs::write(&marca, datos::ahora_iso());
    }

    tauri::async_runtime::spawn(abrir_widget());
    if let Err(e) = sistema::crear_bandeja() {
        datos::registrar("bandeja", e);
    }
    sistema::iniciar_actualizaciones();
    app_logica::iniciar_relojes();
    tauri::async_runtime::spawn(app_logica::actualizar());
    // La primera vez: la guía corta.
    if app_logica::prefs()["tutorialVisto"] != true {
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            app_logica::abrir_app("pendientes", None, true);
        });
    }
}
