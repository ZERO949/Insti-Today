// El estado en memoria del proceso. Se toca siempre con con(), sin esperar
// nada de la red mientras está tomado.

use crate::ventanas::Rect;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, LazyLock, Mutex},
    time::Instant,
};

pub struct Rt {
    // Lo que ve el widget: { datos, error, cargando, sesion, escuela, prefs, … }.
    pub estado: Value,
    // Sube con cada cambio de cuenta: lo que llegue de Moodle para la anterior se descarta.
    pub generacion: u64,
    pub ultimo_intento: Option<Instant>,
    pub vistos: HashSet<String>,
    pub avisados: HashSet<String>,
    pub entregas: Value,
    pub ancho_widget: f64,
    pub guardar_posicion: u64,
    // Vista previa.
    pub tarjeta: Option<Rect>,
    pub pedido_vista: u64,
    pub vista_abierta: bool,
    pub vista_fijada: bool,
    pub vigilando: bool,
    pub cerrar_en: Option<Instant>,
    pub vista_usada: Instant,
    pub precargadas: String,
    // Iniciar sesión.
    pub esperan_login: Vec<tokio::sync::oneshot::Sender<Option<String>>>,
    // Entrega.
    pub archivos_arrastre: Vec<PathBuf>,
    pub destino_arrastre: Option<Value>,
    pub colocando: HashMap<String, Arc<AtomicBool>>,
    pub quitando: HashSet<String>,
    // Actualizaciones.
    pub actualizacion: Value,
    pub preguntadas: HashSet<String>,
    pub salir: bool,
}

static RT: LazyLock<Mutex<Rt>> = LazyLock::new(|| {
    Mutex::new(Rt {
        estado: json!({ "datos": null, "error": null, "cargando": false, "sesion": "falta", "escuela": null }),
        generacion: 0,
        ultimo_intento: None,
        vistos: HashSet::new(),
        avisados: HashSet::new(),
        entregas: json!({}),
        ancho_widget: crate::ventanas::ANCHO,
        guardar_posicion: 0,
        tarjeta: None,
        pedido_vista: 0,
        vista_abierta: false,
        vista_fijada: false,
        vigilando: false,
        cerrar_en: None,
        vista_usada: Instant::now(),
        precargadas: String::new(),
        esperan_login: vec![],
        archivos_arrastre: vec![],
        destino_arrastre: None,
        colocando: HashMap::new(),
        quitando: HashSet::new(),
        actualizacion: json!({ "estado": if cfg!(debug_assertions) { "desarrollo" } else { "inicial" }, "version": null, "porcentaje": 0 }),
        preguntadas: HashSet::new(),
        salir: false,
    })
});

pub fn con<T>(f: impl FnOnce(&mut Rt) -> T) -> T {
    f(&mut RT.lock().unwrap())
}
