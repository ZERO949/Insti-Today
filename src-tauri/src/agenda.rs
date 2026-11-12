// La agenda leída de Moodle: tareas (assign), exámenes (quiz), foros con
// fecha y el resto de actividades pendientes del calendario. Además el
// detalle de una tarea (con muestras de sus archivos) y los mensajes.
// Misma forma de datos que entregaba src/agenda.js: las ventanas no cambian.

use crate::moodle::{escuela, iso, leer_bytes, texto, usuario_actual, ws, ws_opcional, R};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::future::{join_all, try_join_all};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

const DIA: f64 = 864e5;
// Cada cuánto se vuelve a preguntar por las tareas que ya estaban entregadas.
const REVISION_COMPLETA: f64 = 12.0 * 3600.0 * 1000.0;

fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn lista(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

// Orden alfabético en español, sin que los acentos manden.
pub fn clave_orden(t: &str) -> String {
    t.to_lowercase().chars().map(|c| match c {
        'á' | 'à' | 'ä' | 'â' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        c => c,
    }).collect()
}

// ---- Archivos de la misma sección ----
//
// Los profesores suelen subir el material al lado de la tarea. Se emparejan
// por el número más específico del título; un número suelto («Tarea 1») además
// tiene que coincidir con la palabra que lo acompaña.

fn numeros(t: &str) -> Vec<String> {
    static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:[.,]\d+)*").unwrap());
    NUM.find_iter(t).map(|m| {
        let x = m.as_str().replace(',', ".");
        let sin_ceros = x.trim_start_matches('0');
        if sin_ceros.is_empty() || sin_ceros.starts_with('.') { format!("0{sin_ceros}") } else { sin_ceros.to_string() }
    }).collect()
}

struct Clave {
    numero: String,
    palabra: Option<String>,
}

fn clave_de(titulo: &str) -> Option<Clave> {
    let mut nums = numeros(titulo);
    nums.sort_by_key(|x| std::cmp::Reverse(x.len()));
    let primero = nums.first()?.clone();
    if primero.contains('.') {
        return Some(Clave { numero: primero, palabra: None });
    }
    let re = Regex::new(&format!(r"(?i)([a-záéíóúñ]+)[\s_-]*0*{}(?:\D|$)", regex::escape(&primero))).ok()?;
    let palabra = re.captures(titulo)?[1].to_lowercase();
    Some(Clave { numero: primero, palabra: Some(palabra) })
}

fn coincide(c: &Clave, titulo: &str) -> bool {
    match &c.palabra {
        None => numeros(titulo).contains(&c.numero),
        Some(p) => Regex::new(&format!(r"(?i){}[\s_-]*0*{}(?:\D|$)", regex::escape(p), regex::escape(&c.numero))).is_ok_and(|r| r.is_match(titulo)),
    }
}

fn relacionados(titulo: &str, cmid: &Value, hermanos: &[Value]) -> Vec<Value> {
    let Some(clave) = clave_de(titulo) else { return vec![] };
    hermanos
        .iter()
        .filter(|h| &h["id"] != cmid && ["resource", "folder", "page", "book"].contains(&s(&h["modname"])) && h["uservisible"] != false)
        .filter(|h| coincide(&clave, s(&h["name"])))
        .map(|h| json!({ "id": h["id"].to_string(), "titulo": h["name"], "carpeta": matches!(s(&h["modname"]), "folder" | "book") }))
        .collect()
}

struct Lugar {
    seccion: String,
    hermanos: Vec<Value>,
    modulo: Value,
}

// cmid → { sección, hermanos, módulo } de un curso.
fn mapa_secciones(secciones: &Value) -> HashMap<i64, Lugar> {
    let mut mapa = HashMap::new();
    for sec in lista(secciones) {
        let nombre = texto(s(&sec["name"]));
        let modulos = lista(&sec["modules"]);
        for m in &modulos {
            if let Some(id) = m["id"].as_i64() {
                mapa.insert(id, Lugar { seccion: nombre.clone(), hermanos: modulos.clone(), modulo: m.clone() });
            }
        }
    }
    mapa
}

// ---- Archivos de las instrucciones ----

fn archivos_de(v: &Value, origen: &str) -> Vec<Value> {
    lista(v)
        .into_iter()
        .filter(|f| f["fileurl"].is_string() && !s(&f["filename"]).is_empty() && f["filename"] != ".")
        .map(|f| json!({ "nombre": f["filename"], "bytes": f["filesize"], "mime": f["mimetype"], "url": f["fileurl"], "origen": origen }))
        .collect()
}

// Imágenes o archivos incrustados en el HTML de la intro (pluginfile.php).
fn incrustados(html: &str) -> Vec<Value> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(?:href|src)\s*=\s*["']([^"']*/pluginfile\.php/[^"']+)["']"#).unwrap());
    RE.captures_iter(html)
        .map(|m| {
            let url = m[1].replace("&amp;", "&");
            let ultimo = url.split('?').next().unwrap_or("").rsplit('/').next().unwrap_or("archivo");
            let nombre = url::form_urlencoded::parse(format!("x={ultimo}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or("archivo".into());
            json!({ "nombre": nombre, "url": url, "origen": "De la tarea" })
        })
        .collect()
}

fn sin_duplicados(l: Vec<Value>) -> Vec<Value> {
    let mut vistos = HashSet::new();
    l.into_iter().filter(|a| vistos.insert(s(&a["url"]).split('?').next().unwrap_or("").to_string())).collect()
}

fn tipo_de(nombre: &str, modulo: &str) -> &'static str {
    static EXAMEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)examen|\bparcial\b|quiz|\bexam\b|prueba").unwrap());
    match modulo {
        "quiz" => "examen",
        "forum" => "foro",
        "feedback" | "choice" | "survey" | "questionnaire" => "encuesta",
        _ if EXAMEN.is_match(nombre) => "examen",
        _ => "tarea",
    }
}

fn ruta_de(lugar: Option<&Lugar>) -> Value {
    match lugar {
        Some(l) if !l.seccion.is_empty() => json!([l.seccion]),
        _ => json!([]),
    }
}

// Lo que JS dejaba en `undefined` no viaja.
fn sin(mut t: Value, claves: &[&str]) -> Value {
    if let Some(m) = t.as_object_mut() {
        for k in claves {
            let vacio = match m.get(*k) {
                None | Some(Value::Null) | Some(Value::Bool(false)) => true,
                Some(Value::String(s)) => s.is_empty(),
                _ => false,
            };
            if vacio {
                m.remove(*k);
            }
        }
    }
    t
}

// ---- Por tipo de actividad ----

async fn estado_tarea(asig: &Value, entregadas: &Option<HashSet<String>>) -> R<(String, bool, Value, bool)> {
    if entregadas.as_ref().is_some_and(|e| e.contains(&asig["cmid"].to_string())) {
        return Ok(("entregada".into(), false, Value::Null, false));
    }
    let st = ws_opcional("mod_assign_get_submission_status", json!({ "assignid": asig["id"] }), Value::Null).await?;
    let intento = &st["lastattempt"];
    let entrega = if intento["teamsubmission"].is_object() { &intento["teamsubmission"] } else { &intento["submission"] };
    let calificada = intento["gradingstatus"] == "graded" || st["feedback"]["grade"]["grade"].as_str().is_some_and(|g| !g.is_empty()) || n(&st["feedback"]["grade"]["grade"]) != 0.0;
    let mut estado = if entrega["status"] == "submitted" || calificada { "entregada" } else { "pendiente" };
    // Sin entrega en línea (en papel): sólo cuenta si ya la calificaron.
    if asig["nosubmissions"].as_i64().unwrap_or(0) != 0 && !calificada {
        estado = "pendiente";
    }
    let prorroga = if n(&intento["extensionduedate"]) > 0.0 { intento["extensionduedate"].clone() } else { Value::Null };
    Ok((estado.into(), entrega["status"] == "draft", prorroga, intento["locked"] == true))
}

// Una sola tarea ya leída (al volver de su entrega en Moodle): estado y borrador.
pub async fn estado_de(t: &Value) -> R<(String, bool)> {
    let asig = json!({ "id": t["instancia"], "nosubmissions": i64::from(t["sinEntregaEnLinea"] == true) });
    let (estado, borrador, _, _) = estado_tarea(&asig, &None).await?;
    Ok((estado, borrador))
}

async fn tareas_assign(asignaciones: Vec<Value>, secciones: &HashMap<i64, Lugar>, ahora: f64, entregadas: &Option<HashSet<String>>) -> R<Vec<Value>> {
    let base = escuela();
    try_join_all(asignaciones.into_iter().map(|a| {
        let base = base.clone();
        async move {
            let (estado, borrador, prorroga, bloqueada) = estado_tarea(&a, entregadas).await?;
            let lugar = a["cmid"].as_i64().and_then(|c| secciones.get(&c));
            let vence = if prorroga.is_null() { a["duedate"].clone() } else { prorroga };
            let corte = n(&a["cutoffdate"]);
            let html = [s(&a["intro"]), s(&a["activity"])].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join("\n");
            let sin_linea = a["nosubmissions"].as_i64().unwrap_or(0) != 0;
            let creada = if n(&a["allowsubmissionsfromdate"]) > 0.0 { &a["allowsubmissionsfromdate"] } else { &a["timemodified"] };
            let cmid = &a["cmid"];
            let mut adjuntos = archivos_de(&a["introattachments"], "De la tarea");
            adjuntos.extend(archivos_de(&a["activityattachments"], "De la tarea"));
            adjuntos.extend(incrustados(&html));
            Ok(sin(
                json!({
                    "id": cmid.to_string(), "modulo": "assign", "instancia": a["id"], "titulo": a["name"],
                    "ruta": ruta_de(lugar), "tipo": tipo_de(s(&a["name"]), "assign"),
                    "entrega": iso(&vence), "cierre": iso(&a["cutoffdate"]), "estado": estado,
                    "borrador": borrador,
                    "bloqueada": bloqueada || n(&a["allowsubmissionsfromdate"]) * 1000.0 > ahora,
                    // Acepta entrega tardía si no hay fecha de corte o aún no llega.
                    "tardia": !sin_linea && (corte == 0.0 || corte * 1000.0 > ahora),
                    "sinEntregaEnLinea": sin_linea,
                    "instrucciones": texto(&html), "creada": iso(creada),
                    "adjuntos": sin_duplicados(adjuntos),
                    "relacionados": lugar.map(|l| relacionados(s(&a["name"]), cmid, &l.hermanos)).unwrap_or_default(),
                    "enlace": format!("{base}/mod/assign/view.php?id={cmid}"),
                    "enlaceEntrega": if sin_linea { Value::Null } else { json!(format!("{base}/mod/assign/view.php?id={cmid}&action=editsubmission")) },
                }),
                &["borrador", "sinEntregaEnLinea", "instrucciones", "creada", "enlaceEntrega"],
            ))
        }
    }))
    .await
}

async fn tareas_quiz(examenes: Vec<Value>, secciones: &HashMap<i64, Lugar>, ahora: f64) -> R<Vec<Value>> {
    let base = escuela();
    try_join_all(examenes.into_iter().map(|q| {
        let base = base.clone();
        async move {
            let r = ws_opcional("mod_quiz_get_user_attempts", json!({ "quizid": q["id"], "status": "all", "includepreviews": 0 }), json!({ "attempts": [] })).await?;
            let terminados = lista(&r["attempts"]).iter().any(|x| x["state"] == "finished");
            let lugar = q["coursemodule"].as_i64().and_then(|c| secciones.get(&c));
            let cm = &q["coursemodule"];
            let mut adjuntos = archivos_de(&q["introfiles"], "De la tarea");
            adjuntos.extend(incrustados(s(&q["intro"])));
            Ok(sin(
                json!({
                    "id": cm.to_string(), "modulo": "quiz", "instancia": q["id"], "titulo": q["name"], "ruta": ruta_de(lugar),
                    "tipo": "examen", "abre": iso(&q["timeopen"]), "entrega": iso(&q["timeclose"]),
                    "estado": if terminados { "entregada" } else { "pendiente" },
                    "bloqueada": n(&q["timeopen"]) * 1000.0 > ahora, "tardia": false,
                    "instrucciones": texto(s(&q["intro"])),
                    "creada": iso(if n(&q["timecreated"]) > 0.0 { &q["timecreated"] } else { &q["timeopen"] }),
                    "adjuntos": sin_duplicados(adjuntos),
                    "relacionados": lugar.map(|l| relacionados(s(&q["name"]), cm, &l.hermanos)).unwrap_or_default(),
                    "enlace": format!("{base}/mod/quiz/view.php?id={cm}"),
                }),
                &["instrucciones", "creada"],
            ))
        }
    }))
    .await
}

fn tareas_foro(foros: Vec<Value>, secciones: &HashMap<i64, Lugar>, ahora: f64) -> Vec<Value> {
    let base = escuela();
    foros
        .into_iter()
        .filter(|f| n(&f["duedate"]) > 0.0)
        .map(|f| {
            let lugar = f["cmid"].as_i64().and_then(|c| secciones.get(&c));
            let mut adjuntos = archivos_de(&f["introfiles"], "De la tarea");
            adjuntos.extend(incrustados(s(&f["intro"])));
            let corte = n(&f["cutoffdate"]);
            sin(
                json!({
                    "id": f["cmid"].to_string(), "modulo": "forum", "instancia": f["id"], "titulo": f["name"], "ruta": ruta_de(lugar),
                    "tipo": "foro", "entrega": iso(&f["duedate"]), "cierre": iso(&f["cutoffdate"]),
                    // Moodle no dice al alumno si ya participó sin leer cada debate.
                    "estado": if lugar.is_some_and(|l| n(&l.modulo["completiondata"]["state"]) >= 1.0) { "entregada" } else { "pendiente" },
                    "bloqueada": false, "tardia": corte == 0.0 || corte * 1000.0 > ahora,
                    "instrucciones": texto(s(&f["intro"])), "adjuntos": sin_duplicados(adjuntos), "relacionados": [],
                    "enlace": format!("{base}/mod/forum/view.php?id={}", f["cmid"]),
                }),
                &["instrucciones"],
            )
        })
        .collect()
}

// Actividades de otros módulos que el calendario marca como pendientes.
fn tareas_calendario(eventos: Vec<Value>, secciones: &HashMap<i64, Lugar>) -> Vec<Value> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?&]id=(\d+)").unwrap());
    let base = escuela();
    let mut salida = vec![];
    let mut vistos = HashSet::new();
    for ev in eventos {
        let modulo = s(&ev["modulename"]);
        if ["assign", "quiz", "forum"].contains(&modulo) {
            continue;
        }
        let cmid: Option<i64> = ID.captures(s(&ev["url"])).and_then(|m| m[1].parse().ok()).filter(|x| *x != 0);
        let clave = cmid.map(|c| c.to_string()).unwrap_or(format!("ev{}", ev["id"]));
        if !vistos.insert(clave.clone()) {
            continue;
        }
        let lugar = cmid.and_then(|c| secciones.get(&c));
        let nombre = [s(&ev["activityname"]), lugar.map(|l| s(&l.modulo["name"])).unwrap_or(""), s(&ev["name"])].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string();
        let enlace = if !s(&ev["url"]).is_empty() {
            s(&ev["url"]).to_string()
        } else if let Some(c) = cmid {
            format!("{base}/mod/{modulo}/view.php?id={c}")
        } else {
            format!("{base}/calendar/view.php")
        };
        salida.push(sin(
            json!({
                "id": clave, "modulo": if modulo.is_empty() { "evento" } else { modulo }, "titulo": nombre, "ruta": ruta_de(lugar),
                "tipo": tipo_de(&nombre, modulo), "entrega": iso(if n(&ev["timesort"]) > 0.0 { &ev["timesort"] } else { &ev["timestart"] }),
                "estado": "pendiente", "bloqueada": ev["action"].is_object() && ev["action"]["actionable"] == false, "tardia": false,
                "instrucciones": texto(s(&ev["description"])), "adjuntos": [], "relacionados": [], "enlace": enlace,
            }),
            &["instrucciones"],
        ));
    }
    salida
}

// ---- Cursos ----

// "Cálculo Vectorial_ING_2026A" → "Cálculo Vectorial".
fn nombre_corto(nombre: &str) -> String {
    texto(nombre).split('_').next().unwrap_or("").trim().to_string()
}

// Cursos en curso: la misma clasificación del tablero («En progreso») o, si la
// escuela no la permite, las fechas de inicio y fin.
async fn cursos_actuales() -> R<Vec<Value>> {
    let u = usuario_actual().await?;
    let en_curso = ws_opcional("core_course_get_enrolled_courses_by_timeline_classification", json!({ "classification": "inprogress", "limit": 0, "offset": 0 }), Value::Null).await?;
    let cursos = match en_curso["courses"].as_array() {
        Some(c) => c.clone(),
        None => {
            let todos = ws("core_enrol_get_users_courses", json!({ "userid": u["userid"] })).await?;
            let ahora = crate::datos::ahora_ms() as f64;
            lista(&todos)
                .into_iter()
                .filter(|c| {
                    let (inicio, fin) = (n(&c["startdate"]) * 1000.0, n(&c["enddate"]) * 1000.0);
                    if c["visible"] == 0 || c["hidden"] == true || inicio > ahora {
                        return false;
                    }
                    if fin > 0.0 {
                        return ahora <= fin;
                    }
                    // Sin fecha de fin: del semestre si empezó hace poco.
                    ahora - inicio < 183.0 * DIA
                })
                .collect()
        }
    };
    let base = escuela();
    Ok(cursos
        .into_iter()
        .filter(|c| c["hidden"] != true)
        .map(|c| {
            let nombre = [s(&c["fullname"]), s(&c["displayname"]), s(&c["shortname"])].into_iter().find(|x| !x.is_empty()).unwrap_or("");
            json!({
                "id": c["id"].to_string(), "idMoodle": c["id"], "nombre": nombre_corto(nombre),
                "completo": ([s(&c["fullname"]), s(&c["shortname"])].into_iter().find(|x| !x.is_empty()).unwrap_or("")),
                "inicio": iso(&c["startdate"]), "fin": iso(&c["enddate"]),
                "enlace": c["viewurl"].as_str().map(String::from).unwrap_or(format!("{base}/course/view.php?id={}", c["id"])),
            })
        })
        .collect())
}

// ---- Todo junto ----

// `anterior` es la agenda de la revisión pasada: de ahí se toman las tareas
// que ya estaban entregadas, y cada 12 h se revisan todas.
pub async fn agenda(anterior: Option<Value>) -> R<Value> {
    let u = usuario_actual().await?;
    let ocultar: Vec<String> = crate::datos::ocultas().iter().filter_map(|t| t.as_str()).map(str::to_lowercase).collect();
    let actuales = cursos_actuales().await?;
    let oculto = |c: &Value| ocultar.iter().any(|t| s(&c["nombre"]).to_lowercase().contains(t) || s(&c["completo"]).to_lowercase().contains(t));
    let visibles: Vec<Value> = actuales.iter().filter(|c| !oculto(c)).cloned().collect();
    let ids: Vec<Value> = visibles.iter().map(|c| c["idMoodle"].clone()).collect();
    let ahora = crate::datos::ahora_ms() as f64;
    let anterior = anterior.filter(|a| a["cuenta"] == u["username"]);
    let previa = anterior.as_ref().and_then(|a| a["completa"].as_str().or(a["generado"].as_str())).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis() as f64);
    let atajo = previa.is_some_and(|p| ahora - p < REVISION_COMPLETA);
    let entregadas: Option<HashSet<String>> = atajo.then(|| {
        lista(&anterior.as_ref().unwrap()["cursos"]).iter().flat_map(|c| lista(&c["tareas"])).filter(|t| t["modulo"] == "assign" && t["estado"] == "entregada").map(|t| s(&t["id"]).to_string()).collect()
    });

    // Exámenes, foros y calendario se piden una vez para todos los cursos.
    let (quizzes, foros, calendario) = if ids.is_empty() {
        (json!({ "quizzes": [] }), json!([]), json!({ "groupedbycourse": [] }))
    } else {
        futures::try_join!(
            ws_opcional("mod_quiz_get_quizzes_by_courses", json!({ "courseids": ids }), json!({ "quizzes": [] })),
            ws_opcional("mod_forum_get_forums_by_courses", json!({ "courseids": ids }), json!([])),
            ws_opcional("core_calendar_get_action_events_by_courses", json!({ "courseids": ids, "timefrom": ((ahora - 60.0 * DIA) / 1000.0) as i64, "limitnum": 50 }), json!({ "groupedbycourse": [] })),
        )?
    };

    let mut cursos = try_join_all(visibles.iter().map(|c| {
        let (quizzes, foros, calendario, entregadas) = (&quizzes, &foros, &calendario, &entregadas);
        async move {
            let id = c["idMoodle"].clone();
            let (asig, contenido) = futures::try_join!(
                ws_opcional("mod_assign_get_assignments", json!({ "courseids": [id] }), json!({ "courses": [] })),
                ws_opcional("core_course_get_contents", json!({ "courseid": id }), json!([])),
            )?;
            let secciones = mapa_secciones(&contenido);
            let mis_asig = lista(&asig["courses"]).into_iter().find(|x| x["id"] == id).map(|x| lista(&x["assignments"])).unwrap_or_default();
            let mis_quiz: Vec<Value> = lista(&quizzes["quizzes"]).into_iter().filter(|q| q["course"] == id && q["visible"] != false && q["visible"] != 0).collect();
            let mis_foros: Vec<Value> = lista(foros).into_iter().filter(|f| f["course"] == id).collect();
            let mis_eventos = lista(&calendario["groupedbycourse"]).into_iter().find(|g| g["courseid"].to_string().trim_matches('"') == id.to_string()).map(|g| lista(&g["events"])).unwrap_or_default();
            // Fechas de relleno muy lejanas equivalen a «sin fecha».
            let limite = c["fin"].as_str().and_then(|f| chrono::DateTime::parse_from_rfc3339(f).ok()).map(|d| d.timestamp_millis() as f64 + 30.0 * DIA).unwrap_or(f64::INFINITY);
            let mut tareas = tareas_assign(mis_asig, &secciones, ahora, entregadas).await?;
            tareas.extend(tareas_quiz(mis_quiz, &secciones, ahora).await?);
            tareas.extend(tareas_foro(mis_foros, &secciones, ahora));
            tareas.extend(tareas_calendario(mis_eventos, &secciones));
            for t in tareas.iter_mut() {
                let m = t.as_object_mut().unwrap();
                if m.get("entrega").and_then(|e| e.as_str()).and_then(|e| chrono::DateTime::parse_from_rfc3339(e).ok()).is_some_and(|d| d.timestamp_millis() as f64 > limite) {
                    m.insert("entrega".into(), Value::Null);
                }
                for k in ["relacionados", "adjuntos"] {
                    if m.get(k).and_then(|v| v.as_array()).is_none_or(|a| a.is_empty()) {
                        m.remove(k);
                    }
                }
            }
            Ok::<_, crate::moodle::ErrorMoodle>(json!({ "id": c["id"], "nombre": c["nombre"], "horario": null, "inicio": c["inicio"], "fin": c["fin"], "enlace": c["enlace"], "tareas": tareas }))
        }
    }))
    .await?;
    cursos.sort_by_key(|c| clave_orden(s(&c["nombre"])));

    // Para Ajustes: todas las materias del semestre, también las ocultas.
    let mut materias: Vec<Value> = vec![];
    for c in &actuales {
        if !materias.iter().any(|m| m["nombre"] == c["nombre"]) {
            materias.push(json!({ "nombre": c["nombre"], "oculta": oculto(c) }));
        }
    }
    materias.sort_by_key(|m| clave_orden(s(&m["nombre"])));
    let generado = crate::datos::ahora_iso();
    let completa = if atajo { anterior.as_ref().map(|a| if a["completa"].is_string() { a["completa"].clone() } else { a["generado"].clone() }).unwrap() } else { json!(generado) };
    let nombre = [s(&u["firstname"]), s(&u["fullname"]), s(&u["username"])].into_iter().find(|x| !x.is_empty()).unwrap_or("");
    Ok(json!({ "usuario": nombre, "cuenta": u["username"], "generado": generado, "completa": completa, "cursos": cursos, "materias": materias }))
}

// ---- Detalle y muestras ----

const MAX_ARCHIVOS: usize = 8;
const CACHE_DETALLE: Duration = Duration::from_secs(15 * 60);
static DETALLES: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);
static MUESTRAS: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);
const TOPE_MUESTRAS: usize = 24 * 1024 * 1024; // caracteres en base64, ~18 MB

fn archivos_modulo(modulo: Option<&Value>, origen: &str) -> Vec<Value> {
    let Some(m) = modulo else { return vec![] };
    lista(&m["contents"])
        .into_iter()
        .filter(|f| f["type"] == "file" && f["fileurl"].is_string() && !s(&f["filename"]).is_empty() && f["filename"] != ".")
        .map(|f| json!({ "nombre": f["filename"], "bytes": f["filesize"], "mime": f["mimetype"], "url": f["fileurl"], "origen": origen }))
        .collect()
}

// Instrucciones y archivos de una tarea (los propios y los «de al lado»).
pub async fn detalle(curso_id: &str, tarea: &Value) -> R<Value> {
    let clave = format!("{}|{curso_id}|{}", escuela(), s(&tarea["id"]));
    if let Some((cuando, d)) = DETALLES.lock().unwrap().get(&clave) {
        if cuando.elapsed() < CACHE_DETALLE {
            return Ok(d.clone());
        }
    }
    let rel = lista(&tarea["relacionados"]);
    let mut archivos = lista(&tarea["adjuntos"]);
    if !rel.is_empty() {
        let secciones = ws_opcional("core_course_get_contents", json!({ "courseid": curso_id.parse::<i64>().unwrap_or(0) }), json!([])).await?;
        let modulos: HashMap<String, Value> = lista(&secciones).iter().flat_map(|x| lista(&x["modules"])).map(|m| (m["id"].to_string(), m)).collect();
        for r in rel {
            let origen = if r["carpeta"] == true { s(&r["titulo"]).to_string() } else { "Misma sección".into() };
            archivos.extend(archivos_modulo(modulos.get(s(&r["id"])), &origen));
        }
    }
    let mut vistos = HashSet::new();
    let archivos: Vec<Value> = archivos.into_iter().filter(|a| !s(&a["nombre"]).is_empty() && vistos.insert(s(&a["url"]).split('?').next().unwrap_or("").to_string())).take(MAX_ARCHIVOS).collect();
    let d = json!({ "instrucciones": tarea["instrucciones"].as_str().unwrap_or(""), "archivos": archivos });
    let mut c = DETALLES.lock().unwrap();
    c.retain(|_, (cuando, _)| cuando.elapsed() < CACHE_DETALLE);
    c.insert(clave, (Instant::now(), d.clone()));
    Ok(d)
}

fn clave_muestra(a: &Value) -> String {
    format!("{}|{}", s(&a["nombre"]), s(&a["url"]).split('?').next().unwrap_or(""))
}

fn peso(m: &Value) -> usize {
    s(&m["datos"]).len() + s(&m["src"]).len() + 512
}

// Lo más viejo sale primero cuando las muestras pasan del tope.
fn guardar_muestra(clave: String, m: Value) {
    let mut c = MUESTRAS.lock().unwrap();
    c.retain(|_, (cuando, _)| cuando.elapsed() < 6 * CACHE_DETALLE);
    c.insert(clave, (Instant::now(), m));
    let mut total: usize = c.values().map(|(_, m)| peso(m)).sum();
    while total > TOPE_MUESTRAS {
        let Some(k) = c.iter().min_by_key(|(_, (t, _))| *t).map(|(k, _)| k.clone()) else { break };
        total -= c.remove(&k).map(|(_, m)| peso(&m)).unwrap_or(0);
    }
}

// La vista previa dibujó la primera página del PDF: se guarda esa imagen en vez del archivo.
pub fn guardar_miniatura_pdf(archivo: &Value, src: &str) {
    if !src.starts_with("data:image/") {
        return;
    }
    let clave = clave_muestra(archivo);
    let bytes = MUESTRAS.lock().unwrap().get(&clave).map(|(_, m)| m["bytes"].clone());
    if let Some(bytes) = bytes {
        guardar_muestra(clave, json!({ "tipo": "pdf", "src": src, "bytes": bytes }));
    }
}

// Las imágenes viajan reducidas: una foto del celular pesa varios MB.
fn miniatura(datos: &[u8]) -> Option<String> {
    let img = image::load_from_memory(datos).ok()?;
    let img = if img.width() > 680 { img.resize(680, u32::MAX, image::imageops::FilterType::Triangle) } else { img };
    // JPEG no tiene transparencia: lo transparente queda blanco, no negro.
    let mut rgba = img.to_rgba8();
    for p in rgba.pixels_mut() {
        let a = p[3] as u32;
        for c in 0..3 {
            p[c] = ((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8;
        }
    }
    let mut salida = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(rgba).to_rgb8().write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut salida, 84)).ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(salida.into_inner())))
}

fn texto_xml(xml: &str, parrafo: &str) -> String {
    static ETIQUETA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static LINEAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{2,}").unwrap());
    let t = xml.replace(&format!("</{parrafo}>"), "\n");
    let t = ETIQUETA.replace_all(&t, "");
    let t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    LINEAS.replace_all(&t, "\n").trim().to_string()
}

fn corto(t: String, max: usize) -> String {
    t.chars().take(max).collect()
}

async fn muestra(a: &Value) -> Option<Value> {
    let nombre = s(&a["nombre"]).to_lowercase();
    let mime = s(&a["mime"]);
    let ext = nombre.rsplit('.').next().unwrap_or("");
    let es_imagen = mime.starts_with("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext);
    let es_zip = ext == "zip" || mime.contains("zip");
    let es_office = ext == "docx" || ext == "pptx";
    let es_codigo = ["txt", "c", "cc", "cpp", "h", "hpp", "py", "java", "js", "ts", "cs", "md", "csv", "json", "sql", "html", "css", "m", "r", "asm"].contains(&ext) || mime.starts_with("text/");
    let es_pdf = ext == "pdf" || mime == "application/pdf";
    if !(es_imagen || es_zip || es_office || es_codigo || es_pdf) {
        return None;
    }
    let max = if es_imagen { 6e6 } else if es_codigo { 300e3 } else if es_pdf { 10e6 } else { 12e6 } as usize;
    let (datos, _) = leer_bytes(s(&a["url"]), max).await.ok()??;
    // La primera página la dibuja la vista previa con pdf.js.
    if es_pdf {
        return Some(json!({ "tipo": "pdf", "datos": B64.encode(&datos) }));
    }
    if es_imagen {
        return Some(json!({ "tipo": "imagen", "src": miniatura(&datos)? }));
    }
    if es_codigo && !es_office {
        let texto = String::from_utf8_lossy(&datos).replace('\r', "");
        let lineas: Vec<&str> = texto.split('\n').collect();
        return Some(json!({ "tipo": "codigo", "lineas": &lineas[..lineas.len().min(12)], "resto": lineas.len().saturating_sub(12) }));
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(datos)).ok()?;
    let mut leer = |n: &str| -> Option<String> {
        let mut f = zip.by_name(n).ok()?;
        let mut t = String::new();
        std::io::Read::read_to_string(&mut f, &mut t).ok()?;
        Some(t)
    };
    if ext == "docx" {
        return Some(json!({ "tipo": "texto", "texto": corto(texto_xml(&leer("word/document.xml")?, "w:p"), 400) }));
    }
    if ext == "pptx" {
        let xml = leer("ppt/slides/slide1.xml")?;
        let re = Regex::new(r"^ppt/slides/slide\d+\.xml$").unwrap();
        let diapositivas = zip.file_names().filter(|n| re.is_match(n)).count();
        return Some(json!({ "tipo": "texto", "texto": corto(texto_xml(&xml, "a:p"), 300), "nota": format!("{diapositivas} diapositivas") }));
    }
    let basura = Regex::new(r"(^|/)(__MACOSX|\.DS_Store)").unwrap();
    let archivos: Vec<String> = zip.file_names().filter(|n| !n.ends_with('/') && !basura.is_match(n)).map(String::from).collect();
    Some(json!({ "tipo": "zip", "archivos": &archivos[..archivos.len().min(8)], "resto": archivos.len().saturating_sub(8) }))
}

// Las muestras se piden aparte y llegan cuando están: un archivo de varios MB
// no debe retrasar las instrucciones. Se guardan por archivo, sin la firma de la URL.
pub async fn muestra_de(a: &Value) -> Option<Value> {
    let clave = clave_muestra(a);
    if let Some((cuando, m)) = MUESTRAS.lock().unwrap().get(&clave) {
        if cuando.elapsed() < 6 * CACHE_DETALLE {
            return Some(m.clone());
        }
    }
    let mut m = tokio::time::timeout(Duration::from_secs(45), muestra(a)).await.ok()??;
    m["bytes"] = a["bytes"].clone();
    guardar_muestra(clave, m.clone());
    Some(m)
}

// ---- Mensajes, anuncios y notificaciones (la bolita del widget) ----
//
// Sólo se leen: marcar como visto pasa en la app, no en Moodle.

fn extracto(html: &str) -> String {
    corto(texto(html).split_whitespace().collect::<Vec<_>>().join(" "), 280)
}

async fn conversaciones(yo: &Value) -> Result<Vec<Value>, ()> {
    let base = escuela();
    let r = ws_opcional("core_message_get_conversations", json!({ "userid": yo["userid"], "limitfrom": 0, "limitnum": 15 }), Value::Null).await.map_err(|_| ())?;
    if r.is_null() {
        return Err(());
    }
    let mut l = vec![];
    for c in lista(&r["conversations"]) {
        // type 3: conversación contigo mismo (notas personales).
        if c["type"] == 3 {
            continue;
        }
        let nombres: HashMap<String, Value> = lista(&c["members"]).into_iter().map(|m| (m["id"].to_string(), m["fullname"].clone())).collect();
        let curso = if c["type"] == 2 { c["name"].as_str().filter(|x| !x.is_empty()).unwrap_or("Grupo") } else { "Mensaje directo" };
        for m in lista(&c["messages"]) {
            if m["useridfrom"] == yo["userid"] {
                continue;
            }
            let de = nombres.get(&m["useridfrom"].to_string()).and_then(|v| v.as_str()).or(c["name"].as_str()).filter(|x| !x.is_empty()).unwrap_or("Moodle");
            l.push(json!({ "id": format!("m:{}", m["id"]), "tipo": "mensaje", "curso": curso, "de": de, "texto": extracto(s(&m["text"])), "cuando": iso(&m["timecreated"]), "leidoEnBb": c["isread"] == true, "enlace": format!("{base}/message/index.php?convid={}", c["id"]) }));
        }
    }
    Ok(l)
}

async fn anuncios(cursos: &[Value]) -> Result<Vec<Value>, ()> {
    let ids: Vec<i64> = cursos.iter().filter_map(|c| s(&c["id"]).parse().ok()).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let foros = ws_opcional("mod_forum_get_forums_by_courses", json!({ "courseids": ids }), Value::Null).await.map_err(|_| ())?;
    if foros.is_null() {
        return Err(());
    }
    let nombre_de: HashMap<String, Value> = cursos.iter().map(|c| (s(&c["id"]).to_string(), c["nombre"].clone())).collect();
    let base = escuela();
    let listas = join_all(lista(&foros).into_iter().filter(|f| f["type"] == "news").map(|f| {
        let (nombre_de, base) = (&nombre_de, &base);
        async move {
            let r = ws_opcional("mod_forum_get_forum_discussions", json!({ "forumid": f["id"], "sortorder": -1, "page": 0, "perpage": 10 }), json!({ "discussions": [] })).await.unwrap_or(json!({}));
            lista(&r["discussions"])
                .into_iter()
                .map(|d| {
                    let id = if d["discussion"].is_null() { &d["id"] } else { &d["discussion"] };
                    let cuando = [&d["created"], &d["timemodified"], &d["modified"]].into_iter().find(|x| n(x) > 0.0).cloned().unwrap_or(Value::Null);
                    let de = [s(&d["subject"]), s(&d["name"])].into_iter().find(|x| !x.is_empty()).unwrap_or("Anuncio");
                    json!({ "id": format!("a:{id}"), "tipo": "anuncio", "curso": nombre_de.get(&f["course"].to_string()).cloned().unwrap_or(json!("")), "de": de, "texto": extracto(s(&d["message"])), "cuando": iso(&cuando), "leidoEnBb": false, "enlace": format!("{base}/mod/forum/discuss.php?d={id}") })
                })
                .collect::<Vec<_>>()
        }
    }))
    .await;
    Ok(listas.concat())
}

async fn notificaciones(yo: &Value) -> Result<Vec<Value>, ()> {
    let r = ws_opcional("message_popup_get_popup_notifications", json!({ "useridto": yo["userid"], "newestfirst": 1, "limit": 20, "offset": 0 }), Value::Null).await.map_err(|_| ())?;
    let base = escuela();
    Ok(lista(&r["notifications"])
        .into_iter()
        .filter(|x| x["component"] != "mod_forum")
        .map(|x| {
            let cuerpo = [s(&x["smallmessage"]), s(&x["fullmessagehtml"]), s(&x["fullmessage"])].into_iter().find(|t| !t.is_empty()).unwrap_or("");
            json!({ "id": format!("n:{}", x["id"]), "tipo": "notificacion", "curso": "", "de": format!("🔔 {}", x["subject"].as_str().filter(|t| !t.is_empty()).unwrap_or("Notificación")), "texto": extracto(cuerpo), "cuando": iso(&x["timecreated"]), "leidoEnBb": x["read"] == true, "enlace": x["contexturl"].as_str().map(String::from).unwrap_or(format!("{base}/message/output/popup/notifications.php")) })
        })
        .collect())
}

// Lo más reciente primero. `fallidos` cuenta las fuentes que no se pudieron
// leer, para no decir «no hay mensajes» cuando no se sabe.
pub async fn mensajes(cursos: Vec<Value>) -> R<(Vec<Value>, usize, usize)> {
    let yo = usuario_actual().await?;
    let (a, b, c) = futures::join!(conversaciones(&yo), anuncios(&cursos), notificaciones(&yo));
    let resultados = [a, b, c];
    let fallidos = resultados.iter().filter(|r| r.is_err()).count();
    let mut l: Vec<Value> = resultados.into_iter().flat_map(|r| r.unwrap_or_default()).filter(|m| m["cuando"].is_string()).collect();
    l.sort_by(|x, y| s(&y["cuando"]).cmp(s(&x["cuando"])));
    l.truncate(40);
    Ok((l, fallidos, 3))
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn empareja_material_por_numero() {
        let hermanos = vec![
            json!({ "id": 2, "modname": "resource", "name": "Ejercicios 2.4" }),
            json!({ "id": 3, "modname": "resource", "name": "Ejercicios 2.5" }),
            json!({ "id": 4, "modname": "resource", "name": "Práctica 1 resuelta" }),
            json!({ "id": 5, "modname": "resource", "name": "Tarea 1 apuntes" }),
        ];
        let r = relacionados("Tarea 2.4", &json!(1), &hermanos);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["id"], "2");
        let r = relacionados("Tarea 1", &json!(1), &hermanos);
        assert_eq!(r.iter().map(|x| x["id"].clone()).collect::<Vec<_>>(), vec![json!("5")]);
        assert_eq!(nombre_corto("Cálculo Vectorial_ING_2026A"), "Cálculo Vectorial");
    }
}
