// Lo que hacía widget/main.js: revisar Moodle, avisar, la vista previa, las
// cuentas y todo lo que piden las ventanas por el puente (llamar).

use crate::{
    agenda, app,
    app::con,
    datos, entrega, moodle, sistema,
    ventanas::{self as v, emitir, ventana, Rect, ACCESO, APP, ARRASTRE, VISTA, WIDGET},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;

// BB_CAPTURA_SIN_RED=1: trabaja sólo con la última lista guardada, sin consultar Moodle.
pub fn sin_red() -> bool {
    std::env::var_os("BB_CAPTURA_SIN_RED").is_some()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(f: F) {
    tauri::async_runtime::spawn(f);
}

pub fn prefs() -> Value {
    con(|r| r.estado["prefs"].clone())
}

fn zoom() -> f64 {
    prefs()["tamano"].as_f64().unwrap_or(1.0)
}

// ---- El estado que ven las ventanas ----

pub fn publicar(cambios: Value) {
    con(|r| {
        for (k, v) in cambios.as_object().into_iter().flatten() {
            r.estado[k] = v.clone();
        }
        r.estado["escuela"] = json!(moodle::escuela());
        r.estado["entrando"] = json!(!r.esperan_login.is_empty());
    });
    let e = con(|r| r.estado.clone());
    emitir(WIDGET, "agenda:estado", e);
    if ventana(APP).is_some() {
        emitir(APP, "config:estado", datos_configuracion());
    }
    mandar_escritorio();
}

pub fn cuenta() -> Option<String> {
    let s = moodle::leer_sesion().filter(|s| s["token"].is_string())?;
    datos::ajustes().get("cuenta").and_then(|c| c.as_str()).or(s["usuario"].as_str()).map(String::from)
}

// Como URL.host en JS: con el puerto si no es el de siempre.
fn host_de(url: &str) -> String {
    url::Url::parse(url).map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_string()).unwrap_or_default()
}

pub fn lista_cuentas() -> Vec<Value> {
    datos::lista()
        .into_iter()
        .map(|c| {
            let host = host_de(s(&c["url"]));
            json!({ "id": c["id"], "usuario": c["usuario"], "nombre": c["nombre"], "host": host, "color": c["color"], "activa": c["activa"] })
        })
        .collect()
}

fn datos_configuracion() -> Value {
    let e = con(|r| r.estado.clone());
    let hay = cuenta();
    json!({
        "prefs": e["prefs"], "agenda": e["datos"], "entregaCambio": e["entregaCambio"].as_i64().unwrap_or(0),
        "cuenta": hay, "cuentas": if hay.is_some() { lista_cuentas() } else { vec![] }, "coloresCuenta": datos::COLORES,
        "escuela": moodle::escuela(), "materias": if e["datos"]["materias"].is_array() { e["datos"]["materias"].clone() } else { json!([]) },
        "ocultas": datos::ocultas(), "alIniciar": sistema::abre_al_iniciar(), "actualizado": e["datos"]["generado"],
        "cargando": e["cargando"], "version": app().package_info().version.to_string(), "actualizacion": sistema::estado_actualizacion(),
        "pagina": sistema::PAGINA, "descartadas": e["descartadas"], "pospuestas": e["pospuestas"],
    })
}

pub fn buscar_tarea(id: &str) -> Option<(Value, Value)> {
    con(|r| {
        for c in r.estado["datos"]["cursos"].as_array()? {
            if let Some(t) = c["tareas"].as_array()?.iter().find(|t| t["id"] == id) {
                return Some((c.clone(), t.clone()));
            }
        }
        None
    })
}

// Vidrio líquido (Windows): detrás del widget sólo está el fondo de pantalla.
// La página lo dibuja desenfocado justo donde está la ventana.
// shortcut: toma el fondo como «Rellenar» y el mismo en todas las pantallas; con fondos distintos por pantalla o «Ajustar»/«Mosaico» no coincide del todo.
fn mandar_escritorio() {
    let Some(w) = ventana(WIDGET) else { return };
    let p = prefs();
    let mut fondo = Value::Null;
    if cfg!(windows) && p["experimental"] == true && p["tema"] == "vidrio" && p["vidrioLiquido"] == true {
        let archivo = std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join(r"Microsoft\Windows\Themes\TranscodedWallpaper");
        if let (Ok(m), Some(d)) = (std::fs::metadata(&archivo), v::monitor_entero(&w)) {
            let b = Rect::de(&w);
            let f = w.scale_factor().unwrap_or(1.0);
            let marca = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            fondo = json!({ "url": format!("{}?v={marca}", v::url_local(&archivo)), "x": (b.x - d.x) / f, "y": (b.y - d.y) / f, "ancho": d.w / f, "alto": d.h / f, "zoom": p["tamano"] });
        }
    }
    emitir(WIDGET, "agenda:escritorio", fondo);
}

// ---- Revisar Moodle ----

pub async fn actualizar() {
    let ocupado = con(|r| r.estado["cargando"] == true || !r.esperan_login.is_empty());
    if ocupado {
        return;
    }
    con(|r| r.ultimo_intento = Some(Instant::now()));
    if sin_red() {
        publicar(json!({ "sesion": if cuenta().is_some() { "lista" } else { "falta" }, "error": null, "cargando": false }));
        return;
    }
    // Sin cuenta no hay nada que consultar: se queda esperando el inicio de sesión.
    if cuenta().is_none() {
        publicar(json!({ "sesion": "falta", "datos": null, "error": null, "cargando": false }));
        return;
    }
    publicar(json!({ "cargando": true }));
    let (gen, anterior) = con(|r| (r.generacion, r.estado["datos"].clone()));
    let r = tokio::time::timeout(Duration::from_secs(120), agenda::agenda(Some(anterior))).await.unwrap_or_else(|_| Err(moodle::ErrorMoodle::new("Moodle tardó demasiado en responder", 0)));
    if gen != con(|r| r.generacion) {
        return;
    }
    match r {
        Ok(d) => {
            datos::escribir(&datos::ruta("agenda.json"), &d);
            let cursos = d["cursos"].as_array().cloned().unwrap_or_default();
            publicar(json!({ "datos": d, "error": null, "cargando": false, "sesion": "lista" }));
            revisar_avisos();
            spawn(actualizar_mensajes(cursos));
        }
        Err(e) => {
            datos::registrar("actualizar", &e);
            if e.estado == 401 {
                // Ni con la sesión guardada: hay que volver a entrar. No se siguen
                // mostrando datos viejos como si estuvieran al día.
                publicar(json!({ "cargando": false, "sesion": "caducada", "error": null }));
            } else {
                publicar(json!({ "cargando": false, "error": { "tipo": "red", "mensaje": e.mensaje } }));
            }
        }
    }
}

// Al volver de entregar (o quitar el envío) en Moodle: se pregunta sólo por esa
// tarea y se cambia en la agenda, sin revisar todo (tarda segundos y se salta
// las que ya estaban entregadas).
pub async fn revisar_tarea(id: String) {
    let Some((_, t)) = buscar_tarea(&id).filter(|(_, t)| t["modulo"] == "assign") else { return };
    let gen = con(|r| r.generacion);
    let (estado, borrador) = match agenda::estado_de(&t).await {
        Ok(x) => x,
        Err(e) => return datos::registrar("revisar tarea", &e),
    };
    if gen != con(|r| r.generacion) {
        return;
    }
    let cambio = con(|r| {
        let x = r.estado["datos"]["cursos"].as_array_mut()?.iter_mut().flat_map(|c| c["tareas"].as_array_mut().into_iter().flatten()).find(|x| x["id"] == id.as_str())?;
        let antes = x.clone();
        x["estado"] = json!(estado);
        if borrador {
            x["borrador"] = json!(true);
        } else if let Some(m) = x.as_object_mut() {
            m.remove("borrador");
        }
        (*x != antes).then(|| r.estado["datos"].clone())
    });
    if let Some(d) = cambio {
        datos::escribir(&datos::ruta("agenda.json"), &d);
        publicar(json!({}));
        revisar_avisos();
    }
}

// Un reloj por minuto: revisa Moodle cuando toca (también tras suspender o si
// la red falló hace 2 minutos), avisa de lo que vence y libera la vista previa.
pub fn iniciar_relojes() {
    spawn(async {
        let mut vuelta = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            vuelta += 1;
            let (ultimo, generado) = con(|r| (r.ultimo_intento, r.estado["datos"]["generado"].as_str().map(String::from)));
            let intervalo = prefs()["intervaloMin"].as_f64().unwrap_or(60.0) * 60_000.0;
            let edad = generado.and_then(|g| chrono::DateTime::parse_from_rfc3339(&g).ok()).map(|g| (datos::ahora_ms() - g.timestamp_millis()) as f64).unwrap_or(f64::INFINITY);
            if ultimo.is_none_or(|u| u.elapsed() >= Duration::from_secs(120)) && edad >= intervalo - 60_000.0 {
                actualizar().await;
            }
            if vuelta % 5 == 0 {
                revisar_avisos();
            }
            moodle::podar_cache();
            let libre = con(|r| !r.vista_abierta && r.vista_usada.elapsed() > Duration::from_secs(300));
            if libre {
                if let Some(w) = ventana(VISTA) {
                    let _ = w.destroy();
                }
            }
        }
    });
}

// ---- Mensajes y anuncios (la bolita del widget) ----
//
// «Visto» es sólo de Insti Today: se marca al abrir la bolita y no cambia nada en Moodle.

pub fn con_visto(lista: &Value) -> Value {
    let vistos = con(|r| r.vistos.clone());
    json!(lista.as_array().into_iter().flatten().map(|m| {
        let mut m = m.clone();
        m["nuevo"] = json!(!vistos.contains(s(&m["id"])) && m["leidoEnBb"] != true);
        m
    }).collect::<Vec<_>>())
}

async fn actualizar_mensajes(cursos: Vec<Value>) {
    let gen = con(|r| r.generacion);
    let r = tokio::time::timeout(Duration::from_secs(60), agenda::mensajes(cursos)).await;
    if gen != con(|r| r.generacion) {
        return;
    }
    let fallo = "No se pudieron leer los mensajes. Se reintenta en la próxima revisión.";
    match r {
        Ok(Ok((lista, fallidos, total))) => {
            // Si no se pudo leer nada, se queda lo último guardado y la bolita lo dice.
            if fallidos == total {
                return publicar(json!({ "mensajesError": fallo }));
            }
            let lista = json!(lista);
            datos::escribir(&datos::ruta("mensajes.json"), &lista);
            let error = (fallidos > 0).then(|| format!("No se pudieron leer {fallidos} de {total} fuentes (mensajes, avisos, notificaciones)."));
            publicar(json!({ "mensajes": con_visto(&lista), "mensajesError": error }));
        }
        Ok(Err(e)) => {
            datos::registrar("mensajes", e);
            publicar(json!({ "mensajesError": fallo }));
        }
        Err(_) => publicar(json!({ "mensajesError": fallo })),
    }
}

fn marcar_vistos(ids: &Value) {
    let ids: Vec<String> = ids.as_array().into_iter().flatten().filter_map(|x| x.as_str()).map(String::from).collect();
    let mensajes = con(|r| r.estado["mensajes"].clone());
    let vigentes: HashSet<String> = mensajes.as_array().into_iter().flatten().map(|m| s(&m["id"]).to_string()).collect();
    let lista = con(|r| {
        r.vistos.extend(ids.iter().cloned());
        // Sólo se recuerdan los que siguen existiendo.
        r.vistos.retain(|id| vigentes.contains(id) || ids.contains(id));
        r.vistos.iter().cloned().collect::<Vec<_>>()
    });
    datos::escribir(&datos::ruta("mensajes-vistos.json"), &json!(lista));
    publicar(json!({ "mensajes": con_visto(&mensajes) }));
}

// ---- Avisos de Windows ----
//
// Uno por tarea cuando falta poco para que venza y no la has entregado; y el
// resumen del día (experimental) a la hora elegida.

const MADRUGADA: i64 = 6 * 3_600_000;

fn dia_de(ms: i64) -> chrono::NaiveDate {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms - MADRUGADA).single().map(|d| d.date_naive()).unwrap_or_default()
}

fn ms_de(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis())
}

fn hora(ms: i64) -> String {
    use chrono::TimeZone;
    let d = chrono::Local.timestamp_millis_opt(ms).single().unwrap_or_default();
    let (pm, h) = chrono::Timelike::hour12(&d);
    format!("{h}:{:02} {}", chrono::Timelike::minute(&d), if pm { "p.m." } else { "a.m." })
}

fn revisar_resumen() {
    use chrono::Timelike;
    let p = prefs();
    let e = con(|r| r.estado.clone());
    let a_las = p["resumenHora"].as_i64().unwrap_or(0) as u32;
    if p["experimental"] != true || a_las == 0 || e["datos"].is_null() || e["sesion"] != "lista" {
        return;
    }
    let ahora = chrono::Local::now();
    if ahora.hour() < a_las || ahora.hour() >= a_las + 4 {
        return;
    }
    let dia = ahora.date_naive().to_string();
    if datos::leer(&datos::ruta("resumen.json")).is_some_and(|r| r["dia"] == dia) {
        return;
    }
    datos::escribir(&datos::ruta("resumen.json"), &json!({ "dia": dia }));
    let ms = ahora.timestamp_millis();
    let fuera: HashSet<String> = e["descartadas"].as_array().into_iter().flatten().chain(e["pospuestas"].as_array().into_iter().flatten().filter(|t| t["hasta"].as_f64().unwrap_or(0.0) > ms as f64)).map(|t| s(&t["id"]).to_string()).collect();
    let mut de_hoy: Vec<i64> = e["datos"]["cursos"].as_array().into_iter().flatten().flat_map(|c| c["tareas"].as_array().cloned().unwrap_or_default())
        .filter(|t| t["estado"] == "pendiente" && !fuera.contains(s(&t["id"])))
        .filter_map(|t| ms_de(s(&t["entrega"])))
        .filter(|c| *c >= ms && dia_de(*c) == dia_de(ms))
        .collect();
    de_hoy.sort();
    let cuerpo = match de_hoy.first() {
        None => "Hoy no vence nada.".to_string(),
        Some(primera) => {
            let d = chrono::DateTime::from_timestamp_millis(*primera).unwrap().with_timezone(&chrono::Local);
            let minutos = d.hour() * 60 + d.minute();
            let cuando = if minutos == 0 || minutos == 1439 { "a medianoche".into() } else { format!("a las {}", hora(*primera)) };
            format!("Hoy: {} {}; la primera {cuando}.", de_hoy.len(), if de_hoy.len() == 1 { "cosa" } else { "cosas" })
        }
    };
    sistema::avisar("Tu día en Insti Today", &cuerpo, Some(Box::new(|| spawn(async { abrir_app("pendientes", None, false) }))));
}

pub fn revisar_avisos() {
    revisar_resumen();
    let p = prefs();
    let e = con(|r| r.estado.clone());
    if sin_red() || p["avisos"] != true || e["datos"].is_null() || e["sesion"] != "lista" {
        return;
    }
    let ahora = datos::ahora_ms();
    let limite = ahora + p["avisoHoras"].as_i64().unwrap_or(3) * 3_600_000;
    for c in e["datos"]["cursos"].as_array().into_iter().flatten() {
        for t in c["tareas"].as_array().into_iter().flatten() {
            let Some(cuando) = ms_de(s(&t["entrega"])).filter(|_| t["estado"] == "pendiente") else { continue };
            let clave = format!("{}@{}", s(&t["id"]), s(&t["entrega"]));
            if cuando <= ahora || cuando > limite || !con(|r| r.avisados.insert(clave)) {
                continue;
            }
            let horas = ((cuando - ahora) as f64 / 3_600_000.0).round().max(1.0);
            let enlace = s(&t["enlace"]).to_string();
            sistema::avisar(&format!("Vence en {horas} h: {}", s(&t["titulo"])), &format!("{} · {}", s(&c["nombre"]), hora(cuando)), Some(Box::new(move || {
                let enlace = enlace.clone();
                spawn(async move { v::abrir_externo(&enlace).await });
            })));
        }
    }
    // Sólo se guardan los de las últimas dos semanas.
    let vigentes = con(|r| {
        r.avisados.retain(|c| c.split_once('@').and_then(|(_, f)| ms_de(f)).is_some_and(|f| f > ahora - 14 * 86_400_000));
        r.avisados.iter().cloned().collect::<Vec<_>>()
    });
    datos::escribir(&datos::ruta("avisados.json"), &json!(vigentes));
}

// ---- La vista previa al pasar el ratón por una tarea ----
//
// Otra ventana sin marco pegada al costado del widget, de todo el alto del
// área de trabajo; lo que aparece y desaparece es la tarjeta, dentro. Se
// cierra cuando el puntero no está ni sobre el widget ni sobre la tarjeta: se
// pregunta al sistema dónde está el puntero, porque una ventana que no toma
// el foco a veces no se entera de que el ratón salió.

const GRACIA_CIERRE: Duration = Duration::from_millis(220);

async fn asegurar_vista() -> Option<WebviewWindow> {
    con(|r| r.vista_usada = Instant::now());
    if let Some(w) = ventana(VISTA) {
        return Some(w);
    }
    let w = v::crear_vista(zoom()).ok()?;
    for _ in 0..50 {
        if v::ejecutar(&w, "document.readyState").await == Some(json!("complete")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if ventana(WIDGET).is_some_and(|w| w.is_visible().unwrap_or(false)) {
        v::colocar_vista(zoom());
        let _ = w.show();
        v::encima_del_widget();
    }
    Some(w)
}

async fn mostrar_vista(a: &Value) {
    let fijar = a["fijar"] == true;
    if con(|r| r.vista_fijada) && !fijar {
        return;
    }
    con(|r| r.cerrar_en = None);
    let (curso_id, tarea_id) = (s(&a["cursoId"]).to_string(), s(&a["tareaId"]).to_string());
    let Some((curso, tarea)) = buscar_tarea(&tarea_id).filter(|(c, _)| c["id"] == curso_id.as_str()) else { return };
    let Some(vista) = asegurar_vista().await else { return };
    let n = con(|r| {
        r.pedido_vista += 1;
        r.vista_fijada = fijar;
        r.pedido_vista
    });
    let _ = vista.set_focusable(fijar);
    let z = zoom();
    let Some(marco) = v::colocar_vista(z) else { return };
    let w = ventana(WIDGET).unwrap();
    let f = w.scale_factor().unwrap_or(1.0);
    // Altura de la fila dentro de la ventana de la vista previa, en px de la página.
    let ancla = (Rect::de(&w).y + a["y"].as_f64().unwrap_or(0.0) * z * f - marco.y) / (z * f);
    let base = json!({ "n": n, "fijada": fijar, "curso": curso["nombre"], "color": a["color"], "tarea": tarea, "cargando": true, "prefs": prefs(), "ancla": ancla, "respuesta": null, "otrasRutas": [], "mantenimiento": false });
    emitir(VISTA, "vista:datos", base.clone());
    let _ = vista.show();
    if !con(|r| std::mem::replace(&mut r.vista_abierta, true)) {
        v::encima_del_widget();
    }
    if fijar {
        let _ = vista.set_focus();
    }
    vigilar_vista();

    let detalle = if sin_red() { Some(json!({ "instrucciones": tarea["instrucciones"].as_str().unwrap_or(""), "archivos": [] })) } else { agenda::detalle(&curso_id, &tarea).await.ok() };
    if n != con(|r| r.pedido_vista) {
        return;
    }
    let mut listo = base;
    listo["cargando"] = json!(false);
    listo["error"] = json!(detalle.is_none());
    listo["detalle"] = detalle.clone().unwrap_or(Value::Null);
    emitir(VISTA, "vista:datos", listo);
    for (i, archivo) in detalle.map(|d| d["archivos"].as_array().cloned().unwrap_or_default()).unwrap_or_default().into_iter().enumerate() {
        spawn(async move {
            let m = agenda::muestra_de(&archivo).await;
            if n == con(|r| r.pedido_vista) {
                emitir(VISTA, "vista:muestra", json!({ "n": n, "i": i, "muestra": m }));
            }
        });
    }
}

// El hueco entre la tarjeta y el widget cuenta como «dentro»: cruzarlo no la cierra.
fn puente(w: Rect, t: Rect) -> Rect {
    let izquierda = t.x < w.x;
    let x = if izquierda { t.x + t.w - 4.0 } else { w.x + w.w - 4.0 };
    let fin = if izquierda { w.x + 4.0 } else { t.x + 4.0 };
    Rect { x, y: t.y, w: (fin - x).max(0.0), h: t.h }
}

fn vigilar_vista() {
    if con(|r| std::mem::replace(&mut r.vigilando, true)) {
        return;
    }
    spawn(async {
        let mut fuera_desde: Option<Instant> = None;
        let mut atrapa = false;
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let (abierta, fijada, tarjeta, cerrar_en) = con(|r| (r.vista_abierta, r.vista_fijada, r.tarjeta, r.cerrar_en));
            if cerrar_en.is_some_and(|c| Instant::now() >= c) {
                cerrar_vista();
                break;
            }
            if !abierta {
                break;
            }
            let (Some(w), Some(vista)) = (ventana(WIDGET), ventana(VISTA)) else { break };
            let Ok(p) = app().cursor_position() else { continue };
            // Sobre la tarjeta la ventana atrapa el ratón (clics en archivos); fuera, lo deja pasar.
            let sobre = tarjeta.is_some_and(|t| t.contiene(p.x, p.y, 0.0));
            if sobre != atrapa || fijada {
                atrapa = sobre || fijada;
                let _ = vista.set_ignore_cursor_events(!atrapa);
            }
            if fijada {
                continue;
            }
            let b = Rect::de(&w);
            let dentro = b.contiene(p.x, p.y, 2.0) || tarjeta.is_some_and(|t| t.contiene(p.x, p.y, 8.0) || puente(b, t).contiene(p.x, p.y, 0.0));
            if dentro {
                fuera_desde = None;
            } else if fuera_desde.get_or_insert_with(Instant::now).elapsed() > GRACIA_CIERRE {
                cerrar_vista();
                break;
            }
        }
        con(|r| r.vigilando = false);
    });
}

pub fn cerrar_vista() {
    con(|r| {
        r.cerrar_en = None;
        r.pedido_vista += 1;
        r.tarjeta = None;
        r.vista_abierta = false;
        r.vista_fijada = false;
        r.vista_usada = Instant::now();
    });
    if let Some(vista) = ventana(VISTA) {
        let _ = vista.set_focusable(false);
        let _ = vista.set_ignore_cursor_events(true);
        emitir(VISTA, "vista:cerrar", Value::Null);
    }
    emitir(WIDGET, "vista:cerrada", Value::Null);
}

// Dónde quedó la tarjeta (px de la página).
fn tarjeta(r: &Value) {
    let Some(vista) = ventana(VISTA) else { return };
    if !con(|x| x.vista_abierta) || !r.is_object() {
        return;
    }
    let k = zoom() * vista.scale_factor().unwrap_or(1.0);
    let b = Rect::de(&vista);
    let n = |c: &str| r[c].as_f64().unwrap_or(0.0);
    let t = Rect { x: b.x + n("x") * k, y: b.y + n("y") * k, w: n("width") * k, h: n("height") * k };
    con(|x| x.tarjeta = Some(t));
}

// Precarga el detalle y las muestras de las tareas que se ven en el widget, de
// una en una y en segundo plano, para que la vista previa salga al instante.
fn precargar(lista: &Value) {
    if prefs()["vistaPrevia"] != true || con(|r| r.estado["sesion"] != "lista") || sin_red() {
        return;
    }
    let Some(l) = lista.as_array() else { return };
    let clave = l.iter().map(|x| s(&x["tareaId"])).collect::<Vec<_>>().join(",");
    if con(|r| std::mem::replace(&mut r.precargadas, clave.clone()) == clave) {
        return;
    }
    let tareas: Vec<(String, Value)> = l.iter().take(12).filter_map(|x| buscar_tarea(s(&x["tareaId"])).map(|(c, t)| (s(&c["id"]).to_string(), t))).collect();
    spawn(async move {
        for (curso, tarea) in tareas {
            if let Ok(d) = agenda::detalle(&curso, &tarea).await {
                for a in d["archivos"].as_array().into_iter().flatten() {
                    agenda::muestra_de(a).await;
                }
            }
        }
    });
}

// ---- El widget ----

pub fn mostrar_widget() {
    if let Some(w) = ventana(WIDGET) {
        let _ = w.show();
        v::al_fondo();
        if ventana(VISTA).is_some() {
            v::colocar_vista(zoom());
            let _ = ventana(VISTA).unwrap().show();
            v::encima_del_widget();
        }
    }
}

fn ocultar_widget() {
    cerrar_vista();
    if let Some(vista) = ventana(VISTA) {
        let _ = vista.hide();
    }
    if let Some(w) = ventana(WIDGET) {
        let _ = w.hide();
    }
}

fn guardar_posicion() {
    let n = con(|r| {
        r.guardar_posicion += 1;
        r.guardar_posicion
    });
    spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if n != con(|r| r.guardar_posicion) {
            return;
        }
        let Some(w) = ventana(WIDGET) else { return };
        let (p, f) = (w.outer_position().unwrap_or_default(), w.scale_factor().unwrap_or(1.0));
        datos::escribir(&datos::ruta("posicion.json"), &json!({ "x": p.x as f64 / f, "y": p.y as f64 / f, "width": con(|r| r.ancho_widget) }));
        v::colocar_vista(zoom());
    });
}

pub fn evento_widget(e: &tauri::WindowEvent) {
    match e {
        tauri::WindowEvent::Moved(_) => {
            mandar_escritorio();
            if con(|r| r.vista_abierta) {
                cerrar_vista();
            }
            guardar_posicion();
        }
        tauri::WindowEvent::Resized(t) => {
            // El ancho nuevo es un gesto de la persona; se ignora el redondeo de un píxel.
            if let Some(w) = ventana(WIDGET) {
                let ancho = t.width as f64 / w.scale_factor().unwrap_or(1.0);
                con(|r| {
                    if (ancho - r.ancho_widget).abs() > 1.0 {
                        r.ancho_widget = ancho.clamp(v::ANCHO_MIN, v::ANCHO_MAX);
                    }
                });
            }
            guardar_posicion();
        }
        // Cerrar la ventana sólo la esconde; para salir está la bandeja.
        tauri::WindowEvent::CloseRequested { api, .. } if !con(|r| r.salir) => {
            api.prevent_close();
            ocultar_widget();
        }
        tauri::WindowEvent::Focused(true) => v::al_fondo(),
        _ => {}
    }
}

fn alto_widget(alto: f64) {
    let Some(w) = ventana(WIDGET) else { return };
    if !alto.is_finite() {
        return;
    }
    let b = Rect::de(&w);
    let (a, f) = v::area(&w);
    let alto = (alto * zoom() * f).round().min(a.y + a.h - b.y - 8.0 * f).max(40.0 * f);
    let ancho = (con(|r| r.ancho_widget) * f).round();
    if (alto - b.h).abs() <= 1.0 && (b.w - ancho).abs() <= 1.0 {
        return;
    }
    let _ = w.set_size(tauri::PhysicalSize::new(ancho as u32, alto as u32));
}

fn a_la_esquina() {
    let Some(w) = ventana(WIDGET) else { return };
    let Some(m) = w.primary_monitor().ok().flatten() else { return };
    let (a, f) = (m.work_area(), m.scale_factor());
    let ancho = con(|r| r.ancho_widget);
    let x = (a.position.x as f64 + a.size.width as f64) / f - ancho - 16.0;
    let y = a.position.y as f64 / f + 16.0;
    let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    datos::escribir(&datos::ruta("posicion.json"), &json!({ "x": x, "y": y, "width": ancho }));
    mostrar_widget();
}

// ---- Insti Today completo ----

pub fn abrir_app(seccion: &str, tarea: Option<&str>, guia: bool) {
    if let Some(w) = ventana(APP) {
        emitir(APP, "app:ir", json!([seccion, tarea, guia]));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    match v::crear_app(seccion, tarea, guia) {
        Ok(w) => v::al_frente(&w),
        Err(e) => datos::registrar("abrir app", e),
    }
}

// El estilo elegido, para las demás ventanas («sistema» se resuelve con el modo del sistema).
fn tema_actual() -> Value {
    let t = prefs()["tema"].clone();
    if t.as_str().is_some_and(|t| t != "sistema") {
        return t;
    }
    if v::alto_contraste() {
        return json!("contraste");
    }
    let oscuro = ventana(WIDGET).and_then(|w| w.theme().ok()) == Some(tauri::Theme::Dark);
    json!(if oscuro { "medianoche" } else { "claro" })
}

fn aplicar_prefs(antes: &Value) {
    let p = prefs();
    for w in [ventana(WIDGET), ventana(VISTA)].into_iter().flatten() {
        let _ = w.set_zoom(zoom());
    }
    if let Some(w) = ventana(APP) {
        v::material_app(&w);
    }
    // Estas dos no reciben el estado: el tema (y el vidrio) les llega aparte para cambiar en vivo.
    let tema = json!({ "tema": tema_actual(), "liquido": v::liquida() });
    for w in [ARRASTRE, ACCESO] {
        emitir(w, "tema:cambio", tema.clone());
    }
    if antes["avisos"] != true || antes["avisoHoras"] != p["avisoHoras"] {
        revisar_avisos();
    }
}

// ---- Cuentas e inicio de sesión ----

// Abre la ventana «Iniciar sesión». Devuelve el usuario, o None si se cerró antes.
pub async fn iniciar_sesion() -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let primero = con(|r| {
        r.esperan_login.push(tx);
        r.esperan_login.len() == 1
    });
    match ventana(ACCESO) {
        Some(w) => v::al_frente(&w),
        None if primero => match v::crear_acceso() {
            Ok(w) => {
                w.on_window_event(|e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        terminar_login(None);
                    }
                });
                v::al_frente(&w);
            }
            Err(e) => {
                datos::registrar("iniciar sesión", e);
                terminar_login(None);
                publicar(json!({ "avisoAcceso": "No se pudo abrir el inicio de sesión. Inténtalo de nuevo." }));
            }
        },
        None => {}
    }
    publicar(json!({}));
    rx.await.ok().flatten()
}

fn terminar_login(usuario: Option<String>) {
    let esperan = con(|r| std::mem::take(&mut r.esperan_login));
    if esperan.is_empty() {
        return;
    }
    for t in esperan {
        let _ = t.send(usuario.clone());
    }
    if let Some(w) = ventana(ACCESO) {
        // Deja ver «Listo» un momento antes de cerrar.
        let espera = if usuario.is_some() { 900 } else { 0 };
        spawn(async move {
            tokio::time::sleep(Duration::from_millis(espera)).await;
            let _ = w.destroy();
        });
    }
}

async fn acceso_entrar(usuario: &str, contrasena: &str) -> Value {
    let usuario = usuario.trim();
    if usuario.is_empty() || contrasena.is_empty() {
        return json!({ "ok": false, "mensaje": "Escribe tu usuario y tu contraseña." });
    }
    let base = moodle::escuela();
    let r: Result<Value, String> = async {
        let (token, privado) = moodle::pedir_token(&base, usuario, contrasena).await?;
        let info = moodle::info_del_sitio(&base, &token).await?;
        // Primero el registro de cuentas: si era otra cuenta, guarda aparte la activa.
        if let Some(sobra) = datos::registrar_cuenta(s(&info["username"]), s(&info["fullname"]), &base) {
            v::borrar_navegador(&sobra);
        }
        moodle::guardar_sesion(&json!({ "url": base, "token": token, "privatetoken": privado, "userid": info["userid"], "usuario": info["username"], "nombre": info["fullname"], "guardada": datos::ahora_iso() }));
        moodle::olvidar_usuario();
        v::cerrar_navegador_ajeno();
        datos::guardar_ajustes(json!({ "cuenta": info["username"] }));
        // El navegador de la app, en segundo plano.
        spawn(v::entrar_en_navegador(usuario.to_string(), contrasena.to_string()));
        terminar_login(Some(s(&info["username"]).to_string()));
        Ok(json!({ "ok": true, "nombre": if s(&info["firstname"]).is_empty() { &info["fullname"] } else { &info["firstname"] } }))
    }
    .await;
    r.unwrap_or_else(|m| json!({ "ok": false, "mensaje": m }))
}

pub async fn entrar() {
    let usuario = iniciar_sesion().await;
    sistema::renovar_bandeja();
    if usuario.is_some() {
        // Pudo entrar con otra cuenta: lo de la memoria es de la anterior.
        recargar_cuenta(json!({ "avisoAcceso": null }));
        actualizar().await;
    } else {
        publicar(json!({}));
    }
}

// Cierra la sesión de la cuenta activa y la quita. Si hay otra, pasa a ella.
fn cerrar_sesion() -> bool {
    v::borrar_navegador(&datos::particion());
    moodle::olvidar_usuario();
    let hay = match datos::activa() {
        Some(a) => datos::quitar_cuenta(s(&a["id"])).1,
        None => false,
    };
    if !hay {
        datos::guardar_ajustes(json!({ "cuenta": null }));
        moodle::borrar_sesion();
    }
    v::cerrar_navegador_ajeno();
    hay
}

pub async fn salir_de_cuenta() {
    let siguiente = cerrar_sesion();
    if !siguiente {
        let _ = std::fs::remove_file(datos::ruta("agenda.json"));
    }
    recargar_cuenta(json!({}));
    if siguiente {
        actualizar().await;
    }
}

// Cambiar de cuenta cambia los archivos de la carpeta de datos; aquí se vuelve
// a leer lo que de ellos vive en memoria.
pub fn recargar_cuenta(extra: Value) {
    let leer_lista = |n: &str| datos::leer(&datos::ruta(n)).and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|x| x.as_str().map(String::from)).collect::<HashSet<_>>();
    let (vistos, avisados) = (leer_lista("mensajes-vistos.json"), leer_lista("avisados.json"));
    con(|r| {
        r.generacion += 1;
        r.vistos = vistos;
        r.avisados = avisados;
        r.entregas = datos::leer(&datos::ruta("entregas.json")).unwrap_or(json!({}));
        r.estado["cargando"] = json!(false);
    });
    cerrar_vista();
    sistema::renovar_bandeja();
    let hay = cuenta().is_some();
    let mut cambios = json!({
        "sesion": if hay { "lista" } else { "falta" },
        "datos": if hay { datos::leer(&datos::ruta("agenda.json")).unwrap_or(Value::Null) } else { Value::Null },
        "mensajes": if hay { con_visto(&datos::leer(&datos::ruta("mensajes.json")).unwrap_or(json!([]))) } else { json!([]) },
        "mensajesError": null, "error": null, "cargando": false,
        "descartadas": datos::descartadas(), "pospuestas": datos::pospuestas(),
    });
    for (k, v) in extra.as_object().into_iter().flatten() {
        cambios[k] = v.clone();
    }
    publicar(cambios);
}

pub async fn cambiar_de_cuenta(id: &str) -> Value {
    if con(|r| !r.esperan_login.is_empty()) {
        return json!({ "ok": false, "mensaje": "Termina de iniciar sesión primero." });
    }
    if let Err(m) = datos::cambiar(id) {
        datos::registrar("cambiar de cuenta", &m);
        return json!({ "ok": false, "mensaje": m });
    }
    moodle::olvidar_usuario();
    v::cerrar_navegador_ajeno();
    recargar_cuenta(json!({}));
    spawn(actualizar());
    json!({ "ok": true })
}

pub async fn agregar_cuenta() -> Value {
    if con(|r| !r.esperan_login.is_empty()) || cuenta().is_none() {
        spawn(entrar());
        return json!({ "ok": true });
    }
    let anterior = datos::preparar_nueva();
    moodle::olvidar_usuario();
    v::cerrar_navegador_ajeno();
    recargar_cuenta(json!({}));
    let usuario = iniciar_sesion().await;
    // Se cerró sin entrar: vuelve la cuenta de antes.
    if usuario.is_none() {
        datos::cancelar_nueva(anterior);
        moodle::olvidar_usuario();
        v::cerrar_navegador_ajeno();
    }
    recargar_cuenta(json!({}));
    if cuenta().is_some() {
        spawn(actualizar());
    }
    json!({ "ok": usuario.is_some() })
}

async fn quitar_cuenta(id: &str) {
    if datos::activa().is_some_and(|a| a["id"] == id) {
        return salir_de_cuenta().await;
    }
    if let (Some(p), _) = datos::quitar_cuenta(id) {
        v::borrar_navegador(&p);
    }
    sistema::renovar_bandeja();
    publicar(json!({}));
}

async fn cambiar_escuela(url: &str) -> Value {
    let Some(base) = moodle::normalizar_url(url.trim()) else { return json!({ "ok": false, "mensaje": "Esa dirección no es válida." }) };
    let r = moodle::comprobar_moodle(&base).await;
    if r["ok"] != true {
        return r;
    }
    if base != moodle::escuela() {
        cerrar_sesion();
    }
    datos::guardar_ajustes(json!({ "url": base }));
    publicar(json!({ "sesion": "falta", "datos": null, "error": null }));
    json!({ "ok": true, "url": base })
}

// La ✕ de cada tarea: la quita de la lista (se puede devolver desde Ajustes).
async fn descartar(origen: WebviewWindow, tarea: &Value) -> Value {
    let id = s(&tarea["id"]).to_string();
    if id.is_empty() || !con(|r| r.quitando.insert(id.clone())) {
        return json!(false);
    }
    let r = async {
        let (curso, t) = buscar_tarea(&id)?;
        cerrar_vista();
        let ok = sistema::confirmar(Some(origen), "Quitar tarea", &format!("¿Quitar «{}» de la lista?", s(&t["titulo"])), "Se ocultará sólo en Insti Today. Puedes recuperarla en Ajustes → Tareas quitadas.", "Quitar de la lista", false).await;
        if ok {
            publicar(json!({ "descartadas": datos::descartar(&id, s(&t["titulo"]), s(&curso["nombre"])) }));
        }
        Some(ok)
    }
    .await;
    con(|x| x.quitando.remove(&id));
    json!(r.unwrap_or(false))
}

// Un archivo de la tarea se descarga con el token a Descargas/Insti Today/<curso> y se abre.
async fn abrir_archivo(a: &Value) -> Value {
    use tauri_plugin_opener::OpenerExt;
    let carpeta = v::descargas().join("Insti Today").join(moodle::nombre_seguro(s(&a["curso"])));
    match moodle::descargar(s(&a["url"]), &carpeta, Some(s(&a["nombre"]))).await {
        Ok(ruta) => {
            if app().opener().open_path(ruta.to_string_lossy(), None::<&str>).is_err() {
                let _ = app().opener().reveal_item_in_dir(&ruta);
            }
            json!({ "ruta": ruta })
        }
        Err(e) => {
            if e.estado == 401 {
                publicar(json!({ "sesion": "caducada" }));
            }
            json!({ "error": if e.estado == 401 { "Tu sesión se cerró" } else { "No se pudo descargar" } })
        }
    }
}

// ---- El puente: todo lo que piden las ventanas ----

#[tauri::command]
pub async fn llamar(window: WebviewWindow, canal: String, args: Vec<Value>) -> Result<Value, String> {
    let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    let nada = Ok(Value::Null);
    let soy = |etiqueta: &str| window.label() == etiqueta;
    match canal.as_str() {
        "agenda:obtener" => Ok(con(|r| r.estado.clone())),
        "agenda:actualizar" => {
            actualizar().await;
            nada
        }
        "agenda:entrar" | "config:entrar" => {
            spawn(entrar());
            nada
        }
        "agenda:abrir" | "mensajes:abrir" => {
            v::abrir_externo(s(&a(0))).await;
            nada
        }
        "agenda:escuela" => Ok(cambiar_escuela(s(&a(0))).await),
        // Escribir la dirección de la escuela necesita teclado: sólo mientras dura,
        // el widget acepta el foco; luego vuelve a no tomarlo y al fondo.
        "agenda:teclado" => {
            if let Some(w) = ventana(WIDGET) {
                let activo = a(0) == true;
                let _ = w.set_focusable(activo);
                if activo {
                    let _ = w.set_focus();
                } else {
                    v::al_fondo();
                }
            }
            nada
        }
        "archivo:abrir" => Ok(abrir_archivo(&a(0)).await),
        "agenda:ocultar" => {
            ocultar_widget();
            nada
        }
        "agenda:alto" => {
            alto_widget(a(0).as_f64().unwrap_or(f64::NAN));
            nada
        }
        "ventana:arrastrar" => {
            let _ = window.start_dragging();
            nada
        }
        "vista:mostrar" => {
            mostrar_vista(&a(0)).await;
            nada
        }
        "vista:calentar" => {
            if prefs()["vistaPrevia"] == true {
                asegurar_vista().await;
            }
            nada
        }
        "vista:miniaturaPdf" => {
            agenda::guardar_miniatura_pdf(&a(0), s(&a(1)));
            nada
        }
        "vista:soltar" => {
            if !con(|r| r.vista_fijada) {
                con(|r| r.cerrar_en = Some(Instant::now() + GRACIA_CIERRE));
            }
            nada
        }
        "vista:cerrar" => {
            cerrar_vista();
            nada
        }
        "vista:mantener" => {
            con(|r| r.cerrar_en = None);
            nada
        }
        "vista:tarjeta" => {
            tarjeta(&a(0));
            nada
        }
        "vista:raton" => {
            if let Some(vista) = ventana(VISTA) {
                let _ = vista.set_ignore_cursor_events(a(0) != true);
            }
            nada
        }
        "vista:precargar" => {
            precargar(&a(0));
            nada
        }
        "mensajes:vistos" => {
            marcar_vistos(&a(0));
            nada
        }
        "config:obtener" => Ok(datos_configuracion()),
        "config:guardar" => {
            let antes = prefs();
            let p = datos::guardar_prefs(&a(0));
            con(|r| r.estado["prefs"] = p);
            aplicar_prefs(&antes);
            publicar(json!({}));
            Ok(datos_configuracion())
        }
        "config:materias" => {
            datos::guardar_ocultas(&a(0));
            actualizar().await;
            Ok(datos_configuracion())
        }
        "config:inicio" => {
            sistema::abrir_al_iniciar(a(0) == true);
            sistema::renovar_bandeja();
            Ok(datos_configuracion())
        }
        "config:esquina" => {
            a_la_esquina();
            nada
        }
        "config:salir-cuenta" => {
            salir_de_cuenta().await;
            Ok(datos_configuracion())
        }
        "cuentas:cambiar" => {
            let mut r = cambiar_de_cuenta(s(&a(0))).await;
            r["datos"] = datos_configuracion();
            Ok(r)
        }
        "cuentas:agregar" => {
            let mut r = agregar_cuenta().await;
            r["datos"] = datos_configuracion();
            Ok(r)
        }
        "cuentas:quitar" => {
            quitar_cuenta(s(&a(0))).await;
            Ok(json!({ "ok": true, "datos": datos_configuracion() }))
        }
        "cuentas:color" => {
            datos::cambiar_color(s(&a(0)), s(&a(1)));
            publicar(json!({}));
            Ok(datos_configuracion())
        }
        "actualizacion:buscar" => {
            spawn(sistema::buscar());
            nada
        }
        "actualizacion:descargar" | "actualizacion:instalar" => {
            spawn(sistema::descargar());
            nada
        }
        "tareas:descartar" => Ok(descartar(window.clone(), &a(0)).await),
        "tareas:restaurar" => {
            publicar(json!({ "descartadas": datos::restaurar(a(0).as_str()) }));
            Ok(datos_configuracion())
        }
        // «Hoy no»: la esconde hasta mañana, sin preguntar (se deshace al momento).
        "tareas:posponer" => {
            let (id, hasta, ahora) = (s(&a(0)["id"]).to_string(), a(1).as_f64().unwrap_or(0.0), datos::ahora_ms() as f64);
            if id.is_empty() || buscar_tarea(&id).is_none() || hasta <= ahora || hasta > ahora + 2.0 * 86_400_000.0 {
                return Ok(json!(false));
            }
            publicar(json!({ "pospuestas": datos::posponer(&id, hasta) }));
            Ok(json!(true))
        }
        "tareas:volver" => {
            publicar(json!({ "pospuestas": datos::volver(s(&a(0))) }));
            Ok(datos_configuracion())
        }
        "tema:actual" => Ok(tema_actual()),
        "app:abrir" => {
            abrir_app(a(0).as_str().unwrap_or("pendientes"), a(1).as_str(), false);
            nada
        }
        // Instrucciones y archivos de una tarea para la app (sin las muestras).
        "app:detalle" => {
            let Some((curso, tarea)) = buscar_tarea(s(&a(1))).filter(|(c, _)| c["id"] == a(0)) else { return nada };
            let d = if sin_red() { Ok(json!({ "instrucciones": tarea["instrucciones"], "archivos": [] })) } else { agenda::detalle(s(&curso["id"]), &tarea).await };
            Ok(d.map(|d| json!({ "instrucciones": d["instrucciones"], "archivos": d["archivos"].as_array().into_iter().flatten().map(|f| json!({ "nombre": f["nombre"], "url": f["url"], "bytes": f["bytes"], "mime": f["mime"] })).collect::<Vec<_>>() })).unwrap_or(Value::Null))
        }
        // Sólo el aviso de privacidad (viene con la app) y la página de Insti Today.
        "abrir:web" => {
            let ruta = s(&a(0)).to_string();
            if ruta.starts_with("/privacidad") {
                let _ = v::crear_privacidad();
            } else if let Ok(u) = url::Url::parse(sistema::PAGINA).and_then(|b| b.join(&ruta)) {
                if u.origin() == url::Url::parse(sistema::PAGINA).unwrap().origin() {
                    v::abrir_navegador(u.as_str());
                }
            }
            nada
        }
        "acceso:info" if soy(ACCESO) => {
            let base = moodle::escuela();
            let host = host_de(&base);
            Ok(json!({ "escuela": base, "host": host, "cuenta": datos::ajustes().get("cuenta").cloned().unwrap_or(json!("")) }))
        }
        "acceso:entrar" if soy(ACCESO) => Ok(acceso_entrar(s(&a(0)), s(&a(1))).await),
        "acceso:cancelar" if soy(ACCESO) => {
            let _ = window.destroy();
            nada
        }
        c if c.starts_with("entrega:") || c.starts_with("arrastre:") => entrega::llamar(&window, c, &args).await,
        c => Err(format!("Canal desconocido: {c}")),
    }
}
