use serde_json::Value;

const MAXIMO_JSON: usize = 16 * 1024 * 1024;
const MAXIMO_LINEA: usize = 4 * 1024 * 1024;

#[derive(Default, Clone)]
pub struct Uso {
    pub modelo: Option<String>,
    pub entrada: u64,
    pub salida: u64,
    pub cache_creacion: u64,
    pub cache_lectura: u64,
}

impl Uso {
    fn aplicar(&mut self, usage: &Value) {
        let campo = |nombre: &str| usage.get(nombre).and_then(Value::as_u64);
        if let Some(v) = campo("input_tokens") {
            self.entrada = v;
        }
        if let Some(v) = campo("output_tokens") {
            self.salida = v;
        }
        if let Some(v) = campo("cache_creation_input_tokens") {
            self.cache_creacion = v;
        }
        if let Some(v) = campo("cache_read_input_tokens") {
            self.cache_lectura = v;
        }
    }
}

enum Modo {
    Json { datos: Vec<u8>, desbordado: bool },
    Sse { linea: Vec<u8>, descartando: bool },
    Nada,
}

pub struct Lector {
    modo: Modo,
    pub uso: Uso,
}

impl Lector {
    pub fn new(content_type: &str) -> Self {
        let ct = content_type.to_ascii_lowercase();
        let modo = if ct.starts_with("text/event-stream") {
            Modo::Sse { linea: Vec::new(), descartando: false }
        } else if ct.starts_with("application/json") || ct.contains("+json") {
            Modo::Json { datos: Vec::new(), desbordado: false }
        } else {
            Modo::Nada
        };
        Lector { modo, uso: Uso::default() }
    }

    pub fn alimentar(&mut self, trozo: &[u8]) {
        let mut eventos = Vec::new();
        match &mut self.modo {
            Modo::Json { datos, desbordado } => {
                if !*desbordado {
                    if datos.len() + trozo.len() > MAXIMO_JSON {
                        *desbordado = true;
                        datos.clear();
                    } else {
                        datos.extend_from_slice(trozo);
                    }
                }
            }
            Modo::Sse { linea, descartando } => {
                for &b in trozo {
                    if b == b'\n' {
                        if !*descartando {
                            eventos.push(std::mem::take(linea));
                        }
                        linea.clear();
                        *descartando = false;
                    } else if !*descartando {
                        if linea.len() >= MAXIMO_LINEA {
                            *descartando = true;
                            linea.clear();
                        } else {
                            linea.push(b);
                        }
                    }
                }
            }
            Modo::Nada => {}
        }
        for l in eventos {
            self.linea_sse(&l);
        }
    }

    fn linea_sse(&mut self, linea: &[u8]) {
        let linea = linea.strip_suffix(b"\r").unwrap_or(linea);
        let Some(datos) = linea.strip_prefix(b"data:") else { return };
        let Ok(v) = serde_json::from_slice::<Value>(datos) else { return };
        match v.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(m) = v.get("message") {
                    if let Some(modelo) = m.get("model").and_then(Value::as_str) {
                        self.uso.modelo = Some(modelo.to_string());
                    }
                    if let Some(u) = m.get("usage") {
                        self.uso.aplicar(u);
                    }
                }
            }
            Some("message_delta") => {
                if let Some(u) = v.get("usage") {
                    self.uso.aplicar(u);
                }
            }
            _ => {}
        }
    }

    pub fn terminar(&mut self) {
        let modo = std::mem::replace(&mut self.modo, Modo::Nada);
        match modo {
            Modo::Json { datos, desbordado: false } => {
                if let Ok(v) = serde_json::from_slice::<Value>(&datos) {
                    if let Some(modelo) = v.get("model").and_then(Value::as_str) {
                        self.uso.modelo = Some(modelo.to_string());
                    }
                    if let Some(u) = v.get("usage") {
                        self.uso.aplicar(u);
                    }
                }
            }
            Modo::Sse { linea, descartando: false } => {
                if !linea.is_empty() {
                    self.linea_sse(&linea);
                }
            }
            _ => {}
        }
    }
}

pub fn modelo_pedido(cuerpo: &[u8]) -> Option<String> {
    if cuerpo.is_empty() {
        return None;
    }
    serde_json::from_slice::<Value>(cuerpo)
        .ok()?
        .get("model")?
        .as_str()
        .map(str::to_string)
}
