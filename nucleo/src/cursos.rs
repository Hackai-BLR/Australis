use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use rand::Rng;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::auth::*;
use crate::db::auditar;
use crate::login::{contar, registrar};
use crate::util::*;

const COLORES: [&str; 7] = ["#1F7A4D", "#A4492A", "#6E4BA8", "#A87400", "#5B7A1E", "#9C2F6A", "#2E6A8E"];
const ALFABETO: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RESERVADOS: [&str; 40] = [
    "www", "api", "admin", "administracion", "owner", "app", "mail", "correo", "smtp", "imap", "pop", "ftp", "static",
    "estaticos", "cdn", "assets", "login", "auth", "cuenta", "cuentas", "soporte", "ayuda", "docs", "blog", "status",
    "estado", "salud", "campus", "campusia", "plataforma", "nucleo", "curso", "cursos", "prueba", "pruebas", "test", "dev",
    "staging", "root", "sistema",
];

pub struct CursoFila {
    pub id: String,
    pub nombre: String,
    pub periodo: String,
    pub color: String,
    pub universidad_id: i64,
    pub version_publicada: Option<i64>,
    pub estado: String,
    pub contenedor: Option<String>,
    pub archivado: bool,
}

pub struct Inscripto {
    pub id: i64,
    pub nombre: String,
    pub email: String,
    pub rol: String,
    pub pendiente: bool,
    pub profesor: bool,
    pub suspendida: bool,
}

impl Inscripto {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "nombre": self.nombre, "email": self.email, "rol": self.rol, "pendiente": self.pendiente, "profesor": self.profesor, "suspendida": self.suspendida})
    }
}

fn subdominio_valido(s: &str) -> bool {
    let n = s.len();
    (3..=40).contains(&n)
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && !s.ends_with("-curso")
        && !s.ends_with("-prueba")
        && !RESERVADOS.contains(&s)
}

fn texto_acotado(m: &Map<String, Value>, k: &str, max: usize) -> Result<String, ApiError> {
    let v = texto_de(m, k).map(str::trim).ok_or_else(ApiError::datos_invalidos)?;
    let n = v.chars().count();
    if n == 0 || n > max {
        return Err(ApiError::datos_invalidos());
    }
    Ok(v.to_string())
}

fn cuerpo_opcional(encabezados: &HeaderMap, cuerpo: &Bytes) -> Result<Map<String, Value>, ApiError> {
    if cuerpo.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    cuerpo_json(encabezados, cuerpo)
}

fn con_emails(mut e: ApiError, emails: Vec<String>) -> ApiError {
    e.extra = Some(("emails", json!(emails)));
    e
}

pub fn no_es_profesor() -> ApiError {
    ApiError::nuevo(StatusCode::BAD_REQUEST, "no_es_profesor", "Solo las personas con marca de profesor pueden ser profesores.")
}

pub fn es_dueno() -> ApiError {
    ApiError::conflicto("es_dueno", "No se puede quitar ni cambiar al dueño del curso.")
}

pub async fn fila_curso(app: &App, id: &str) -> Result<Option<CursoFila>, sqlx::Error> {
    let f = sqlx::query(
        "SELECT c.id, c.nombre, c.periodo, c.color, c.universidad_id, c.version_publicada, c.estado, k.estado AS contenedor, \
         c.archivado_en IS NOT NULL AS archivado FROM cursos c LEFT JOIN contenedores k ON k.curso_id = c.id WHERE c.id = ?",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await?;
    Ok(f.map(|f| CursoFila {
        id: f.get("id"),
        nombre: f.get("nombre"),
        periodo: f.get("periodo"),
        color: f.get("color"),
        universidad_id: f.get("universidad_id"),
        version_publicada: f.get("version_publicada"),
        estado: f.get("estado"),
        contenedor: f.get("contenedor"),
        archivado: f.get::<i64, _>("archivado") != 0,
    }))
}

pub fn curso_json(c: &CursoFila, rol: &str) -> Value {
    let contenedor = match c.contenedor.as_deref() {
        None => "ninguno",
        Some("encendido") => "encendido",
        Some("encendiendo") => "encendiendo",
        Some(_) => "apagado",
    };
    json!({
        "id": c.id,
        "nombre": c.nombre,
        "periodo": c.periodo,
        "color": c.color,
        "rol": rol,
        "version_publicada": c.version_publicada,
        "estado": c.estado,
        "contenedor": contenedor,
        "archivado": c.archivado,
    })
}

pub const ROL_EFECTIVO: &str = "CASE WHEN i.rol <> 'alumno' AND u.profesor = 0 THEN 'alumno' ELSE i.rol END";

pub async fn rol_de(app: &App, curso: &str, usuario: i64) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT {ROL_EFECTIVO} FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? AND i.usuario_id = ?"
    ))
        .bind(curso)
        .bind(usuario)
        .fetch_optional(&app.db)
        .await
}

async fn inscripto_en(app: &App, ctx: &Ctx, id: &str) -> Result<(CursoFila, String), ApiError> {
    let curso = fila_curso(app, id).await?.ok_or_else(ApiError::no_encontrado)?;
    let rol = rol_de(app, id, ctx.usuario.id).await?.ok_or_else(ApiError::no_encontrado)?;
    crate::inhabilitar::curso_visible(&app.db, id, &rol).await?;
    Ok((curso, rol))
}

async fn docente_en(app: &App, ctx: &Ctx, id: &str) -> Result<(CursoFila, String), ApiError> {
    let (c, rol) = inscripto_en(app, ctx, id).await?;
    if rol == "alumno" {
        return Err(ApiError::prohibido());
    }
    Ok((c, rol))
}

async fn dueno_en(app: &App, ctx: &Ctx, id: &str) -> Result<CursoFila, ApiError> {
    let (c, rol) = inscripto_en(app, ctx, id).await?;
    if rol != "dueño" {
        return Err(ApiError::prohibido());
    }
    Ok(c)
}

fn orden_rol(r: &str) -> u8 {
    match r {
        "dueño" => 0,
        "profesor" => 1,
        _ => 2,
    }
}

pub async fn inscriptos_ordenados(app: &App, id: &str) -> Result<Vec<Inscripto>, sqlx::Error> {
    let filas = sqlx::query(&format!(
        "SELECT u.id, u.nombre, u.email, u.pendiente, u.profesor, i.rol, {} AS suspendida FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ?",
        crate::inhabilitar::SQL_INHABILITADA
    ))
    .bind(id)
    .fetch_all(&app.db)
    .await?;
    let mut lista: Vec<Inscripto> = filas
        .iter()
        .map(|f| Inscripto {
            id: f.get("id"),
            nombre: f.get("nombre"),
            email: f.get("email"),
            rol: f.get("rol"),
            pendiente: bool_de(f.get("pendiente")),
            profesor: bool_de(f.get("profesor")),
            suspendida: bool_de(f.get("suspendida")),
        })
        .collect();
    lista.sort_by(|a, b| {
        (orden_rol(&a.rol), sin_acentos(&a.nombre), &a.email).cmp(&(orden_rol(&b.rol), sin_acentos(&b.nombre), &b.email))
    });
    Ok(lista)
}

pub async fn inscripto_por_id(app: &App, curso: &str, usuario: i64) -> Result<Option<Inscripto>, sqlx::Error> {
    let f = sqlx::query(&format!(
        "SELECT u.id, u.nombre, u.email, u.pendiente, u.profesor, i.rol, {} AS suspendida FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id \
         WHERE i.curso_id = ? AND i.usuario_id = ?",
        crate::inhabilitar::SQL_INHABILITADA
    ))
    .bind(curso)
    .bind(usuario)
    .fetch_optional(&app.db)
    .await?;
    Ok(f.map(|f| Inscripto {
        id: f.get("id"),
        nombre: f.get("nombre"),
        email: f.get("email"),
        rol: f.get("rol"),
        pendiente: bool_de(f.get("pendiente")),
        profesor: bool_de(f.get("profesor")),
        suspendida: bool_de(f.get("suspendida")),
    }))
}

pub async fn tiene_marca(app: &App, usuario: i64) -> Result<bool, sqlx::Error> {
    let p: Option<i64> = sqlx::query_scalar("SELECT profesor FROM usuarios WHERE id = ?").bind(usuario).fetch_optional(&app.db).await?;
    Ok(p == Some(1))
}

fn nuevo_codigo(id: &str) -> String {
    let mut prefijo: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(3).collect::<String>().to_ascii_uppercase();
    while prefijo.len() < 3 {
        prefijo.push('X');
    }
    let mut r = rand::rngs::OsRng;
    let sufijo: String = (0..6).map(|_| ALFABETO[r.gen_range(0..ALFABETO.len())] as char).collect();
    format!("{prefijo}-{sufijo}")
}

fn codigo_con_formato(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() == 10
        && b[..3].iter().all(|x| x.is_ascii_uppercase() || x.is_ascii_digit())
        && b[3] == b'-'
        && b[4..].iter().all(|x| ALFABETO.contains(x))
}

async fn insertar_codigo(
    conexion: &mut sqlx::SqliteConnection,
    curso: &str,
    activo: bool,
    vence: Option<String>,
    por: Option<i64>,
) -> Result<String, sqlx::Error> {
    loop {
        let codigo = nuevo_codigo(curso);
        let r = sqlx::query(
            "INSERT INTO codigos_curso (curso_id, codigo, activo, vence_en, creado_en, creado_por) VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(curso_id) DO UPDATE SET codigo = excluded.codigo, activo = excluded.activo, vence_en = excluded.vence_en, \
             creado_en = excluded.creado_en, creado_por = excluded.creado_por",
        )
        .bind(curso)
        .bind(&codigo)
        .bind(activo as i64)
        .bind(&vence)
        .bind(ahora_txt())
        .bind(por)
        .execute(&mut *conexion)
        .await;
        match r {
            Ok(_) => return Ok(codigo),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(e),
        }
    }
}

pub async fn crear(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let universidad = match (ctx.usuario.profesor, ctx.usuario.universidad_id) {
        (true, Some(u)) => u,
        _ => return Err(ApiError::prohibido()),
    };
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let nombre = texto_acotado(&datos, "nombre", 120)?;
    let periodo = texto_acotado(&datos, "periodo", 60)?;
    let subdominio_invalido =
        || ApiError::nuevo(StatusCode::BAD_REQUEST, "subdominio_invalido", "Esa dirección no se puede usar.");
    let id = texto_de(&datos, "subdominio").map(str::trim).ok_or_else(subdominio_invalido)?.to_string();
    if !subdominio_valido(&id) {
        return Err(subdominio_invalido());
    }
    let Some(sup) = app.supervisor.clone() else {
        return Err(ApiError::servicio_no_disponible());
    };
    let en_uso = || ApiError::conflicto("subdominio_en_uso", "Esa dirección ya está en uso.");
    let existe: Option<String> = sqlx::query_scalar("SELECT id FROM cursos WHERE id = ?").bind(&id).fetch_optional(&app.db).await?;
    if existe.is_some() || sup.cfg.raiz_cursos.join(&id).exists() {
        return Err(en_uso());
    }
    let color = COLORES[rand::rngs::OsRng.gen_range(0..COLORES.len())];
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    let r = sqlx::query(
        "INSERT INTO cursos (id, nombre, periodo, color, universidad_id, version_publicada, creado_en, estado) VALUES (?, ?, ?, ?, ?, NULL, ?, 'preparando')",
    )
    .bind(&id)
    .bind(&nombre)
    .bind(&periodo)
    .bind(color)
    .bind(universidad)
    .bind(&ahora)
    .execute(&mut *tx)
    .await;
    match r {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(en_uso()),
        Err(e) => return Err(e.into()),
    }
    sqlx::query("INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, 'dueño', ?)")
        .bind(&id)
        .bind(ctx.usuario.id)
        .bind(&ahora)
        .execute(&mut *tx)
        .await?;
    insertar_codigo(&mut *tx, &id, false, None, Some(ctx.usuario.id)).await?;
    auditar(
        &mut *tx,
        Some(universidad),
        Some(ctx.usuario.id),
        "curso_creado",
        &format!("{} creó el curso {} ({})", ctx.usuario.email, id, nombre),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    tokio::spawn(sup.preparar(id.clone()));
    let fila = fila_curso(&app, &id).await?.ok_or_else(ApiError::servicio_no_disponible)?;
    Ok(json_estado(StatusCode::CREATED, crate::agente::extender_curso(&app, &fila.id, curso_json(&fila, "dueño")).await))
}

pub async fn reintentar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let (curso, rol) = docente_en(&app, &ctx, &id).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let Some(sup) = app.supervisor.clone() else {
        return Err(ApiError::servicio_no_disponible());
    };
    let mut tx = app.db.begin().await?;
    let r = sqlx::query("UPDATE cursos SET estado = 'preparando' WHERE id = ? AND estado = 'error'").bind(&id).execute(&mut *tx).await?;
    if r.rows_affected() != 1 {
        return Err(ApiError::conflicto("curso_no_en_error", "El curso no tiene un error para reintentar."));
    }
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "curso_reintentado",
        &format!("{} reintentó preparar el curso {}", ctx.usuario.email, id),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    tokio::spawn(sup.preparar(id.clone()));
    let fila = fila_curso(&app, &id).await?.ok_or_else(ApiError::no_encontrado)?;
    Ok(ok(crate::agente::extender_curso(&app, &id, curso_json(&fila, &rol)).await))
}

pub async fn ver(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let (c, rol) = inscripto_en(&app, &ctx, &id).await?;
    Ok(ok(crate::agente::extender_curso(&app, &id, curso_json(&c, &rol)).await))
}

pub async fn listar_inscriptos(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente_en(&app, &ctx, &id).await?;
    let lista = inscriptos_ordenados(&app, &id).await?;
    let alumnos = lista.iter().filter(|i| i.rol == "alumno" && !i.suspendida).count();
    let profesores = lista.iter().filter(|i| i.rol != "alumno" && !i.suspendida).count();
    Ok(ok(json!({
        "inscriptos": lista.iter().map(Inscripto::json).collect::<Vec<_>>(),
        "alumnos": alumnos,
        "profesores": profesores,
    })))
}

async fn universidad_de_dominio(app: &App, email: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?").bind(dominio_de(email)).fetch_optional(&app.db).await
}

struct Cuenta {
    universidad_id: Option<i64>,
    profesor: bool,
}

async fn cuenta_por_email(app: &App, email: &str) -> Result<Option<Cuenta>, sqlx::Error> {
    let f = sqlx::query("SELECT universidad_id, profesor FROM usuarios WHERE email = ?").bind(email).fetch_optional(&app.db).await?;
    Ok(f.map(|f| Cuenta { universidad_id: f.get("universidad_id"), profesor: bool_de(f.get("profesor")) }))
}

async fn de_la_universidad(app: &App, email: &str, universidad: i64) -> Result<bool, sqlx::Error> {
    if universidad_de_dominio(app, email).await? != Some(universidad) {
        return Ok(false);
    }
    Ok(match cuenta_por_email(app, email).await? {
        Some(c) => c.universidad_id == Some(universidad),
        None => true,
    })
}

struct Alta {
    agregados: Vec<String>,
    ya_estaban: Vec<String>,
    creados: Vec<String>,
}

async fn inscribir_lista(
    app: &App,
    ctx: &Ctx,
    curso: &CursoFila,
    personas: &[(String, Option<String>)],
    rol: &str,
) -> Result<Alta, ApiError> {
    let mut alta = Alta { agregados: Vec::new(), ya_estaban: Vec::new(), creados: Vec::new() };
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    for (email, nombre) in personas {
        let existente: Option<i64> =
            sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?").bind(email).fetch_optional(&mut *tx).await?;
        let usuario = match existente {
            Some(u) => u,
            None => {
                let nombre = nombre.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| nombre_desde_email(email));
                let id: i64 = sqlx::query_scalar(
                    "INSERT INTO usuarios (email, nombre, universidad_id, pendiente, creado_en) VALUES (?, ?, ?, 1, ?) RETURNING id",
                )
                .bind(email)
                .bind(nombre)
                .bind(curso.universidad_id)
                .bind(&ahora)
                .fetch_one(&mut *tx)
                .await?;
                alta.creados.push(email.clone());
                id
            }
        };
        let r = sqlx::query("INSERT OR IGNORE INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, ?, ?)")
            .bind(&curso.id)
            .bind(usuario)
            .bind(rol)
            .bind(&ahora)
            .execute(&mut *tx)
            .await?;
        if r.rows_affected() == 1 {
            alta.agregados.push(email.clone());
            auditar(
                &mut *tx,
                Some(curso.universidad_id),
                Some(ctx.usuario.id),
                "inscripcion",
                &format!("{} inscribió a {} como {} en el curso {}", ctx.usuario.email, email, rol, curso.id),
                Some(&ctx.ip),
            )
            .await?;
        } else {
            alta.ya_estaban.push(email.clone());
        }
    }
    tx.commit().await?;
    Ok(alta)
}

pub async fn agregar_inscriptos(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let (curso, rol_propio) = docente_en(&app, &ctx, &id).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let rol = match texto_de(&datos, "rol") {
        Some("alumno") => "alumno",
        Some("profesor") => "profesor",
        _ => return Err(ApiError::datos_invalidos()),
    };
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
    if rol == "profesor" && rol_propio != "dueño" {
        return Err(ApiError::prohibido());
    }
    let invalidos: Vec<String> = emails.iter().filter(|e| normalizar_email(e).is_none()).cloned().collect();
    if !invalidos.is_empty() {
        return Err(con_emails(ApiError::email_invalido(), invalidos));
    }
    let mut ajenos = Vec::new();
    for e in &emails {
        if !de_la_universidad(&app, e, curso.universidad_id).await? {
            ajenos.push(e.clone());
        }
    }
    if !ajenos.is_empty() {
        return Err(con_emails(ApiError::dominio_no_habilitado(), ajenos));
    }
    if rol == "profesor" {
        let mut sin_marca = Vec::new();
        for e in &emails {
            match cuenta_por_email(&app, e).await? {
                Some(c) if c.profesor => {}
                _ => sin_marca.push(e.clone()),
            }
        }
        if !sin_marca.is_empty() {
            return Err(con_emails(no_es_profesor(), sin_marca));
        }
    }
    let personas: Vec<(String, Option<String>)> = emails.into_iter().map(|e| (e, None)).collect();
    let alta = inscribir_lista(&app, &ctx, &curso, &personas, rol).await?;
    Ok(ok(json!({"agregados": alta.agregados, "ya_estaban": alta.ya_estaban, "creados": alta.creados})))
}

pub async fn importar_siu(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let (curso, _) = docente_en(&app, &ctx, &id).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let archivo_invalido = || ApiError::nuevo(StatusCode::BAD_REQUEST, "archivo_invalido", "No se pudo leer el archivo.");
    let archivo = texto_de(&datos, "archivo").ok_or_else(ApiError::datos_invalidos)?;
    if archivo.chars().count() > 255 {
        return Err(ApiError::datos_invalidos());
    }
    let contenido = texto_de(&datos, "contenido").ok_or_else(ApiError::datos_invalidos)?;
    let limpio: String = contenido.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let motor = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let bytes = motor.decode(limpio.as_bytes()).map_err(|_| archivo_invalido())?;
    if bytes.is_empty() || bytes.len() > crate::siu::MAXIMO_ARCHIVO {
        return Err(archivo_invalido());
    }
    let filas = crate::siu::leer_aislado(bytes).await.ok_or_else(archivo_invalido)?;
    let mut rechazados = Vec::new();
    let mut personas: Vec<(String, Option<String>)> = Vec::new();
    let mut vistos = HashSet::new();
    for f in filas {
        let Some(email) = normalizar_email(&f.email) else {
            rechazados.push(json!({"fila": f.fila, "email": f.email, "motivo": "email_invalido"}));
            continue;
        };
        if !de_la_universidad(&app, &email, curso.universidad_id).await? {
            rechazados.push(json!({"fila": f.fila, "email": email, "motivo": "dominio_no_habilitado"}));
            continue;
        }
        if vistos.insert(email.clone()) {
            personas.push((email, f.nombre));
        }
    }
    let alta = inscribir_lista(&app, &ctx, &curso, &personas, "alumno").await?;
    auditar(
        &app.db,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "importacion_siu",
        &format!(
            "{} importó el listado del SIU en el curso {}: {} agregados, {} ya estaban, {} rechazados",
            ctx.usuario.email,
            curso.id,
            alta.agregados.len(),
            alta.ya_estaban.len(),
            rechazados.len()
        ),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(json!({
        "agregados": alta.agregados,
        "ya_estaban": alta.ya_estaban,
        "creados": alta.creados,
        "rechazados": rechazados,
    })))
}

fn usuario_de_ruta(s: &str) -> Result<i64, ApiError> {
    s.parse::<i64>().map_err(|_| ApiError::no_encontrado())
}

pub async fn cambiar_rol(
    State(app): State<Estado>,
    ctx: Ctx,
    Path((id, usuario)): Path<(String, String)>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    let curso = dueno_en(&app, &ctx, &id).await?;
    ctx.reautenticada(&app.cfg)?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let rol = match texto_de(&datos, "rol") {
        Some("alumno") => "alumno",
        Some("profesor") => "profesor",
        _ => return Err(ApiError::datos_invalidos()),
    };
    let usuario = usuario_de_ruta(&usuario)?;
    let persona = inscripto_por_id(&app, &id, usuario).await?.ok_or_else(ApiError::no_encontrado)?;
    if persona.rol == "dueño" {
        return Err(es_dueno());
    }
    if rol == "profesor" && !tiene_marca(&app, usuario).await? {
        return Err(no_es_profesor());
    }
    ejecutar_rol(&app, &ctx.usuario, &ctx.ip, &curso, &persona, rol).await?;
    let persona = inscripto_por_id(&app, &id, usuario).await?.ok_or_else(ApiError::no_encontrado)?;
    Ok(ok(persona.json()))
}

pub async fn quitar(State(app): State<Estado>, ctx: Ctx, Path((id, usuario)): Path<(String, String)>) -> Resultado {
    ctx.solo_sesion()?;
    let (curso, rol_propio) = docente_en(&app, &ctx, &id).await?;
    ctx.reautenticada(&app.cfg)?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let usuario = usuario_de_ruta(&usuario)?;
    let persona = inscripto_por_id(&app, &id, usuario).await?.ok_or_else(ApiError::no_encontrado)?;
    if persona.rol == "dueño" {
        return Err(es_dueno());
    }
    if rol_propio != "dueño" && persona.rol != "alumno" {
        return Err(ApiError::prohibido());
    }
    ejecutar_quitar(&app, &ctx.usuario, &ctx.ip, &curso, &persona).await?;
    Ok(sin_contenido())
}

pub async fn ejecutar_rol(app: &App, actor: &Usuario, ip: &str, curso: &CursoFila, persona: &Inscripto, rol: &str) -> Result<(), ApiError> {
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE inscripciones SET rol = ? WHERE curso_id = ? AND usuario_id = ? AND rol <> 'dueño'")
        .bind(rol)
        .bind(&curso.id)
        .bind(persona.id)
        .execute(&mut *tx)
        .await?;
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(actor.id),
        "rol_en_curso",
        &format!("{} cambió el rol de {} a {} en el curso {}", actor.email, persona.email, rol, curso.id),
        Some(ip),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn ejecutar_quitar(app: &App, actor: &Usuario, ip: &str, curso: &CursoFila, persona: &Inscripto) -> Result<(), ApiError> {
    let ahora = ahora_txt();
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "INSERT INTO inscripciones_historia (curso_id, usuario_id, rol, creada_en, quitada_en, motivo, actor_id) \
         SELECT curso_id, usuario_id, rol, creada_en, ?, 'desinscripcion', ? FROM inscripciones WHERE curso_id = ? AND usuario_id = ? AND rol <> 'dueño'",
    )
    .bind(&ahora)
    .bind(actor.id)
    .bind(&curso.id)
    .bind(persona.id)
    .execute(&mut *tx)
    .await?;
    let r = sqlx::query("DELETE FROM inscripciones WHERE curso_id = ? AND usuario_id = ? AND rol <> 'dueño'")
        .bind(&curso.id)
        .bind(persona.id)
        .execute(&mut *tx)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::no_encontrado());
    }
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(actor.id),
        "desinscripcion",
        &format!("{} quitó a {} ({}) del curso {}", actor.email, persona.email, persona.rol, curso.id),
        Some(ip),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn transferir(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    ctx.solo_sesion()?;
    let curso = dueno_en(&app, &ctx, &id).await?;
    ctx.reautenticada(&app.cfg)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let usuario = match datos.get("usuario_id") {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(ApiError::datos_invalidos)?,
        Some(Value::String(s)) => s.trim().parse::<i64>().map_err(|_| ApiError::datos_invalidos())?,
        _ => return Err(ApiError::datos_invalidos()),
    };
    let persona = inscripto_por_id(&app, &id, usuario).await?.ok_or_else(ApiError::no_encontrado)?;
    if persona.rol != "profesor" || !tiene_marca(&app, usuario).await? {
        return Err(no_es_profesor());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE inscripciones SET rol = 'profesor' WHERE curso_id = ? AND usuario_id = ? AND rol = 'dueño'")
        .bind(&id)
        .bind(ctx.usuario.id)
        .execute(&mut *tx)
        .await?;
    let r = sqlx::query("UPDATE inscripciones SET rol = 'dueño' WHERE curso_id = ? AND usuario_id = ? AND rol = 'profesor'")
        .bind(&id)
        .bind(usuario)
        .execute(&mut *tx)
        .await?;
    if r.rows_affected() != 1 {
        return Err(ApiError::conflicto("conflicto", "El curso cambió mientras tanto."));
    }
    auditar(
        &mut *tx,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "curso_transferido",
        &format!("{} transfirió el curso {} a {}", ctx.usuario.email, id, persona.email),
        Some(&ctx.ip),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"dueno": {"id": persona.id, "nombre": persona.nombre, "email": persona.email}})))
}

pub async fn codigo_json(app: &App, id: &str) -> Result<Value, ApiError> {
    let mut f = sqlx::query("SELECT codigo, activo, vence_en FROM codigos_curso WHERE curso_id = ?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?;
    if f.is_none() {
        let mut c = app.db.acquire().await?;
        insertar_codigo(&mut c, id, false, None, None).await?;
        f = sqlx::query("SELECT codigo, activo, vence_en FROM codigos_curso WHERE curso_id = ?")
            .bind(id)
            .fetch_optional(&app.db)
            .await?;
    }
    let f = f.ok_or_else(ApiError::servicio_no_disponible)?;
    Ok(json!({
        "codigo": f.get::<String, _>("codigo"),
        "activo": bool_de(f.get("activo")),
        "vence": f.get::<Option<String>, _>("vence_en"),
    }))
}

pub async fn ver_codigo(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente_en(&app, &ctx, &id).await?;
    Ok(ok(codigo_json(&app, &id).await?))
}

pub async fn generar_codigo(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let (curso, _) = docente_en(&app, &ctx, &id).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let datos = cuerpo_opcional(&encabezados, &cuerpo)?;
    let dias = match datos.get("dias") {
        None | Some(Value::Null) => 30,
        Some(Value::Number(n)) => match n.as_i64() {
            Some(d) if (1..=365).contains(&d) => d,
            _ => return Err(ApiError::datos_invalidos()),
        },
        _ => return Err(ApiError::datos_invalidos()),
    };
    let vence = fecha(en_segundos(dias * 86_400));
    let mut c = app.db.acquire().await?;
    let codigo = insertar_codigo(&mut c, &id, true, Some(vence), Some(ctx.usuario.id)).await?;
    drop(c);
    auditar(
        &app.db,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "codigo_curso_generado",
        &format!("{} generó el código {} del curso {} por {} días", ctx.usuario.email, codigo, id, dias),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(codigo_json(&app, &id).await?))
}

pub async fn cambiar_codigo(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(id): Path<String>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let (curso, _) = docente_en(&app, &ctx, &id).await?;
    crate::inhabilitar::curso_modificable(&app.db, &id).await?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let activo = datos.get("activo").and_then(Value::as_bool).ok_or_else(ApiError::datos_invalidos)?;
    codigo_json(&app, &id).await?;
    sqlx::query("UPDATE codigos_curso SET activo = ? WHERE curso_id = ?").bind(activo as i64).bind(&id).execute(&app.db).await?;
    auditar(
        &app.db,
        Some(curso.universidad_id),
        Some(ctx.usuario.id),
        "codigo_curso_cambiado",
        &format!("{} {} el código del curso {}", ctx.usuario.email, if activo { "activó" } else { "desactivó" }, id),
        Some(&ctx.ip),
    )
    .await?;
    Ok(ok(codigo_json(&app, &id).await?))
}

pub async fn unirse(State(app): State<Estado>, ctx: Ctx, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let clave_usuario = ctx.usuario.id.to_string();
    if contar(&app, "unirse_usuario", &clave_usuario).await? >= app.cfg.limite_unirse_usuario
        || contar(&app, "unirse_ip", &ctx.ip).await? >= app.cfg.limite_unirse_ip
    {
        return Err(ApiError::demasiados_intentos());
    }
    let datos = cuerpo_json(&encabezados, &cuerpo).ok();
    let codigo = datos
        .as_ref()
        .and_then(|d| texto_de(d, "codigo"))
        .map(|c| c.trim().to_ascii_uppercase())
        .unwrap_or_default();
    let mut encontrado: Option<(CursoFila, Option<String>)> = None;
    if codigo_con_formato(&codigo) {
        let f = sqlx::query("SELECT curso_id, activo, vence_en FROM codigos_curso WHERE codigo = ?")
            .bind(&codigo)
            .fetch_optional(&app.db)
            .await?;
        if let Some(f) = f {
            let activo = bool_de(f.get("activo"));
            let vigente = f
                .get::<Option<String>, _>("vence_en")
                .map(|v| leer_fecha(&v).map(|d| d > ahora()).unwrap_or(false))
                .unwrap_or(true);
            let curso_id: String = f.get("curso_id");
            if activo && vigente {
                if let Some(c) = fila_curso(&app, &curso_id).await? {
                    if ctx.usuario.universidad_id == Some(c.universidad_id) && !c.archivado {
                        let rol = rol_de(&app, &curso_id, ctx.usuario.id).await?;
                        encontrado = Some((c, rol));
                    }
                }
            }
        }
    }
    let Some((curso, rol)) = encontrado else {
        registrar(&app, "unirse_usuario", &clave_usuario).await?;
        registrar(&app, "unirse_ip", &ctx.ip).await?;
        return Err(ApiError::codigo_invalido());
    };
    let rol = match rol {
        Some(r) => r,
        None => {
            let mut tx = app.db.begin().await?;
            sqlx::query("INSERT OR IGNORE INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, 'alumno', ?)")
                .bind(&curso.id)
                .bind(ctx.usuario.id)
                .bind(ahora_txt())
                .execute(&mut *tx)
                .await?;
            auditar(
                &mut *tx,
                Some(curso.universidad_id),
                Some(ctx.usuario.id),
                "inscripcion_por_codigo",
                &format!("{} se unió al curso {} con un código", ctx.usuario.email, curso.id),
                Some(&ctx.ip),
            )
            .await?;
            tx.commit().await?;
            rol_de(&app, &curso.id, ctx.usuario.id).await?.unwrap_or_else(|| "alumno".to_string())
        }
    };
    Ok(ok(json!({"curso": {
        "id": curso.id,
        "nombre": curso.nombre,
        "periodo": curso.periodo,
        "color": curso.color,
        "rol": rol,
    }})))
}
