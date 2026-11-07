// La sesión y el cliente de los servicios web REST de Moodle, autenticado con
// el token del estudiante (el mismo que usa la app oficial de Moodle).
//
// Sólo LEE: nada de aquí entrega, publica ni modifica algo en Moodle. El
// token sólo se añade a direcciones de la propia plataforma y nunca viaja a
// las ventanas.

use crate::datos;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub const ESCUELA_POR_DEFECTO: &str = "https://plataforma.uii.edu.mx/moodle";
pub const SERVICIO: &str = "moodle_mobile_app";
pub const MENSAJE_SESION: &str = "Tu sesión de Moodle se cerró. Inicia sesión de nuevo.";

#[derive(Debug, Clone)]
pub struct ErrorMoodle {
    pub mensaje: String,
    pub estado: u16,
}

impl ErrorMoodle {
    pub fn new(mensaje: impl Into<String>, estado: u16) -> Self {
        Self { mensaje: mensaje.into(), estado }
    }
}

impl std::fmt::Display for ErrorMoodle {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.mensaje)
    }
}

pub type R<T> = Result<T, ErrorMoodle>;

fn caducada() -> ErrorMoodle {
    ErrorMoodle::new(MENSAJE_SESION, 401)
}

// ---- La sesión ----

// Moodle puede vivir en una subcarpeta (https://plataforma.uii.edu.mx/moodle).
// Se queda con origen + carpeta y quita lo que se haya copiado de más.
pub fn normalizar_url(url: &str) -> Option<String> {
    let texto = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    let u = url::Url::parse(&texto).ok()?;
    static RESTO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/(login|my|course|mod|admin|user|calendar|message|grade|webservice|lib|theme|pluginfile\.php)(/.*)?$").unwrap());
    static INDICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/index\.php$").unwrap());
    let ruta = RESTO.replace(u.path(), "");
    let ruta = INDICE.replace(&ruta, "");
    Some(format!("{}{}", u.origin().ascii_serialization(), ruta.trim_end_matches('/')))
}

pub fn escuela() -> String {
    let url = datos::ajustes().get("url").and_then(|v| v.as_str()).map(String::from).unwrap_or(ESCUELA_POR_DEFECTO.into());
    normalizar_url(&url).unwrap_or_else(|| ESCUELA_POR_DEFECTO.into())
}

pub fn leer_sesion() -> Option<Value> {
    datos::leer(&datos::ruta("sesion.json"))
}

pub fn guardar_sesion(s: &Value) {
    datos::escribir(&datos::ruta("sesion.json"), s)
}

pub fn borrar_sesion() {
    let _ = std::fs::remove_file(datos::ruta("sesion.json"));
}

pub fn token() -> Option<String> {
    let s = leer_sesion()?;
    // Un token de otra plataforma no sirve en esta.
    if normalizar_url(s["url"].as_str()?)? != escuela() {
        return None;
    }
    s["token"].as_str().map(String::from)
}

// ---- La red ----

pub fn http() -> &'static reqwest::Client {
    static C: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().unwrap());
    &C
}

// Ocho consultas a la vez como mucho, para todo el programa.
static COLA: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
static PAUSA: Mutex<Option<Instant>> = Mutex::new(None);

fn espera_reintento(cabecera: Option<&str>, intento: u32) -> Duration {
    let indicado = cabecera.and_then(|c| c.trim().parse::<f64>().ok()).map(|s| Duration::from_secs_f64(s.max(0.0)));
    indicado.unwrap_or(Duration::from_millis(1000 * 2u64.pow(intento)))
}

// Respeta 429/503 (Retry-After) con hasta dos reintentos.
async fn consultar(pedido: impl Fn() -> reqwest::RequestBuilder) -> Result<reqwest::Response, reqwest::Error> {
    for intento in 0.. {
        let r = {
            let _turno = COLA.acquire().await.unwrap();
            let pausa = *PAUSA.lock().unwrap();
            if let Some(hasta) = pausa.filter(|h| *h > Instant::now()) {
                tokio::time::sleep(hasta - Instant::now()).await;
            }
            pedido().send().await?
        };
        if ![429, 503].contains(&r.status().as_u16()) {
            return Ok(r);
        }
        let espera = espera_reintento(r.headers().get("retry-after").and_then(|v| v.to_str().ok()), intento);
        if intento >= 2 || espera > Duration::from_secs(60) {
            return Ok(r);
        }
        let mut p = PAUSA.lock().unwrap();
        *p = Some(p.unwrap_or_else(Instant::now).max(Instant::now() + espera));
    }
    unreachable!()
}

fn sin_conexion(e: reqwest::Error) -> ErrorMoodle {
    ErrorMoodle::new(format!("Sin conexión con Moodle ({})", if e.is_timeout() { "tardó demasiado".into() } else { e.to_string() }), 0)
}

// Moodle recibe los parámetros como formulario con corchetes:
// { courseids: [3, 5] } → courseids[0]=3&courseids[1]=5
pub fn aplanar(valor: &Value, prefijo: &str, salida: &mut Vec<(String, String)>) {
    match valor {
        Value::Null => {}
        Value::Array(l) => l.iter().enumerate().for_each(|(i, v)| aplanar(v, &format!("{prefijo}[{i}]"), salida)),
        Value::Object(m) => m.iter().for_each(|(k, v)| aplanar(v, &if prefijo.is_empty() { k.clone() } else { format!("{prefijo}[{k}]") }, salida)),
        Value::Bool(b) => salida.push((prefijo.into(), if *b { "1" } else { "0" }.into())),
        Value::String(s) => salida.push((prefijo.into(), s.clone())),
        Value::Number(n) => salida.push((prefijo.into(), n.to_string())),
    }
}

const SESION_INVALIDA: [&str; 4] = ["invalidtoken", "accessexception", "usernotfullysetup", "tokennotfound"];

async fn llamar_crudo(funcion: &str, args: &Value) -> R<Value> {
    let t = token().ok_or_else(caducada)?;
    let mut cuerpo = vec![];
    aplanar(args, "", &mut cuerpo);
    cuerpo.push(("wstoken".into(), t));
    cuerpo.push(("wsfunction".into(), funcion.into()));
    let url = format!("{}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction={funcion}", escuela());
    let r = consultar(|| http().post(&url).header("Accept", "application/json").form(&cuerpo).timeout(Duration::from_secs(45))).await.map_err(sin_conexion)?;
    let estado = r.status().as_u16();
    if !r.status().is_success() {
        return Err(ErrorMoodle::new(format!("Moodle respondió {estado} [{funcion}]"), estado));
    }
    let datos: Value = r.json().await.map_err(|_| ErrorMoodle::new(format!("Moodle no respondió JSON [{funcion}]"), estado))?;
    if datos.get("exception").is_some_and(|e| !e.is_null()) {
        let codigo = datos["errorcode"].as_str().unwrap_or("");
        if SESION_INVALIDA.contains(&codigo) {
            return Err(caducada());
        }
        let estado = if codigo == "nopermissions" || codigo == "requireloginerror" { 403 } else { 400 };
        return Err(ErrorMoodle::new(format!("{} [{funcion}]", datos["message"].as_str().unwrap_or("Error de Moodle")), estado));
    }
    Ok(datos)
}

// Las lecturas iguales en menos de 30 s salen de la caché (la agenda y el
// detalle piden lo mismo).
static CACHE: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);

pub async fn ws(funcion: &str, args: Value) -> R<Value> {
    let clave = format!("{}|{funcion}|{args}", escuela());
    if let Some((cuando, v)) = CACHE.lock().unwrap().get(&clave) {
        if cuando.elapsed() < Duration::from_secs(30) {
            return Ok(v.clone());
        }
    }
    let v = llamar_crudo(funcion, &args).await?;
    let mut c = CACHE.lock().unwrap();
    // shortcut: al pasar de 300 entradas se vacía entera; un LRU si alguna vez molesta.
    if c.len() > 300 {
        c.clear();
    }
    c.insert(clave, (Instant::now(), v.clone()));
    Ok(v)
}

// Igual que ws(), pero devuelve `defecto` si la función no existe o no está
// permitida en esta escuela. Una sesión caducada, un fallo de red o del
// servidor sí se propagan: un vacío pasaría por «no hay nada».
pub async fn ws_opcional(funcion: &str, args: Value, defecto: Value) -> R<Value> {
    match ws(funcion, args).await {
        Err(e) if e.estado == 401 || e.estado == 0 || e.estado == 429 || e.estado >= 500 => Err(e),
        Err(_) => Ok(defecto),
        ok => ok,
    }
}

static YO: Mutex<Option<Value>> = Mutex::new(None);

pub async fn usuario_actual() -> R<Value> {
    if let Some(u) = YO.lock().unwrap().clone() {
        return Ok(u);
    }
    let u = ws("core_webservice_get_site_info", json!({})).await?;
    *YO.lock().unwrap() = Some(u.clone());
    Ok(u)
}

// Tras cerrar sesión o entrar con otra cuenta.
pub fn olvidar_usuario() {
    *YO.lock().unwrap() = None;
    CACHE.lock().unwrap().clear();
}

// Los archivos de Moodle (pluginfile.php) se leen con el token. Sólo se le
// pone el token a direcciones de tu propia plataforma.
pub fn url_con_token(direccion: &str) -> R<String> {
    let base = escuela();
    let raiz = url::Url::parse(&format!("{base}/")).map_err(|_| ErrorMoodle::new("Dirección no válida", 400))?;
    let mut u = raiz.join(direccion).map_err(|_| ErrorMoodle::new("Dirección no válida", 400))?;
    if u.origin() != raiz.origin() {
        return Err(ErrorMoodle::new(format!("Sólo se aceptan direcciones de {base}."), 400));
    }
    if u.path().contains("/pluginfile.php/") {
        if !u.path().contains("/webservice/pluginfile.php/") {
            let p = u.path().replacen("/pluginfile.php/", "/webservice/pluginfile.php/", 1);
            u.set_path(&p);
        }
        let t = token().ok_or_else(caducada)?;
        let otros: Vec<(String, String)> = u.query_pairs().filter(|(k, _)| k != "token").map(|(k, v)| (k.into(), v.into())).collect();
        u.query_pairs_mut().clear().extend_pairs(otros).append_pair("token", &t);
    }
    Ok(u.to_string())
}

async fn bajar(direccion: &str, espera: Duration) -> R<reqwest::Response> {
    let url = url_con_token(direccion)?;
    let r = consultar(|| http().get(&url).timeout(espera)).await.map_err(sin_conexion)?;
    let estado = r.status().as_u16();
    // Un token inválido en pluginfile devuelve una página de error.
    if estado == 401 || estado == 403 {
        return Err(caducada());
    }
    if !r.status().is_success() {
        return Err(ErrorMoodle::new(if estado == 404 { "El archivo ya no existe en Moodle.".into() } else { format!("Moodle respondió {estado}") }, estado));
    }
    let tipo = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if tipo.contains("json") {
        let d: Value = r.json().await.unwrap_or(json!({}));
        if SESION_INVALIDA.contains(&d["errorcode"].as_str().unwrap_or("")) {
            return Err(caducada());
        }
        return Err(ErrorMoodle::new(d["message"].as_str().unwrap_or("Moodle no entregó el archivo."), 400));
    }
    Ok(r)
}

// Descarga a memoria, para previsualizar. Si pasa de `maximo` bytes, None.
pub async fn leer_bytes(direccion: &str, maximo: usize) -> R<Option<(Vec<u8>, String)>> {
    let mut r = bajar(direccion, Duration::from_secs(60)).await?;
    if r.content_length().is_some_and(|n| n as usize > maximo) {
        return Ok(None);
    }
    let tipo = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut datos = vec![];
    while let Some(trozo) = r.chunk().await.map_err(sin_conexion)? {
        datos.extend_from_slice(&trozo);
        if datos.len() > maximo {
            return Ok(None);
        }
    }
    Ok(Some((datos, tipo)))
}

pub fn nombre_seguro(nombre: &str) -> String {
    static MALOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap());
    let s = MALOS.replace_all(nombre, "_");
    s.trim_end_matches(['.', ' ']).chars().take(150).collect()
}

pub fn ruta_libre(carpeta: &Path, nombre: &str) -> PathBuf {
    let p = Path::new(nombre);
    let raiz = p.file_stem().and_then(|s| s.to_str()).unwrap_or("archivo");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut candidato = carpeta.join(nombre);
    let mut n = 1;
    while candidato.exists() {
        candidato = carpeta.join(format!("{raiz} ({n}){ext}"));
        n += 1;
    }
    candidato
}

fn nombre_de_cabecera(disposicion: &str) -> Option<String> {
    static UTF8: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)filename\*=UTF-8''([^;]+)").unwrap());
    static SIMPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)filename="?([^";]+)"?"#).unwrap());
    if let Some(m) = UTF8.captures(disposicion) {
        return url::form_urlencoded::parse(format!("x={}", &m[1]).as_bytes()).next().map(|(_, v)| v.into_owned());
    }
    SIMPLE.captures(disposicion).map(|m| m[1].to_string())
}

pub async fn descargar(direccion: &str, carpeta: &Path, preferido: Option<&str>) -> R<PathBuf> {
    let mut r = bajar(direccion, Duration::from_secs(180)).await?;
    let de_cabecera = r.headers().get("content-disposition").and_then(|v| v.to_str().ok()).and_then(nombre_de_cabecera);
    let de_url = url::Url::parse(&format!("{}/", escuela()))
        .ok()
        .and_then(|b| b.join(direccion).ok())
        .and_then(|u| u.path_segments()?.next_back().map(|s| url::form_urlencoded::parse(format!("x={s}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default()));
    let nombre = nombre_seguro(&preferido.map(String::from).filter(|s| !s.is_empty()).or(de_cabecera).or(de_url).filter(|s| !s.is_empty()).unwrap_or("archivo".into()));
    std::fs::create_dir_all(carpeta).map_err(|e| ErrorMoodle::new(e.to_string(), 0))?;
    let destino = ruta_libre(carpeta, &nombre);
    let parcial = destino.with_extension(format!("{}.parcial", uuid::Uuid::new_v4().simple()));
    let mut datos = vec![];
    let resultado: R<()> = async {
        while let Some(trozo) = r.chunk().await.map_err(sin_conexion)? {
            datos.extend_from_slice(&trozo);
        }
        std::fs::write(&parcial, &datos).and_then(|_| std::fs::rename(&parcial, &destino)).map_err(|e| ErrorMoodle::new(e.to_string(), 0))
    }
    .await;
    let _ = std::fs::remove_file(&parcial);
    resultado.map(|_| destino)
}

// ---- Texto ----

// Moodle devuelve HTML. Se pasa a texto plano conservando los enlaces.
pub fn html_a_texto(html: &str) -> (String, Vec<String>) {
    static ENLACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(?:href|src)\s*=\s*["']([^"']+)["']"#).unwrap());
    static SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<script.*?</script>|<style.*?</style>").unwrap());
    static BR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
    static LI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<li[^>]*>").unwrap());
    static CIERRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</(p|div|h[1-6]|li|tr|ul|ol|table)>").unwrap());
    static ETIQUETA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    // Cualquier espacio antes de un salto: Moodle mete \r\n y &nbsp; que dejaban líneas «vacías».
    static ESPACIOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\S\n]+\n").unwrap());
    static LINEAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    if html.is_empty() {
        return (String::new(), vec![]);
    }
    let mut enlaces: Vec<String> = vec![];
    for m in ENLACE.captures_iter(html) {
        let e = decodificar(&m[1]);
        if !m[1].starts_with("javascript:") && !m[1].starts_with('#') && !enlaces.contains(&e) {
            enlaces.push(e);
        }
    }
    let t = SCRIPT.replace_all(html, "");
    let t = BR.replace_all(&t, "\n");
    let t = LI.replace_all(&t, "\n• ");
    let t = CIERRE.replace_all(&t, "\n");
    let t = ETIQUETA.replace_all(&t, "");
    let t = decodificar(&t);
    let t = ESPACIOS.replace_all(&t, "\n");
    let t = LINEAS.replace_all(&t, "\n\n");
    (t.trim().to_string(), enlaces)
}

pub fn texto(html: &str) -> String {
    html_a_texto(html).0
}

fn con_marca(letra: char, marca: &str) -> Option<char> {
    let (base, con) = match marca {
        "acute" => ("aeiouyAEIOUY", "áéíóúýÁÉÍÓÚÝ"),
        "grave" => ("aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        "uml" => ("aeiouyAEIOU", "äëïöüÿÄËÏÖÜ"),
        "circ" => ("aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        "tilde" => ("anoANO", "ãñõÃÑÕ"),
        "cedil" => ("cC", "çÇ"),
        _ => return None,
    };
    base.chars().position(|c| c == letra).and_then(|i| con.chars().nth(i))
}

fn decodificar(s: &str) -> String {
    static ENTIDAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);").unwrap());
    ENTIDAD
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            let fijo = match e {
                "nbsp" => Some(' '),
                "iquest" => Some('¿'),
                "iexcl" => Some('¡'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => None,
            };
            let num = if let Some(h) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
                u32::from_str_radix(h, 16).ok().and_then(char::from_u32)
            } else if let Some(d) = e.strip_prefix('#') {
                d.parse().ok().and_then(char::from_u32)
            } else {
                let mut cs = e.chars();
                cs.next().and_then(|l| con_marca(l, cs.as_str()))
            };
            fijo.or(num).map(String::from).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

// Moodle da fechas en segundos Unix; la app las usa en ISO (UTC).
pub fn iso(segundos: &Value) -> Value {
    let s = segundos.as_f64().or_else(|| segundos.as_str().and_then(|t| t.parse().ok())).unwrap_or(0.0);
    if s <= 0.0 {
        return Value::Null;
    }
    chrono::DateTime::from_timestamp_millis((s * 1000.0) as i64).map(|d| json!(d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))).unwrap_or(Value::Null)
}

// ---- Entrar ----

// Pide el token a /login/token.php. La contraseña no se guarda.
pub async fn pedir_token(base: &str, usuario: &str, contrasena: &str) -> Result<(String, Option<String>), String> {
    let r = http()
        .post(format!("{base}/login/token.php"))
        .header("Accept", "application/json")
        .form(&[("username", usuario.trim()), ("password", contrasena), ("service", SERVICIO)])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("No hay conexión con tu Moodle ({}).", if e.is_timeout() { "tardó demasiado".into() } else { e.to_string() }))?;
    let estado = r.status().as_u16();
    let d: Value = r.json().await.map_err(|_| "Tu Moodle respondió algo que no es JSON. Revisa la dirección de la plataforma.".to_string())?;
    if let Some(t) = d["token"].as_str() {
        return Ok((t.into(), d["privatetoken"].as_str().map(String::from)));
    }
    let codigo = d["errorcode"].as_str().unwrap_or("");
    Err(match codigo {
        "invalidlogin" => "Usuario o contraseña incorrectos.".into(),
        "enablewsdescription" => "Tu escuela no tiene activados los servicios web de Moodle. Pide a soporte que activen «Servicios para móviles».".into(),
        "servicenotavailable" => "Tu escuela no tiene activo el servicio de la app de Moodle.".into(),
        "sitemaintenance" => "La plataforma está en mantenimiento. Intenta más tarde.".into(),
        "usernotconfirmed" => "Tu cuenta aún no está confirmada en Moodle.".into(),
        "forcepasswordchangenotice" => "Moodle te pide cambiar la contraseña. Entra una vez en el navegador, cámbiala y vuelve a intentar.".into(),
        "restoredaccountresetpassword" => "Moodle te pide restablecer la contraseña. Hazlo en el navegador y vuelve a intentar.".into(),
        _ => d["error"].as_str().map(String::from).unwrap_or(format!("Moodle no dio un token ({}).", if codigo.is_empty() { estado.to_string() } else { codigo.into() })),
    })
}

pub async fn info_del_sitio(base: &str, token: &str) -> Result<Value, String> {
    let r = http()
        .post(format!("{base}/webservice/rest/server.php?moodlewsrestformat=json"))
        .form(&[("wstoken", token), ("wsfunction", "core_webservice_get_site_info")])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let info: Value = r.json().await.map_err(|e| e.to_string())?;
    if info.get("exception").is_some_and(|e| !e.is_null()) {
        return Err(info["message"].as_str().unwrap_or("Moodle rechazó el token.").into());
    }
    Ok(info)
}

// ¿Es un Moodle con servicios web? token.php sin usuario responde «missingparam» si están activos.
pub async fn comprobar_moodle(base: &str) -> Value {
    let Ok(r) = http().get(format!("{base}/login/token.php?service={SERVICIO}")).timeout(Duration::from_secs(15)).send().await else {
        return json!({ "ok": false, "mensaje": "No pude abrir esa dirección. Revisa que sea la de tu plataforma Moodle." });
    };
    match r.json::<Value>().await {
        Ok(d) if d.is_object() && d["errorcode"] == "enablewsdescription" => json!({ "ok": false, "mensaje": "Ese Moodle no tiene activados los servicios web (los usa la app móvil)." }),
        Ok(d) if d.is_object() => json!({ "ok": true, "url": base }),
        _ => json!({ "ok": false, "mensaje": "No parece un Moodle. Copia la dirección que ves al entrar a tu plataforma." }),
    }
}

// Inicio automático de la app móvil de Moodle: con el token privado se pide
// una llave de un solo uso y con ella Moodle abre la sesión del navegador.
// Moodle sólo da una llave cada 6 minutos y sólo a «apps de Moodle».
pub async fn url_autologin(destino: &str) -> Option<String> {
    let s = leer_sesion()?;
    let (t, privado) = (s["token"].as_str()?, s["privatetoken"].as_str()?);
    let r = http()
        .post(format!("{}/webservice/rest/server.php?moodlewsrestformat=json", escuela()))
        .header("User-Agent", "MoodleMobile Insti Today")
        .form(&[("wstoken", t), ("wsfunction", "tool_mobile_get_autologin_key"), ("privatetoken", privado)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    let d: Value = r.json().await.ok()?;
    if !d["key"].is_string() {
        datos::registrar("inicio automático", d["errorcode"].as_str().unwrap_or("sin llave"));
    }
    let mut u = url::Url::parse(d["autologinurl"].as_str()?).ok()?;
    u.query_pairs_mut().append_pair("userid", &s["userid"].to_string()).append_pair("key", d["key"].as_str()?).append_pair("urltogo", destino);
    Some(u.to_string())
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn normaliza_direcciones() {
        assert_eq!(normalizar_url("plataforma.uii.edu.mx/moodle/login/index.php?x=1").unwrap(), "https://plataforma.uii.edu.mx/moodle");
        assert_eq!(normalizar_url("https://m.ejemplo.mx/my/").unwrap(), "https://m.ejemplo.mx");
    }

    #[test]
    fn aplana_como_moodle() {
        let mut s = vec![];
        aplanar(&json!({ "courseids": [3, 5], "x": true }), "", &mut s);
        assert_eq!(s, vec![("courseids[0]".into(), "3".into()), ("courseids[1]".into(), "5".into()), ("x".into(), "1".into())]);
    }

    #[test]
    fn html_a_texto_plano() {
        let (t, e) = html_a_texto("<p>Hola&nbsp;<b>Jos&eacute;</b></p><script>x</script><a href=\"https://a.mx/f?x=1&amp;y=2\">ver</a><br>fin &#191;");
        assert_eq!(t, "Hola José\nver\nfin ¿");
        assert_eq!(texto("<p>a</p>\r\n<p>&nbsp;</p>\r\n\r\n<p>\u{a0}</p>\r\n<p>b</p>"), "a\n\nb");
        assert_eq!(e, vec!["https://a.mx/f?x=1&y=2"]);
        assert_eq!(iso(&json!(86400)), json!("1970-01-02T00:00:00.000Z"));
    }
}
