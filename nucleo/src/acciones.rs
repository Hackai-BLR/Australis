use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::auth::*;
use crate::cursos::{fila_curso, inscripto_por_id, inscriptos_ordenados, rol_de, tiene_marca, CursoFila, Inscripto};
use crate::db::{auditar, POR_AGENTE};
use crate::modelo::token_valido;
use crate::util::*;

static APROBACIONES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const MAXIMO_SIU: usize = 4 * 1024 * 1024;

pub struct TokenAgente {
    pub id: i64,
    pub valor: String,
}

impl TokenAgente {
    pub async fn revocar(&self, db: &SqlitePool) {
        if let Err(e) = sqlx::query("UPDATE tokens_agente SET revocado = 1 WHERE id = ?").bind(self.id).execute(db).await {
            eprintln!("no se pudo revocar el token del agente {}: {e}", self.id);
        }
    }
}

pub async fn crear_token_agente(app: &App, curso: &str, usuario: i64, mensaje: i64) -> Result<TokenAgente, ApiError> {
    let valor = format!("cat_{}", token_aleatorio());
    let segundos = app.cfg.agente.agente_max_seg;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO tokens_agente (huella, curso_id, usuario_id, mensaje_id, creado_en, vence_en) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(huella(&app.cfg.session_secret, &valor))
    .bind(curso)
    .bind(usuario)
    .bind(mensaje)
    .bind(ahora_txt())
    .bind(fecha(en_segundos(segundos)))
    .fetch_one(&app.db)
    .await?;
    Ok(TokenAgente { id, valor })
}

#[derive(Clone, Copy, PartialEq)]
enum Escucha {
    Espacios,
    Cursos,
}

enum Portador {
    Curso,
    Agente(Usuario),
}

async fn autenticar(app: &App, encabezados: &HeaderMap, escucha: Escucha) -> Result<(String, Portador), ApiError> {
    let token = bearer(encabezados).ok_or_else(ApiError::no_autenticado)?;
    if token_valido(&token, "cct_") {
        if escucha == Escucha::Cursos {
            let curso = crate::api_cursos::curso_del_token(app, encabezados).await?;
            return Ok((curso, Portador::Curso));
        }
        let h = huella(&app.cfg.session_secret, &token);
        let curso: Option<String> = sqlx::query_scalar(&format!(
            "SELECT e.curso_id FROM espacios e JOIN cursos c ON c.id = e.curso_id WHERE e.token_curso_huella = ? AND NOT {}",
            crate::inhabilitar::SQL_FUERA_DE_SERVICIO
        ))
        .bind(&h)
        .fetch_optional(&app.db)
        .await?;
        let curso = curso.ok_or_else(ApiError::no_autenticado)?;
        crate::endurecimiento::limitar_curso(&app.cfg, &format!("espacio:{curso}"))?;
        return Ok((curso, Portador::Curso));
    }
    if escucha == Escucha::Espacios && token_valido(&token, "cat_") {
        let h = huella(&app.cfg.session_secret, &token);
        let f = sqlx::query(&format!(
            "SELECT t.id, t.curso_id, t.usuario_id FROM tokens_agente t JOIN cursos c ON c.id = t.curso_id \
             WHERE t.huella = ? AND t.revocado = 0 AND t.vence_en > ? AND NOT {}",
            crate::inhabilitar::SQL_FUERA_DE_SERVICIO
        ))
        .bind(&h)
        .bind(ahora_txt())
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_autenticado)?;
        let id: i64 = f.get("id");
        let curso: String = f.get("curso_id");
        let usuario_id: i64 = f.get("usuario_id");
        if crate::inhabilitar::cuenta_inhabilitada(&app.db, usuario_id).await? {
            return Err(ApiError::no_autenticado());
        }
        let usuario = usuario_por_id(&app.db, usuario_id).await?.ok_or_else(ApiError::no_autenticado)?;
        crate::endurecimiento::limitar_curso(&app.cfg, &format!("agente:{id}"))?;
        return Ok((curso, Portador::Agente(usuario)));
    }
    Err(ApiError::no_autenticado())
}

#[derive(Clone, Copy, PartialEq)]
enum Accion {
    Inscriptos,
    Inscribir,
    Siu,
    Codigo,
    GenerarCodigo,
    ActivarCodigo,
    Quitar,
    Rol,
    Confirmaciones,
}

impl Accion {
    fn de(metodo: &Method, resto: &str) -> Option<Accion> {
        let get = metodo == Method::GET || metodo == Method::HEAD;
        let post = metodo == Method::POST;
        match (resto, get, post) {
            ("inscriptos", true, _) => Some(Accion::Inscriptos),
            ("inscriptos", _, true) => Some(Accion::Inscribir),
            ("inscriptos/siu", _, true) => Some(Accion::Siu),
            ("codigo", true, _) => Some(Accion::Codigo),
            ("codigo", _, true) => Some(Accion::GenerarCodigo),
            ("codigo/activo", _, true) => Some(Accion::ActivarCodigo),
            ("quitar", _, true) => Some(Accion::Quitar),
            ("rol", _, true) => Some(Accion::Rol),
            ("confirmaciones", true, _) => Some(Accion::Confirmaciones),
            _ => None,
        }
    }

    fn escribe(self) -> bool {
        !matches!(self, Accion::Inscriptos | Accion::Codigo | Accion::Confirmaciones)
    }
}

pub async fn en_espacios(State(app): State<Estado>, req: Request) -> Response {
    atender(&app, req, Escucha::Espacios).await.unwrap_or_else(IntoResponse::into_response)
}

pub async fn en_cursos(State(app): State<Estado>, req: Request) -> Response {
    atender(&app, req, Escucha::Cursos).await.unwrap_or_else(IntoResponse::into_response)
}

fn ctx_agente(usuario: Usuario) -> Ctx {
    Ctx { usuario, via: Via::Agente, ip: String::new(), alcance: crate::roles::Alcance::Prohibido }
}

async fn atender(app: &Estado, req: Request, escucha: Escucha) -> Result<Response, ApiError> {
    let (curso, portador) = autenticar(app, req.headers(), escucha).await?;
    let resto = req.uri().path().strip_prefix("/api/curso/acciones/").unwrap_or("").to_string();
    let accion = Accion::de(req.method(), &resto).ok_or_else(ApiError::no_encontrado)?;
    let usuario = match portador {
        Portador::Curso if accion.escribe() => return Err(ApiError::prohibido()),
        Portador::Curso => None,
        Portador::Agente(u) => {
            match rol_de(app, &curso, u.id).await?.as_deref() {
                Some("dueño") | Some("profesor") => {}
                _ => return Err(ApiError::prohibido()),
            }
            Some(u)
        }
    };
    let limite = if accion == Accion::Siu { MAXIMO_SIU } else { app.cfg.limite_cuerpo_json };
    let (partes, cuerpo) = req.into_parts();
    let cuerpo = axum::body::to_bytes(cuerpo, limite).await.map_err(|_| crate::endurecimiento::cuerpo_demasiado_grande())?;
    let encabezados = partes.headers;
    match accion {
        Accion::Inscriptos => listar(app, &curso).await,
        Accion::Codigo => Ok(ok(crate::cursos::codigo_json(app, &curso).await?)),
        Accion::Confirmaciones => Ok(ok(json!({"confirmaciones": pendientes(&app.db, &curso, true).await?}))),
        _ => {
            let usuario = usuario.ok_or_else(ApiError::prohibido)?;
            let app2 = app.clone();
            POR_AGENTE
                .scope(true, async move {
                    let ctx = ctx_agente(usuario);
                    let s = State(app2.clone());
                    let p = Path(curso.clone());
                    match accion {
                        Accion::Inscribir => crate::cursos::agregar_inscriptos(s, ctx, p, encabezados, cuerpo).await,
                        Accion::Siu => crate::cursos::importar_siu(s, ctx, p, encabezados, cuerpo).await,
                        Accion::GenerarCodigo => crate::cursos::generar_codigo(s, ctx, p, encabezados, cuerpo).await,
                        Accion::ActivarCodigo => crate::cursos::cambiar_codigo(s, ctx, p, encabezados, cuerpo).await,
                        Accion::Quitar => pedir(&app2, &ctx, &curso, &encabezados, &cuerpo, false).await,
                        _ => pedir(&app2, &ctx, &curso, &encabezados, &cuerpo, true).await,
                    }
                })
                .await
        }
    }
}

async fn listar(app: &App, curso: &str) -> Resultado {
    let lista = inscriptos_ordenados(app, curso).await?;
    let alumnos = lista.iter().filter(|i| i.rol == "alumno" && !i.suspendida).count();
    let profesores = lista.iter().filter(|i| i.rol != "alumno" && !i.suspendida).count();
    let inscriptos: Vec<Value> = lista
        .iter()
        .map(|i| {
            json!({
                "id": i.id.to_string(),
                "nombre": i.nombre,
                "email": i.email,
                "rol": i.rol,
                "pendiente": i.pendiente,
                "suspendida": i.suspendida,
            })
        })
        .collect();
    Ok(ok(json!({"inscriptos": inscriptos, "alumnos": alumnos, "profesores": profesores})))
}

fn usuario_de_cuerpo(datos: &Map<String, Value>) -> Result<i64, ApiError> {
    match datos.get("usuario_id") {
        Some(Value::Number(n)) => n.as_i64().filter(|v| *v > 0).ok_or_else(ApiError::datos_invalidos),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() || s.len() > 18 || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ApiError::datos_invalidos());
            }
            s.parse::<i64>().map_err(|_| ApiError::datos_invalidos())
        }
        _ => Err(ApiError::datos_invalidos()),
    }
}

async fn pedir(app: &App, ctx: &Ctx, curso_id: &str, encabezados: &HeaderMap, cuerpo: &Bytes, cambio_de_rol: bool) -> Resultado {
    let curso = fila_curso(app, curso_id).await?.ok_or_else(ApiError::no_autenticado)?;
    let rol_propio = rol_de(app, curso_id, ctx.usuario.id).await?.ok_or_else(ApiError::prohibido)?;
    if cambio_de_rol && rol_propio != "dueño" {
        return Err(ApiError::prohibido());
    }
    crate::inhabilitar::curso_modificable(&app.db, curso_id).await?;
    let datos = cuerpo_json(encabezados, cuerpo)?;
    let rol = if cambio_de_rol {
        match texto_de(&datos, "rol") {
            Some("alumno") => Some("alumno"),
            Some("profesor") => Some("profesor"),
            _ => return Err(ApiError::datos_invalidos()),
        }
    } else {
        None
    };
    let usuario = usuario_de_cuerpo(&datos)?;
    let persona = inscripto_por_id(app, curso_id, usuario).await?.ok_or_else(ApiError::no_encontrado)?;
    if persona.rol == "dueño" {
        return Err(crate::cursos::es_dueno());
    }
    match rol {
        Some(r) => {
            if r == "profesor" && !tiene_marca(app, usuario).await? {
                return Err(crate::cursos::no_es_profesor());
            }
        }
        None => {
            if persona.id == ctx.usuario.id || (rol_propio != "dueño" && persona.rol != "alumno") {
                return Err(ApiError::prohibido());
            }
        }
    }
    let mensaje: Option<i64> = sqlx::query_scalar(
        "SELECT mensaje_id FROM tokens_agente WHERE curso_id = ? AND usuario_id = ? AND revocado = 0 ORDER BY id DESC LIMIT 1",
    )
    .bind(curso_id)
    .bind(ctx.usuario.id)
    .fetch_optional(&app.db)
    .await?
    .flatten();
    let tipo = if rol.is_some() { "rol" } else { "quitar" };
    let mut tx = app.db.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO confirmaciones_agente (curso_id, tipo, usuario_id, rol, pedida_por, mensaje_id, estado, creada_en) \
         VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?) RETURNING id",
    )
    .bind(curso_id)
    .bind(tipo)
    .bind(usuario)
    .bind(rol)
    .bind(ctx.usuario.id)
    .bind(mensaje)
    .bind(ahora_txt())
    .fetch_one(&mut *tx)
    .await?;
    let que = match rol {
        Some(r) => format!("pasar a {} a {r}", persona.email),
        None => format!("quitar a {}", persona.email),
    };
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "confirmacion_pedida",
        &format!("{} pidió {que} en el curso {curso_id}", ctx.usuario.email),
        None,
    )
    .await?;
    tx.commit().await?;
    let c = confirmacion(&app.db, id, true).await?.ok_or_else(ApiError::servicio_no_disponible)?;
    Ok(json_estado(StatusCode::ACCEPTED, c))
}

const SQL_CONFIRMACION: &str = "SELECT c.id, c.curso_id, c.tipo, c.usuario_id, c.rol, c.pedida_por, c.estado, c.error, c.creada_en, c.resuelta_en, \
     p.nombre AS persona_nombre, p.email AS persona_email, q.nombre AS pedida_nombre FROM confirmaciones_agente c \
     JOIN usuarios p ON p.id = c.usuario_id JOIN usuarios q ON q.id = c.pedida_por";

fn confirmacion_json(f: &sqlx::sqlite::SqliteRow, texto: bool) -> Value {
    let ident = |v: i64| if texto { Value::String(v.to_string()) } else { json!(v) };
    json!({
        "id": f.get::<i64, _>("id"),
        "tipo": f.get::<String, _>("tipo"),
        "persona": {
            "id": ident(f.get("usuario_id")),
            "nombre": f.get::<String, _>("persona_nombre"),
            "email": f.get::<String, _>("persona_email"),
        },
        "rol": f.get::<Option<String>, _>("rol"),
        "estado": f.get::<String, _>("estado"),
        "pedida_por": {"id": ident(f.get("pedida_por")), "nombre": f.get::<String, _>("pedida_nombre")},
        "creada": f.get::<String, _>("creada_en"),
        "resuelta": f.get::<Option<String>, _>("resuelta_en"),
        "error": f.get::<Option<String>, _>("error"),
    })
}

async fn confirmacion(db: &SqlitePool, id: i64, texto: bool) -> Result<Option<Value>, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_CONFIRMACION} WHERE c.id = ?")).bind(id).fetch_optional(db).await?;
    Ok(f.map(|f| confirmacion_json(&f, texto)))
}

async fn pendientes(db: &SqlitePool, curso: &str, texto: bool) -> Result<Vec<Value>, sqlx::Error> {
    let filas = sqlx::query(&format!("{SQL_CONFIRMACION} WHERE c.curso_id = ? AND c.estado = 'pendiente' ORDER BY c.id"))
        .bind(curso)
        .fetch_all(db)
        .await?;
    Ok(filas.iter().map(|f| confirmacion_json(f, texto)).collect())
}

async fn docente_con_rol(app: &App, ctx: &Ctx, id: &str) -> Result<(CursoFila, String), ApiError> {
    let curso = fila_curso(app, id).await?.ok_or_else(ApiError::no_encontrado)?;
    let rol = rol_de(app, id, ctx.usuario.id).await?.ok_or_else(ApiError::no_encontrado)?;
    if rol == "alumno" {
        return Err(ApiError::prohibido());
    }
    Ok((curso, rol))
}

pub async fn listar_confirmaciones(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente_con_rol(&app, &ctx, &id).await?;
    Ok(ok(json!({"confirmaciones": pendientes(&app.db, &id, false).await?})))
}

struct Pedido {
    id: i64,
    tipo: String,
    usuario_id: i64,
    rol: Option<String>,
    estado: String,
    email: String,
}

async fn pedido(app: &App, ctx: &Ctx, curso: &str, cid: &str) -> Result<Pedido, ApiError> {
    let cid: i64 = cid.trim().parse().map_err(|_| ApiError::no_encontrado())?;
    let f = sqlx::query(
        "SELECT c.id, c.tipo, c.usuario_id, c.rol, c.pedida_por, c.estado, u.email FROM confirmaciones_agente c \
         JOIN usuarios u ON u.id = c.usuario_id WHERE c.id = ? AND c.curso_id = ?",
    )
    .bind(cid)
    .bind(curso)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(ApiError::no_encontrado)?;
    if f.get::<i64, _>("pedida_por") != ctx.usuario.id {
        return Err(ApiError::prohibido());
    }
    Ok(Pedido {
        id: f.get("id"),
        tipo: f.get("tipo"),
        usuario_id: f.get("usuario_id"),
        rol: f.get("rol"),
        estado: f.get("estado"),
        email: f.get("email"),
    })
}

fn resuelta() -> ApiError {
    ApiError::conflicto("confirmacion_resuelta", "Ese pedido ya fue resuelto.")
}

async fn estado_actual(db: &SqlitePool, id: i64) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT estado FROM confirmaciones_agente WHERE id = ?").bind(id).fetch_one(db).await
}

async fn resolver(db: &SqlitePool, id: i64, estado: &str, error: Option<&str>, por: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE confirmaciones_agente SET estado = ?, error = ?, resuelta_en = ?, resuelta_por = ? WHERE id = ? AND estado = 'pendiente'")
        .bind(estado)
        .bind(error)
        .bind(ahora_txt())
        .bind(por)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

async fn aplicar(app: &App, ctx: &Ctx, curso: &CursoFila, rol_propio: &str, p: &Pedido) -> Result<(), ApiError> {
    let persona: Inscripto = inscripto_por_id(app, &curso.id, p.usuario_id).await?.ok_or_else(ApiError::no_encontrado)?;
    if persona.rol == "dueño" {
        return Err(crate::cursos::es_dueno());
    }
    if p.tipo == "rol" {
        if rol_propio != "dueño" {
            return Err(ApiError::prohibido());
        }
        let rol = match p.rol.as_deref() {
            Some("profesor") => "profesor",
            _ => "alumno",
        };
        if rol == "profesor" && !tiene_marca(app, p.usuario_id).await? {
            return Err(crate::cursos::no_es_profesor());
        }
        crate::cursos::ejecutar_rol(app, &ctx.usuario, &ctx.ip, curso, &persona, rol).await
    } else {
        if rol_propio != "dueño" && persona.rol != "alumno" {
            return Err(ApiError::prohibido());
        }
        crate::cursos::ejecutar_quitar(app, &ctx.usuario, &ctx.ip, curso, &persona).await
    }
}

pub async fn aprobar(State(app): State<Estado>, ctx: Ctx, Path((id, cid)): Path<(String, String)>) -> Resultado {
    let (curso, rol_propio) = docente_con_rol(&app, &ctx, &id).await?;
    let p = pedido(&app, &ctx, &id, &cid).await?;
    ctx.reautenticada(&app.cfg)?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let _g = APROBACIONES.lock().await;
    if estado_actual(&app.db, p.id).await? != "pendiente" {
        return Err(resuelta());
    }
    let r = POR_AGENTE.scope(true, aplicar(&app, &ctx, &curso, &rol_propio, &p)).await;
    match r {
        Ok(()) => resolver(&app.db, p.id, "aprobada", None, ctx.usuario.id).await?,
        Err(e) => {
            resolver(&app.db, p.id, "fallida", Some(&e.mensaje), ctx.usuario.id).await?;
            return Err(e);
        }
    }
    Ok(ok(confirmacion(&app.db, p.id, false).await?.ok_or_else(ApiError::no_encontrado)?))
}

pub async fn rechazar(State(app): State<Estado>, ctx: Ctx, Path((id, cid)): Path<(String, String)>) -> Resultado {
    let (curso, _) = docente_con_rol(&app, &ctx, &id).await?;
    let p = pedido(&app, &ctx, &id, &cid).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let _g = APROBACIONES.lock().await;
    if p.estado != "pendiente" || estado_actual(&app.db, p.id).await? != "pendiente" {
        return Err(resuelta());
    }
    resolver(&app.db, p.id, "rechazada", None, ctx.usuario.id).await?;
    let que = match p.rol.as_deref() {
        Some(r) if p.tipo == "rol" => format!("pasar a {} a {r}", p.email),
        _ => format!("quitar a {}", p.email),
    };
    POR_AGENTE
        .scope(
            true,
            auditar(
                &app.db,
                Some(curso.universidad_id),
                Some(ctx.usuario.id),
                "confirmacion_rechazada",
                &format!("{} canceló el pedido de {que} en el curso {id}", ctx.usuario.email),
                Some(&ctx.ip),
            ),
        )
        .await?;
    Ok(ok(confirmacion(&app.db, p.id, false).await?.ok_or_else(ApiError::no_encontrado)?))
}
