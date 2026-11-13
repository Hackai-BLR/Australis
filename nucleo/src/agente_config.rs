use std::collections::BTreeMap;
use std::env;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use serde_json::Value;

#[derive(Clone)]
pub enum Proveedor {
    Suscripcion { token: String },
    Api { clave: String },
}

impl Proveedor {
    pub fn secreto(&self) -> &str {
        match self {
            Proveedor::Suscripcion { token } => token,
            Proveedor::Api { clave } => clave,
        }
    }
}

impl std::fmt::Debug for Proveedor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Proveedor::Suscripcion { .. } => write!(f, "suscripcion"),
            Proveedor::Api { .. } => write!(f, "api"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Precio {
    pub entrada: f64,
    pub salida: f64,
    pub cache_creacion: f64,
    pub cache_lectura: f64,
}

#[derive(Clone, Debug)]
pub struct Precios {
    tabla: BTreeMap<String, Precio>,
}

impl Precios {
    pub fn incluidos() -> Precios {
        let mut tabla = BTreeMap::new();
        tabla.insert("claude-haiku".to_string(), Precio { entrada: 1.0, salida: 5.0, cache_creacion: 1.25, cache_lectura: 0.1 });
        tabla.insert("claude-3-5-haiku".to_string(), Precio { entrada: 0.8, salida: 4.0, cache_creacion: 1.0, cache_lectura: 0.08 });
        tabla.insert("claude-sonnet".to_string(), Precio { entrada: 3.0, salida: 15.0, cache_creacion: 3.75, cache_lectura: 0.3 });
        tabla.insert("claude-3-7-sonnet".to_string(), Precio { entrada: 3.0, salida: 15.0, cache_creacion: 3.75, cache_lectura: 0.3 });
        tabla.insert("claude-opus".to_string(), Precio { entrada: 5.0, salida: 25.0, cache_creacion: 6.25, cache_lectura: 0.5 });
        tabla.insert("claude-opus-4-0".to_string(), Precio { entrada: 15.0, salida: 75.0, cache_creacion: 18.75, cache_lectura: 1.5 });
        tabla.insert("claude-opus-4-1".to_string(), Precio { entrada: 15.0, salida: 75.0, cache_creacion: 18.75, cache_lectura: 1.5 });
        tabla.insert("*".to_string(), Precio { entrada: 3.0, salida: 15.0, cache_creacion: 3.75, cache_lectura: 0.3 });
        Precios { tabla }
    }

    pub fn leer(texto: &str) -> Result<Precios, String> {
        let v: Value = serde_json::from_str(texto).map_err(|_| "no es un JSON válido".to_string())?;
        let Value::Object(m) = v else { return Err("tiene que ser un objeto JSON".to_string()) };
        let mut tabla = BTreeMap::new();
        for (modelo, p) in m {
            let campo = |k: &str| -> Result<f64, String> {
                p.get(k)
                    .and_then(Value::as_f64)
                    .filter(|x| x.is_finite() && *x >= 0.0)
                    .ok_or_else(|| format!("el modelo {modelo} no tiene un número válido en {k}"))
            };
            tabla.insert(
                modelo.clone(),
                Precio {
                    entrada: campo("entrada")?,
                    salida: campo("salida")?,
                    cache_creacion: campo("cache_creacion")?,
                    cache_lectura: campo("cache_lectura")?,
                },
            );
        }
        if !tabla.contains_key("*") {
            if let Some(p) = Precios::incluidos().tabla.get("*") {
                tabla.insert("*".to_string(), *p);
            }
        }
        Ok(Precios { tabla })
    }

    pub fn de(&self, modelo: Option<&str>) -> Precio {
        let m = modelo.unwrap_or("");
        if let Some(p) = self.tabla.get(m) {
            if m != "*" || modelo.is_none() {
                return *p;
            }
        }
        let mut mejor: Option<(&String, &Precio)> = None;
        for (k, p) in &self.tabla {
            if k == "*" || !m.starts_with(k.as_str()) {
                continue;
            }
            if mejor.map(|(b, _)| k.len() > b.len()).unwrap_or(true) {
                mejor = Some((k, p));
            }
        }
        if let Some((_, p)) = mejor {
            return *p;
        }
        self.tabla.get("*").copied().unwrap_or(Precio { entrada: 0.0, salida: 0.0, cache_creacion: 0.0, cache_lectura: 0.0 })
    }
}

#[derive(Clone, Debug)]
pub struct ConfigAgente {
    pub proveedor: Option<Proveedor>,
    pub destino: String,
    pub beta: String,
    pub modelo_agente: String,
    pub precios: Precios,
    pub imagen: String,
    pub raiz_espacios: PathBuf,
    pub red_espacios: String,
    pub puerto_espacios: u16,
    pub direccion_espacios: Option<String>,
    pub url_espacios: Option<String>,
    pub puerto_proxy: u16,
    pub salida_permitida: Vec<String>,
    pub memoria: String,
    pub cpus: String,
    pub pids: i64,
    pub inactividad_seg: i64,
    pub arranque_seg: i64,
    pub espera_prueba_seg: i64,
    pub agente_max_seg: i64,
    pub publicacion_max_seg: i64,
    pub reserva_tokens_pedido: i64,
    pub espera_sin_uso_seg: i64,
}

fn var(nombre: &str) -> Option<String> {
    env::var(nombre).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn entero(nombre: &str, defecto: i64) -> Result<i64, String> {
    match var(nombre) {
        None => Ok(defecto),
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("La variable {nombre} tiene que ser un entero no negativo")),
    }
}

fn puerto(nombre: &str, defecto: u16) -> Result<u16, String> {
    match var(nombre) {
        None => Ok(defecto),
        Some(v) => v.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("{nombre} inválido")),
    }
}

fn nombre_valido(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:/@".contains(&b))
}

fn host_valido(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|e| {
            !e.is_empty() && e.len() <= 63 && e.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

impl ConfigAgente {
    pub fn desde_entorno() -> Result<ConfigAgente, String> {
        let proveedor = match var("PROVEEDOR_MODELO").as_deref() {
            None | Some("ninguno") => None,
            Some("suscripcion") => match var("CLAUDE_CODE_OAUTH_TOKEN") {
                Some(token) => Some(Proveedor::Suscripcion { token }),
                None => return Err("PROVEEDOR_MODELO=suscripcion necesita la variable CLAUDE_CODE_OAUTH_TOKEN".to_string()),
            },
            Some("api") => match var("ANTHROPIC_API_KEY") {
                Some(clave) => Some(Proveedor::Api { clave }),
                None => return Err("PROVEEDOR_MODELO=api necesita la variable ANTHROPIC_API_KEY".to_string()),
            },
            Some(_) => return Err("PROVEEDOR_MODELO desconocido: tiene que ser ninguno, suscripcion o api".to_string()),
        };
        let destino = var("MODELO_DESTINO").unwrap_or_else(|| "https://api.anthropic.com".to_string());
        match url::Url::parse(&destino) {
            Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some() && u.query().is_none() => {}
            _ => return Err("MODELO_DESTINO tiene que ser una URL http o https".to_string()),
        }
        let destino = destino.trim_end_matches('/').to_string();
        let beta = var("MODELO_BETA").unwrap_or_else(|| "oauth-2025-04-20".to_string());
        if !beta.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') {
            return Err("MODELO_BETA inválido".to_string());
        }
        let modelo_agente = var("MODELO_AGENTE").unwrap_or_else(|| "sonnet".to_string());
        if !nombre_valido(&modelo_agente) || modelo_agente.contains('/') {
            return Err("MODELO_AGENTE inválido".to_string());
        }
        let precios = match var("PRECIOS_MODELO_ARCHIVO") {
            None => Precios::incluidos(),
            Some(ruta) => {
                let texto = std::fs::read_to_string(&ruta)
                    .map_err(|_| "No se pudo leer el archivo de PRECIOS_MODELO_ARCHIVO".to_string())?;
                Precios::leer(&texto).map_err(|e| format!("PRECIOS_MODELO_ARCHIVO inválido: {e}"))?
            }
        };
        let imagen = var("ESPACIO_IMAGEN").unwrap_or_else(|| "campusia-espacio:1".to_string());
        if !nombre_valido(&imagen) {
            return Err("ESPACIO_IMAGEN inválida".to_string());
        }
        let raiz = var("RAIZ_ESPACIOS").unwrap_or_else(|| "/srv/campusia/espacios".to_string());
        let raiz_espacios =
            std::path::absolute(Path::new(&raiz)).map_err(|_| "La variable RAIZ_ESPACIOS tiene una ruta inválida".to_string())?;
        let prefijo = var("PREFIJO_CONTENEDORES").unwrap_or_else(|| "campusia".to_string());
        let red_espacios = var("RED_ESPACIOS").unwrap_or_else(|| format!("{prefijo}-espacios"));
        if !red_espacios.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') {
            return Err("RED_ESPACIOS inválida".to_string());
        }
        let direccion_espacios = var("DIRECCION_ESPACIOS");
        if let Some(d) = &direccion_espacios {
            d.parse::<IpAddr>().map_err(|_| "DIRECCION_ESPACIOS tiene que ser una dirección IP".to_string())?;
        }
        let url_espacios = var("URL_ESPACIOS").map(|u| u.trim_end_matches('/').to_string());
        if let Some(u) = &url_espacios {
            match url::Url::parse(u) {
                Ok(x) if x.scheme() == "http" || x.scheme() == "https" => {}
                _ => return Err("URL_ESPACIOS tiene que ser una URL http o https".to_string()),
            }
        }
        let salida = var("SALIDA_PERMITIDA").unwrap_or_else(|| "registry.npmjs.org".to_string());
        let mut salida_permitida = Vec::new();
        for h in salida.split(',').map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty()) {
            if !host_valido(&h) {
                return Err(format!("SALIDA_PERMITIDA tiene un host inválido: {h}"));
            }
            salida_permitida.push(h);
        }
        let memoria = var("ESPACIO_MEMORIA").unwrap_or_else(|| "2g".to_string());
        if !memoria.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("ESPACIO_MEMORIA inválida".to_string());
        }
        let cpus = var("ESPACIO_CPUS").unwrap_or_else(|| "1".to_string());
        if cpus.parse::<f64>().map(|c| c <= 0.0 || !c.is_finite()).unwrap_or(true) {
            return Err("ESPACIO_CPUS inválido".to_string());
        }
        let pids = entero("ESPACIO_PIDS", 1024)?;
        if pids < 1 {
            return Err("ESPACIO_PIDS tiene que ser positivo".to_string());
        }
        let reserva_tokens_pedido = entero("RESERVA_TOKENS_PEDIDO", 20_000)?;
        if reserva_tokens_pedido > 10_000_000 {
            return Err("RESERVA_TOKENS_PEDIDO tiene que ser un entero de 0 a 10000000".to_string());
        }
        let espera_sin_uso_seg = entero("ESPERA_SIN_USO_SEG", 300)?;
        if !(1..=86_400).contains(&espera_sin_uso_seg) {
            return Err("ESPERA_SIN_USO_SEG tiene que ser un entero de 1 a 86400".to_string());
        }
        Ok(ConfigAgente {
            proveedor,
            destino,
            beta,
            modelo_agente,
            precios,
            imagen,
            raiz_espacios,
            red_espacios,
            puerto_espacios: puerto("PUERTO_ESPACIOS", 8082)?,
            direccion_espacios,
            url_espacios,
            puerto_proxy: puerto("PUERTO_PROXY_SALIDA", 8083)?,
            salida_permitida,
            memoria,
            cpus,
            pids,
            inactividad_seg: entero("INACTIVIDAD_ESPACIO_SEG", 1800)?.max(1),
            arranque_seg: entero("ARRANQUE_ESPACIO_SEG", 900)?.max(1),
            espera_prueba_seg: entero("ESPERA_PRUEBA_SEG", 20)?.max(1),
            agente_max_seg: entero("AGENTE_MAX_SEG", 900)?.max(1),
            publicacion_max_seg: entero("PUBLICACION_MAX_SEG", 1800)?.max(1),
            reserva_tokens_pedido,
            espera_sin_uso_seg,
        })
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn precios_por_prefijo() {
        let p = Precios::leer(
            r#"{"claude-haiku-5-5":{"entrada":10,"salida":50,"cache_creacion":12.5,"cache_lectura":1},"claude-haiku":{"entrada":7,"salida":7,"cache_creacion":7,"cache_lectura":7},"*":{"entrada":3,"salida":15,"cache_creacion":3.75,"cache_lectura":0.3}}"#,
        )
        .unwrap();
        assert_eq!(p.de(Some("claude-haiku-5-5")).entrada, 10.0);
        assert_eq!(p.de(Some("claude-haiku-9-1")).entrada, 7.0);
        assert_eq!(p.de(Some("otro")).entrada, 3.0);
        assert_eq!(p.de(None).entrada, 3.0);
        assert!(Precios::leer("{\"claude\": ").is_err());
    }
}
