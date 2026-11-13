use std::io::{Cursor, Read, Write};
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use calamine::{Data, Reader, Xls, Xlsx};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use crate::util::sin_acentos;

pub const MAXIMO_ARCHIVO: usize = 2 * 1024 * 1024;
const MAXIMO_FILAS: usize = 20_000;
const MEMORIA_LECTOR: u64 = 512 * 1024 * 1024;
const CPU_LECTOR_SEG: u64 = 20;
const TIEMPO_LECTOR: Duration = Duration::from_secs(30);
const MAXIMO_SALIDA: u64 = 32 * 1024 * 1024;

static LECTORES: Semaphore = Semaphore::const_new(2);

pub struct FilaSiu {
    pub fila: usize,
    pub email: String,
    pub nombre: Option<String>,
}

fn celda(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        otro => otro.to_string(),
    }
}

fn hoja<R: Reader<Cursor<Vec<u8>>>>(mut libro: R) -> Option<Vec<Vec<String>>> {
    let rango = libro.worksheet_range_at(0)?.ok()?;
    let inicio = rango.start().map(|(f, _)| f as usize).unwrap_or(0);
    let mut filas: Vec<Vec<String>> = vec![Vec::new(); inicio];
    for f in rango.rows() {
        filas.push(f.iter().map(celda).collect());
    }
    Some(filas)
}

fn decodificar(bytes: &[u8]) -> String {
    let sin_bom = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    match std::str::from_utf8(sin_bom) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(sin_bom).0.to_string(),
    }
}

fn separador(texto: &str) -> char {
    let primera = texto.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut comillas = false;
    let (mut pyc, mut coma) = (0, 0);
    for c in primera.chars() {
        match c {
            '"' => comillas = !comillas,
            ';' if !comillas => pyc += 1,
            ',' if !comillas => coma += 1,
            _ => {}
        }
    }
    if pyc >= coma && pyc > 0 {
        ';'
    } else {
        ','
    }
}

fn csv(texto: &str) -> Vec<Vec<String>> {
    let sep = separador(texto);
    let mut filas = Vec::new();
    let mut fila: Vec<String> = Vec::new();
    let mut campo = String::new();
    let mut comillas = false;
    let mut cs = texto.chars().peekable();
    while let Some(c) = cs.next() {
        if comillas {
            if c == '"' {
                if cs.peek() == Some(&'"') {
                    campo.push('"');
                    cs.next();
                } else {
                    comillas = false;
                }
            } else {
                campo.push(c);
            }
            continue;
        }
        match c {
            '"' if campo.is_empty() => comillas = true,
            '\r' => {}
            '\n' => {
                fila.push(std::mem::take(&mut campo));
                filas.push(std::mem::take(&mut fila));
            }
            c if c == sep => fila.push(std::mem::take(&mut campo)),
            c => campo.push(c),
        }
    }
    if !campo.is_empty() || !fila.is_empty() {
        fila.push(campo);
        filas.push(fila);
    }
    filas
}

fn clave(s: &str) -> String {
    sin_acentos(s.trim()).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn dar_vuelta(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match s.split_once(',') {
        Some((apellido, nombre)) if !nombre.trim().is_empty() && !apellido.trim().is_empty() => {
            format!("{} {}", nombre.trim(), apellido.trim())
        }
        _ => s.trim().to_string(),
    }
}

pub fn leer(bytes: &[u8]) -> Option<Vec<FilaSiu>> {
    let filas = if bytes.starts_with(b"PK") {
        hoja(Xlsx::new(Cursor::new(bytes.to_vec())).ok()?)?
    } else if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        hoja(Xls::new(Cursor::new(bytes.to_vec())).ok()?)?
    } else {
        if bytes.contains(&0) {
            return None;
        }
        csv(&decodificar(bytes))
    };
    let cabecera = filas.iter().position(|f| f.iter().any(|c| !c.trim().is_empty()))?;
    let titulos: Vec<String> = filas[cabecera].iter().map(|t| clave(t)).collect();
    let mail = titulos.iter().position(|t| t.contains("mail") || t.contains("correo"))?;
    let completo = titulos
        .iter()
        .position(|t| ["nombre", "nombre y apellido", "apellido y nombre", "apellido, nombre", "apellido y nombres", "nombres y apellido"].contains(&t.as_str()));
    let apellido = titulos.iter().position(|t| t == "apellido" || t == "apellidos");
    let nombres = titulos.iter().position(|t| t == "nombre" || t == "nombres");
    let mut salida = Vec::new();
    for (i, f) in filas.iter().enumerate().skip(cabecera + 1) {
        let email = f.get(mail).map(|s| s.trim().to_string()).unwrap_or_default();
        if email.is_empty() {
            continue;
        }
        let tomar = |k: Option<usize>| k.and_then(|k| f.get(k)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let nombre = match (apellido, nombres) {
            (Some(a), Some(n)) if completo.is_none() || completo == Some(n) => match (tomar(Some(n)), tomar(Some(a))) {
                (Some(n), Some(a)) => Some(format!("{n} {a}")),
                (Some(n), None) => Some(n),
                (None, Some(a)) => Some(a),
                (None, None) => None,
            },
            _ => tomar(completo).map(|s| dar_vuelta(&s)),
        };
        let nombre = nombre.map(|n| n.chars().take(120).collect::<String>());
        salida.push(FilaSiu { fila: i - cabecera + 1, email, nombre });
    }
    Some(salida)
}

fn limitar_recursos() -> bool {
    let memoria = libc::rlimit { rlim_cur: MEMORIA_LECTOR as libc::rlim_t, rlim_max: MEMORIA_LECTOR as libc::rlim_t };
    let cpu = libc::rlimit { rlim_cur: CPU_LECTOR_SEG as libc::rlim_t, rlim_max: CPU_LECTOR_SEG as libc::rlim_t };
    unsafe {
        libc::setrlimit(libc::RLIMIT_AS, &memoria) == 0 && libc::setrlimit(libc::RLIMIT_CPU, &cpu) == 0
    }
}

pub fn proceso_lector() -> ExitCode {
    if !limitar_recursos() {
        return ExitCode::from(3);
    }
    let mut bytes = Vec::new();
    if std::io::stdin().take(MAXIMO_ARCHIVO as u64 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > MAXIMO_ARCHIVO {
        return ExitCode::from(2);
    }
    let Some(filas) = leer(&bytes) else { return ExitCode::from(2) };
    drop(bytes);
    if filas.len() > MAXIMO_FILAS {
        return ExitCode::from(2);
    }
    let salida: Vec<Value> = filas
        .into_iter()
        .map(|f| json!([f.fila, f.email.chars().take(320).collect::<String>(), f.nombre]))
        .collect();
    let Ok(texto) = serde_json::to_vec(&salida) else { return ExitCode::from(2) };
    let mut out = std::io::stdout().lock();
    if out.write_all(&texto).and_then(|_| out.flush()).is_err() {
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}

pub async fn leer_aislado(bytes: Vec<u8>) -> Option<Vec<FilaSiu>> {
    if bytes.is_empty() || bytes.len() > MAXIMO_ARCHIVO {
        return None;
    }
    let _permiso = LECTORES.acquire().await.ok()?;
    let ejecutable = std::env::current_exe().ok()?;
    let mut c = tokio::process::Command::new(ejecutable);
    c.arg("leer-siu")
        .env_clear()
        .current_dir("/")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut hijo = match c.spawn() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("no se pudo iniciar el lector del SIU: {e}");
            return None;
        }
    };
    let mut entrada = hijo.stdin.take()?;
    let mut salida = hijo.stdout.take()?;
    let lectura = async move {
        let escribir = async move {
            let _ = entrada.write_all(&bytes).await;
            drop(entrada);
        };
        let leer = async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut limitada = (&mut salida).take(MAXIMO_SALIDA + 1);
            limitada.read_to_end(&mut buf).await.ok()?;
            if buf.len() as u64 > MAXIMO_SALIDA {
                return None;
            }
            Some(buf)
        };
        let ((), buf) = tokio::join!(escribir, leer);
        let estado = hijo.wait().await.ok()?;
        if !estado.success() {
            return None;
        }
        buf
    };
    let buf = tokio::time::timeout(TIEMPO_LECTOR, lectura).await.ok()??;
    let filas: Vec<(usize, String, Option<String>)> = serde_json::from_slice(&buf).ok()?;
    Some(filas.into_iter().map(|(fila, email, nombre)| FilaSiu { fila, email, nombre }).collect())
}
