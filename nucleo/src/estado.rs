use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::extract::State;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};

use crate::auth::{Ctx, Estado};
use crate::config::Config;
use crate::util::*;

static ARRANQUE: OnceLock<DateTime<Utc>> = OnceLock::new();

pub fn preparar(cfg: &Config) {
    ARRANQUE.get_or_init(Utc::now);
    if let Err(e) = crate::archivos::preparar_raiz(&cfg.raiz_archivos) {
        eprintln!("no se pudo preparar RAIZ_ARCHIVOS ({}): {e}; se reintenta en la primera subida", cfg.raiz_archivos.display());
    }
}

fn disco(raiz: &Path) -> Option<(u64, u64)> {
    let mut p: PathBuf = raiz.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let c = CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let bloque = s.f_frsize as u64;
    Some((s.f_blocks as u64 * bloque, s.f_bavail as u64 * bloque))
}

fn ultimo_respaldo(dir: &Path) -> Value {
    let Ok(entradas) = std::fs::read_dir(dir) else { return Value::Null };
    let mut mejor: Option<(String, NaiveDateTime, u64)> = None;
    for e in entradas.flatten() {
        let Some(nombre) = e.file_name().to_str().map(str::to_string) else { continue };
        let b = nombre.as_bytes();
        if b.len() != 15 || b[8] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit()) {
            continue;
        }
        let Ok(fecha) = NaiveDateTime::parse_from_str(&nombre, "%Y%m%d-%H%M%S") else { continue };
        let Ok(meta) = std::fs::metadata(e.path().join("respaldo.tar.gz")) else { continue };
        if !meta.is_file() {
            continue;
        }
        if mejor.as_ref().map(|(n, _, _)| nombre > *n).unwrap_or(true) {
            mejor = Some((nombre, fecha, meta.len()));
        }
    }
    match mejor {
        Some((nombre, fecha, bytes)) => json!({
            "nombre": nombre,
            "fecha": fecha.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "bytes": bytes,
        }),
        None => Value::Null,
    }
}

pub async fn ver(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    let arranque = *ARRANQUE.get_or_init(Utc::now);
    let activo = (Utc::now() - arranque).num_seconds().max(0);
    let (proveedor, encendidos, cursos) = if app.cfg.contenedores.is_some() {
        let cursos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contenedores").fetch_one(&app.db).await?;
        let encendidos: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM contenedores WHERE estado = 'encendido'").fetch_one(&app.db).await?;
        ("docker", encendidos, cursos)
    } else {
        ("ninguno", 0, 0)
    };
    let (cantidad, bytes): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(tamano), 0) FROM archivos WHERE id NOT IN (SELECT archivo_id FROM archivos_retirados)").fetch_one(&app.db).await?;
    let raiz = app.cfg.raiz_archivos.clone();
    let respaldos = app.cfg.dir_respaldos.clone();
    let (disco, ultimo) = tokio::task::spawn_blocking(move || (disco(&raiz), ultimo_respaldo(&respaldos)))
        .await
        .map_err(|e| anyhow::anyhow!("no se pudo leer el estado del disco: {e}"))?;
    let (total, libres) = disco.unwrap_or((0, 0));
    Ok(ok(json!({
        "nucleo": {
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "arranque": fecha(arranque),
            "segundos_activo": activo,
        },
        "contenedores": {"proveedor": proveedor, "encendidos": encendidos, "cursos": cursos},
        "disco": {"total_bytes": total, "libres_bytes": libres},
        "archivos": {"cantidad": cantidad, "bytes": bytes},
        "respaldo": {"ultimo": ultimo},
    })))
}
