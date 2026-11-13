use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::admin::{invitar, limite_valido};
use crate::auth::*;
use crate::db::auditar;
use crate::util::*;

pub async fn universidad_owner(db: &SqlitePool, id: i64) -> Result<Option<Value>, sqlx::Error> {
    let Some(f) = sqlx::query(
        "SELECT un.id, un.nombre, un.limite_usd, un.cupo_tokens, un.deshabilitada_en IS NOT NULL AS deshabilitada, \
         (SELECT COUNT(*) FROM usuarios u WHERE u.universidad_id = un.id AND u.profesor = 1 AND u.owner = 0) AS profesores, \
         (SELECT COUNT(*) FROM usuarios u WHERE u.universidad_id = un.id AND u.owner = 0) AS personas, \
         (SELECT COUNT(*) FROM cursos c WHERE c.universidad_id = un.id) AS cursos \
         FROM universidades un WHERE un.id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let dominios: Vec<String> = sqlx::query_scalar("SELECT dominio FROM dominios WHERE universidad_id = ? ORDER BY dominio")
        .bind(id)
        .fetch_all(db)
        .await?;
    let admins = sqlx::query(
        "SELECT id, nombre, email, pendiente FROM usuarios WHERE universidad_id = ? AND administrador = 1 ORDER BY nombre",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let administradores: Vec<Value> = admins
        .iter()
        .map(|a| {
            json!({
                "id": a.get::<i64, _>("id"),
                "nombre": a.get::<String, _>("nombre"),
                "email": a.get::<String, _>("email"),
                "pendiente": bool_de(a.get("pendiente")),
            })
        })
        .collect();
    Ok(Some(json!({
        "id": f.get::<i64, _>("id"),
        "nombre": f.get::<String, _>("nombre"),
        "dominios": dominios,
        "limite_usd": f.get::<f64, _>("limite_usd"),
        "cupo_tokens": f.get::<i64, _>("cupo_tokens"),
        "administradores": administradores,
        "profesores": f.get::<i64, _>("profesores"),
        "personas": f.get::<i64, _>("personas"),
        "cursos": f.get::<i64, _>("cursos"),
        "deshabilitada": f.get::<i64, _>("deshabilitada") != 0,
    })))
}

pub async fn universidades(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM universidades ORDER BY nombre").fetch_all(&app.db).await?;
    let mut lista = Vec::new();
    for id in ids {
        if let Some(u) = universidad_owner(&app.db, id).await? {
            lista.push(u);
        }
    }
    Ok(ok(json!({"universidades": lista})))
}

pub async fn crear_universidad(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let nombre = texto_de(&datos, "nombre").map(str::trim).unwrap_or("").to_string();
    if nombre.is_empty() || nombre.chars().count() > 200 {
        return Err(ApiError::datos_invalidos());
    }
    let dominio = texto_de(&datos, "dominio").and_then(normalizar_dominio).ok_or_else(ApiError::datos_invalidos)?;
    let email =
        texto_de(&datos, "email_administrador").and_then(normalizar_email).ok_or_else(ApiError::email_invalido)?;
    let limite = match datos.get("limite_usd") {
        None | Some(Value::Null) => 20.0,
        v => limite_valido(v).ok_or_else(ApiError::datos_invalidos)?,
    };
    let cupo = match datos.get("cupo_tokens") {
        None | Some(Value::Null) => crate::cupos::CUPO_POR_DEFECTO,
        Some(v) => v.as_i64().filter(|n| (0..=crate::cupos::MAXIMO_TOKENS).contains(n)).ok_or_else(ApiError::datos_invalidos)?,
    };
    if dominio_de(&email) != dominio {
        return Err(ApiError::dominio_no_habilitado());
    }
    let en_uso: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM dominios WHERE dominio = ?").bind(&dominio).fetch_optional(&app.db).await?;
    if en_uso.is_some() {
        return Err(ApiError::conflicto("dominio_en_uso", "Ese dominio ya está habilitado en una universidad."));
    }
    if usuario_por_email(&app.db, &email).await?.is_some() {
        return Err(ApiError::conflicto("email_en_uso", "Ese mail ya tiene una cuenta."));
    }
    let mut tx = app.db.begin().await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO universidades (nombre, limite_usd, cupo_tokens, creada_en) VALUES (?, ?, ?, ?) RETURNING id")
        .bind(&nombre)
        .bind(limite)
        .bind(cupo)
        .bind(ahora_txt())
        .fetch_one(&mut *tx)
        .await?;
    let r = sqlx::query("INSERT OR IGNORE INTO dominios (dominio, universidad_id) VALUES (?, ?)")
        .bind(&dominio)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::conflicto("dominio_en_uso", "Ese dominio ya está habilitado en una universidad."));
    }
    auditar(
        &mut *tx,
        Some(id),
        Some(ctx.usuario.id),
        "universidad_creada",
        &format!("Creó la universidad {nombre} con el dominio {dominio}"),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    invitar(&app, &ctx, id, &email, "administrador").await?;
    Ok(json_estado(StatusCode::CREATED, universidad_owner(&app.db, id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn invitar_administrador(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let email = texto_de(&datos, "email").and_then(normalizar_email).ok_or_else(ApiError::email_invalido)?;
    let id: i64 = id.parse().map_err(|_| ApiError::no_encontrado())?;
    let existe: Option<i64> =
        sqlx::query_scalar("SELECT id FROM universidades WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    if existe.is_none() {
        return Err(ApiError::no_encontrado());
    }
    invitar(&app, &ctx, id, &email, "administrador").await
}

pub async fn agregar_dominio(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let dominio = texto_de(&datos, "dominio").and_then(normalizar_dominio).ok_or_else(ApiError::datos_invalidos)?;
    let id: i64 = id.parse().map_err(|_| ApiError::no_encontrado())?;
    let existe: Option<i64> =
        sqlx::query_scalar("SELECT id FROM universidades WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    if existe.is_none() {
        return Err(ApiError::no_encontrado());
    }
    let r = sqlx::query("INSERT OR IGNORE INTO dominios (dominio, universidad_id) VALUES (?, ?)")
        .bind(&dominio)
        .bind(id)
        .execute(&app.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::conflicto("dominio_en_uso", "Ese dominio ya está habilitado en una universidad."));
    }
    auditar(&app.db, Some(id), Some(ctx.usuario.id), "dominio_agregado", &format!("Habilitó el dominio {dominio}"), Some(&ctx.ip))
        .await?;
    Ok(json_estado(StatusCode::CREATED, universidad_owner(&app.db, id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn uso(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    let mes = mes_actual();
    let personas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usuarios WHERE owner = 0").fetch_one(&app.db).await?;
    let cursos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cursos").fetch_one(&app.db).await?;
    let agente: f64 = sqlx::query_scalar("SELECT COALESCE(SUM(usd), 0.0) FROM uso_agente WHERE mes = ?")
        .bind(&mes)
        .fetch_one(&app.db)
        .await?;
    let mails_hoy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM emails_enviados WHERE fecha >= ?")
        .bind(inicio_del_dia())
        .fetch_one(&app.db)
        .await?;
    let filas = sqlx::query(
        "SELECT un.id, un.nombre, (SELECT COUNT(*) FROM cursos c WHERE c.universidad_id = un.id) AS cursos, \
         COALESCE((SELECT SUM(g.usd) FROM uso_agente g JOIN cursos c ON c.id = g.curso_id WHERE c.universidad_id = un.id AND g.mes = ?), 0.0) AS usd \
         FROM universidades un ORDER BY un.nombre",
    )
    .bind(&mes)
    .fetch_all(&app.db)
    .await?;
    let universidades: Vec<Value> = filas
        .iter()
        .map(|f| {
            json!({
                "id": f.get::<i64, _>("id"),
                "nombre": f.get::<String, _>("nombre"),
                "cursos": f.get::<i64, _>("cursos"),
                "agente_usd_mes": f.get::<f64, _>("usd"),
            })
        })
        .collect();
    Ok(ok(json!({
        "personas": personas,
        "cursos": cursos,
        "agente_usd_mes": agente,
        "mails_hoy": mails_hoy,
        "universidades": universidades,
    })))
}

async fn leer_proveedores(db: &SqlitePool) -> Result<Value, sqlx::Error> {
    let modelo: Option<String> = sqlx::query_scalar("SELECT valor FROM configuracion WHERE clave = 'proveedor_modelo'")
        .fetch_optional(db)
        .await?;
    let email: Option<String> = sqlx::query_scalar("SELECT valor FROM configuracion WHERE clave = 'proveedor_email'")
        .fetch_optional(db)
        .await?;
    Ok(json!({
        "modelo": modelo.unwrap_or_else(|| "api".into()),
        "email": email.unwrap_or_else(|| "brevo".into()),
    }))
}

pub async fn ver_proveedores(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    Ok(ok(leer_proveedores(&app.db).await?))
}

pub async fn cambiar_proveedores(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    ctx.owner()?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let modelo = match texto_de(&datos, "modelo") {
        Some(m @ ("api" | "suscripcion")) => m.to_string(),
        _ => return Err(ApiError::datos_invalidos()),
    };
    let email = match texto_de(&datos, "email") {
        Some(e @ ("brevo" | "resend")) => e.to_string(),
        _ => return Err(ApiError::datos_invalidos()),
    };
    let mut tx = app.db.begin().await?;
    for (clave, valor) in [("proveedor_modelo", &modelo), ("proveedor_email", &email)] {
        sqlx::query("INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
            .bind(clave)
            .bind(valor)
            .execute(&mut *tx)
            .await?;
    }
    auditar(
        &mut *tx,
        None,
        Some(ctx.usuario.id),
        "proveedores_cambiados",
        &format!("Proveedor del modelo: {modelo}; proveedor de mails: {email}"),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(leer_proveedores(&app.db).await?))
}
