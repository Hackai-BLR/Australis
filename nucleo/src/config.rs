use std::env;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub enum TipoProveedorEmail {
    Archivo { ruta: String },
    Brevo { clave: String, url: String },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub puerto: u16,
    pub direccion: String,
    pub desarrollo: bool,
    pub database_url: String,
    pub dominio_base: String,
    pub proveedor_email: TipoProveedorEmail,
    pub email_from: String,
    pub email_from_name: String,
    pub turnstile_site_key: String,
    pub turnstile_secret: String,
    pub turnstile_verify_url: String,
    pub session_secret: Vec<u8>,
    pub interfaz_dir: String,
    pub encabezado_ip_cliente: Option<String>,
    pub proxies_confiables: Vec<Red>,
    pub codigo_vigencia_seg: i64,
    pub sesion_comun_seg: i64,
    pub sesion_privilegiada_seg: i64,
    pub reautenticacion_seg: i64,
    pub reautenticacion_modo: ModoReautenticacion,
    pub ventana_limites_seg: i64,
    pub limite_codigos_email: i64,
    pub limite_codigos_ip: i64,
    pub umbral_turnstile: i64,
    pub contenedores: Option<ConfigContenedores>,
    pub inactividad_seg: i64,
    pub revision_inactividad_seg: i64,
    pub arranque_curso_seg: i64,
    pub construccion_max_seg: i64,
    pub identidad_clave_privada: Option<String>,
    pub identidad_vigencia_seg: i64,
    pub australis_url: Option<String>,
    pub australis_token_modelo: Option<String>,
    pub limite_unirse_usuario: i64,
    pub limite_unirse_ip: i64,
    pub raiz_archivos: PathBuf,
    pub dir_respaldos: PathBuf,
    pub archivos_cuota_curso: u64,
    pub archivos_cuota_persona: u64,
    pub archivos_max_bytes: u64,
    pub subidas_simultaneas: u64,
    pub descargas_simultaneas: u64,
    pub archivos_tipos: Vec<String>,
    pub limite_cuerpo_json: usize,
    pub limite_api_minuto: u64,
    pub limite_api_curso_minuto: u64,
    pub tiempo_espera_encabezados_seg: u64,
    pub tiempo_espera_cuerpo_seg: u64,
    pub agente: crate::agente_config::ConfigAgente,
    pub espera_codigo_inicial_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ModoReautenticacion {
    Sesion,
    Codigo,
}

impl ModoReautenticacion {
    pub fn nombre(&self) -> &'static str {
        match self {
            ModoReautenticacion::Sesion => "sesion",
            ModoReautenticacion::Codigo => "codigo",
        }
    }
}

fn modo_reautenticacion() -> Result<ModoReautenticacion, String> {
    match var("REAUTENTICACION_MODO").map(|v| v.to_lowercase()).as_deref() {
        None | Some("sesion") => Ok(ModoReautenticacion::Sesion),
        Some("codigo") => Ok(ModoReautenticacion::Codigo),
        Some(otro) => Err(format!("REAUTENTICACION_MODO desconocido: {otro}")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SinRoot {
    Auto,
    Si,
    No,
}

#[derive(Clone, Debug)]
pub struct ConfigContenedores {
    pub cli: String,
    pub prefijo: String,
    pub red: String,
    pub raiz_cursos: PathBuf,
    pub plantilla_dir: PathBuf,
    pub sdk_dir: PathBuf,
    pub puerto_api: u16,
    pub direccion_api: Option<String>,
    pub url_api: Option<String>,
    pub memoria: String,
    pub cpus: String,
    pub pids: i64,
    pub sin_root: SinRoot,
    pub pid_red: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Red {
    pub direccion: IpAddr,
    pub prefijo: u8,
}

impl Red {
    pub fn leer(texto: &str) -> Option<Red> {
        let texto = texto.trim();
        let (dir, prefijo) = match texto.split_once('/') {
            Some((d, p)) => (d, Some(p.parse::<u8>().ok()?)),
            None => (texto, None),
        };
        let direccion: IpAddr = dir.parse().ok()?;
        let maximo = if direccion.is_ipv4() { 32 } else { 128 };
        let prefijo = prefijo.unwrap_or(maximo);
        if prefijo > maximo {
            return None;
        }
        Some(Red { direccion, prefijo })
    }

    pub fn contiene(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
            otra => otra,
        };
        match (self.direccion, ip) {
            (IpAddr::V4(red), IpAddr::V4(ip)) => {
                let mascara = if self.prefijo == 0 { 0 } else { u32::MAX << (32 - self.prefijo as u32) };
                u32::from(red) & mascara == u32::from(ip) & mascara
            }
            (IpAddr::V6(red), IpAddr::V6(ip)) => {
                let mascara = if self.prefijo == 0 { 0 } else { u128::MAX << (128 - self.prefijo as u32) };
                u128::from(red) & mascara == u128::from(ip) & mascara
            }
            _ => false,
        }
    }
}

fn redes(nombre: &str, defecto: &str) -> Result<Vec<Red>, String> {
    let texto = var(nombre).unwrap_or_else(|| defecto.to_string());
    texto
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| Red::leer(t).ok_or_else(|| format!("La variable {nombre} tiene una red inválida: {t}")))
        .collect()
}

fn var(nombre: &str) -> Option<String> {
    env::var(nombre).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn obligatoria(nombre: &str) -> Result<String, String> {
    var(nombre).ok_or_else(|| format!("Falta la variable {nombre}"))
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

fn positivo(nombre: &str, defecto: u64) -> Result<u64, String> {
    match var(nombre) {
        None => Ok(defecto),
        Some(v) => v
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0 && *n <= i64::MAX as u64)
            .ok_or_else(|| format!("La variable {nombre} tiene que ser un entero positivo")),
    }
}

const TIPOS_POR_DEFECTO: &str = "pdf,txt,md,csv,json,png,jpg,jpeg,gif,webp,zip,docx,xlsx,pptx,odt,ods,odp,ipynb,py,c,cpp,h,java,ts,sql";

fn tipos_archivos() -> Result<Vec<String>, String> {
    let texto = var("ARCHIVOS_TIPOS").unwrap_or_else(|| TIPOS_POR_DEFECTO.to_string());
    let mut tipos = Vec::new();
    for t in texto.split(',').map(|t| t.trim().trim_start_matches('.').to_ascii_lowercase()).filter(|t| !t.is_empty()) {
        if t.len() > 20 || !t.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(format!("ARCHIVOS_TIPOS tiene una extensión inválida: {t}"));
        }
        if !tipos.contains(&t) {
            tipos.push(t);
        }
    }
    Ok(tipos)
}

fn australis_url() -> Result<Option<String>, String> {
    match var("AUSTRALIS_URL") {
        None => Ok(None),
        Some(v) => {
            let v = v.trim_end_matches('/').to_string();
            if (v.starts_with("http://") || v.starts_with("https://")) && !v.contains(char::is_whitespace) {
                Ok(Some(v))
            } else {
                Err("AUSTRALIS_URL tiene que ser una URL http o https".to_string())
            }
        }
    }
}

fn australis_token_modelo() -> Result<Option<String>, String> {
    match var("AUSTRALIS_TOKEN_MODELO") {
        None => Ok(None),
        Some(v) if crate::modelo::token_valido(&v, "cmt_") => Ok(Some(v)),
        Some(_) => Err("AUSTRALIS_TOKEN_MODELO tiene que ser un token cmt_ de 43 caracteres base64url".to_string()),
    }
}

pub fn es_desarrollo() ->Result<bool, String> {
    match var("ENTORNO").as_deref() {
        None | Some("produccion") => Ok(false),
        Some("desarrollo") => Ok(true),
        Some(otro) => Err(format!("ENTORNO desconocido: {otro}")),
    }
}

pub fn identidad_clave_privada() -> Result<Option<String>, String> {
    match var("IDENTIDAD_CLAVE_PRIVADA") {
        None => Ok(None),
        Some(v) => {
            use base64::Engine;
            match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(v.as_bytes()) {
                Ok(b) if b.len() == 32 => Ok(Some(v)),
                _ => Err("IDENTIDAD_CLAVE_PRIVADA tiene que ser una semilla Ed25519 de 32 bytes en base64url sin relleno".to_string()),
            }
        }
    }
}

fn absoluta(nombre: &str, defecto: &str) -> Result<PathBuf, String> {
    let texto = var(nombre).unwrap_or_else(|| defecto.to_string());
    std::path::absolute(Path::new(&texto)).map_err(|_| format!("La variable {nombre} tiene una ruta inválida"))
}

fn contenedores() -> Result<Option<ConfigContenedores>, String> {
    match var("PROVEEDOR_CONTENEDORES").as_deref() {
        None | Some("docker") => {}
        Some("ninguno") => return Ok(None),
        Some(otro) => return Err(format!("PROVEEDOR_CONTENEDORES desconocido: {otro}")),
    }
    let prefijo = var("PREFIJO_CONTENEDORES").unwrap_or_else(|| "campusia".to_string());
    if prefijo.is_empty() || prefijo.len() > 20 || !prefijo.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return Err("PREFIJO_CONTENEDORES tiene que tener de 1 a 20 minúsculas o números".to_string());
    }
    let red = var("RED_CURSOS").unwrap_or_else(|| format!("{prefijo}-cursos"));
    if !red.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') {
        return Err("RED_CURSOS inválida".to_string());
    }
    let cli = var("CONTENEDORES_CLI").unwrap_or_else(|| "docker".to_string());
    let puerto_api = match var("PUERTO_API_CURSOS") {
        None => 8081,
        Some(v) => v.parse::<u16>().map_err(|_| "PUERTO_API_CURSOS inválido".to_string())?,
    };
    let direccion_api = var("DIRECCION_API_CURSOS");
    if let Some(d) = &direccion_api {
        d.parse::<IpAddr>().map_err(|_| "DIRECCION_API_CURSOS tiene que ser una dirección IP".to_string())?;
    }
    let memoria = var("CURSO_MEMORIA").unwrap_or_else(|| "256m".to_string());
    if !memoria.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("CURSO_MEMORIA inválida".to_string());
    }
    let cpus = var("CURSO_CPUS").unwrap_or_else(|| "0.5".to_string());
    if cpus.parse::<f64>().map(|c| c <= 0.0).unwrap_or(true) {
        return Err("CURSO_CPUS inválido".to_string());
    }
    let pids = entero("CURSO_PIDS", 256)?;
    if pids < 1 {
        return Err("CURSO_PIDS tiene que ser positivo".to_string());
    }
    let sin_root = match var("CONTENEDORES_SIN_ROOT").as_deref() {
        None | Some("auto") => SinRoot::Auto,
        Some("si") => SinRoot::Si,
        Some("no") => SinRoot::No,
        Some(otro) => return Err(format!("CONTENEDORES_SIN_ROOT desconocido: {otro} (auto, si o no)")),
    };
    let pid_red = match var("CONTENEDORES_PID_RED") {
        Some(_) => Some(absoluta("CONTENEDORES_PID_RED", "")?),
        None => None,
    };
    Ok(Some(ConfigContenedores {
        cli,
        prefijo,
        red,
        raiz_cursos: absoluta("RAIZ_CURSOS", "/srv/campusia/cursos")?,
        plantilla_dir: absoluta("PLANTILLA_CURSO_DIR", "/srv/campusia/plataforma/plantilla-curso")?,
        sdk_dir: absoluta("SDK_DIR", "/srv/campusia/plataforma/sdk")?,
        puerto_api,
        direccion_api,
        url_api: var("URL_API_CURSOS"),
        memoria,
        cpus,
        pids,
        sin_root,
        pid_red,
    }))
}

pub fn database_url() -> Result<String, String> {
    obligatoria("DATABASE_URL")
}

impl Config {
    pub fn desde_entorno() -> Result<Config, String> {
        let desarrollo = es_desarrollo()?;
        let puerto = match var("PUERTO") {
            None => 8080,
            Some(v) => v.parse::<u16>().map_err(|_| "PUERTO inválido".to_string())?,
        };
        let secreto = env::var("SESSION_SECRET").unwrap_or_default();
        if secreto.chars().count() < 32 {
            return Err("SESSION_SECRET tiene que tener 32 caracteres o más".to_string());
        }
        let proveedor = var("PROVEEDOR_EMAIL").unwrap_or_else(|| "brevo".to_string());
        let proveedor_email = match proveedor.as_str() {
            "archivo" => TipoProveedorEmail::Archivo { ruta: obligatoria("ARCHIVO_EMAIL")? },
            "brevo" => TipoProveedorEmail::Brevo {
                clave: obligatoria("BREVO_API_KEY")?,
                url: var("BREVO_API_URL").unwrap_or_else(|| "https://api.brevo.com/v3/smtp/email".to_string()),
            },
            otro => return Err(format!("PROVEEDOR_EMAIL desconocido: {otro}")),
        };
        let espera_por_defecto = match proveedor_email {
            TipoProveedorEmail::Archivo { .. } => 10,
            TipoProveedorEmail::Brevo { .. } => 800,
        };
        let espera_codigo_inicial_ms = positivo("ESPERA_CODIGO_INICIAL_MS", espera_por_defecto)?.min(20_000);
        let dominio_base = obligatoria("DOMINIO_BASE")?.to_lowercase();
        Ok(Config {
            puerto,
            direccion: var("DIRECCION").unwrap_or_else(|| "127.0.0.1".to_string()),
            desarrollo,
            database_url: database_url()?,
            dominio_base,
            proveedor_email,
            email_from: var("EMAIL_FROM").unwrap_or_else(|| "no-responder@campusia.tech".to_string()),
            email_from_name: var("EMAIL_FROM_NAME").unwrap_or_else(|| "Campus IA".to_string()),
            turnstile_site_key: obligatoria("TURNSTILE_SITE_KEY")?,
            turnstile_secret: obligatoria("TURNSTILE_SECRET")?,
            turnstile_verify_url: var("TURNSTILE_VERIFY_URL")
                .unwrap_or_else(|| "https://challenges.cloudflare.com/turnstile/v0/siteverify".to_string()),
            session_secret: secreto.into_bytes(),
            interfaz_dir: var("INTERFAZ_DIR").unwrap_or_else(|| "./interfaz/dist".to_string()),
            encabezado_ip_cliente: var("ENCABEZADO_IP_CLIENTE").map(|v| v.to_lowercase()),
            proxies_confiables: redes("PROXIES_CONFIABLES", "127.0.0.1,::1")?,
            codigo_vigencia_seg: entero("CODIGO_VIGENCIA_SEG", 600)?,
            sesion_comun_seg: entero("SESION_COMUN_SEG", 2_592_000)?,
            sesion_privilegiada_seg: entero("SESION_PRIVILEGIADA_SEG", 43_200)?,
            reautenticacion_seg: entero("REAUTENTICACION_SEG", 600)?,
            reautenticacion_modo: modo_reautenticacion()?,
            ventana_limites_seg: entero("VENTANA_LIMITES_SEG", 900)?,
            limite_codigos_email: entero("LIMITE_CODIGOS_EMAIL", 3)?,
            limite_codigos_ip: entero("LIMITE_CODIGOS_IP", 20)?,
            umbral_turnstile: entero("UMBRAL_TURNSTILE", 5)?,
            contenedores: contenedores()?,
            inactividad_seg: match var("INACTIVIDAD_SEG") {
                Some(_) => entero("INACTIVIDAD_SEG", 900)?.max(1),
                None => entero("MINUTOS_INACTIVIDAD", 15)?.max(1) * 60,
            },
            revision_inactividad_seg: entero("REVISION_INACTIVIDAD_SEG", 30)?.max(1),
            arranque_curso_seg: entero("ARRANQUE_CURSO_SEG", 60)?.max(1),
            construccion_max_seg: entero("CONSTRUCCION_MAX_SEG", 900)?.max(1),
            identidad_clave_privada: identidad_clave_privada()?,
            identidad_vigencia_seg: entero("IDENTIDAD_VIGENCIA_SEG", 60)?.clamp(1, 120),
            australis_url: australis_url()?,
            australis_token_modelo: australis_token_modelo()?,
            limite_unirse_usuario: entero("LIMITE_UNIRSE_USUARIO", 10)?,
            limite_unirse_ip: entero("LIMITE_UNIRSE_IP", 30)?,
            raiz_archivos: absoluta("RAIZ_ARCHIVOS", "/srv/campusia/archivos")?,
            dir_respaldos: absoluta("DIR_RESPALDOS", "/srv/campusia/respaldos")?,
            archivos_cuota_curso: positivo("ARCHIVOS_CUOTA_CURSO", 1_073_741_824)?,
            archivos_cuota_persona: positivo("ARCHIVOS_CUOTA_PERSONA", 104_857_600)?,
            archivos_max_bytes: positivo("ARCHIVOS_MAX_BYTES", 26_214_400)?,
            subidas_simultaneas: positivo("SUBIDAS_SIMULTANEAS", 16)?.min(4096),
            descargas_simultaneas: positivo("DESCARGAS_SIMULTANEAS", 32)?.min(4096),
            archivos_tipos: tipos_archivos()?,
            limite_cuerpo_json: positivo("LIMITE_CUERPO_JSON", 262_144)?.min(usize::MAX as u64) as usize,
            limite_api_minuto: positivo("LIMITE_API_MINUTO", 1000)?,
            limite_api_curso_minuto: positivo("LIMITE_API_CURSO_MINUTO", 6000)?,
            tiempo_espera_encabezados_seg: positivo("TIEMPO_ESPERA_ENCABEZADOS_SEG", 15)?,
            tiempo_espera_cuerpo_seg: positivo("TIEMPO_ESPERA_CUERPO_SEG", 120)?,
            agente: crate::agente_config::ConfigAgente::desde_entorno()?,
            espera_codigo_inicial_ms,
        })
    }

    pub fn esquema(&self) -> &'static str {
        if self.desarrollo {
            "http"
        } else {
            "https"
        }
    }
}
