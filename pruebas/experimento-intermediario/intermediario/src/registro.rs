use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::uso::Uso;

pub struct Registro {
    archivo: Mutex<File>,
}

pub struct Linea {
    pub momento: String,
    pub curso: Option<String>,
    pub metodo: String,
    pub ruta: String,
    pub estado: u16,
    pub reenviada: bool,
    pub uso: Uso,
}

impl Registro {
    pub fn abrir(ruta: &str) -> Result<Self, String> {
        let archivo = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(ruta)
            .map_err(|_| "no se puede abrir el archivo de registro".to_string())?;
        Ok(Registro { archivo: Mutex::new(archivo) })
    }

    pub fn escribir(&self, l: &Linea) {
        let valor = json!({
            "momento": l.momento,
            "curso": l.curso,
            "metodo": l.metodo,
            "ruta": l.ruta,
            "estado": l.estado,
            "reenviada": l.reenviada,
            "modelo": l.uso.modelo,
            "tokens_entrada": l.uso.entrada,
            "tokens_salida": l.uso.salida,
            "tokens_cache_creacion": l.uso.cache_creacion,
            "tokens_cache_lectura": l.uso.cache_lectura,
        });
        let mut texto = valor.to_string();
        texto.push('\n');
        let mut archivo = match self.archivo.lock() {
            Ok(a) => a,
            Err(e) => e.into_inner(),
        };
        if archivo.write_all(texto.as_bytes()).is_err() {
            eprintln!("no se pudo escribir una línea del registro");
        }
    }
}

pub fn ahora_iso() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let segundos = d.as_secs() as i64;
    let milis = d.subsec_millis();
    let dias = segundos.div_euclid(86_400);
    let resto = segundos.rem_euclid(86_400);
    let (h, m, s) = (resto / 3600, (resto % 3600) / 60, resto % 60);
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + if mes <= 2 { 1 } else { 0 };
    format!("{anio:04}-{mes:02}-{dia:02}T{h:02}:{m:02}:{s:02}.{milis:03}Z")
}
