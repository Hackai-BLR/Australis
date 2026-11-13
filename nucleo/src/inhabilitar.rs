use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::util::*;

pub const SQL_INHABILITADA: &str = "(u.suspendida_en IS NOT NULL OR (u.owner = 0 AND EXISTS (SELECT 1 FROM universidades xu \
     WHERE xu.id = u.universidad_id AND xu.deshabilitada_en IS NOT NULL)))";

pub const SQL_FUERA_DE_SERVICIO: &str = "(c.archivado_en IS NOT NULL OR EXISTS (SELECT 1 FROM universidades xc \
     WHERE xc.id = c.universidad_id AND xc.deshabilitada_en IS NOT NULL))";

pub fn curso_archivado_error() -> ApiError {
    ApiError::conflicto("curso_archivado", "El curso está archivado y no se puede modificar.")
}

fn propia_cuenta() -> ApiError {
    ApiError::conflicto("propia_cuenta", "No podés hacer esto con tu propia cuenta.")
}

fn cuenta_suspendida() -> ApiError {
    ApiError::conflicto("cuenta_suspendida", "La cuenta está suspendida.")
}

pub fn universidad_deshabilitada() -> ApiError {
    ApiError::conflicto("universidad_deshabilitada", "La universidad está deshabilitada.")
}

fn no_es_profesor() -> ApiError {
    ApiError::nuevo(StatusCode::BAD_REQUEST, "no_es_profesor", "Solo las personas con marca de profesor pueden ser profesores.")
}

pub async fn cuenta_inhabilitada(db: &SqlitePool, usuario_id: i64) -> Result<bool, sqlx::Error> {
    let r: Option<i64> = sqlx::query_scalar(&format!("SELECT {SQL_INHABILITADA} FROM usuarios u WHERE u.id = ?"))
        .bind(usuario_id)
        .fetch_optional(db)
        .await?;
    Ok(r.map(|v| v != 0).unwrap_or(true))
}

pub async fn exigir_habilitada(db: &SqlitePool, usuario_id: i64) -> Result<(), ApiError> {
    if cuenta_inhabilitada(db, usuario_id).await? {
        return Err(ApiError::no_autenticado());
    }
    Ok(())
}

pub async fn curso_archivado(db: &SqlitePool, curso: &str) -> Result<bool, sqlx::Error> {
    let r: Option<i64> = sqlx::query_scalar("SELECT archivado_en IS NOT NULL FROM cursos WHERE id = ?")
        .bind(curso)
        .fetch_optional(db)
        .await?;
    Ok(r.map(|v| v != 0).unwrap_or(false))
}

pub async fn curso_fuera_de_servicio(db: &SqlitePool, curso: &str) -> Result<bool, sqlx::Error> {
    let r: Option<i64> = sqlx::query_scalar(&format!("SELECT {SQL_FUERA_DE_SERVICIO} FROM cursos c WHERE c.id = ?"))
        .bind(curso)
        .fetch_optional(db)
        .await?;
    Ok(r.map(|v| v != 0).unwrap_or(false))
}

pub async fn curso_servible(db: &SqlitePool, curso: &str) -> Result<bool, sqlx::Error> {
    Ok(!curso_fuera_de_servicio(db, curso).await?)
}

pub async fn curso_modificable(db: &SqlitePool, curso: &str) -> Result<(), ApiError> {
    if curso_archivado(db, curso).await? {
        return Err(curso_archivado_error());
    }
    Ok(())
}

pub async fn curso_visible(db: &SqlitePool, curso: &str, rol: &str) -> Result<(), ApiError> {
    if rol == "alumno" && curso_archivado(db, curso).await? {
        return Err(ApiError::no_encontrado());
    }
    Ok(())
}

pub async fn universidad_habilitada(db: &SqlitePool, universidad: i64) -> Result<(), ApiError> {
    let r: Option<i64> = sqlx::query_scalar("SELECT deshabilitada_en IS NOT NULL FROM universidades WHERE id = ?")
        .bind(universidad)
        .fetch_optional(db)
        .await?;
    if r == Some(1) {
        return Err(universidad_deshabilitada());
    }
    Ok(())
}

pub async fn login_permitido(db: &SqlitePool, email: &str) -> Result<bool, sqlx::Error> {
    let cuenta: Option<i64> = sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?").bind(email).fetch_optional(db).await?;
    if let Some(id) = cuenta {
        return Ok(!cuenta_inhabilitada(db, id).await?);
    }
    let deshabilitada: Option<i64> = sqlx::query_scalar(
        "SELECT un.deshabilitada_en IS NOT NULL FROM dominios d JOIN universidades un ON un.id = d.universidad_id WHERE d.dominio = ?",
    )
    .bind(dominio_de(email))
    .fetch_optional(db)
    .await?;
    Ok(deshabilitada != Some(1))
}

pub async fn bloqueo_enrutador(
    app: &App,
    curso: &str,
    encabezados: &HeaderMap,
) -> Result<Option<(StatusCode, &'static str)>, sqlx::Error> {
    const SIN_ACCESO: &str = "<h1>Sin acceso</h1><p>No tenés acceso a este curso.</p>";
    let Some(sesion) = sesion_de_cookie(app, encabezados).await? else {
        return Ok(None);
    };
    if cuenta_inhabilitada(&app.db, sesion.usuario_id).await? {
        return Ok(Some((StatusCode::FORBIDDEN, SIN_ACCESO)));
    }
    let f = sqlx::query(&format!(
        "SELECT c.archivado_en IS NOT NULL AS archivado, {SQL_FUERA_DE_SERVICIO} AS fuera, \
         EXISTS (SELECT 1 FROM inscripciones i WHERE i.curso_id = c.id AND i.usuario_id = ?) AS inscripto \
         FROM cursos c WHERE c.id = ?"
    ))
    .bind(sesion.usuario_id)
    .bind(curso)
    .fetch_optional(&app.db)
    .await?;
    let Some(f) = f else { return Ok(None) };
    if f.get::<i64, _>("fuera") == 0 {
        return Ok(None);
    }
    if f.get::<i64, _>("inscripto") == 0 {
        return Ok(Some((StatusCode::FORBIDDEN, SIN_ACCESO)));
    }
    if f.get::<i64, _>("archivado") != 0 {
        Ok(Some((StatusCode::FORBIDDEN, "<h1>Curso archivado</h1><p>Este curso está archivado.</p>")))
    } else {
        Ok(Some((StatusCode::FORBIDDEN, "<h1>Curso no disponible</h1><p>Este curso no está disponible.</p>")))
    }
}

fn detener_en_segundo_plano(app: &App) {
    if let Some(sup) = app.supervisor.clone() {
        tokio::spawn(async move { sup.revisar_fuera_de_servicio().await });
    }
    if let Some(esp) = app.espacios.clone() {
        tokio::spawn(async move { esp.revisar_fuera_de_servicio().await });
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Como {
    Admin,
    Owner,
}

#[derive(Clone, Copy, PartialEq)]
enum AccionCuenta {
    Suspender,
    Reactivar,
    Baja,
}

struct Destino {
    id: i64,
    email: String,
    universidad_id: Option<i64>,
    administrador: bool,
    owner: bool,
}

fn baja_confirmada(encabezados: &HeaderMap, cuerpo: &Bytes) -> Result<(), ApiError> {
    let datos = cuerpo_json(encabezados, cuerpo)?;
    if datos.get("confirmar") != Some(&Value::Bool(true)) {
        return Err(ApiError::datos_invalidos());
    }
    Ok(())
}

async fn revocar_accesos(tx: &mut sqlx::SqliteConnection, usuario: i64, email: &str, tokens: bool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0").bind(usuario).execute(&mut *tx).await?;
    if tokens {
        sqlx::query("UPDATE tokens_api SET revocado = 1 WHERE usuario_id = ? AND revocado = 0").bind(usuario).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE codigos_login SET anulado = 1 WHERE email = ? AND usado = 0 AND anulado = 0").bind(email).execute(&mut *tx).await?;
    Ok(())
}

async fn accion_cuenta(
    app: &App,
    ctx: &Ctx,
    como: Como,
    accion: AccionCuenta,
    id: &str,
    encabezados: &HeaderMap,
    cuerpo: &Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    let uni_admin = match como {
        Como::Admin => Some(ctx.admin()?),
        Como::Owner => {
            ctx.owner()?;
            None
        }
    };
    ctx.reautenticada(&app.cfg)?;
    if accion == AccionCuenta::Baja {
        baja_confirmada(encabezados, cuerpo)?;
    }
    let id: i64 = id.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let f = sqlx::query("SELECT id, email, universidad_id, administrador, owner FROM usuarios WHERE id = ?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let destino = Destino {
        id: f.get("id"),
        email: f.get("email"),
        universidad_id: f.get("universidad_id"),
        administrador: bool_de(f.get("administrador")),
        owner: bool_de(f.get("owner")),
    };
    if let Some(uni) = uni_admin {
        if destino.universidad_id != Some(uni) {
            return Err(ApiError::no_encontrado());
        }
    }
    if destino.id == ctx.usuario.id {
        return Err(propia_cuenta());
    }
    if accion == AccionCuenta::Baja && destino.universidad_id.is_none() {
        return Err(ApiError::no_encontrado());
    }
    if como == Como::Admin && !ctx.usuario.owner && (destino.owner || destino.administrador) {
        return Err(ApiError::prohibido());
    }
    if accion == AccionCuenta::Baja {
        let cursos: Vec<String> =
            sqlx::query_scalar("SELECT curso_id FROM inscripciones WHERE usuario_id = ? AND rol = 'dueño' ORDER BY curso_id")
                .bind(destino.id)
                .fetch_all(&app.db)
                .await?;
        if !cursos.is_empty() {
            let mut e = ApiError::conflicto("es_dueno", "La persona es dueña de cursos. Transferilos antes de darla de baja.");
            e.extra = Some(("cursos", json!(cursos)));
            return Err(e);
        }
    }
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    match accion {
        AccionCuenta::Suspender | AccionCuenta::Baja => {
            let r = sqlx::query("UPDATE usuarios SET suspendida_en = ?, suspendida_por = ? WHERE id = ? AND suspendida_en IS NULL")
                .bind(&ahora)
                .bind(ctx.usuario.id)
                .bind(destino.id)
                .execute(&mut *tx)
                .await?;
            revocar_accesos(&mut tx, destino.id, &destino.email, true).await?;
            if accion == AccionCuenta::Baja {
                let dueno: Option<i64> =
                    sqlx::query_scalar("SELECT 1 FROM inscripciones WHERE usuario_id = ? AND rol = 'dueño' LIMIT 1")
                        .bind(destino.id)
                        .fetch_optional(&mut *tx)
                        .await?;
                if dueno.is_some() {
                    return Err(ApiError::conflicto("conflicto", "La persona cambió mientras tanto."));
                }
                sqlx::query("UPDATE usuarios SET baja_en = COALESCE(baja_en, ?) WHERE id = ?")
                    .bind(&ahora)
                    .bind(destino.id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    "INSERT INTO inscripciones_historia (curso_id, usuario_id, rol, creada_en, quitada_en, motivo, actor_id) \
                     SELECT curso_id, usuario_id, rol, creada_en, ?, 'baja', ? FROM inscripciones WHERE usuario_id = ?",
                )
                .bind(&ahora)
                .bind(ctx.usuario.id)
                .bind(destino.id)
                .execute(&mut *tx)
                .await?;
                let quitadas = sqlx::query("DELETE FROM inscripciones WHERE usuario_id = ?").bind(destino.id).execute(&mut *tx).await?;
                auditar(
                    &mut *tx,
                    destino.universidad_id,
                    Some(ctx.usuario.id),
                    "baja_universidad",
                    &format!(
                        "{} dio de baja a {} de la universidad ({} inscripciones quitadas)",
                        ctx.usuario.email,
                        destino.email,
                        quitadas.rows_affected()
                    ),
                    Some(&ctx.ip),
                )
                .await?;
            } else if r.rows_affected() == 1 {
                auditar(
                    &mut *tx,
                    destino.universidad_id,
                    Some(ctx.usuario.id),
                    "cuenta_suspendida",
                    &format!("{} suspendió la cuenta de {}", ctx.usuario.email, destino.email),
                    Some(&ctx.ip),
                )
                .await?;
            }
        }
        AccionCuenta::Reactivar => {
            let r = sqlx::query(
                "UPDATE usuarios SET suspendida_en = NULL, suspendida_por = NULL, baja_en = NULL \
                 WHERE id = ? AND (suspendida_en IS NOT NULL OR baja_en IS NOT NULL)",
            )
            .bind(destino.id)
            .execute(&mut *tx)
            .await?;
            if r.rows_affected() == 1 {
                auditar(
                    &mut *tx,
                    destino.universidad_id,
                    Some(ctx.usuario.id),
                    "cuenta_reactivada",
                    &format!("{} reactivó la cuenta de {}", ctx.usuario.email, destino.email),
                    Some(&ctx.ip),
                )
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(ok(crate::admin::persona(&app.db, destino.id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn admin_suspender(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Admin, AccionCuenta::Suspender, &id, &h, &c).await
}

pub async fn admin_reactivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Admin, AccionCuenta::Reactivar, &id, &h, &c).await
}

pub async fn admin_baja(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Admin, AccionCuenta::Baja, &id, &h, &c).await
}

pub async fn owner_suspender(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Owner, AccionCuenta::Suspender, &id, &h, &c).await
}

pub async fn owner_reactivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Owner, AccionCuenta::Reactivar, &id, &h, &c).await
}

pub async fn owner_baja(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, h: HeaderMap, c: Bytes) -> Resultado {
    accion_cuenta(&app, &ctx, Como::Owner, AccionCuenta::Baja, &id, &h, &c).await
}

async fn accion_universidad(app: &App, ctx: &Ctx, id: &str, deshabilitar: bool) -> Resultado {
    ctx.solo_sesion()?;
    ctx.owner()?;
    ctx.reautenticada(&app.cfg)?;
    let id: i64 = id.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let nombre: String = sqlx::query_scalar("SELECT nombre FROM universidades WHERE id = ?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let mut tx = app.db.begin().await?;
    if deshabilitar {
        let r = sqlx::query("UPDATE universidades SET deshabilitada_en = ? WHERE id = ? AND deshabilitada_en IS NULL")
            .bind(ahora_txt())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let cuentas: Vec<(i64, String)> = sqlx::query_as("SELECT id, email FROM usuarios WHERE universidad_id = ? AND owner = 0")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
        for (usuario, email) in &cuentas {
            revocar_accesos(&mut tx, *usuario, email, false).await?;
        }
        if r.rows_affected() == 1 {
            auditar(
                &mut *tx,
                Some(id),
                Some(ctx.usuario.id),
                "universidad_deshabilitada",
                &format!("{} deshabilitó la universidad {}", ctx.usuario.email, nombre),
                Some(&ctx.ip),
            )
            .await?;
        }
    } else {
        let r = sqlx::query("UPDATE universidades SET deshabilitada_en = NULL WHERE id = ? AND deshabilitada_en IS NOT NULL")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if r.rows_affected() == 1 {
            auditar(
                &mut *tx,
                Some(id),
                Some(ctx.usuario.id),
                "universidad_rehabilitada",
                &format!("{} rehabilitó la universidad {}", ctx.usuario.email, nombre),
                Some(&ctx.ip),
            )
            .await?;
        }
    }
    tx.commit().await?;
    if deshabilitar {
        detener_en_segundo_plano(app);
    }
    Ok(ok(crate::owner::universidad_owner(&app.db, id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn deshabilitar_universidad(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    accion_universidad(&app, &ctx, &id, true).await
}

pub async fn rehabilitar_universidad(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    accion_universidad(&app, &ctx, &id, false).await
}

async fn cambiar_archivo(app: &App, ctx: &Ctx, curso: &str, universidad: i64, archivar: bool) -> Result<(), ApiError> {
    let mut tx = app.db.begin().await?;
    let r = if archivar {
        sqlx::query("UPDATE cursos SET archivado_en = ?, archivado_por = ? WHERE id = ? AND archivado_en IS NULL")
            .bind(ahora_txt())
            .bind(ctx.usuario.id)
            .bind(curso)
            .execute(&mut *tx)
            .await?
    } else {
        sqlx::query("UPDATE cursos SET archivado_en = NULL, archivado_por = NULL WHERE id = ? AND archivado_en IS NOT NULL")
            .bind(curso)
            .execute(&mut *tx)
            .await?
    };
    if r.rows_affected() == 1 {
        let (accion, verbo) = if archivar { ("curso_archivado", "archivó") } else { ("curso_desarchivado", "desarchivó") };
        auditar(
            &mut *tx,
            Some(universidad),
            Some(ctx.usuario.id),
            accion,
            &format!("{} {} el curso {}", ctx.usuario.email, verbo, curso),
            Some(&ctx.ip),
        )
        .await?;
    }
    tx.commit().await?;
    if archivar {
        detener_en_segundo_plano(app);
    }
    Ok(())
}

async fn archivar_como_dueno(app: &App, ctx: &Ctx, id: &str, archivar: bool) -> Resultado {
    ctx.solo_sesion()?;
    let f = sqlx::query(&format!(
        "SELECT {} AS rol, c.universidad_id FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id \
         JOIN cursos c ON c.id = i.curso_id WHERE i.curso_id = ? AND i.usuario_id = ?",
        crate::cursos::ROL_EFECTIVO
    ))
    .bind(id)
    .bind(ctx.usuario.id)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(ApiError::no_encontrado)?;
    if f.get::<String, _>("rol") != "dueño" {
        return Err(ApiError::prohibido());
    }
    ctx.reautenticada(&app.cfg)?;
    cambiar_archivo(app, ctx, id, f.get("universidad_id"), archivar).await?;
    let fila = crate::cursos::fila_curso(app, id).await?.ok_or_else(ApiError::no_encontrado)?;
    Ok(ok(crate::cursos::curso_json(&fila, "dueño")))
}

pub async fn archivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    archivar_como_dueno(&app, &ctx, &id, true).await
}

pub async fn desarchivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    archivar_como_dueno(&app, &ctx, &id, false).await
}

async fn curso_de_universidad(app: &App, id: &str, uni: i64) -> Result<(), ApiError> {
    let existe: Option<i64> = sqlx::query_scalar("SELECT 1 FROM cursos WHERE id = ? AND universidad_id = ?")
        .bind(id)
        .bind(uni)
        .fetch_optional(&app.db)
        .await?;
    existe.map(|_| ()).ok_or_else(ApiError::no_encontrado)
}

pub async fn curso_admin(db: &SqlitePool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let f = sqlx::query(&format!(
        "SELECT c.id, c.nombre, c.periodo, c.color, c.version_publicada, c.archivado_en IS NOT NULL AS archivado, \
         (SELECT COUNT(*) FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = c.id \
          AND i.rol IN ('dueño', 'profesor') AND NOT {SQL_INHABILITADA}) AS profesores, \
         (SELECT COUNT(*) FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = c.id \
          AND i.rol = 'alumno' AND NOT {SQL_INHABILITADA}) AS alumnos, \
         COALESCE((SELECT usd FROM uso_agente g WHERE g.curso_id = c.id AND g.mes = ?), 0.0) AS uso, \
         d.id AS dueno_id, d.nombre AS dueno_nombre, d.email AS dueno_email \
         FROM cursos c LEFT JOIN inscripciones di ON di.curso_id = c.id AND di.rol = 'dueño' \
         LEFT JOIN usuarios d ON d.id = di.usuario_id WHERE c.id = ?"
    ))
    .bind(mes_actual())
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(f.map(|f| {
        let dueno = match f.get::<Option<i64>, _>("dueno_id") {
            Some(id) => json!({
                "id": id,
                "nombre": f.get::<String, _>("dueno_nombre"),
                "email": f.get::<String, _>("dueno_email"),
            }),
            None => Value::Null,
        };
        json!({
            "id": f.get::<String, _>("id"),
            "nombre": f.get::<String, _>("nombre"),
            "periodo": f.get::<String, _>("periodo"),
            "color": f.get::<String, _>("color"),
            "dueno": dueno,
            "profesores": f.get::<i64, _>("profesores"),
            "alumnos": f.get::<i64, _>("alumnos"),
            "version_publicada": f.get::<Option<i64>, _>("version_publicada"),
            "uso_usd_mes": f.get::<f64, _>("uso"),
            "archivado": f.get::<i64, _>("archivado") != 0,
        })
    }))
}

async fn archivar_como_admin(app: &App, ctx: &Ctx, id: &str, archivar: bool) -> Resultado {
    ctx.solo_sesion()?;
    let uni = ctx.admin()?;
    ctx.reautenticada(&app.cfg)?;
    curso_de_universidad(app, id, uni).await?;
    cambiar_archivo(app, ctx, id, uni, archivar).await?;
    Ok(ok(curso_admin(&app.db, id).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn admin_archivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    archivar_como_admin(&app, &ctx, &id, true).await
}

pub async fn admin_desarchivar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    archivar_como_admin(&app, &ctx, &id, false).await
}

pub async fn admin_transferir(
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
    let usuario = match datos.get("usuario_id") {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(ApiError::datos_invalidos)?,
        Some(Value::String(s)) => s.trim().parse::<i64>().map_err(|_| ApiError::datos_invalidos())?,
        _ => return Err(ApiError::datos_invalidos()),
    };
    curso_de_universidad(&app, &id, uni).await?;
    let f = sqlx::query("SELECT id, nombre, email, profesor FROM usuarios WHERE id = ? AND universidad_id = ?")
        .bind(usuario)
        .bind(uni)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let nombre: String = f.get("nombre");
    let email: String = f.get("email");
    if !bool_de(f.get("profesor")) {
        return Err(no_es_profesor());
    }
    if cuenta_inhabilitada(&app.db, usuario).await? {
        return Err(cuenta_suspendida());
    }
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE inscripciones SET rol = 'profesor' WHERE curso_id = ? AND rol = 'dueño' AND usuario_id <> ?")
        .bind(&id)
        .bind(usuario)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, 'dueño', ?) \
         ON CONFLICT(curso_id, usuario_id) DO UPDATE SET rol = 'dueño'",
    )
    .bind(&id)
    .bind(usuario)
    .bind(&ahora)
    .execute(&mut *tx)
    .await?;
    auditar(
        &mut *tx,
        Some(uni),
        Some(ctx.usuario.id),
        "curso_transferido",
        &format!("{} transfirió el curso {} a {}", ctx.usuario.email, id, email),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"dueno": {"id": usuario, "nombre": nombre, "email": email}})))
}
