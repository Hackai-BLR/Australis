use std::collections::HashSet;
use std::fs;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;

pub struct Curso {
    pub id: String,
    pub token: Vec<u8>,
}

pub struct Config {
    pub direccion: SocketAddr,
    pub destino: String,
    pub token_real: Vec<u8>,
    pub cursos: Vec<Curso>,
    pub registro: String,
    pub beta: String,
}

fn variable(nombre: &str) -> Option<String> {
    std::env::var(nombre).ok().filter(|v| !v.trim().is_empty())
}

fn id_valido(id: &str) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || b.len() > 63 {
        return false;
    }
    let primero = b[0].is_ascii_lowercase() || b[0].is_ascii_digit();
    primero
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn token_curso_valido(token: &str) -> bool {
    match token.strip_prefix("curso-") {
        Some(resto) => {
            resto.len() >= 16
                && resto
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        }
        None => false,
    }
}

fn leer_token_real(ruta: &str) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(ruta).map_err(|_| "no se puede leer el archivo del token real".to_string())?;
    if !meta.is_file() {
        return Err("el archivo del token real no es un archivo regular".into());
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err("el archivo del token real tiene permisos para el grupo u otros".into());
    }
    let contenido = fs::read(ruta).map_err(|_| "no se puede leer el archivo del token real".to_string())?;
    let texto = String::from_utf8(contenido).map_err(|_| "el token real no es texto válido".to_string())?;
    let token = texto.trim();
    if token.is_empty() {
        return Err("el archivo del token real está vacío".into());
    }
    if token.bytes().any(|c| c.is_ascii_whitespace() || c.is_ascii_control()) {
        return Err("el token real tiene caracteres inválidos".into());
    }
    Ok(token.as_bytes().to_vec())
}

fn leer_cursos(ruta: &str, token_real: &[u8]) -> Result<Vec<Curso>, String> {
    let contenido = fs::read_to_string(ruta).map_err(|_| "no se puede leer el archivo de cursos".to_string())?;
    let mut cursos = Vec::new();
    let mut vistos: HashSet<Vec<u8>> = HashSet::new();
    for (n, linea) in contenido.lines().enumerate() {
        let linea = linea.strip_suffix('\r').unwrap_or(linea);
        if linea.is_empty() {
            continue;
        }
        let partes: Vec<&str> = linea.split(' ').collect();
        if partes.len() != 2 {
            return Err(format!("la línea {} del archivo de cursos no tiene el formato <id> <token>", n + 1));
        }
        let (id, token) = (partes[0], partes[1]);
        if !id_valido(id) {
            return Err(format!("la línea {} del archivo de cursos tiene un id inválido", n + 1));
        }
        if !token_curso_valido(token) {
            return Err(format!("la línea {} del archivo de cursos tiene un token con formato inválido", n + 1));
        }
        if token.as_bytes() == token_real {
            return Err(format!("la línea {} del archivo de cursos usa el token real", n + 1));
        }
        if !vistos.insert(token.as_bytes().to_vec()) {
            return Err(format!("la línea {} del archivo de cursos repite un token", n + 1));
        }
        cursos.push(Curso { id: id.to_string(), token: token.as_bytes().to_vec() });
    }
    Ok(cursos)
}

pub fn cargar() -> Result<Config, String> {
    let direccion = variable("INTERMEDIARIO_DIRECCION").unwrap_or_else(|| "127.0.0.1:8790".into());
    let direccion: SocketAddr = direccion
        .trim()
        .parse()
        .map_err(|_| "INTERMEDIARIO_DIRECCION no es una dirección válida".to_string())?;
    let destino = variable("INTERMEDIARIO_DESTINO").unwrap_or_else(|| "https://api.anthropic.com".into());
    let destino = destino.trim().trim_end_matches('/').to_string();
    let uri: hyper::Uri = destino
        .parse()
        .map_err(|_| "INTERMEDIARIO_DESTINO no es una URL válida".to_string())?;
    match uri.scheme_str() {
        Some("http") | Some("https") => {}
        _ => return Err("INTERMEDIARIO_DESTINO tiene que empezar con http:// o https://".into()),
    }
    if uri.authority().is_none() || uri.query().is_some() {
        return Err("INTERMEDIARIO_DESTINO no es una URL base válida".into());
    }
    let ruta_token = variable("INTERMEDIARIO_TOKEN_ARCHIVO").ok_or("falta INTERMEDIARIO_TOKEN_ARCHIVO")?;
    let token_real = leer_token_real(&ruta_token)?;
    let ruta_cursos = variable("INTERMEDIARIO_CURSOS").ok_or("falta INTERMEDIARIO_CURSOS")?;
    let cursos = leer_cursos(&ruta_cursos, &token_real)?;
    let registro = variable("INTERMEDIARIO_REGISTRO").ok_or("falta INTERMEDIARIO_REGISTRO")?;
    let beta = variable("INTERMEDIARIO_BETA").unwrap_or_else(|| "oauth-2025-04-20".into());
    let beta = beta.trim().to_string();
    if beta.contains(',') || hyper::header::HeaderValue::from_str(&beta).is_err() {
        return Err("INTERMEDIARIO_BETA no es un valor válido".into());
    }
    Ok(Config { direccion, destino, token_real, cursos, registro, beta })
}
