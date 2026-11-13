use axum::extract::{Path, State};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::util::*;

pub fn dispositivo(agente: Option<&str>) -> String {
    let Some(a) = agente else { return "Dispositivo desconocido".to_string() };
    let navegador = if a.contains("Edg/") || a.contains("EdgA/") || a.contains("EdgiOS/") {
        Some("Edge")
    } else if a.contains("OPR/") || a.contains("Opera") {
        Some("Opera")
    } else if a.contains("Firefox/") || a.contains("FxiOS/") {
        Some("Firefox")
    } else if a.contains("Chrome/") || a.contains("CriOS/") || a.contains("Chromium/") {
        Some("Chrome")
    } else if a.contains("Safari/") && a.contains("Version/") {
        Some("Safari")
    } else {
        None
    };
    let sistema = if a.contains("iPhone") {
        Some("iPhone")
    } else if a.contains("iPad") {
        Some("iPad")
    } else if a.contains("Android") {
        Some("Android")
    } else if a.contains("Windows") {
        Some("Windows")
    } else if a.contains("CrOS") {
        Some("ChromeOS")
    } else if a.contains("Macintosh") || a.contains("Mac OS X") {
        Some("Mac")
    } else if a.contains("Linux") || a.contains("X11") {
        Some("Linux")
    } else {
        None
    };
    match (navegador, sistema) {
        (Some(n), Some(s)) => format!("{n} en {s}"),
        (Some(n), None) => n.to_string(),
        (None, Some(s)) => format!("Navegador en {s}"),
        (None, None) => "Dispositivo desconocido".to_string(),
    }
}

async fn persona(app: &App, ctx: &Ctx, id: &str) -> Result<(i64, String, Option<i64>), ApiError> {
    ctx.owner()?;
    let id: i64 = id.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let f: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT email, universidad_id FROM usuarios WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    let (email, universidad) = f.ok_or_else(ApiError::no_encontrado)?;
    Ok((id, email, universidad))
}

pub async fn listar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let (id, _, _) = persona(&app, &ctx, &id).await?;
    let filas = sqlx::query(
        "SELECT id, agente, ip, creada_en, COALESCE(ultimo_uso, creada_en) AS uso, vence_en FROM sesiones \
         WHERE usuario_id = ? AND revocada = 0 AND vence_en > ? ORDER BY uso DESC, id DESC",
    )
    .bind(id)
    .bind(ahora_txt())
    .fetch_all(&app.db)
    .await?;
    let sesiones: Vec<Value> = filas
        .iter()
        .map(|f| {
            let agente: Option<String> = f.get("agente");
            json!({
                "id": f.get::<i64, _>("id"),
                "dispositivo": dispositivo(agente.as_deref()),
                "agente": agente,
                "ip": f.get::<Option<String>, _>("ip"),
                "creada": f.get::<String, _>("creada_en"),
                "ultimo_uso": f.get::<String, _>("uso"),
                "vence": f.get::<String, _>("vence_en"),
            })
        })
        .collect();
    Ok(ok(json!({"sesiones": sesiones})))
}

pub async fn cerrar_una(State(app): State<Estado>, ctx: Ctx, Path((id, sid)): Path<(String, String)>) -> Resultado {
    let (id, email, universidad) = persona(&app, &ctx, &id).await?;
    ctx.reautenticada(&app.cfg)?;
    let sid: i64 = sid.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let r = sqlx::query("UPDATE sesiones SET revocada = 1 WHERE id = ? AND usuario_id = ? AND revocada = 0 AND vence_en > ?")
        .bind(sid)
        .bind(id)
        .bind(ahora_txt())
        .execute(&app.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::no_encontrado());
    }
    auditar(
        &app.db,
        universidad,
        Some(ctx.usuario.id),
        "sesion_cerrada",
        &format!("{} cerró una sesión de {email}", ctx.usuario.email),
        Some(&ctx.ip),
    )
    .await?;
    Ok(sin_contenido())
}

pub async fn cerrar_todas(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let (id, email, universidad) = persona(&app, &ctx, &id).await?;
    ctx.reautenticada(&app.cfg)?;
    let r = sqlx::query("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0 AND vence_en > ?")
        .bind(id)
        .bind(ahora_txt())
        .execute(&app.db)
        .await?;
    let n = r.rows_affected() as i64;
    auditar(
        &app.db,
        universidad,
        Some(ctx.usuario.id),
        "sesiones_cerradas",
        &format!("{} cerró {n} sesiones de {email}", ctx.usuario.email),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(json!({"cerradas": n})))
}
