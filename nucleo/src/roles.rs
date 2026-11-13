use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::email::Mail;
use crate::login::enviar_mail;
use crate::util::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Alcance {
    Universidad(i64),
    Prohibido,
    NoEncontrado,
}

pub fn universidad_pedida(consulta: Option<&str>) -> Option<String> {
    let q = consulta?;
    url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "universidad").map(|(_, v)| v.into_owned())
}

pub async fn alcance_admin(db: &SqlitePool, usuario: &Usuario, consulta: Option<&str>) -> Result<Alcance, sqlx::Error> {
    let propia = match (usuario.administrador, usuario.universidad_id) {
        (true, Some(u)) => Some(u),
        _ => None,
    };
    let Some(pedida) = universidad_pedida(consulta) else {
        return Ok(propia.map(Alcance::Universidad).unwrap_or(Alcance::Prohibido));
    };
    if !usuario.owner && propia.is_none() {
        return Ok(Alcance::Prohibido);
    }
    let Ok(id) = pedida.trim().parse::<i64>() else {
        return Ok(Alcance::NoEncontrado);
    };
    if usuario.owner {
        let existe: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM universidades WHERE id = ?").bind(id).fetch_optional(db).await?;
        return Ok(if existe.is_some() { Alcance::Universidad(id) } else { Alcance::NoEncontrado });
    }
    Ok(if propia == Some(id) { Alcance::Universidad(id) } else { Alcance::NoEncontrado })
}

fn ultimo_administrador() -> ApiError {
    ApiError::conflicto(
        "ultimo_administrador",
        "No se puede quitar al último administrador de una universidad activa. Invitá a otro antes.",
    )
}

fn ultimo_owner() -> ApiError {
    ApiError::conflicto("ultimo_owner", "No se puede quitar al último owner.")
}

fn id_de(crudo: &str) -> Result<i64, ApiError> {
    crudo.trim().parse::<i64>().map_err(|_| ApiError::no_encontrado())
}

pub async fn quitar_administrador(
    State(app): State<Estado>,
    ctx: Ctx,
    Path((uni, usuario)): Path<(String, String)>,
) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let uni = id_de(&uni)?;
    let usuario = id_de(&usuario)?;
    let f = sqlx::query("SELECT nombre, deshabilitada_en IS NOT NULL AS deshabilitada FROM universidades WHERE id = ?")
        .bind(uni)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let nombre_uni: String = f.get("nombre");
    let deshabilitada = f.get::<i64, _>("deshabilitada") != 0;
    let email: String = sqlx::query_scalar("SELECT email FROM usuarios WHERE id = ? AND universidad_id = ? AND administrador = 1")
        .bind(usuario)
        .bind(uni)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let mut tx = app.db.begin().await?;
    let r = sqlx::query(
        "UPDATE usuarios SET administrador = 0 WHERE id = ? AND universidad_id = ? AND administrador = 1 AND \
         (EXISTS (SELECT 1 FROM universidades un WHERE un.id = ? AND un.deshabilitada_en IS NOT NULL) OR \
          EXISTS (SELECT 1 FROM usuarios o WHERE o.universidad_id = ? AND o.administrador = 1 AND o.id <> ? \
                  AND o.suspendida_en IS NULL))",
    )
    .bind(usuario)
    .bind(uni)
    .bind(uni)
    .bind(uni)
    .bind(usuario)
    .execute(&mut *tx)
    .await?;
    if r.rows_affected() == 0 {
        let sigue: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM usuarios WHERE id = ? AND universidad_id = ? AND administrador = 1")
                .bind(usuario)
                .bind(uni)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(if sigue.is_some() && !deshabilitada { ultimo_administrador() } else { ApiError::no_encontrado() });
    }
    sqlx::query("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0").bind(usuario).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE tokens_api SET revocado = 1 WHERE usuario_id = ? AND revocado = 0 AND (permisos LIKE '%admin:%' OR permisos LIKE '%owner:%')",
    )
    .bind(usuario)
    .execute(&mut *tx)
    .await?;
    auditar(
        &mut *tx,
        Some(uni),
        Some(ctx.usuario.id),
        "administrador_quitado",
        &format!("{} quitó el rol de administrador de {} a {}", ctx.usuario.email, nombre_uni, email),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(crate::owner::universidad_owner(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?))
}

const SQL_OWNER: &str = "SELECT u.id, u.email, u.nombre, u.pendiente, u.suspendida_en, un.nombre AS universidad \
     FROM usuarios u LEFT JOIN universidades un ON un.id = u.universidad_id WHERE u.owner = 1";

fn owner_json(f: &sqlx::sqlite::SqliteRow) -> Value {
    let estado = if f.get::<Option<String>, _>("suspendida_en").is_some() {
        "suspendida"
    } else if bool_de(f.get("pendiente")) {
        "pendiente"
    } else {
        "activa"
    };
    json!({
        "id": f.get::<i64, _>("id"),
        "email": f.get::<String, _>("email"),
        "nombre": f.get::<String, _>("nombre"),
        "pendiente": bool_de(f.get("pendiente")),
        "estado": estado,
        "universidad": f.get::<Option<String>, _>("universidad"),
    })
}

async fn lista_owners(db: &SqlitePool) -> Result<Vec<Value>, sqlx::Error> {
    let filas = sqlx::query(&format!("{SQL_OWNER} ORDER BY u.nombre, u.id")).fetch_all(db).await?;
    Ok(filas.iter().map(owner_json).collect())
}

pub async fn owners(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    Ok(ok(json!({"owners": lista_owners(&app.db).await?})))
}

fn mail_de_owner(para: &str, quien: &str, dominio_base: &str) -> Mail {
    let direccion = format!("https://{dominio_base}");
    let asunto = "Invitación a Campus IA como owner".to_string();
    let texto = format!(
        "{quien} te dio el rol de owner de Campus IA.\n\nEntrá en {direccion} con tu mail. Te vamos a mandar un código para ingresar."
    );
    let e = escapar_html;
    let html = format!(
        "<!doctype html><html><body style=\"font-family:Inter,Arial,sans-serif;color:#1a1a1a\">\
<p>{} te dio el rol de owner de Campus IA.</p>\
<p><a href=\"{d}\" style=\"color:#1E4FD6\">{d}</a></p>\
<p style=\"color:#666\">Entrá con tu mail. Te vamos a mandar un código para ingresar.</p>\
</body></html>",
        e(quien),
        d = e(&direccion)
    );
    Mail { para: para.to_string(), asunto, texto, html }
}

pub async fn poner_owner(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let email = texto_de(&datos, "email").and_then(normalizar_email).ok_or_else(ApiError::email_invalido)?;
    let existente = usuario_por_email(&app.db, &email).await?;
    let (id, estado, universidad) = match existente {
        Some(u) if u.owner => {
            let f = sqlx::query(&format!("{SQL_OWNER} AND u.id = ?")).bind(u.id).fetch_one(&app.db).await?;
            return Ok(ok(owner_json(&f)));
        }
        Some(u) => {
            sqlx::query("UPDATE usuarios SET owner = 1 WHERE id = ?").bind(u.id).execute(&app.db).await?;
            (u.id, StatusCode::OK, u.universidad_id)
        }
        None => {
            let uni: Option<i64> = sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?")
                .bind(dominio_de(&email))
                .fetch_optional(&app.db)
                .await?;
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO usuarios (email, nombre, universidad_id, owner, pendiente, creado_en) VALUES (?, ?, ?, 1, 1, ?) RETURNING id",
            )
            .bind(&email)
            .bind(nombre_desde_email(&email))
            .bind(uni)
            .bind(ahora_txt())
            .fetch_one(&app.db)
            .await?;
            (id, StatusCode::CREATED, uni)
        }
    };
    auditar(
        &app.db,
        universidad,
        Some(ctx.usuario.id),
        "owner_agregado",
        &format!("{} le dio el rol de owner a {}", ctx.usuario.email, email),
        Some(&ctx.ip),
    )
    .await?;
    let mail = mail_de_owner(&email, &ctx.usuario.nombre, &app.cfg.dominio_base);
    enviar_mail(&app, &mail, "invitacion").await?;
    let f = sqlx::query(&format!("{SQL_OWNER} AND u.id = ?")).bind(id).fetch_one(&app.db).await?;
    Ok(json_estado(estado, owner_json(&f)))
}

pub enum QuitarOwner {
    Quitado { email: String, universidad: Option<i64> },
    NoEsOwner,
    Ultimo,
}

pub async fn quitar_owner_de(db: &SqlitePool, usuario: i64) -> Result<QuitarOwner, sqlx::Error> {
    let mut tx = db.begin().await?;
    let f = sqlx::query("SELECT email, universidad_id FROM usuarios WHERE id = ? AND owner = 1")
        .bind(usuario)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(f) = f else { return Ok(QuitarOwner::NoEsOwner) };
    let r = sqlx::query(
        "UPDATE usuarios SET owner = 0 WHERE id = ? AND owner = 1 AND \
         EXISTS (SELECT 1 FROM usuarios o WHERE o.owner = 1 AND o.id <> ? AND o.suspendida_en IS NULL)",
    )
    .bind(usuario)
    .bind(usuario)
    .execute(&mut *tx)
    .await?;
    if r.rows_affected() == 0 {
        return Ok(QuitarOwner::Ultimo);
    }
    sqlx::query("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0").bind(usuario).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE tokens_api SET revocado = 1 WHERE usuario_id = ? AND revocado = 0 AND (permisos LIKE '%admin:%' OR permisos LIKE '%owner:%')",
    )
    .bind(usuario)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(QuitarOwner::Quitado { email: f.get("email"), universidad: f.get("universidad_id") })
}

pub async fn quitar_owner(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let id = id_de(&id)?;
    match quitar_owner_de(&app.db, id).await? {
        QuitarOwner::NoEsOwner => Err(ApiError::no_encontrado()),
        QuitarOwner::Ultimo => Err(ultimo_owner()),
        QuitarOwner::Quitado { email, universidad } => {
            auditar(
                &app.db,
                universidad,
                Some(ctx.usuario.id),
                "owner_quitado",
                &format!("{} le quitó el rol de owner a {}", ctx.usuario.email, email),
                Some(&ctx.ip),
            )
            .await?;
            Ok(ok(json!({"owners": lista_owners(&app.db).await?})))
        }
    }
}
