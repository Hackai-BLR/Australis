use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Map, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::util::*;

pub const MAXIMO_TOKENS: i64 = 1_000_000_000_000;
pub const CUPO_POR_DEFECTO: i64 = 20_000_000;
pub const MENSAJE_CUPO_PROFESOR: &str = "Se agotó tu cupo mensual de uso del agente.";
pub const MENSAJE_CUPO_UNIVERSIDAD: &str = "Se agotó el cupo mensual de uso del agente de la universidad.";

static CAMBIOS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn porcentaje(usado: i64, cupo: i64) -> i64 {
    if cupo <= 0 {
        return if usado > 0 { 100 } else { 0 };
    }
    ((usado.max(0) as i128 * 100) / cupo as i128).min(i64::MAX as i128) as i64
}

pub async fn usado_universidad(db: &SqlitePool, universidad: i64, mes: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(SUM(tokens), 0) FROM uso_modelo WHERE universidad_id = ? AND mes = ?")
        .bind(universidad)
        .bind(mes)
        .fetch_one(db)
        .await
}

pub async fn usado_profesor(db: &SqlitePool, usuario: i64, universidad: i64, mes: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(SUM(tokens), 0) FROM uso_modelo WHERE usuario_id = ? AND universidad_id = ? AND mes = ?")
        .bind(usuario)
        .bind(universidad)
        .bind(mes)
        .fetch_one(db)
        .await
}

pub async fn cupo_universidad(db: &SqlitePool, universidad: i64) -> Result<Option<(i64, Option<i64>)>, sqlx::Error> {
    sqlx::query_as("SELECT cupo_tokens, cupo_profesor_predeterminado FROM universidades WHERE id = ?")
        .bind(universidad)
        .fetch_optional(db)
        .await
}

pub async fn cupo_profesor(db: &SqlitePool, usuario: i64, universidad: i64) -> Result<Option<i64>, sqlx::Error> {
    let propio: Option<i64> = sqlx::query_scalar("SELECT tokens FROM cupos_profesor WHERE usuario_id = ? AND universidad_id = ?")
        .bind(usuario)
        .bind(universidad)
        .fetch_optional(db)
        .await?;
    if propio.is_some() {
        return Ok(propio);
    }
    Ok(cupo_universidad(db, universidad).await?.and_then(|c| c.1))
}

struct Profesor {
    id: i64,
    nombre: String,
    email: String,
    propio: Option<i64>,
}

async fn profesores(db: &SqlitePool, universidad: i64) -> Result<Vec<Profesor>, sqlx::Error> {
    let filas = sqlx::query(
        "SELECT u.id, u.nombre, u.email, cp.tokens AS propio FROM usuarios u \
         LEFT JOIN cupos_profesor cp ON cp.usuario_id = u.id AND cp.universidad_id = u.universidad_id \
         WHERE u.universidad_id = ? AND u.profesor = 1 AND u.suspendida_en IS NULL AND u.baja_en IS NULL",
    )
    .bind(universidad)
    .fetch_all(db)
    .await?;
    let mut lista: Vec<Profesor> = filas
        .iter()
        .map(|f| Profesor { id: f.get("id"), nombre: f.get("nombre"), email: f.get("email"), propio: f.get("propio") })
        .collect();
    lista.sort_by(|a, b| (sin_acentos(&a.nombre), &a.email).cmp(&(sin_acentos(&b.nombre), &b.email)));
    Ok(lista)
}

fn repartido(lista: &[Profesor], predeterminado: Option<i64>, cambio: Option<(i64, Option<i64>)>) -> i128 {
    lista
        .iter()
        .map(|p| {
            let propio = match cambio {
                Some((id, valor)) if id == p.id => valor,
                _ => p.propio,
            };
            propio.or(predeterminado).unwrap_or(0) as i128
        })
        .sum()
}

async fn usados_por_profesor(db: &SqlitePool, universidad: i64, mes: &str) -> Result<HashMap<i64, i64>, sqlx::Error> {
    let filas: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT usuario_id, COALESCE(SUM(tokens), 0) FROM uso_modelo WHERE universidad_id = ? AND mes = ? AND usuario_id IS NOT NULL GROUP BY usuario_id",
    )
    .bind(universidad)
    .bind(mes)
    .fetch_all(db)
    .await?;
    Ok(filas.into_iter().collect())
}

pub async fn cupo_universidad_json(db: &SqlitePool, universidad: i64, mes: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(f) = sqlx::query(
        "SELECT id, nombre, cupo_tokens, cupo_profesor_predeterminado, deshabilitada_en IS NOT NULL AS deshabilitada FROM universidades WHERE id = ?",
    )
    .bind(universidad)
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let cupo: i64 = f.get("cupo_tokens");
    let predeterminado: Option<i64> = f.get("cupo_profesor_predeterminado");
    let usado = usado_universidad(db, universidad, mes).await?;
    let lista = profesores(db, universidad).await?;
    let rep = repartido(&lista, predeterminado, None);
    let reserva = (cupo as i128 - rep).max(0);
    let p = porcentaje(usado, cupo);
    Ok(Some(json!({
        "id": f.get::<i64, _>("id"),
        "nombre": f.get::<String, _>("nombre"),
        "cupo": cupo,
        "usado": usado,
        "porcentaje": p,
        "aviso": p >= 80,
        "repartido": rep.min(i64::MAX as i128) as i64,
        "reserva": reserva.min(i64::MAX as i128) as i64,
        "deshabilitada": f.get::<i64, _>("deshabilitada") != 0,
    })))
}

async fn cupos_admin_json(db: &SqlitePool, universidad: i64) -> Result<Value, ApiError> {
    let mes = mes_actual();
    let uni = cupo_universidad_json(db, universidad, &mes).await?.ok_or_else(ApiError::no_encontrado)?;
    let (_, predeterminado) = cupo_universidad(db, universidad).await?.ok_or_else(ApiError::no_encontrado)?;
    let usados = usados_por_profesor(db, universidad, &mes).await?;
    let lista = profesores(db, universidad).await?;
    let profes: Vec<Value> = lista
        .iter()
        .map(|p| {
            let cupo = p.propio.or(predeterminado);
            let usado = usados.get(&p.id).copied().unwrap_or(0);
            let pc = cupo.map(|c| porcentaje(usado, c));
            json!({
                "id": p.id,
                "nombre": p.nombre,
                "email": p.email,
                "cupo": cupo,
                "propio": p.propio.is_some(),
                "usado": usado,
                "porcentaje": pc,
                "aviso": pc.map(|x| x >= 80).unwrap_or(false),
            })
        })
        .collect();
    Ok(json!({"mes": mes, "universidad": uni, "predeterminado": predeterminado, "profesores": profes}))
}

fn tokens_de(datos: &Map<String, Value>, nulo: bool) -> Result<Option<i64>, ApiError> {
    match datos.get("tokens") {
        Some(Value::Null) if nulo => Ok(None),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(t) if (0..=MAXIMO_TOKENS).contains(&t) => Ok(Some(t)),
            _ => Err(ApiError::datos_invalidos()),
        },
        _ => Err(ApiError::datos_invalidos()),
    }
}

fn cupo_excedido() -> ApiError {
    ApiError::conflicto("cupo_excedido", "Lo repartido supera el cupo de la universidad.")
}

async fn nombre_de(db: &SqlitePool, universidad: i64) -> Result<String, sqlx::Error> {
    let n: Option<String> = sqlx::query_scalar("SELECT nombre FROM universidades WHERE id = ?").bind(universidad).fetch_optional(db).await?;
    Ok(n.unwrap_or_default())
}

pub async fn owner_cupos(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    ctx.owner()?;
    let mes = mes_actual();
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM universidades ORDER BY nombre").fetch_all(&app.db).await?;
    let mut lista = Vec::new();
    for id in ids {
        if let Some(u) = cupo_universidad_json(&app.db, id, &mes).await? {
            lista.push(u);
        }
    }
    Ok(ok(json!({"mes": mes, "universidades": lista})))
}

pub async fn owner_poner_cupo(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.owner()?;
    let id: i64 = id.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let tokens = tokens_de(&datos, false)?.ok_or_else(ApiError::datos_invalidos)?;
    let _g = CAMBIOS.lock().await;
    let r = sqlx::query("UPDATE universidades SET cupo_tokens = ? WHERE id = ?").bind(tokens).bind(id).execute(&app.db).await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::no_encontrado());
    }
    let nombre = nombre_de(&app.db, id).await?;
    auditar(
        &app.db,
        Some(id),
        Some(ctx.usuario.id),
        "cupo_universidad",
        &format!("Asignó a la universidad {nombre} un cupo mensual de {tokens} tokens"),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(cupo_universidad_json(&app.db, id, &mes_actual()).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn admin_cupos(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let uni = ctx.admin()?;
    Ok(ok(cupos_admin_json(&app.db, uni).await?))
}

pub async fn admin_predeterminado(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let uni = ctx.admin()?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let tokens = tokens_de(&datos, true)?;
    let _g = CAMBIOS.lock().await;
    let (cupo, actual) = cupo_universidad(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?;
    let lista = profesores(&app.db, uni).await?;
    let antes = repartido(&lista, actual, None);
    let despues = repartido(&lista, tokens, None);
    if despues > cupo as i128 && despues > antes {
        return Err(cupo_excedido());
    }
    sqlx::query("UPDATE universidades SET cupo_profesor_predeterminado = ? WHERE id = ?").bind(tokens).bind(uni).execute(&app.db).await?;
    let nombre = nombre_de(&app.db, uni).await?;
    let valor = tokens.map(|t| format!("{t} tokens")).unwrap_or_else(|| "sin predeterminado".to_string());
    auditar(
        &app.db,
        Some(uni),
        Some(ctx.usuario.id),
        "cupo_predeterminado",
        &format!("Puso el cupo predeterminado de los profesores de {nombre} en {valor}"),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(cupos_admin_json(&app.db, uni).await?))
}

pub async fn admin_cupo_profesor(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(usuario): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let uni = ctx.admin()?;
    let usuario: i64 = usuario.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let f: Option<(Option<i64>, i64, String)> = sqlx::query_as("SELECT universidad_id, profesor, email FROM usuarios WHERE id = ?")
        .bind(usuario)
        .fetch_optional(&app.db)
        .await?;
    let Some((Some(su_uni), profesor, email)) = f else { return Err(ApiError::no_encontrado()) };
    if su_uni != uni {
        return Err(ApiError::no_encontrado());
    }
    if profesor != 1 {
        return Err(ApiError::nuevo(
            StatusCode::BAD_REQUEST,
            "no_es_profesor",
            "Solo las personas con marca de profesor pueden tener cupo.",
        ));
    }
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let tokens = tokens_de(&datos, true)?;
    let _g = CAMBIOS.lock().await;
    let (cupo, predeterminado) = cupo_universidad(&app.db, uni).await?.ok_or_else(ApiError::no_encontrado)?;
    let lista = profesores(&app.db, uni).await?;
    let antes = repartido(&lista, predeterminado, None);
    let despues = repartido(&lista, predeterminado, Some((usuario, tokens)));
    if despues > cupo as i128 && despues > antes {
        return Err(cupo_excedido());
    }
    match tokens {
        Some(t) => {
            sqlx::query(
                "INSERT INTO cupos_profesor (usuario_id, universidad_id, tokens, actualizado_en, actualizado_por) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(usuario_id) DO UPDATE SET universidad_id = excluded.universidad_id, tokens = excluded.tokens, \
                 actualizado_en = excluded.actualizado_en, actualizado_por = excluded.actualizado_por",
            )
            .bind(usuario)
            .bind(uni)
            .bind(t)
            .bind(ahora_txt())
            .bind(ctx.usuario.id)
            .execute(&app.db)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM cupos_profesor WHERE usuario_id = ?").bind(usuario).execute(&app.db).await?;
        }
    }
    let nombre = nombre_de(&app.db, uni).await?;
    let valor = tokens.map(|t| format!("{t} tokens")).unwrap_or_else(|| "el predeterminado".to_string());
    auditar(
        &app.db,
        Some(uni),
        Some(ctx.usuario.id),
        "cupo_profesor",
        &format!("Puso el cupo de {email} en {nombre} en {valor}"),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(cupos_admin_json(&app.db, uni).await?))
}

pub enum Agotado {
    Profesor,
    Universidad,
}

impl Agotado {
    pub fn nombre(&self) -> &'static str {
        match self {
            Agotado::Profesor => "profesor",
            Agotado::Universidad => "universidad",
        }
    }

    pub fn mensaje(&self) -> &'static str {
        match self {
            Agotado::Profesor => MENSAJE_CUPO_PROFESOR,
            Agotado::Universidad => MENSAJE_CUPO_UNIVERSIDAD,
        }
    }
}

pub async fn agotado(db: &SqlitePool, usuario: i64, universidad: i64) -> Result<Option<Agotado>, sqlx::Error> {
    let mes = mes_actual();
    if let Some(c) = cupo_profesor(db, usuario, universidad).await? {
        if usado_profesor(db, usuario, universidad, &mes).await? >= c {
            return Ok(Some(Agotado::Profesor));
        }
    }
    let cupo = cupo_universidad(db, universidad).await?.map(|c| c.0).unwrap_or(0);
    if usado_universidad(db, universidad, &mes).await? >= cupo {
        return Ok(Some(Agotado::Universidad));
    }
    Ok(None)
}

pub fn cupo_agotado(a: &Agotado) -> ApiError {
    let mut e = ApiError::nuevo(StatusCode::TOO_MANY_REQUESTS, "cupo_agotado", a.mensaje());
    e.extra = Some(("cupo", Value::String(a.nombre().to_string())));
    e
}

pub async fn curso_cupo(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let curso = crate::agente::docente(&app, &ctx, &id).await?;
    let uni = curso.universidad_id;
    let mes = mes_actual();
    let cupo_p = cupo_profesor(&app.db, ctx.usuario.id, uni).await?;
    let usado_p = usado_profesor(&app.db, ctx.usuario.id, uni, &mes).await?;
    let cupo_u = cupo_universidad(&app.db, uni).await?.map(|c| c.0).unwrap_or(0);
    let usado_u = usado_universidad(&app.db, uni, &mes).await?;
    let restante_u = (cupo_u - usado_u).max(0);
    let restante_p = cupo_p.map(|c| (c - usado_p).max(0));
    let restante = restante_p.map(|r| r.min(restante_u)).unwrap_or(restante_u);
    let pc_p = cupo_p.map(|c| porcentaje(usado_p, c));
    let pc_u = porcentaje(usado_u, cupo_u);
    let aviso = pc_p.map(|x| x >= 80).unwrap_or(false) || pc_u >= 80;
    let agotado = match cupo_p {
        Some(c) if usado_p >= c => Value::String("profesor".into()),
        _ if usado_u >= cupo_u => Value::String("universidad".into()),
        _ => Value::Null,
    };
    Ok(ok(json!({
        "mes": mes,
        "cupo": cupo_p,
        "usado": usado_p,
        "restante": restante,
        "porcentaje": pc_p,
        "universidad": {"cupo": cupo_u, "usado": usado_u, "restante": restante_u, "porcentaje": pc_u},
        "aviso": aviso,
        "agotado": agotado,
        "modelo_disponible": app.intermediario.modelo_disponible(),
    })))
}
