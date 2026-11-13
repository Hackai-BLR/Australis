use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::email::mail_de_invitacion;
use crate::login::enviar_mail;
use crate::util::*;

pub async fn universidad_json(db: &SqlitePool, id: i64) -> Result<Option<Value>, sqlx::Error> {
    let Some(f) = sqlx::query("SELECT id, nombre, limite_usd, cupo_tokens FROM universidades WHERE id = ?").bind(id).fetch_optional(db).await?
    else {
        return Ok(None);
    };
    let dominios: Vec<String> = sqlx::query_scalar("SELECT dominio FROM dominios WHERE universidad_id = ? ORDER BY dominio")
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(Some(json!({
        "id": f.get::<i64, _>("id"),
        "nombre": f.get::<String, _>("nombre"),
        "dominios": dominios,
        "limite_usd": f.get::<f64, _>("limite_usd"),
        "cupo_tokens": f.get::<i64, _>("cupo_tokens"),
    })))
}

const SQL_PERSONA: &str = "SELECT u.id, u.email, u.nombre, u.profesor, u.administrador, u.owner, u.pendiente, u.ultimo_ingreso, \
     u.suspendida_en, u.baja_en, (SELECT COUNT(*) FROM inscripciones i WHERE i.usuario_id = u.id) AS cursos FROM usuarios u";

fn persona_json(f: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": f.get::<i64, _>("id"),
        "email": f.get::<String, _>("email"),
        "nombre": f.get::<String, _>("nombre"),
        "profesor": bool_de(f.get("profesor")),
        "administrador": bool_de(f.get("administrador")),
        "owner": bool_de(f.get("owner")),
        "pendiente": bool_de(f.get("pendiente")),
        "cursos": f.get::<i64, _>("cursos"),
        "ultimo_ingreso": f.get::<Option<String>, _>("ultimo_ingreso"),
        "estado": estado_persona(f),
        "baja": f.get::<Option<String>, _>("baja_en").is_some(),
    })
}

fn estado_persona(f: &sqlx::sqlite::SqliteRow) -> &'static str {
    if f.get::<Option<String>, _>("suspendida_en").is_some() {
        "suspendida"
    } else if bool_de(f.get("pendiente")) {
        "pendiente"
    } else {
        "activa"
    }
}

pub async fn persona(db: &SqlitePool, id: i64) -> Result<Option<Value>, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_PERSONA} WHERE u.id = ?")).bind(id).fetch_optional(db).await?;
    Ok(f.as_ref().map(persona_json))
}

pub async fn ver_universidad(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let uni = ctx.admin()?;
    Ok(ok(universidad_json(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn personas(State(app): State<Estado>, ctx: Ctx, Query(q): Query<HashMap<String, String>>) -> Resultado {
    let uni = ctx.admin()?;
    let filtro = q.get("filtro").map(String::as_str).unwrap_or("todos");
    let condicion = match filtro {
        "" | "todos" => "",
        "profesores" | "prof" => " AND u.profesor = 1",
        "administradores" | "admin" => " AND u.administrador = 1",
        _ => return Err(ApiError::datos_invalidos()),
    };
    let estado = match q.get("estado").map(String::as_str).unwrap_or("todas") {
        "" | "todas" => None,
        "activas" => Some("activa"),
        "suspendidas" => Some("suspendida"),
        "pendientes" => Some("pendiente"),
        _ => return Err(ApiError::datos_invalidos()),
    };
    let filas = sqlx::query(&format!("{SQL_PERSONA} WHERE u.universidad_id = ?{condicion}"))
        .bind(uni)
        .fetch_all(&app.db)
        .await?;
    let buscar = sin_acentos(q.get("buscar").map(|s| s.trim()).unwrap_or(""));
    let mut lista: Vec<(String, Value)> = filas
        .iter()
        .filter(|f| estado.map(|e| estado_persona(f) == e).unwrap_or(true))
        .filter(|f| {
            buscar.is_empty()
                || sin_acentos(&f.get::<String, _>("nombre")).contains(&buscar)
                || sin_acentos(&f.get::<String, _>("email")).contains(&buscar)
        })
        .map(|f| (sin_acentos(&f.get::<String, _>("nombre")), persona_json(f)))
        .collect();
    lista.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ok(json!({"personas": lista.into_iter().map(|p| p.1).collect::<Vec<_>>()})))
}

pub async fn marcar_profesor(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    let uni = ctx.admin()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let profesor = datos.get("profesor").and_then(|v| v.as_bool()).ok_or_else(ApiError::datos_invalidos)?;
    let id: i64 = id.parse().map_err(|_| ApiError::no_encontrado())?;
    let email: String = sqlx::query_scalar("SELECT email FROM usuarios WHERE id = ? AND universidad_id = ?")
        .bind(id)
        .bind(uni)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE usuarios SET profesor = ? WHERE id = ?").bind(profesor as i64).bind(id).execute(&mut *tx).await?;
    let (accion, detalle) = if profesor {
        ("marca_profesor", format!("Marcó como profesor a {email}"))
    } else {
        ("quita_profesor", format!("Quitó la marca de profesor a {email}"))
    };
    auditar(&mut *tx, Some(uni), Some(ctx.usuario.id), accion, &detalle, Some(&ctx.ip)).await?;
    if !profesor {
        let cursos: Vec<(String, i64)> = sqlx::query_as(
            "SELECT c.id, c.universidad_id FROM inscripciones i JOIN cursos c ON c.id = i.curso_id \
             WHERE i.usuario_id = ? AND i.rol = 'profesor' ORDER BY c.id",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        sqlx::query("UPDATE inscripciones SET rol = 'alumno' WHERE usuario_id = ? AND rol = 'profesor'")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for (curso, universidad) in cursos {
            auditar(
                &mut *tx,
                Some(universidad),
                Some(ctx.usuario.id),
                "rol_en_curso",
                &format!("{} pasó a alumno en el curso {} porque perdió la marca de profesor", email, curso),
                Some(&ctx.ip),
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(ok(persona(&app.db, id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn invitar(
    app: &App,
    ctx: &Ctx,
    uni: i64,
    email: &str,
    tipo: &str,
) -> Result<axum::response::Response, ApiError> {
    let dominio_uni: Option<i64> = sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?")
        .bind(dominio_de(email))
        .fetch_optional(&app.db)
        .await?;
    if dominio_uni != Some(uni) {
        return Err(ApiError::dominio_no_habilitado());
    }
    crate::inhabilitar::universidad_habilitada(&app.db, uni).await?;
    let nombre_uni: String =
        sqlx::query_scalar("SELECT nombre FROM universidades WHERE id = ?").bind(uni).fetch_one(&app.db).await?;
    let columna = if tipo == "administrador" { "administrador" } else { "profesor" };
    let existente = usuario_por_email(&app.db, email).await?;
    let (id, estado) = match existente {
        Some(u) => {
            if u.universidad_id != Some(uni) {
                return Err(ApiError::conflicto("email_en_uso", "Ese mail ya tiene una cuenta en otra universidad."));
            }
            sqlx::query(&format!("UPDATE usuarios SET {columna} = 1 WHERE id = ?")).bind(u.id).execute(&app.db).await?;
            (u.id, StatusCode::OK)
        }
        None => {
            let id: i64 = sqlx::query_scalar(&format!(
                "INSERT INTO usuarios (email, nombre, universidad_id, {columna}, pendiente, creado_en) VALUES (?, ?, ?, 1, 1, ?) RETURNING id"
            ))
            .bind(email)
            .bind(nombre_desde_email(email))
            .bind(uni)
            .bind(ahora_txt())
            .fetch_one(&app.db)
            .await?;
            (id, StatusCode::CREATED)
        }
    };
    auditar(
        &app.db,
        Some(uni),
        Some(ctx.usuario.id),
        if tipo == "administrador" { "invitacion_administrador" } else { "invitacion_profesor" },
        &format!("Invitó a {email} como {tipo}"),
        Some(&ctx.ip),
    )
    .await?;
    let mail = mail_de_invitacion(email, &ctx.usuario.nombre, &nombre_uni, tipo, &app.cfg.dominio_base);
    enviar_mail(app, &mail, "invitacion").await?;
    Ok(json_estado(estado, persona(&app.db, id).await?.ok_or_else(ApiError::servicio_no_disponible)?))
}

pub async fn invitaciones(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    ctx.solo_sesion()?;
    let uni = ctx.admin()?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let tipo = match texto_de(&datos, "tipo") {
        Some(t @ ("profesor" | "administrador")) => t.to_string(),
        _ => return Err(ApiError::datos_invalidos()),
    };
    let email = texto_de(&datos, "email").and_then(normalizar_email).ok_or_else(ApiError::email_invalido)?;
    invitar(&app, &ctx, uni, &email, &tipo).await
}

pub async fn cursos(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let uni = ctx.admin()?;
    let filas = sqlx::query(
        &format!("SELECT c.id, c.nombre, c.periodo, c.color, c.version_publicada, c.archivado_en IS NOT NULL AS archivado, \
         (SELECT COUNT(*) FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = c.id AND i.rol IN ('dueño', 'profesor') AND NOT {x}) AS profesores, \
         (SELECT COUNT(*) FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = c.id AND i.rol = 'alumno' AND NOT {x}) AS alumnos, \
         COALESCE((SELECT usd FROM uso_agente g WHERE g.curso_id = c.id AND g.mes = ?), 0.0) AS uso, \
         d.id AS dueno_id, d.nombre AS dueno_nombre, d.email AS dueno_email \
         FROM cursos c LEFT JOIN inscripciones di ON di.curso_id = c.id AND di.rol = 'dueño' \
         LEFT JOIN usuarios d ON d.id = di.usuario_id WHERE c.universidad_id = ?", x = crate::inhabilitar::SQL_INHABILITADA),
    )
    .bind(mes_actual())
    .bind(uni)
    .fetch_all(&app.db)
    .await?;
    let mut lista: Vec<(String, Value)> = filas
        .iter()
        .map(|f| {
            let nombre: String = f.get("nombre");
            let dueno = match f.get::<Option<i64>, _>("dueno_id") {
                Some(id) => json!({
                    "id": id,
                    "nombre": f.get::<String, _>("dueno_nombre"),
                    "email": f.get::<String, _>("dueno_email"),
                }),
                None => Value::Null,
            };
            (
                sin_acentos(&nombre),
                json!({
                    "id": f.get::<String, _>("id"),
                    "tipo": crate::cursos::modulos::TIPO_LIBRE,
                    "nombre": nombre,
                    "periodo": f.get::<String, _>("periodo"),
                    "color": f.get::<String, _>("color"),
                    "dueno": dueno,
                    "profesores": f.get::<i64, _>("profesores"),
                    "alumnos": f.get::<i64, _>("alumnos"),
                    "version_publicada": f.get::<Option<i64>, _>("version_publicada"),
                    "uso_usd_mes": f.get::<f64, _>("uso"),
                    "archivado": f.get::<i64, _>("archivado") != 0,
                }),
            )
        })
        .collect();
    lista.extend(crate::cursos::modulos::de_la_universidad_para_admin(&app, uni).await?);
    lista.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ok(json!({"cursos": lista.into_iter().map(|c| c.1).collect::<Vec<_>>()})))
}

async fn dominio_padre(app: &App, dominio: &str) -> Result<Option<i64>, sqlx::Error> {
    let mut resto = dominio;
    while let Some((_, padre)) = resto.split_once('.') {
        if !padre.contains('.') {
            break;
        }
        let uni: Option<i64> =
            sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?").bind(padre).fetch_optional(&app.db).await?;
        if uni.is_some() {
            return Ok(uni);
        }
        resto = padre;
    }
    Ok(None)
}

pub async fn agregar_dominio(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let uni = ctx.admin()?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let dominio = texto_de(&datos, "dominio").and_then(normalizar_dominio).ok_or_else(ApiError::datos_invalidos)?;
    let en_uso: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM dominios WHERE dominio = ?").bind(&dominio).fetch_optional(&app.db).await?;
    if en_uso.is_some() {
        return Err(ApiError::conflicto("dominio_en_uso", "Ese dominio ya está habilitado en una universidad."));
    }
    if dominio_padre(&app, &dominio).await? != Some(uni) {
        return Err(ApiError::nuevo(
            StatusCode::FORBIDDEN,
            "prohibido",
            "Solo se pueden agregar subdominios de los dominios de la universidad. Para otro dominio, pedíselo al owner.",
        ));
    }
    let r = sqlx::query("INSERT OR IGNORE INTO dominios (dominio, universidad_id) VALUES (?, ?)")
        .bind(&dominio)
        .bind(uni)
        .execute(&app.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::conflicto("dominio_en_uso", "Ese dominio ya está habilitado en una universidad."));
    }
    auditar(&app.db, Some(uni), Some(ctx.usuario.id), "dominio_agregado", &format!("Habilitó el dominio {dominio}"), Some(&ctx.ip))
        .await?;
    Ok(json_estado(StatusCode::CREATED, universidad_json(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn quitar_dominio(State(app): State<Estado>, ctx: Ctx, Path(dominio): Path<String>) -> Resultado {
    ctx.solo_sesion()?;
    let uni = ctx.admin()?;
    ctx.reautenticada(&app.cfg)?;
    let dominio = dominio.trim().trim_start_matches('@').to_lowercase();
    let existe: Option<i64> = sqlx::query_scalar("SELECT 1 FROM dominios WHERE dominio = ? AND universidad_id = ?")
        .bind(&dominio)
        .bind(uni)
        .fetch_optional(&app.db)
        .await?;
    if existe.is_none() {
        return Err(ApiError::no_encontrado());
    }
    let mut tx = app.db.begin().await?;
    let cantidad: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dominios WHERE universidad_id = ?")
        .bind(uni)
        .fetch_one(&mut *tx)
        .await?;
    if cantidad <= 1 {
        return Err(ApiError::conflicto("ultimo_dominio", "No se puede quitar el último dominio de la universidad."));
    }
    sqlx::query("DELETE FROM dominios WHERE dominio = ? AND universidad_id = ?").bind(&dominio).bind(uni).execute(&mut *tx).await?;
    auditar(&mut *tx, Some(uni), Some(ctx.usuario.id), "dominio_quitado", &format!("Quitó el dominio {dominio}"), Some(&ctx.ip))
        .await?;
    tx.commit().await?;
    Ok(ok(universidad_json(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub fn limite_valido(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    if n.is_finite() && (0.0..=100_000.0).contains(&n) {
        Some(n)
    } else {
        None
    }
}

pub async fn auditoria(State(app): State<Estado>, ctx: Ctx, Query(q): Query<HashMap<String, String>>) -> Resultado {
    let uni = ctx.admin()?;
    let limite = match q.get("limite") {
        None => 100,
        Some(s) => match s.trim().parse::<i64>() {
            Ok(n) if (1..=1000).contains(&n) => n,
            _ => return Err(ApiError::datos_invalidos()),
        },
    };
    let filas = sqlx::query(
        "SELECT a.id, a.fecha, a.accion, a.detalle, a.ip, a.agente, u.id AS actor_id, u.nombre AS actor_nombre, u.email AS actor_email \
         FROM auditoria a LEFT JOIN usuarios u ON u.id = a.actor_id WHERE a.universidad_id = ? ORDER BY a.id DESC LIMIT ?",
    )
    .bind(uni)
    .bind(limite)
    .fetch_all(&app.db)
    .await?;
    let eventos: Vec<Value> = filas
        .iter()
        .map(|f| {
            let actor = match f.get::<Option<i64>, _>("actor_id") {
                Some(id) => json!({
                    "id": id,
                    "nombre": f.get::<String, _>("actor_nombre"),
                    "email": f.get::<String, _>("actor_email"),
                }),
                None => Value::Null,
            };
            json!({
                "id": f.get::<i64, _>("id"),
                "fecha": f.get::<String, _>("fecha"),
                "actor": actor,
                "accion": f.get::<String, _>("accion"),
                "detalle": f.get::<String, _>("detalle"),
                "ip": f.get::<Option<String>, _>("ip"),
                "agente": f.get::<i64, _>("agente") != 0,
            })
        })
        .collect();
    Ok(ok(json!({"eventos": eventos})))
}
