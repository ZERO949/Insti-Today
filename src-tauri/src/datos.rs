// Lo que vive en la carpeta de datos: ajustes.json (escuela, cuenta,
// preferencias, tareas quitadas…), sesion.json (el token) y cuentas.json.
// Es la misma carpeta y el mismo formato que la versión de Electron: al
// actualizar no hay que volver a entrar.

use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub fn inicio() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

// %APPDATA%\insti-today en Windows, ~/Library/Application Support/Insti Today
// en Mac y ~/.config/insti-today en Linux. INSTI_DATOS (o BB_DATOS) apunta a otra.
pub fn dir() -> &'static PathBuf {
    static D: OnceLock<PathBuf> = OnceLock::new();
    D.get_or_init(|| {
        if let Some(d) = std::env::var_os("INSTI_DATOS").or_else(|| std::env::var_os("BB_DATOS")) {
            return d.into();
        }
        if cfg!(target_os = "macos") {
            return inicio().join("Library/Application Support/Insti Today");
        }
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| inicio().join(".config")).join("insti-today")
    })
}

pub fn ruta(nombre: &str) -> PathBuf {
    dir().join(nombre)
}

pub fn leer(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

pub fn escribir(p: &Path, v: &Value) {
    if let Some(padre) = p.parent() {
        let _ = fs::create_dir_all(padre);
    }
    let _ = fs::write(p, serde_json::to_string(v).unwrap_or_default());
}

// Registro de errores para poder diagnosticar sin consola.
pub fn registrar(contexto: &str, error: impl std::fmt::Display) {
    use std::io::Write;
    let _ = fs::create_dir_all(dir());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(ruta("registro.log")) {
        let _ = writeln!(f, "{} {contexto}: {error}", chrono::Utc::now().to_rfc3339());
    }
}

pub fn ahora_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn ahora_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---- ajustes.json ----

pub fn ajustes() -> Map<String, Value> {
    leer(&ruta("ajustes.json")).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

pub fn guardar_ajustes(cambios: Value) -> Map<String, Value> {
    let mut a = ajustes();
    if let Value::Object(c) = cambios {
        for (k, v) in c {
            a.insert(k, v);
        }
    }
    escribir(&ruta("ajustes.json"), &Value::Object(a.clone()));
    a
}

// ---- Preferencias (ajustes.json → prefs) ----

pub fn predeterminadas() -> Value {
    json!({
        "diasAdelante": 0, "diasAtras": 7, "soloTardias": true, "sinFecha": true, "sinFechaDias": 14,
        "tema": "sistema", "opacidad": 92, "tamano": 1, "vistaPrevia": true, "avisos": true, "avisoHoras": 3,
        "intervaloMin": 60, "experimental": false, "verSemana": true, "verSiguiente": true, "verAnillo": true,
        "verSaludo": true, "resumenHora": 0, "vidrioLiquido": false, "tutorialVisto": false, "barraPlegada": true,
        "avisoVersion": ""
    })
}

fn permitidos(clave: &str) -> Option<Value> {
    Some(match clave {
        "diasAdelante" => json!([0, 1, 2, 6, 13]),
        "diasAtras" => json!([0, 1, 3, 7, 14]),
        "tema" => json!(["medianoche", "marca", "claro", "papel", "vidrio", "bosque", "oceano", "lavanda", "cereza", "contraste", "sistema"]),
        "tamano" => json!([0.9, 1, 1.15]),
        "avisoHoras" => json!([1, 2, 3, 6, 12]),
        "intervaloMin" => json!([30, 60, 120]),
        "resumenHora" => json!([0, 7, 13, 19]),
        "sinFechaDias" => json!([7, 14, 30, 60, 0]),
        _ => return None,
    })
}

// 1 y 1.0 son el mismo valor para la ventana.
fn igual(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

pub fn prefs() -> Value {
    let mut p = predeterminadas();
    if let Some(Value::Object(g)) = ajustes().get("prefs") {
        for (k, v) in g {
            if p.get(k).is_some() {
                p[k] = v.clone();
            }
        }
    }
    p
}

// Lo que llegue de la ventana se ajusta a los valores permitidos.
pub fn guardar_prefs(cambios: &Value) -> Value {
    let base = predeterminadas();
    let mut p = prefs();
    for (clave, valor) in cambios.as_object().into_iter().flatten() {
        let Some(defecto) = base.get(clave) else { continue };
        if let Some(lista) = permitidos(clave) {
            if !lista.as_array().unwrap().iter().any(|x| igual(x, valor)) {
                continue;
            }
        }
        p[clave] = if defecto.is_boolean() {
            json!(valor.as_bool().unwrap_or(false) || valor.as_f64().is_some_and(|n| n != 0.0))
        } else if clave == "avisoVersion" {
            let s = valor.as_str().unwrap_or("");
            let ok = regex::Regex::new(r"(?i)^[0-9][0-9a-z.\-]{0,39}$").unwrap().is_match(s);
            json!(if ok { s } else { "" })
        } else if clave == "opacidad" {
            json!(valor.as_f64().unwrap_or(92.0).round().clamp(0.0, 100.0) as i64)
        } else {
            valor.clone()
        };
    }
    let mut a = ajustes();
    a.insert("prefs".into(), p.clone());
    escribir(&ruta("ajustes.json"), &Value::Object(a));
    p
}

fn lista_ajuste(clave: &str) -> Vec<Value> {
    ajustes().get(clave).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

pub fn ocultas() -> Vec<Value> {
    lista_ajuste("ocultar")
}

pub fn guardar_ocultas(lista: &Value) {
    let mut vistas = Vec::<Value>::new();
    for x in lista.as_array().into_iter().flatten() {
        if x.as_str().is_some_and(|s| !s.is_empty()) && !vistas.contains(x) {
            vistas.push(x.clone());
        }
    }
    guardar_ajustes(json!({ "ocultar": vistas }));
}

// Tareas quitadas con la ✕: lo justo para enseñarlas en Ajustes y devolverlas.
pub fn descartadas() -> Vec<Value> {
    lista_ajuste("descartadas")
}

pub fn descartar(id: &str, titulo: &str, curso: &str) -> Vec<Value> {
    let mut l: Vec<Value> = descartadas().into_iter().filter(|t| t["id"] != id).collect();
    l.insert(0, json!({ "id": id, "titulo": titulo, "curso": curso, "cuando": ahora_iso() }));
    guardar_ajustes(json!({ "descartadas": l }));
    l
}

// Sin id, devuelve todas.
pub fn restaurar(id: Option<&str>) -> Vec<Value> {
    let l: Vec<Value> = match id {
        Some(id) => descartadas().into_iter().filter(|t| t["id"] != id).collect(),
        None => vec![],
    };
    guardar_ajustes(json!({ "descartadas": l }));
    l
}

// «Hoy no»: escondidas hasta una fecha (ms). Las que ya volvieron se olvidan solas.
pub fn pospuestas() -> Vec<Value> {
    let ahora = ahora_ms() as f64;
    lista_ajuste("pospuestas").into_iter().filter(|t| t["hasta"].as_f64().unwrap_or(0.0) > ahora).collect()
}

pub fn posponer(id: &str, hasta: f64) -> Vec<Value> {
    let mut l: Vec<Value> = pospuestas().into_iter().filter(|t| t["id"] != id).collect();
    l.push(json!({ "id": id, "hasta": hasta }));
    guardar_ajustes(json!({ "pospuestas": l }));
    l
}

pub fn volver(id: &str) -> Vec<Value> {
    let l: Vec<Value> = pospuestas().into_iter().filter(|t| t["id"] != id).collect();
    guardar_ajustes(json!({ "pospuestas": l }));
    l
}

// ---- Varias cuentas ----
//
// La cuenta activa vive donde siempre (sesion.json, agenda.json… en la carpeta
// de datos). Las demás esperan en cuentas/<id>/; cambiar de cuenta es mover
// sus archivos. Cada cuenta tiene su propio navegador (una carpeta de datos de
// WebView2), para que las cookies de Moodle no se mezclen, y un color.
//
// cuentas.json: { activa, pendiente, lista: [{ id, usuario, nombre, url, color, particion }] }

pub const PARTICION_ORIGINAL: &str = "persist:moodle";
pub const COLORES: [&str; 8] = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#40c8e0", "#ffcc00", "#a2845e"];
const ARCHIVOS: [&str; 6] = ["sesion.json", "agenda.json", "mensajes.json", "mensajes-vistos.json", "entregas.json", "avisados.json"];
// De ajustes.json, lo que es de cada cuenta: la escuela, el usuario, las tareas quitadas y las materias ocultas.
const AJUSTES_CUENTA: [&str; 4] = ["url", "cuenta", "descartadas", "ocultar"];

fn clave(url: &str, usuario: &str) -> String {
    format!("{}|{}", crate::moodle::normalizar_url(url).unwrap_or_default(), usuario.to_lowercase())
}

fn nuevo_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

// El registro. La primera vez se arma con la sesión que ya había.
fn registro() -> Value {
    if let Some(r) = leer(&ruta("cuentas.json")).filter(|r| r["lista"].is_array()) {
        return r;
    }
    let mut r = json!({ "activa": null, "pendiente": null, "lista": [] });
    if let Some(s) = crate::moodle::leer_sesion().filter(|s| s["token"].is_string()) {
        let id = nuevo_id();
        r["lista"] = json!([{ "id": id, "usuario": s["usuario"], "nombre": if s["nombre"].is_string() { &s["nombre"] } else { &s["usuario"] }, "url": s["url"], "color": COLORES[0], "particion": PARTICION_ORIGINAL }]);
        r["activa"] = json!(id);
    }
    escribir(&ruta("cuentas.json"), &r);
    r
}

fn guardar_registro(r: &Value) {
    escribir(&ruta("cuentas.json"), r)
}

fn lista_de(r: &Value) -> Vec<Value> {
    r["lista"].as_array().cloned().unwrap_or_default()
}

pub fn lista() -> Vec<Value> {
    let r = registro();
    lista_de(&r)
        .into_iter()
        .map(|mut c| {
            c["activa"] = json!(c["id"] == r["activa"]);
            c
        })
        .collect()
}

pub fn activa() -> Option<Value> {
    let r = registro();
    lista_de(&r).into_iter().find(|c| c["id"] == r["activa"])
}

// La partición del navegador de la cuenta activa (o de la que se está añadiendo).
pub fn particion() -> String {
    let r = registro();
    let c = lista_de(&r).into_iter().find(|c| c["id"] == r["activa"]).unwrap_or_else(|| r["pendiente"].clone());
    c["particion"].as_str().unwrap_or(PARTICION_ORIGINAL).to_string()
}

fn quitar(p: &Path) {
    let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
}

fn mover(desde: &Path, hacia: &Path) {
    quitar(hacia);
    if fs::rename(desde, hacia).is_err() {
        // Otro disco o un archivo abierto: se copia.
        if fs::copy(desde, hacia).is_ok() {
            quitar(desde);
        }
    }
}

// La cuenta activa se guarda en cuentas/<id>/ y su lugar queda vacío.
fn guardar_activa(r: &mut Value) {
    let Some(id) = r["activa"].as_str().map(String::from) else { return };
    let dir = ruta("cuentas").join(&id);
    let _ = fs::create_dir_all(&dir);
    for n in ARCHIVOS {
        let p = ruta(n);
        if p.exists() {
            mover(&p, &dir.join(n));
        } else {
            quitar(&dir.join(n));
        }
    }
    let mut a = ajustes();
    let propios: Map<String, Value> = AJUSTES_CUENTA.iter().map(|k| (k.to_string(), a.get(*k).cloned().unwrap_or(Value::Null))).collect();
    escribir(&dir.join("ajustes-cuenta.json"), &Value::Object(propios));
    for k in AJUSTES_CUENTA.iter().filter(|k| **k != "url") {
        a.remove(*k);
    }
    escribir(&ruta("ajustes.json"), &Value::Object(a));
    r["activa"] = Value::Null;
}

// Los archivos de cuentas/<id>/ pasan a la carpeta de datos.
fn traer(r: &mut Value, id: &str) {
    let dir = ruta("cuentas").join(id);
    for n in ARCHIVOS {
        let g = dir.join(n);
        if g.exists() {
            mover(&g, &ruta(n));
        } else {
            quitar(&ruta(n));
        }
    }
    let propios = leer(&dir.join("ajustes-cuenta.json")).unwrap_or(json!({}));
    let mut a = ajustes();
    for k in AJUSTES_CUENTA {
        match propios.get(k) {
            Some(v) if !v.is_null() => {
                a.insert(k.into(), v.clone());
            }
            _ if k != "url" => {
                a.remove(k);
            }
            _ => {}
        }
    }
    // La escuela de la cuenta manda sobre la que quedó guardada.
    if let Some(url) = lista_de(r).iter().find(|c| c["id"] == id).and_then(|c| c["url"].as_str()) {
        a.insert("url".into(), json!(url));
    }
    escribir(&ruta("ajustes.json"), &Value::Object(a));
    quitar(&dir);
    r["activa"] = json!(id);
    r["pendiente"] = Value::Null;
}

pub fn cambiar(id: &str) -> Result<(), String> {
    let mut r = registro();
    if !lista_de(&r).iter().any(|c| c["id"] == id) {
        return Err("Esa cuenta ya no existe.".into());
    }
    if r["activa"] == id {
        return Ok(());
    }
    guardar_activa(&mut r);
    traer(&mut r, id);
    guardar_registro(&r);
    Ok(())
}

// Antes de abrir el inicio de sesión para otra cuenta: la activa se guarda y
// la nueva tendrá su propio navegador. Devuelve el id de la anterior.
pub fn preparar_nueva() -> Option<String> {
    let mut r = registro();
    let anterior = r["activa"].as_str().map(String::from);
    guardar_activa(&mut r);
    let id = nuevo_id();
    r["pendiente"] = json!({ "id": id, "particion": format!("persist:moodle-{id}") });
    guardar_registro(&r);
    anterior
}

// Se cerró el inicio de sesión sin entrar: vuelve la cuenta de antes.
pub fn cancelar_nueva(anterior: Option<String>) {
    let mut r = registro();
    r["pendiente"] = Value::Null;
    if let Some(a) = anterior.filter(|a| lista_de(&r).iter().any(|c| c["id"] == a.as_str())) {
        traer(&mut r, &a);
    }
    guardar_registro(&r);
}

// Tras entrar con usuario y contraseña. Devuelve la partición que sobra si la
// cuenta ya estaba guardada aparte con otro navegador.
pub fn registrar_cuenta(usuario: &str, nombre: &str, url: &str) -> Option<String> {
    let mut r = registro();
    let k = clave(url, usuario);
    let mut lista = lista_de(&r);
    if let Some(actual) = lista.iter_mut().find(|c| c["id"] == r["activa"]) {
        if clave(actual["url"].as_str().unwrap_or(""), actual["usuario"].as_str().unwrap_or("")) == k {
            actual["usuario"] = json!(usuario);
            actual["nombre"] = json!(nombre);
            actual["url"] = json!(url);
            r["lista"] = json!(lista);
            guardar_registro(&r);
            return None;
        }
        guardar_activa(&mut r);
    }
    let pendiente = r["pendiente"].clone();
    let id = pendiente["id"].as_str().map(String::from).unwrap_or_else(nuevo_id);
    let part = pendiente["particion"].as_str().map(String::from).unwrap_or_else(|| {
        if lista.is_empty() { PARTICION_ORIGINAL.into() } else { format!("persist:moodle-{id}") }
    });
    let mut color = COLORES.iter().find(|c| !lista.iter().any(|x| x["color"] == **c)).copied().unwrap_or(COLORES[lista.len() % COLORES.len()]).to_string();
    let mut sobra = None;
    if let Some(i) = lista.iter().position(|c| clave(c["url"].as_str().unwrap_or(""), c["usuario"].as_str().unwrap_or("")) == k) {
        let rep = lista.remove(i);
        color = rep["color"].as_str().unwrap_or(&color).to_string();
        if rep["particion"].as_str() != Some(&part) {
            sobra = rep["particion"].as_str().map(String::from);
        }
        quitar(&ruta("cuentas").join(rep["id"].as_str().unwrap_or("_")));
    }
    lista.push(json!({ "id": id, "usuario": usuario, "nombre": if nombre.is_empty() { usuario } else { nombre }, "url": url, "color": color, "particion": part }));
    r["lista"] = json!(lista);
    r["activa"] = json!(id);
    r["pendiente"] = Value::Null;
    guardar_registro(&r);
    sobra
}

pub fn cambiar_color(id: &str, color: &str) {
    if !COLORES.contains(&color) {
        return;
    }
    let mut r = registro();
    let mut lista = lista_de(&r);
    if let Some(c) = lista.iter_mut().find(|c| c["id"] == id) {
        c["color"] = json!(color);
    }
    r["lista"] = json!(lista);
    guardar_registro(&r);
}

// Quita una cuenta. Si era la activa, borra sus archivos y pasa a la siguiente.
// Devuelve la partición a vaciar y si quedó una cuenta activa.
pub fn quitar_cuenta(id: &str) -> (Option<String>, bool) {
    let mut r = registro();
    let mut lista = lista_de(&r);
    let Some(i) = lista.iter().position(|c| c["id"] == id) else { return (None, activa().is_some()) };
    let c = lista.remove(i);
    r["lista"] = json!(lista);
    if r["activa"] == id {
        r["activa"] = Value::Null;
        for n in ARCHIVOS {
            quitar(&ruta(n));
        }
        let mut a = ajustes();
        for k in AJUSTES_CUENTA.iter().filter(|k| **k != "url") {
            a.remove(*k);
        }
        escribir(&ruta("ajustes.json"), &Value::Object(a));
        if let Some(primera) = lista.first().and_then(|c| c["id"].as_str()).map(String::from) {
            traer(&mut r, &primera);
        }
    } else {
        quitar(&ruta("cuentas").join(id));
    }
    guardar_registro(&r);
    let hay = !r["activa"].is_null();
    (c["particion"].as_str().map(String::from), hay)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn prefs_se_ajustan_a_lo_permitido() {
        std::env::set_var("INSTI_DATOS", std::env::temp_dir().join(format!("insti-prueba-{}", nuevo_id())));
        let p = guardar_prefs(&json!({ "tamano": 1.15, "tema": "inventado", "opacidad": 140, "avisos": 0, "otra": 1 }));
        assert_eq!(p["tamano"], json!(1.15));
        assert_eq!(p["tema"], json!("sistema"));
        assert_eq!(p["opacidad"], json!(100));
        assert_eq!(p["avisos"], json!(false));
        assert!(p.get("otra").is_none());
    }
}
