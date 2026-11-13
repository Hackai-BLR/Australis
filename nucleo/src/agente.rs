use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use sqlx::Row;
use tokio::sync::mpsc;

use crate::auth::*;
use crate::cursos::{fila_curso, CursoFila, ROL_EFECTIVO};
use crate::db::auditar;
use crate::espacios::{interpretar_linea, Espacios, Ocupacion, Turno};
use crate::modelo::{total_universidad, MENSAJE_SIN_USO};
use crate::repo::{git_texto, Lugar};
use crate::util::*;

pub fn sin_uso_disponible() -> ApiError {
    ApiError::nuevo(StatusCode::SERVICE_UNAVAILABLE, "sin_uso_disponible", MENSAJE_SIN_USO)
}

pub fn ocupado(o: Ocupacion) -> ApiError {
    match o {
        Ocupacion::Agente => ApiError::conflicto("agente_ocupado", "El agente está trabajando en este curso."),
        Ocupacion::Publicacion => ApiError::conflicto("publicacion_en_curso", "Hay una publicación en curso."),
    }
}

pub fn curso_no_listo() -> ApiError {
    ApiError::conflicto("curso_no_listo", "El curso todavía no está listo.")
}

pub async fn docente(app: &App, ctx: &Ctx, id: &str) -> Result<CursoFila, ApiError> {
    let curso = fila_curso(app, id).await?.ok_or_else(ApiError::no_encontrado)?;
    let rol: Option<String> = sqlx::query_scalar(&format!(
        "SELECT {ROL_EFECTIVO} FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? AND i.usuario_id = ?"
    ))
    .bind(id)
    .bind(ctx.usuario.id)
    .fetch_optional(&app.db)
    .await?;
    match rol.as_deref() {
        None => Err(ApiError::no_encontrado()),
        Some("alumno") => Err(ApiError::prohibido()),
        Some(_) => Ok(curso),
    }
}

pub async fn exigir_en_servicio(app: &App, id: &str) -> Result<(), ApiError> {
    crate::inhabilitar::curso_modificable(&app.db, id).await?;
    if !crate::inhabilitar::curso_servible(&app.db, id).await? {
        return Err(crate::inhabilitar::universidad_deshabilitada());
    }
    Ok(())
}

pub fn cuerpo_objeto(encabezados: &HeaderMap, cuerpo: &Bytes) -> Result<Map<String, Value>, ApiError> {
    if cuerpo.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    cuerpo_json(encabezados, cuerpo)
}

pub async fn cambios_sin_publicar(app: &App, id: &str) -> bool {
    let Some(cc) = &app.cfg.contenedores else { return false };
    let repo = cc.raiz_cursos.join(id);
    if !repo.join(".git").is_dir() {
        return false;
    }
    match git_texto(&Lugar::Repo(repo), &["rev-list", "--count", "refs/heads/main..refs/heads/prueba"]).await {
        Ok(n) => n.parse::<i64>().map(|n| n > 0).unwrap_or(false),
        Err(_) => false,
    }
}

pub async fn estado_espacio(app: &App, id: &str) -> Result<(String, Option<String>), sqlx::Error> {
    match &app.espacios {
        Some(e) => e.estado(id).await,
        None => {
            let f: Option<(String, Option<String>)> =
                sqlx::query_as("SELECT estado, error FROM espacios WHERE curso_id = ?").bind(id).fetch_optional(&app.db).await?;
            Ok(f.unwrap_or_else(|| ("ninguno".to_string(), None)))
        }
    }
}

pub async fn extender_curso(app: &App, id: &str, mut v: Value) -> Value {
    let espacio = estado_espacio(app, id).await.map(|e| e.0).unwrap_or_else(|_| "ninguno".to_string());
    let cambios = cambios_sin_publicar(app, id).await;
    if let Some(m) = v.as_object_mut() {
        m.insert("espacio".into(), Value::String(espacio));
        m.insert("cambios_sin_publicar".into(), Value::Bool(cambios));
    }
    v
}

pub async fn ver_espacio(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente(&app, &ctx, &id).await?;
    let (e, error) = estado_espacio(&app, &id).await?;
    Ok(ok(json!({"espacio": e, "error": error})))
}

pub async fn encender_espacio(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    exigir_en_servicio(&app, &id).await?;
    cuerpo_objeto(&encabezados, &cuerpo)?;
    let Some(esp) = app.espacios.clone() else { return Err(ApiError::servicio_no_disponible()) };
    if curso.estado != "listo" {
        return Err(curso_no_listo());
    }
    esp.encender(&id).await?;
    let (e, error) = esp.estado(&id).await?;
    let e = if e == "ninguno" { "encendiendo".to_string() } else { e };
    Ok(json_estado(StatusCode::ACCEPTED, json!({"espacio": e, "error": error})))
}

fn mensaje_json(f: &sqlx::sqlite::SqliteRow) -> Value {
    let autor = match f.get::<Option<i64>, _>("autor_id") {
        Some(aid) => json!({
            "id": aid,
            "nombre": f.get::<Option<String>, _>("autor_nombre"),
            "email": f.get::<Option<String>, _>("autor_email"),
        }),
        None => Value::Null,
    };
    let archivos: Value = serde_json::from_str(&f.get::<String, _>("archivos")).unwrap_or_else(|_| json!([]));
    json!({
        "id": f.get::<i64, _>("id"),
        "rol": f.get::<String, _>("rol"),
        "texto": f.get::<String, _>("texto"),
        "autor": autor,
        "archivos": archivos,
        "estado": f.get::<String, _>("estado"),
        "fecha": f.get::<String, _>("creado_en"),
    })
}

const SQL_MENSAJE: &str = "SELECT m.id, m.rol, m.texto, m.autor_id, m.archivos, m.estado, m.creado_en, u.nombre AS autor_nombre, \
     u.email AS autor_email FROM mensajes_agente m LEFT JOIN usuarios u ON u.id = m.autor_id";

async fn mensaje(app: &App, id: i64) -> Result<Value, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_MENSAJE} WHERE m.id = ?")).bind(id).fetch_one(&app.db).await?;
    Ok(mensaje_json(&f))
}

pub async fn ver_agente(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente(&app, &ctx, &id).await?;
    let filas = sqlx::query(&format!("{SQL_MENSAJE} WHERE m.curso_id = ? ORDER BY m.id")).bind(&id).fetch_all(&app.db).await?;
    let en_curso = app.espacios.as_ref().map(|e| e.ocupado(&id) == Some(Ocupacion::Agente)).unwrap_or(false);
    Ok(ok(json!({"mensajes": filas.iter().map(mensaje_json).collect::<Vec<_>>(), "en_curso": en_curso})))
}

fn evento(nombre: &str, datos: &Value) -> Bytes {
    Bytes::from(format!("event: {nombre}\ndata: {datos}\n\n"))
}

pub async fn pedir_agente(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    exigir_en_servicio(&app, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let pedido = texto_de(&datos, "pedido").map(str::trim).ok_or_else(ApiError::datos_invalidos)?.to_string();
    let n = pedido.chars().count();
    if n == 0 || n > 8000 {
        return Err(ApiError::datos_invalidos());
    }
    let esp = match (&app.espacios, app.intermediario.disponible()) {
        (Some(e), true) => e.clone(),
        _ => return Err(ApiError::servicio_no_disponible()),
    };
    if curso.estado != "listo" {
        return Err(curso_no_listo());
    }
    let turno = esp.tomar(&id, Ocupacion::Agente).map_err(ocupado)?;
    if !app.intermediario.modelo_disponible() {
        return Err(sin_uso_disponible());
    }
    if let Some(a) = crate::cupos::agotado(&app.db, ctx.usuario.id, curso.universidad_id).await? {
        return Err(crate::cupos::cupo_agotado(&a));
    }
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    let id_pedido: i64 = sqlx::query_scalar(
        "INSERT INTO mensajes_agente (curso_id, rol, autor_id, texto, archivos, estado, creado_en, terminado_en) \
         VALUES (?, 'profesor', ?, ?, '[]', 'ok', ?, ?) RETURNING id",
    )
    .bind(&id)
    .bind(ctx.usuario.id)
    .bind(&pedido)
    .bind(&ahora)
    .bind(&ahora)
    .fetch_one(&mut *tx)
    .await?;
    let id_respuesta: i64 = sqlx::query_scalar(
        "INSERT INTO mensajes_agente (curso_id, rol, autor_id, texto, archivos, estado, creado_en) \
         VALUES (?, 'agente', NULL, '', '[]', 'en_curso', ?) RETURNING id",
    )
    .bind(&id)
    .bind(&ahora)
    .fetch_one(&mut *tx)
    .await?;
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "agente_pedido",
        &format!("Pedido al agente en el curso {id} por {}", ctx.usuario.email),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    let inicio = json!({"pedido": mensaje(&app, id_pedido).await?, "respuesta": mensaje(&app, id_respuesta).await?});
    let (envio, recepcion) = mpsc::unbounded_channel::<Bytes>();
    let _ = envio.send(evento("inicio", &inicio));
    let token = crate::acciones::crear_token_agente(&app, &id, ctx.usuario.id, id_respuesta).await?;
    let ejecucion = app.intermediario.ejecutar_como(&id, ctx.usuario.id, &token.valor);
    tokio::spawn(ejecutar(app.clone(), esp, turno, id.clone(), pedido, id_respuesta, envio, token, ejecucion));
    let intervalo = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(15), Duration::from_secs(15));
    let flujo = futures_util::stream::unfold((recepcion, intervalo), |(mut rx, mut iv)| async move {
        tokio::select! {
            m = rx.recv() => m.map(|b| (Ok::<Bytes, std::io::Error>(b), (rx, iv))),
            _ = iv.tick() => Some((Ok(Bytes::from_static(b": sigue\n\n")), (rx, iv))),
        }
    });
    let mut r = Response::new(Body::from_stream(flujo));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(r)
}

#[allow(clippy::too_many_arguments)]
async fn ejecutar(
    app: Estado,
    esp: Arc<Espacios>,
    turno: Turno,
    id: String,
    pedido: String,
    id_respuesta: i64,
    envio: mpsc::UnboundedSender<Bytes>,
    token: crate::acciones::TokenAgente,
    ejecucion: crate::modelo::Ejecucion,
) {
    let _activo = esp.activo(&id);
    let cortes = app.intermediario.cortes(&id);
    let (mut estado, mut texto) = correr_agente(&esp, &id, &pedido, &envio, &token.valor).await;
    token.revocar(&app.db).await;
    drop(ejecucion);
    let mut archivos: Vec<(String, String)> = Vec::new();
    let mut commit: Option<String> = None;
    match esp.guardar_cambios(&id, &pedido).await {
        Ok((c, a)) => {
            commit = c;
            archivos = a;
        }
        Err(e) => {
            eprintln!("no se pudieron guardar los cambios del agente en {id}: {e:#}");
            if estado == "ok" {
                estado = "error";
                texto = "No se pudieron guardar los cambios en la versión de prueba.".to_string();
            }
        }
    }
    if app.intermediario.cortes(&id) > cortes {
        estado = "error";
        texto = app.intermediario.ultimo_corte(&id).unwrap_or_else(|| MENSAJE_SIN_USO.to_string());
    }
    let lista: Vec<Value> = archivos.iter().map(|(r, c)| json!({"ruta": r, "cambio": c})).collect();
    let r = sqlx::query("UPDATE mensajes_agente SET texto = ?, archivos = ?, estado = ?, commit_prueba = ?, terminado_en = ? WHERE id = ?")
        .bind(&texto)
        .bind(Value::Array(lista).to_string())
        .bind(estado)
        .bind(&commit)
        .bind(ahora_txt())
        .bind(id_respuesta)
        .execute(&app.db)
        .await;
    if let Err(e) = r {
        eprintln!("no se pudo guardar la respuesta del agente en {id}: {e}");
    }
    drop(turno);
    if let Ok(m) = mensaje(&app, id_respuesta).await {
        let _ = envio.send(evento("fin", &json!({"respuesta": m})));
    }
}

async fn con_contexto(esp: &Espacios, id: &str, pedido: &str) -> String {
    let filas: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, rol, texto FROM mensajes_agente WHERE curso_id = ? AND estado <> 'en_curso' ORDER BY id DESC LIMIT 13",
    )
    .bind(id)
    .fetch_all(&esp.db)
    .await
    .unwrap_or_default();
    let mut previos: Vec<String> = Vec::new();
    let mut total = 0usize;
    for (_, rol, texto) in filas.into_iter().skip(1) {
        let t: String = texto.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(600).collect();
        let linea = match rol.as_str() {
            "profesor" => format!("- Pedido: {t}"),
            _ => format!("  Respuesta: {t}"),
        };
        total += linea.len();
        if total > 6000 {
            break;
        }
        previos.push(linea);
    }
    if previos.is_empty() {
        return pedido.to_string();
    }
    previos.reverse();
    format!(
        "{pedido}\n\n---\nContexto: pedidos anteriores de los docentes en este curso y tus respuestas, del más viejo al más nuevo. \
         Ya están aplicados en el repo; usalos solo como referencia.\n{}",
        previos.join("\n")
    )
}

async fn correr_agente(
    esp: &Arc<Espacios>,
    id: &str,
    pedido: &str,
    envio: &mpsc::UnboundedSender<Bytes>,
    token: &str,
) -> (&'static str, String) {
    if let Err(e) = esp.asegurar(id).await {
        eprintln!("el agente de {id} no pudo encender el espacio: {e}");
        return ("error", "No se pudo encender el espacio de trabajo.".to_string());
    }
    let continuar = esp.sesion_viva(id).is_some();
    let generacion = esp.generacion_actual(id);
    let mut c = esp.comando_agente(id, continuar, token);
    let mut hijo = match c.spawn() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("no se pudo ejecutar el agente de {id}: {e}");
            return ("error", "No se pudo ejecutar el agente.".to_string());
        }
    };
    let entrada = if continuar { pedido.to_string() } else { con_contexto(esp, id, pedido).await };
    crate::espacios::escribir_entrada(&mut hijo, &entrada).await;
    if let Some(err) = hijo.stderr.take() {
        tokio::spawn(async move {
            let mut err = err;
            let mut buf = [0u8; 4096];
            use tokio::io::AsyncReadExt;
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
            }
        });
    }
    let mut textos: Vec<String> = Vec::new();
    let mut resultado: Option<(String, bool)> = None;
    let limite = Duration::from_secs(esp.cfg.agente_max_seg as u64);
    let lectura = crate::espacios::leer_lineas(&mut hijo, |linea| {
        let l = interpretar_linea(linea);
        for t in l.textos {
            let _ = envio.send(evento("texto", &json!({"texto": t})));
            textos.push(t);
        }
        for (nombre, ruta) in l.herramientas {
            let _ = envio.send(evento("herramienta", &json!({"nombre": nombre, "ruta": ruta})));
        }
        if l.resultado.is_some() {
            resultado = l.resultado;
        }
    });
    let a_tiempo = tokio::time::timeout(limite, lectura).await.is_ok();
    if !a_tiempo {
        let _ = hijo.start_kill();
        let _ = hijo.wait().await;
        esp.permisos_en_contenedor(id).await;
        esp.reiniciar(id).await;
        return ("error", "El agente superó el tiempo máximo y se detuvo. Los cambios que alcanzó a hacer quedaron guardados en la versión de prueba.".to_string());
    }
    let salida = tokio::time::timeout(Duration::from_secs(30), hijo.wait()).await;
    let exito = matches!(salida, Ok(Ok(s)) if s.success());
    if resultado.is_some() {
        esp.guardar_sesion(id, generacion);
    }
    let final_texto = match &resultado {
        Some((t, _)) if !t.trim().is_empty() => t.trim().to_string(),
        _ => textos.join("\n\n").trim().to_string(),
    };
    let error = resultado.as_ref().map(|r| r.1).unwrap_or(true);
    if exito && !error {
        let t = if final_texto.is_empty() { "Listo.".to_string() } else { final_texto };
        ("ok", t)
    } else {
        let t = if final_texto.is_empty() { "El agente terminó con un error.".to_string() } else { final_texto };
        ("error", t)
    }
}

pub async fn ver_uso(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    let mes = mes_actual();
    let usd: f64 = sqlx::query_scalar("SELECT COALESCE(SUM(usd), 0.0) FROM uso_agente WHERE curso_id = ? AND mes = ?")
        .bind(&id)
        .bind(&mes)
        .fetch_one(&app.db)
        .await?;
    let f = sqlx::query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(tokens_entrada), 0) AS e, COALESCE(SUM(tokens_salida), 0) AS s, \
         COALESCE(SUM(tokens_cache_creacion), 0) AS cc, COALESCE(SUM(tokens_cache_lectura), 0) AS cl \
         FROM uso_modelo WHERE curso_id = ? AND mes = ?",
    )
    .bind(&id)
    .bind(&mes)
    .fetch_one(&app.db)
    .await?;
    let universidad = total_universidad(&app.db, curso.universidad_id, &mes).await?;
    let limite: f64 = sqlx::query_scalar("SELECT limite_usd FROM universidades WHERE id = ?")
        .bind(curso.universidad_id)
        .fetch_one(&app.db)
        .await?;
    Ok(ok(json!({
        "mes": mes,
        "usd": usd,
        "consultas": f.get::<i64, _>("n"),
        "tokens_entrada": f.get::<i64, _>("e"),
        "tokens_salida": f.get::<i64, _>("s"),
        "tokens_cache_creacion": f.get::<i64, _>("cc"),
        "tokens_cache_lectura": f.get::<i64, _>("cl"),
        "usd_universidad": universidad,
        "limite_usd": limite,
    })))
}
