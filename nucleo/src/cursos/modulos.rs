use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::Row;

use super::{con_emails, de_la_universidad, texto_acotado};
use crate::auth::*;
use crate::db::auditar;
use crate::util::*;

#[cfg(test)]
mod pruebas;

pub const TIPO_LIBRE: &str = "libre";
pub const TIPO_MODULOS: &str = "modulos";

pub struct CampusModulos {
    pub id: i64,
    pub campus_externo: i64,
    pub universidad_id: i64,
}

fn rol_desde_australis(rol: &str) -> &'static str {
    match rol {
        "professor" | "guest" => "profesor",
        _ => "alumno",
    }
}

async fn llamar_australis(
    app: &App,
    usuario: &Usuario,
    metodo: reqwest::Method,
    ruta: &str,
    cuerpo: Option<Value>,
) -> Result<(StatusCode, Value), ApiError> {
    let Some(destino) = app.cfg.australis_url.as_deref() else {
        return Err(ApiError::servicio_no_disponible());
    };
    let firma = app
        .identidad
        .firmar_australis(&crate::identidad::PersonaAustralis::de_usuario(usuario), app.cfg.identidad_vigencia_seg);
    let mut pedido = app
        .http
        .request(metodo, format!("{}{}", destino.trim_end_matches('/'), ruta))
        .header("X-Campus-Identidad", firma)
        .timeout(std::time::Duration::from_secs(20));
    if let Some(c) = cuerpo {
        pedido = pedido.json(&c);
    }
    let respuesta = pedido.send().await.map_err(|_| ApiError::servicio_no_disponible())?;
    let estado = StatusCode::from_u16(respuesta.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let valor = respuesta.json::<Value>().await.unwrap_or(Value::Null);
    Ok((estado, valor))
}

fn error_de_australis(estado: StatusCode) -> ApiError {
    if estado == StatusCode::FORBIDDEN || estado == StatusCode::UNAUTHORIZED {
        return ApiError::prohibido();
    }
    if estado.is_client_error() {
        return ApiError::datos_invalidos();
    }
    ApiError::servicio_no_disponible()
}

async fn campus_modulos(app: &App, id: i64) -> Result<CampusModulos, ApiError> {
    let f = sqlx::query("SELECT id, campus_externo, universidad_id FROM campus_modulos WHERE id = ?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    Ok(CampusModulos { id: f.get("id"), campus_externo: f.get("campus_externo"), universidad_id: f.get("universidad_id") })
}

async fn rol_en_modulos(app: &App, campus: i64, usuario: i64) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT i.rol FROM inscripciones_modulos i JOIN usuarios u ON u.id = i.usuario_id \
         WHERE i.campus_id = ? AND i.usuario_id = ? AND i.suspendida = 0 AND (i.rol = 'alumno' OR u.profesor = 1)",
    )
    .bind(campus)
    .bind(usuario)
    .fetch_optional(&app.db)
    .await
}

async fn docente_en_modulos(app: &App, ctx: &Ctx, id: &str) -> Result<CampusModulos, ApiError> {
    let n: i64 = id.parse().map_err(|_| ApiError::no_encontrado())?;
    let campus = campus_modulos(app, n).await?;
    match rol_en_modulos(app, n, ctx.usuario.id).await?.as_deref() {
        Some("dueño") | Some("profesor") => Ok(campus),
        Some(_) => Err(ApiError::prohibido()),
        None => Err(ApiError::no_encontrado()),
    }
}

pub fn json_modulos(id: i64, externo: i64, nombre: &str, rol: &str) -> Value {
    json!({
        "id": format!("campus-{id}"),
        "tipo": TIPO_MODULOS,
        "nombre": nombre,
        "periodo": "Campus con módulos",
        "color": "#001D9C",
        "rol": rol,
        "version_publicada": null,
        "archivado": false,
        "campus_id": id,
        "campus_externo": externo,
    })
}

pub async fn crear(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let universidad = match (ctx.usuario.profesor, ctx.usuario.universidad_id) {
        (true, Some(u)) => u,
        _ => return Err(ApiError::prohibido()),
    };
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let nombre = texto_acotado(&datos, "nombre", 120)?;
    let plantilla = match texto_de(&datos, "plantilla") {
        Some(p) => p.to_string(),
        None => {
            let (estado, v) = llamar_australis(&app, &ctx.usuario, reqwest::Method::GET, "/api/campus-templates", None).await?;
            if !estado.is_success() {
                return Err(error_de_australis(estado));
            }
            v.as_array()
                .and_then(|l| l.first())
                .and_then(|t| t["key"].as_str())
                .map(str::to_string)
                .ok_or_else(ApiError::servicio_no_disponible)?
        }
    };
    let (estado, campus) = llamar_australis(
        &app,
        &ctx.usuario,
        reqwest::Method::POST,
        "/api/campuses",
        Some(json!({"name": nombre, "template_key": plantilla})),
    )
    .await?;
    if !estado.is_success() {
        return Err(error_de_australis(estado));
    }
    let externo = campus["id"].as_i64().ok_or_else(ApiError::servicio_no_disponible)?;
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO campus_modulos (campus_externo, nombre, universidad_id, creado_por, creado_en) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(externo)
    .bind(&nombre)
    .bind(universidad)
    .bind(ctx.usuario.id)
    .bind(&ahora)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO inscripciones_modulos (campus_id, usuario_id, rol, creada_en) VALUES (?, ?, 'dueño', ?)")
        .bind(id)
        .bind(ctx.usuario.id)
        .bind(&ahora)
        .execute(&mut *tx)
        .await?;
    auditar(
        &mut *tx,
        Some(universidad),
        Some(ctx.usuario.id),
        "campus_modulos_creado",
        &format!("{} creó el campus con módulos {} ({})", ctx.usuario.email, id, nombre),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    Ok(json_estado(StatusCode::CREATED, json_modulos(id, externo, &nombre, "dueño")))
}

pub async fn de_la_persona(app: &App, usuario: i64) -> Result<Vec<Value>, sqlx::Error> {
    let filas = sqlx::query(
        "SELECT c.id, c.campus_externo, c.nombre, CASE WHEN i.rol <> 'alumno' AND u.profesor = 0 THEN 'alumno' ELSE i.rol END AS rol \
         FROM inscripciones_modulos i JOIN campus_modulos c ON c.id = i.campus_id JOIN usuarios u ON u.id = i.usuario_id \
         WHERE i.usuario_id = ? AND i.suspendida = 0",
    )
    .bind(usuario)
    .fetch_all(&app.db)
    .await?;
    Ok(filas
        .iter()
        .map(|f| json_modulos(f.get("id"), f.get("campus_externo"), &f.get::<String, _>("nombre"), &f.get::<String, _>("rol")))
        .collect())
}

pub async fn listar_inscriptos(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let n: i64 = id.parse().map_err(|_| ApiError::no_encontrado())?;
    docente_en_modulos(&app, &ctx, &id).await?;
    let filas = sqlx::query(
        "SELECT u.id, u.nombre, u.email, i.rol, u.pendiente, i.suspendida FROM inscripciones_modulos i \
         JOIN usuarios u ON u.id = i.usuario_id WHERE i.campus_id = ? \
         ORDER BY CASE i.rol WHEN 'dueño' THEN 0 WHEN 'profesor' THEN 1 ELSE 2 END, u.nombre",
    )
    .bind(n)
    .fetch_all(&app.db)
    .await?;
    let lista: Vec<Value> = filas
        .iter()
        .map(|f| {
            json!({
                "id": f.get::<i64, _>("id"),
                "nombre": f.get::<String, _>("nombre"),
                "email": f.get::<String, _>("email"),
                "rol": f.get::<String, _>("rol"),
                "pendiente": f.get::<i64, _>("pendiente") != 0,
                "suspendida": f.get::<i64, _>("suspendida") != 0,
            })
        })
        .collect();
    Ok(ok(json!({"inscriptos": lista})))
}

fn texto_de_lista(personas: &[(String, String)]) -> String {
    personas
        .iter()
        .map(|(email, nombre)| {
            let limpio: String = nombre
                .chars()
                .filter(|c| !c.is_ascii_digit() && !matches!(c, ';' | '"' | '\n' | '\r' | '\t' | ','))
                .collect();
            format!("{};{}", limpio.trim(), email)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn agregar_inscriptos(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let campus = docente_en_modulos(&app, &ctx, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let lista = datos.get("emails").and_then(Value::as_array).ok_or_else(ApiError::datos_invalidos)?;
    let mut emails: Vec<String> = Vec::new();
    let mut vistos = HashSet::new();
    for e in lista {
        let e = e.as_str().ok_or_else(ApiError::datos_invalidos)?.trim().to_lowercase();
        if vistos.insert(e.clone()) {
            emails.push(e);
        }
    }
    if emails.is_empty() || emails.len() > 500 {
        return Err(ApiError::datos_invalidos());
    }
    let invalidos: Vec<String> = emails.iter().filter(|e| normalizar_email(e).is_none()).cloned().collect();
    if !invalidos.is_empty() {
        return Err(con_emails(ApiError::email_invalido(), invalidos));
    }
    let mut ajenos = Vec::new();
    for e in &emails {
        if !de_la_universidad(&app, e, campus.universidad_id).await? {
            ajenos.push(e.clone());
        }
    }
    if !ajenos.is_empty() {
        return Err(con_emails(ApiError::dominio_no_habilitado(), ajenos));
    }
    let mut personas: Vec<(String, String)> = Vec::new();
    for e in &emails {
        let nombre: Option<String> =
            sqlx::query_scalar("SELECT nombre FROM usuarios WHERE email = ?").bind(e).fetch_optional(&app.db).await?;
        personas.push((e.clone(), nombre.unwrap_or_else(|| nombre_desde_email(e))));
    }
    let ruta = format!("/api/campuses/{}/roster/imports", campus.campus_externo);
    let (estado, previa) =
        llamar_australis(&app, &ctx.usuario, reqwest::Method::POST, &ruta, Some(json!({"text": texto_de_lista(&personas)})))
            .await?;
    if !estado.is_success() {
        return Err(error_de_australis(estado));
    }
    let import = previa["id"].as_i64().ok_or_else(ApiError::servicio_no_disponible)?;
    let (estado, _) =
        llamar_australis(&app, &ctx.usuario, reqwest::Method::POST, &format!("{ruta}/{import}/confirm"), None).await?;
    if !estado.is_success() {
        return Err(error_de_australis(estado));
    }
    let (agregados, actualizados) = sincronizar_con(&app, &ctx.usuario, Some(&ctx.ip), &campus).await?;
    Ok(ok(json!({"agregados": agregados, "actualizados": actualizados})))
}

fn cerrojo_del_campus(campus_id: i64) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static CERROJOS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i64, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let mut mapa = CERROJOS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    mapa.entry(campus_id).or_default().clone()
}

async fn sincronizar_con(app: &App, usuario: &Usuario, ip: Option<&str>, campus: &CampusModulos) -> Result<(usize, usize), ApiError> {
    sincronizar_completo(app, usuario, ip, campus).await.map(|(a, b, _)| (a, b))
}

async fn sincronizar_completo(
    app: &App,
    usuario: &Usuario,
    ip: Option<&str>,
    campus: &CampusModulos,
) -> Result<(usize, usize, Vec<String>), ApiError> {
    let cerrojo = cerrojo_del_campus(campus.id);
    let _turno = cerrojo.lock().await;
    let ruta = format!("/api/campuses/{}/members", campus.campus_externo);
    let (estado, miembros) = llamar_australis(app, usuario, reqwest::Method::GET, &ruta, None).await?;
    if !estado.is_success() {
        return Err(error_de_australis(estado));
    }
    let lista = miembros.as_array().ok_or_else(ApiError::servicio_no_disponible)?;
    let ahora = ahora_txt();
    let mut agregados = 0;
    let mut actualizados = 0;
    let mut admitidos = Vec::new();
    let mut docentes_omitidos = Vec::new();
    for m in lista {
        let Some(email) = m["email"].as_str().and_then(normalizar_email) else { continue };
        if de_la_universidad(app, &email, campus.universidad_id).await? {
            admitidos.push((email, m));
        } else if rol_desde_australis(m["role"].as_str().unwrap_or("student")) == "profesor" {
            docentes_omitidos.push(email);
        }
    }
    let mut tx = app.db.begin().await?;
    for (email, m) in admitidos {
        let rol = rol_desde_australis(m["role"].as_str().unwrap_or("student"));
        let suspendida = i64::from(m["status"].as_str() == Some("suspended"));
        let usuario: Option<i64> =
            sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?").bind(&email).fetch_optional(&mut *tx).await?;
        let usuario = match usuario {
            Some(u) => u,
            None => {
                let nombre = m["full_name"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
                sqlx::query_scalar(
                    "INSERT INTO usuarios (email, nombre, universidad_id, pendiente, creado_en) VALUES (?, ?, ?, 1, ?) RETURNING id",
                )
                .bind(&email)
                .bind(nombre.unwrap_or_else(|| nombre_desde_email(&email)))
                .bind(campus.universidad_id)
                .bind(&ahora)
                .fetch_one(&mut *tx)
                .await?
            }
        };
        let previa: Option<(String, i64)> =
            sqlx::query_as("SELECT rol, suspendida FROM inscripciones_modulos WHERE campus_id = ? AND usuario_id = ?")
                .bind(campus.id)
                .bind(usuario)
                .fetch_optional(&mut *tx)
                .await?;
        match previa {
            None => {
                sqlx::query(
                    "INSERT INTO inscripciones_modulos (campus_id, usuario_id, rol, suspendida, creada_en) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(campus.id)
                .bind(usuario)
                .bind(rol)
                .bind(suspendida)
                .bind(&ahora)
                .execute(&mut *tx)
                .await?;
                agregados += 1;
            }
            Some((rol_previo, susp_previa)) => {
                let rol_final = if rol_previo == "dueño" { "dueño" } else { rol };
                if rol_final != rol_previo || susp_previa != suspendida {
                    sqlx::query("UPDATE inscripciones_modulos SET rol = ?, suspendida = ? WHERE campus_id = ? AND usuario_id = ?")
                        .bind(rol_final)
                        .bind(suspendida)
                        .bind(campus.id)
                        .bind(usuario)
                        .execute(&mut *tx)
                        .await?;
                    actualizados += 1;
                }
            }
        }
    }
    auditar(
        &mut *tx,
        Some(campus.universidad_id),
        Some(usuario.id),
        "inscripcion_modulos",
        &format!("{} sincronizó las inscripciones del campus con módulos {}", usuario.email, campus.id),
        ip,
    )
    .await?;
    tx.commit().await?;
    Ok((agregados, actualizados, docentes_omitidos))
}

pub async fn sincronizar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let campus = docente_en_modulos(&app, &ctx, &id).await?;
    let (agregados, actualizados) = sincronizar_con(&app, &ctx.usuario, Some(&ctx.ip), &campus).await?;
    Ok(ok(json!({"agregados": agregados, "actualizados": actualizados})))
}

pub async fn sincronizar_docentes(app: &App, ctx: &Ctx) {
    let Ok(filas) = sqlx::query(
        "SELECT c.id, c.campus_externo, c.universidad_id FROM inscripciones_modulos i JOIN campus_modulos c ON c.id = i.campus_id \
         WHERE i.usuario_id = ? AND i.suspendida = 0 AND i.rol IN ('dueño', 'profesor')",
    )
    .bind(ctx.usuario.id)
    .fetch_all(&app.db)
    .await
    else {
        return;
    };
    for f in filas {
        let campus = CampusModulos { id: f.get("id"), campus_externo: f.get("campus_externo"), universidad_id: f.get("universidad_id") };
        let _ = sincronizar_con(app, &ctx.usuario, Some(&ctx.ip), &campus).await;
    }
}

pub async fn sincronizar_campus_externo(app: &App, usuario: &Usuario, campus_externo: i64) -> Result<Vec<String>, ApiError> {
    let Some(f) = sqlx::query("SELECT id, campus_externo, universidad_id FROM campus_modulos WHERE campus_externo = ?")
        .bind(campus_externo)
        .fetch_optional(&app.db)
        .await?
    else {
        return Ok(Vec::new());
    };
    let campus = CampusModulos { id: f.get("id"), campus_externo: f.get("campus_externo"), universidad_id: f.get("universidad_id") };
    sincronizar_completo(app, usuario, None, &campus).await.map(|(_, _, omitidos)| omitidos)
}

pub fn sincronizacion_fallida() -> ApiError {
    ApiError::nuevo(
        StatusCode::BAD_GATEWAY,
        "sincronizacion_fallida",
        "El cambio se hizo en el campus, pero no llegó a las inscripciones de Campus IA. Sincronizá las inscripciones para reintentar.",
    )
}

pub fn sincronizacion_fallida_para_australis() -> axum::response::Response {
    use axum::response::IntoResponse;
    let e = sincronizacion_fallida();
    (e.estado, axum::Json(json!({"error": e.mensaje, "codigo": e.codigo}))).into_response()
}

pub fn docentes_fuera_del_dominio_para_australis(emails: &[String]) -> axum::response::Response {
    use axum::response::IntoResponse;
    let e = ApiError::nuevo(
        StatusCode::BAD_GATEWAY,
        "invitado_fuera_del_dominio",
        &format!(
            "El docente se agregó al campus, pero no llegó a las inscripciones de Campus IA porque su email no es del dominio de la universidad: {}.",
            emails.join(", ")
        ),
    );
    (e.estado, axum::Json(json!({"error": e.mensaje, "codigo": e.codigo}))).into_response()
}
