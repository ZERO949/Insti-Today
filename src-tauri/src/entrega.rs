// Tus archivos de cada tarea y la entrega en Moodle.
//
// Los archivos que subes viven en Documentos/Insti Today/<materia>/<tarea>/tuyos.
// Los que adjuntas forman la entrega, junto con un texto opcional.
//
// «Entregar» abre la página oficial de la entrega en Moodle con la sesión de
// la app y suelta tus archivos en su selector, como si los arrastraras. El
// clic final («Guardar cambios») es de la persona: la API pública no deja a
// un estudiante subir archivos a un intento.

use crate::{
    app::con,
    app_logica::{buscar_tarea, publicar},
    datos, moodle, sistema,
    ventanas::{self as v, emitir, ventana, ARRASTRE},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

// Sin acentos ni símbolos, como las carpetas que ya existen.
fn nombre_ascii(t: &str) -> String {
    let sin: String = moodle::nombre_seguro(t)
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'A',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'É' | 'È' | 'Ë' | 'Ê' => 'E',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'Í' | 'Ì' | 'Ï' | 'Î' => 'I',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'O',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'Ú' | 'Ù' | 'Ü' | 'Û' => 'U',
            'ñ' => 'n',
            'Ñ' => 'N',
            'ç' => 'c',
            'Ç' => 'C',
            c if (' '..='~').contains(&c) => c,
            _ => '-',
        })
        .collect();
    let mut t = String::new();
    for c in sin.chars() {
        if !(c == '-' && t.ends_with('-')) {
            t.push(c);
        }
    }
    let t = t.trim().to_string();
    if t.is_empty() { "tarea".into() } else { t }
}

fn carpeta(tarea_id: &str) -> Option<PathBuf> {
    let (curso, tarea) = buscar_tarea(tarea_id)?;
    let base = std::env::var_os("BB_CARPETA_TAREAS").map(PathBuf::from).unwrap_or_else(|| crate::app().path().document_dir().unwrap_or_else(|_| datos::inicio().join("Documents")).join("Insti Today"));
    Some(base.join(nombre_ascii(s(&curso["nombre"]))).join(nombre_ascii(s(&tarea["titulo"]))))
}

fn guardar() {
    let e = con(|r| r.entregas.clone());
    datos::escribir(&datos::ruta("entregas.json"), &e);
}

fn entregables(tarea_id: &str) -> Vec<Value> {
    let Some(c) = carpeta(tarea_id) else { return vec![] };
    let mut nombres: Vec<PathBuf> = std::fs::read_dir(c.join("tuyos")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    nombres.sort();
    nombres
        .into_iter()
        .map(|ruta| {
            let m = std::fs::metadata(&ruta).ok();
            let imagen = ruta.extension().and_then(|e| e.to_str()).is_some_and(|e| ["png", "jpg", "jpeg", "webp", "gif"].contains(&e.to_lowercase().as_str()));
            let marca = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            let r = ruta.to_string_lossy().to_string();
            json!({
                "ruta": r, "origen": "Tuyo", "nombre": ruta.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                "imagen": imagen, "revisable": false, "url": if imagen { json!(format!("{}?v={marca}", v::url_local(&ruta))) } else { Value::Null },
                "peso": m.map(|m| m.len()).unwrap_or(0), "adjuntado": true,
            })
        })
        .collect()
}

fn datos_entrega(tarea_id: &str) -> Value {
    let e = con(|r| r.entregas[tarea_id].clone());
    json!({ "entregables": entregables(tarea_id), "texto": e["texto"].as_str().unwrap_or(""), "respuesta": null, "abierta": e["abierta"], "estado": e["estado"] })
}

// Sólo se tocan rutas que son archivos de esa tarea.
fn es_entregable(tarea_id: &str, ruta: &str) -> bool {
    entregables(tarea_id).iter().any(|x| s(&x["ruta"]) == ruta)
}

fn subir(tarea_id: &str, rutas: Vec<String>) {
    let Some(c) = carpeta(tarea_id) else { return };
    let tuyos = c.join("tuyos");
    let _ = std::fs::create_dir_all(&tuyos);
    for origen in rutas.iter().map(Path::new).filter(|p| p.is_file()) {
        let raiz = moodle::nombre_seguro(&origen.file_stem().map(|x| x.to_string_lossy()).unwrap_or_default());
        let raiz = if raiz.is_empty() { "archivo".to_string() } else { raiz };
        let ext = origen.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let destino = moodle::ruta_libre(&tuyos, &format!("{raiz}{ext}"));
        let _ = std::fs::copy(origen, &destino);
    }
}

// Estado de la entrega de cada tarea: abierta → preparando → colocados | manual | cancelada | error.
fn estado_entrega(tarea_id: &str, fase: &str, texto: &str) {
    con(|r| r.entregas[tarea_id]["estado"] = json!({ "fase": fase, "texto": texto, "cuando": datos::ahora_iso() }));
    guardar();
    publicar(json!({ "entregaCambio": datos::ahora_ms() }));
    if !["preparando", "colocados", "cancelada"].contains(&fase) && con(|r| r.destino_arrastre.as_ref().is_some_and(|d| d["tareaId"] == tarea_id)) {
        emitir(ARRASTRE, "arrastre:aviso", json!(texto));
    }
}

fn huella(ruta: &str) -> Option<String> {
    let datos = std::fs::read(ruta).ok()?;
    Some(Sha256::digest(&datos).iter().map(|b| format!("{b:02x}")).collect())
}

fn cancelar_colocar(tarea_id: &str) {
    if let Some(c) = con(|r| r.colocando.remove(tarea_id)) {
        c.store(true, Ordering::SeqCst);
    }
}

async fn entregar(origen: &WebviewWindow, tarea_id: &str) -> Value {
    let Some((curso, tarea)) = buscar_tarea(tarea_id) else { return json!({ "error": "No encontré esa tarea." }) };
    let enlace = s(&tarea["enlace"]).to_string();
    if !enlace.starts_with("http") {
        return json!({ "error": "Esta tarea no tiene página de entrega en Moodle." });
    }
    let pagina = tarea["enlaceEntrega"].as_str().unwrap_or(&enlace).to_string();
    let adjuntos: Vec<Value> = entregables(tarea_id).into_iter().filter(|x| x["adjuntado"] == true).collect();
    let archivos: Vec<String> = adjuntos.iter().map(|x| s(&x["ruta"]).to_string()).collect();

    // ¿Alguno de estos archivos ya se entregó con otra cuenta? Se pregunta antes de abrir Moodle.
    let activa = datos::activa();
    let ruta_entregados = datos::ruta("entregados.json");
    let mut entregados = datos::leer(&ruta_entregados).unwrap_or(json!({}));
    let huellas: Vec<String> = archivos.iter().filter_map(|r| huella(r)).collect();
    if let Some(a) = &activa {
        let repetidos: Vec<String> = huellas
            .iter()
            .zip(&adjuntos)
            .filter(|(h, _)| entregados[h.as_str()]["cuenta"].as_str().is_some_and(|c| c != s(&a["id"])))
            .map(|(h, x)| {
                let e = &entregados[h.as_str()];
                let cuando = s(&e["cuando"]).get(..10).unwrap_or("");
                format!("«{}» → {}, en «{}» ({cuando})", s(&x["nombre"]), s(&e["usuario"]), s(&e["tarea"]))
            })
            .collect();
        if !repetidos.is_empty() {
            let mensaje = if repetidos.len() == 1 { "Este archivo ya lo entregaste con otra cuenta" } else { "Estos archivos ya los entregaste con otra cuenta" };
            let detalle = format!("{}\n\nAhora vas a entregar con {} ({}).", repetidos.join("\n"), s(&a["nombre"]), s(&a["usuario"]));
            if !sistema::confirmar(Some(origen.clone()), "¿Seguro?", mensaje, &detalle, "Entregar de todos modos", true).await {
                return json!({ "error": "Entrega cancelada: no se abrió Moodle." });
            }
        }
        for h in &huellas {
            entregados[h.as_str()] = json!({ "cuenta": a["id"], "usuario": format!("{} ({})", s(&a["nombre"]), s(&a["usuario"])), "tarea": tarea["titulo"], "cuando": datos::ahora_iso() });
        }
        if !huellas.is_empty() {
            datos::escribir(&ruta_entregados, &entregados);
        }
    }

    cancelar_colocar(tarea_id);
    let texto = con(|r| r.entregas[tarea_id]["texto"].as_str().unwrap_or("").to_string());
    if !texto.is_empty() {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let _ = crate::app().clipboard().write_text(texto.clone());
    }
    let Some(moodle_w) = v::abrir_en_moodle(&pagina).await else {
        estado_entrega(tarea_id, "error", "No se pudo abrir la página de Moodle.");
        return json!({ "error": "No se pudo abrir la página de Moodle." });
    };
    con(|r| r.entregas[tarea_id]["abierta"] = json!(datos::ahora_iso()));
    let destino = json!({ "enlace": enlace, "enlaceEntrega": tarea["enlaceEntrega"], "cursoId": curso["id"], "tareaId": tarea_id });
    if !archivos.is_empty() {
        abrir_arrastre(archivos.iter().map(PathBuf::from).collect(), destino.clone());
    }
    if !archivos.is_empty() && tarea["modulo"] == "assign" && tarea["enlaceEntrega"].is_string() {
        colocar(moodle_w, archivos.clone(), destino);
    } else if !archivos.is_empty() {
        estado_entrega(tarea_id, "manual", "Esta actividad no tiene entrega de archivos en línea. Ábrela en Moodle y sigue sus instrucciones.");
    } else {
        estado_entrega(tarea_id, "abierta", "Página de entrega abierta. No adjuntaste archivos.");
    }
    json!({ "ok": true, "archivos": archivos.len(), "texto": !texto.is_empty() })
}

fn abrir_arrastre(rutas: Vec<PathBuf>, destino: Value) {
    let n = rutas.len();
    con(|r| {
        r.archivos_arrastre = rutas;
        r.destino_arrastre = Some(destino);
    });
    if let Err(e) = v::crear_arrastre(n) {
        datos::registrar("ventana de archivos", e);
    }
}

// ---- Soltar los archivos en Moodle ----

fn url_de(direccion: &str) -> Option<url::Url> {
    url::Url::parse(direccion).ok()
}

// ¿Es la página de esta tarea en Moodle? (cualquier vista de la tarea).
fn es_pagina_de_tarea(direccion: &str, d: &Value) -> bool {
    let (Some(u), Some(e)) = (url_de(direccion), url_de(s(&d["enlace"]))) else { return false };
    u.scheme().starts_with("http") && u.origin() == e.origin() && u.path().ends_with("/mod/assign/view.php") && u.query_pairs().any(|(k, val)| k == "id" && val == s(&d["tareaId"]))
}

fn es_pagina_de_edicion(direccion: &str, d: &Value) -> bool {
    es_pagina_de_tarea(direccion, d) && url_de(direccion).is_some_and(|u| u.query_pairs().any(|(k, val)| k == "action" && val == "editsubmission"))
}

// El selector de archivos de la entrega. La página puede traer otros (ocultos o
// de otro campo): cuentan los visibles y, si aún hay varios, el de archivos de la tarea.
const ELEGIR: &str = "const visibles = [...document.querySelectorAll('.filemanager')].filter((e) => e.getClientRects().length);
  const propios = visibles.filter((e) => e.closest('#fitem_id_files_filemanager'));
  const fm = propios.length === 1 ? propios : visibles;";

fn leer_archivos() -> String {
    format!(
        "(() => {{ if (document.readyState !== 'complete') return null; {ELEGIR}
  if (fm.length !== 1) return {{ campos: fm.length, nombres: [] }};
  const nombres = [...fm[0].querySelectorAll('.fp-filename, .fp-filename-field .fp-filename')].map((e) => e.textContent.trim()).filter(Boolean);
  const cargando = [...fm[0].querySelectorAll('.dndupload-uploadinprogress, .dndupload-progressbars progress')].some((e) => e.getClientRects().length);
  return {{ campos: 1, nombres: [...new Set(nombres)], cargando }}; }})()"
    )
}

fn rectangulo() -> String {
    format!(
        "(() => {{ {ELEGIR}
  const uno = fm.length === 1 ? fm[0] : null;
  const zona = uno && (uno.querySelector('.filemanager-container') || uno.querySelector('.fp-content') || uno);
  if (!zona) return null;
  zona.scrollIntoView({{ block: 'center' }});
  const r = zona.getBoundingClientRect();
  return {{ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 60)), ancho: r.width, alto: r.height }}; }})()"
    )
}

enum Fin {
    Cancelada(&'static str),
    Manual(String),
    Colocados(&'static str),
}

async fn soltar(w: &WebviewWindow, rutas: &[String], d: &Value, cancelado: &AtomicBool) -> Option<bool> {
    let zona = v::ejecutar(w, &rectangulo()).await?;
    if zona["ancho"].as_f64().unwrap_or(0.0) < 20.0 || zona["alto"].as_f64().unwrap_or(0.0) < 20.0 {
        return Some(false);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let z = v::ejecutar(w, &rectangulo()).await?;
    let datos = json!({ "items": [], "files": rutas, "dragOperationsMask": 1 });
    for tipo in ["dragEnter", "dragOver", "drop"] {
        if cancelado.load(Ordering::SeqCst) || !w.url().is_ok_and(|u| es_pagina_de_edicion(u.as_str(), d)) {
            return None;
        }
        if let Err(e) = v::cdp(w, "Input.dispatchDragEvent", json!({ "type": tipo, "x": z["x"], "y": z["y"], "data": datos })).await {
            datos::registrar("soltar en Moodle", &e);
            return Some(false);
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    Some(true)
}

// Cada intento es cancelable y está ligado a su tarea. Volver a entregar cancela el anterior.
fn colocar(w: WebviewWindow, rutas: Vec<String>, d: Value) {
    let tarea_id = s(&d["tareaId"]).to_string();
    cancelar_colocar(&tarea_id);
    let cancelado = Arc::new(AtomicBool::new(false));
    con(|r| r.colocando.insert(tarea_id.clone(), cancelado.clone()));
    estado_entrega(&tarea_id, "preparando", "Página abierta. Esperando el selector de archivos de Moodle…");
    tauri::async_runtime::spawn(async move {
        let fin = intentar(&w, &rutas, &d, &cancelado).await;
        let ya = cancelado.load(Ordering::SeqCst);
        con(|r| {
            if r.colocando.get(&tarea_id).is_some_and(|c| Arc::ptr_eq(c, &cancelado)) {
                r.colocando.remove(&tarea_id);
            }
        });
        let (fase, texto) = match fin {
            _ if ya => ("cancelada", "Preparación cancelada. Tus archivos se conservan; puedes arrastrarlos manualmente.".to_string()),
            Fin::Cancelada(t) => ("cancelada", t.to_string()),
            Fin::Manual(t) => ("manual", t),
            Fin::Colocados(t) => ("colocados", t.to_string()),
        };
        estado_entrega(&tarea_id, fase, &texto);
    });
}

async fn intentar(w: &WebviewWindow, rutas: &[String], d: &Value, cancelado: &AtomicBool) -> Fin {
    let limite = Instant::now() + Duration::from_secs(300);
    let nombres: Vec<String> = rutas.iter().map(|r| Path::new(r).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect();
    let mut en_edicion_desde: Option<Instant> = None;
    let mut llego = false;
    loop {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if cancelado.load(Ordering::SeqCst) {
            return Fin::Cancelada("");
        }
        // La ventana se cerró (cerrarla la esconde).
        let (Ok(url), Ok(true)) = (w.url(), w.is_visible()) else { return Fin::Cancelada("Cerraste Moodle. Tus archivos y tu texto siguen guardados.") };
        if Instant::now() >= limite {
            return Fin::Manual("No apareció el selector de archivos de Moodle. Arrastra los archivos desde la ventana de Insti Today.".into());
        }
        let url = url.to_string();
        // Ya en la edición, irse a otra parte de Moodle cancela (no el inicio de sesión).
        if llego && !es_pagina_de_tarea(&url, d) {
            let mismo = url_de(&url).zip(url_de(s(&d["enlace"]))).is_some_and(|(u, e)| u.origin() == e.origin() && !u.path().contains("/login/") && !u.path().contains("/admin/tool/mobile/"));
            if mismo {
                return Fin::Cancelada("Preparación cancelada. Tus archivos se conservan; puedes arrastrarlos manualmente.");
            }
        }
        if es_pagina_de_tarea(&url, d) && !es_pagina_de_edicion(&url, d) {
            // En la vista de la tarea (sin editar) se lleva a la edición.
            if let Some(e) = d["enlaceEntrega"].as_str().and_then(url_de) {
                let _ = w.navigate(e);
            }
            continue;
        }
        if !es_pagina_de_edicion(&url, d) {
            continue;
        }
        llego = true;
        let desde = *en_edicion_desde.get_or_insert_with(Instant::now);
        let Some(antes) = v::ejecutar(w, &leer_archivos()).await.filter(|x| !x.is_null()) else { continue };
        let campos = antes["campos"].as_u64().unwrap_or(0);
        if campos > 1 {
            return Fin::Manual("Hay varios selectores de archivos. Elige el correcto y arrastra tus archivos.".into());
        }
        if campos == 0 {
            // Moodle tarda en dibujar el selector; si nunca aparece, la tarea sólo pide texto.
            if desde.elapsed() > Duration::from_secs(15) {
                return Fin::Manual("Esta tarea no tiene selector de archivos (quizá sólo pide texto en línea). Copia tu texto en Moodle y guarda.".into());
            }
            continue;
        }
        // Moodle aún sube algo: se espera para no soltarlo dos veces.
        if antes["cargando"] == true {
            continue;
        }
        let hay = |x: &Value, n: &String| x["nombres"].as_array().is_some_and(|l| l.iter().any(|y| s(y) == n));
        if nombres.iter().all(|n| hay(&antes, n)) {
            return Fin::Colocados("Tus archivos ya están en la entrega de Moodle. Revisa y pulsa «Guardar cambios» allí.");
        }
        match soltar(w, rutas, d, cancelado).await {
            None => return Fin::Cancelada("Preparación cancelada. Tus archivos se conservan; puedes arrastrarlos manualmente."),
            Some(false) => return Fin::Manual("No encontré dónde soltar los archivos. Arrástralos al recuadro de Moodle.".into()),
            Some(true) => {}
        }
        estado_entrega(s(&d["tareaId"]), "preparando", "Subiendo tus archivos al borrador de Moodle…");
        // Moodle sube cada archivo y luego lo muestra en la lista.
        let hasta = Instant::now() + Duration::from_secs(90);
        while Instant::now() < hasta {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if cancelado.load(Ordering::SeqCst) || !w.url().is_ok_and(|u| es_pagina_de_edicion(u.as_str(), d)) {
                return Fin::Cancelada("Preparación cancelada. Tus archivos se conservan; puedes arrastrarlos manualmente.");
            }
            if let Some(ahora) = v::ejecutar(w, &leer_archivos()).await {
                if nombres.iter().all(|n| hay(&ahora, n)) {
                    return Fin::Colocados("Archivos subidos al borrador de Moodle. Revisa la lista y pulsa «Guardar cambios» (y «Enviar tarea» si aparece).");
                }
            }
        }
        return Fin::Manual("Moodle no confirmó todos los archivos (puede pedir confirmar si ya existe uno con ese nombre). Revísalos o arrástralos manualmente.".into());
    }
}

// ---- Lo que piden las ventanas ----

pub async fn llamar(w: &WebviewWindow, canal: &str, args: &[Value]) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    let id = s(&a(0)).to_string();
    let rutas = |v: Value| -> Vec<String> { v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect() };
    Ok(match canal {
        "entrega:obtener" => datos_entrega(&id),
        "entrega:subir" => {
            let mut lista = rutas(a(1));
            if lista.is_empty() {
                use tauri_plugin_dialog::DialogExt;
                let w = w.clone();
                let elegidos = tauri::async_runtime::spawn_blocking(move || crate::app().dialog().file().set_title("Sube tus archivos a la entrega").set_parent(&w).blocking_pick_files()).await.ok().flatten();
                lista = elegidos.into_iter().flatten().filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
            }
            subir(&id, lista);
            datos_entrega(&id)
        }
        "entrega:quitarTuyo" => {
            let ruta = s(&a(1)).to_string();
            let es_tuyo = carpeta(&id).is_some_and(|c| Path::new(&ruta).parent() == Some(&c.join("tuyos")));
            if es_tuyo && es_entregable(&id, &ruta) {
                let _ = std::fs::remove_file(&ruta);
            }
            datos_entrega(&id)
        }
        "entrega:texto" => {
            let texto: String = a(1).as_str().map(String::from).unwrap_or_else(|| if a(1).is_null() { String::new() } else { a(1).to_string() }).chars().take(50_000).collect();
            con(|r| {
                if !r.entregas.is_object() {
                    r.entregas = json!({});
                }
                r.entregas[id.as_str()]["texto"] = json!(texto);
            });
            guardar();
            datos_entrega(&id)
        }
        "entrega:abrirArchivo" => {
            let ruta = s(&a(1)).to_string();
            if es_entregable(&id, &ruta) {
                let _ = crate::app().opener().open_path(ruta, None::<&str>);
            }
            Value::Null
        }
        "entrega:mostrarArchivo" => {
            let ruta = s(&a(1)).to_string();
            if es_entregable(&id, &ruta) {
                let _ = crate::app().opener().reveal_item_in_dir(ruta);
            }
            Value::Null
        }
        "entrega:entregar" => entregar(w, &id).await,
        "entrega:cancelar" => {
            cancelar_colocar(&id);
            datos_entrega(&id)
        }
        "arrastre:obtener" => json!(con(|r| r.archivos_arrastre.clone()).iter().map(|p| json!({ "nombre": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), "ext": p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or("ARCH".into()) })).collect::<Vec<_>>()),
        "arrastre:cerrar" => {
            if let Some(x) = ventana(ARRASTRE) {
                let _ = x.destroy();
            }
            Value::Null
        }
        // Crece hacia arriba: la esquina de abajo se queda donde estaba.
        "arrastre:ajustar" => {
            if let (Some(x), Some(alto)) = (ventana(ARRASTRE), a(0).as_f64()) {
                let b = v::Rect::de(&x);
                let f = x.scale_factor().unwrap_or(1.0);
                let nuevo = alto.ceil().clamp(60.0, 420.0) * f;
                v::poner(&x, v::Rect { y: b.y + b.h - nuevo, h: nuevo, ..b });
            }
            Value::Null
        }
        // Tocar un archivo de la ventanita lo suelta en Moodle como al abrir la
        // entrega; arrastrarlo es un arrastre de verdad, como desde el Explorador.
        "arrastre:colocar" | "arrastre:iniciar" => {
            let (todos, destino) = con(|r| (r.archivos_arrastre.clone(), r.destino_arrastre.clone()));
            let elegidos: Vec<String> = match a(0).as_u64() {
                Some(i) => todos.get(i as usize).into_iter().map(|p| p.to_string_lossy().to_string()).collect(),
                None => todos.iter().map(|p| p.to_string_lossy().to_string()).collect(),
            };
            if canal == "arrastre:iniciar" {
                v::arrastrar(w, elegidos);
            } else if let (Some(m), Some(d)) = (ventana(v::MOODLE).filter(|m| m.is_visible().unwrap_or(false)), destino) {
                if !elegidos.is_empty() {
                    colocar(m.clone(), elegidos, d);
                    let _ = m.set_focus();
                }
            }
            Value::Null
        }
        c => return Err(format!("Canal desconocido: {c}")),
    })
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn carpetas_sin_acentos() {
        assert_eq!(nombre_ascii("Cálculo: Vectorial ñ"), "Calculo_ Vectorial n");
        assert_eq!(nombre_ascii("日本"), "-");
        let d = json!({ "enlace": "https://m.mx/mod/assign/view.php?id=7", "tareaId": "7" });
        assert!(es_pagina_de_edicion("https://m.mx/mod/assign/view.php?id=7&action=editsubmission", &d));
        assert!(!es_pagina_de_tarea("https://m.mx/mod/assign/view.php?id=8", &d));
    }
}
