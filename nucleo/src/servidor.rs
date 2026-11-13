use std::path::{Component, Path as RutaFs, PathBuf};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::json;

use crate::auth::*;
use crate::util::*;
use crate::{acciones, admin, agente, archivos, cuenta, cupos, cursos, estado, inhabilitar, login, owner, publicar, registros, roles, sesiones_owner};

#[derive(Clone, Debug, PartialEq)]
pub enum Host {
    Plataforma,
    Curso(String),
    Prueba(String),
    Australis,
    Ajeno,
}

pub const SUBDOMINIO_AUSTRALIS: &str = "campus";

pub fn separar_host(crudo: &str) -> (String, Option<String>) {
    let crudo = crudo.trim().to_ascii_lowercase();
    if crudo.starts_with('[') {
        return (crudo, None);
    }
    match crudo.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h.to_string(), Some(p.to_string())),
        _ => (crudo, None),
    }
}

fn etiqueta_valida(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn clasificar(nombre: &str, base: &str) -> Host {
    let nombre = nombre.strip_suffix('.').unwrap_or(nombre);
    if nombre == base {
        return Host::Plataforma;
    }
    let Some(sub) = nombre.strip_suffix(base).and_then(|s| s.strip_suffix('.')) else {
        return Host::Ajeno;
    };
    if !etiqueta_valida(sub) {
        return Host::Ajeno;
    }
    if let Some(id) = sub.strip_suffix("-curso") {
        return if etiqueta_valida(id) { Host::Curso(id.to_string()) } else { Host::Ajeno };
    }
    if let Some(id) = sub.strip_suffix("-prueba") {
        return if etiqueta_valida(id) { Host::Prueba(id.to_string()) } else { Host::Ajeno };
    }
    if sub == SUBDOMINIO_AUSTRALIS {
        return Host::Australis;
    }
    Host::Plataforma
}

fn host_crudo(req: &Request) -> String {
    req.headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()))
        .unwrap_or_default()
}

fn no_encontrado_texto() -> Response {
    (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "No encontrado").into_response()
}

fn origen_valido(app: &App, encabezados: &HeaderMap, host: &str) -> bool {
    let propio = encabezados.get("x-campusia").and_then(|v| v.to_str().ok()).map(str::trim) == Some("1");
    if !propio {
        return false;
    }
    let Some(origen) = encabezados.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let host = host.trim();
    if host.is_empty() {
        return false;
    }
    let mut validos = vec![format!("https://{host}")];
    if app.cfg.desarrollo {
        validos.push(format!("http://{host}"));
    }
    validos.iter().any(|v| v.eq_ignore_ascii_case(origen))
}

pub async fn filtro(State(app): State<Estado>, req: Request, next: Next) -> Response {
    let ruta = req.uri().path().to_string();
    let crudo = host_crudo(&req);
    let (nombre, puerto) = separar_host(&crudo);
    let host = clasificar(&nombre, &app.cfg.dominio_base);
    let es_curso = matches!(host, Host::Curso(_) | Host::Prueba(_));
    let repetida = host != Host::Ajeno && cookie_repetida(req.headers(), COOKIE);
    let mut respuesta = if ruta == "/salud" && !es_curso {
        let mut r = Json(json!({"ok": true})).into_response();
        encabezado_no_store(&mut r);
        r
    } else {
        match host {
            Host::Ajeno => no_encontrado_texto(),
            Host::Curso(id) => crate::enrutador::atender(&app, &id, puerto.as_deref(), req).await,
            Host::Prueba(id) => crate::prueba::atender(&app, &id, puerto.as_deref(), req).await,
            Host::Australis => crate::enrutador::atender_australis(&app, puerto.as_deref(), req).await,
            Host::Plataforma => {
                if ruta == "/modelo" || ruta.starts_with("/modelo/") {
                    no_encontrado_texto()
                } else if ruta == "/api" || ruta.starts_with("/api/") {
                    let modifica = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
                    if modifica && !origen_valido(&app, req.headers(), &crudo) {
                        ApiError::origen_invalido().into_response()
                    } else if ruta == "/api/curso" || ruta.starts_with("/api/curso/") {
                        ApiError::no_encontrado().into_response()
                    } else if req.headers().contains_key(header::AUTHORIZATION) {
                        ApiError::no_autenticado().into_response()
                    } else {
                        next.run(req).await
                    }
                } else if req.method() == Method::GET || req.method() == Method::HEAD {
                    estatico(&app, &ruta).await
                } else {
                    StatusCode::METHOD_NOT_ALLOWED.into_response()
                }
            }
        }
    };
    let h = respuesta.headers_mut();
    if repetida {
        for c in borrar_cookies_repetidas(&app.cfg, &ruta, es_curso) {
            h.append(header::SET_COOKIE, c);
        }
    }
    if es_curso {
        h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
        h.remove(header::ACCESS_CONTROL_ALLOW_CREDENTIALS);
        return respuesta;
    }
    if (ruta == "/api" || ruta.starts_with("/api/") || ruta == "/salud") && !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    h.remove(header::ACCESS_CONTROL_ALLOW_ORIGIN);
    h.remove(header::ACCESS_CONTROL_ALLOW_CREDENTIALS);
    respuesta
}

fn ruta_segura(base: &RutaFs, ruta: &str) -> Option<PathBuf> {
    let relativa = ruta.trim_start_matches('/');
    if relativa.is_empty() {
        return None;
    }
    let decodificada = url::form_urlencoded::parse(format!("x={}", relativa.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())?;
    let p = PathBuf::from(&decodificada);
    if decodificada.contains('\\') || decodificada.contains('\0') {
        return None;
    }
    if !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(base.join(p))
}

async fn estatico(app: &App, ruta: &str) -> Response {
    let base = PathBuf::from(&app.cfg.interfaz_dir);
    let mut archivo = None;
    if let Some(p) = ruta_segura(&base, ruta) {
        if let Ok(m) = tokio::fs::metadata(&p).await {
            if m.is_file() {
                archivo = Some(p);
            }
        }
    }
    let (p, es_indice) = match archivo {
        Some(p) => {
            let indice = p.file_name().map(|n| n == "index.html").unwrap_or(false);
            (p, indice)
        }
        None => (base.join("index.html"), true),
    };
    let contenido = match tokio::fs::read(&p).await {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "La interfaz no está disponible",
            )
                .into_response()
        }
    };
    let tipo = if es_indice {
        "text/html; charset=utf-8".to_string()
    } else {
        let m = mime_guess::from_path(&p).first_or_octet_stream();
        if m.type_() == "text" || m.essence_str() == "application/javascript" {
            format!("{}; charset=utf-8", m.essence_str())
        } else {
            m.essence_str().to_string()
        }
    };
    let cache = if !es_indice && ruta.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut r = Response::new(Body::from(contenido));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&tipo).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("frame-ancestors 'none'"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    r
}

fn pagina(estado: StatusCode, titulo: &str, cuerpo: &str, csp: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{t}</title><style>body{{margin:0;font-family:Inter,system-ui,sans-serif;background:#F5F6F8;color:#1a1a1a;display:flex;\
align-items:center;justify-content:center;min-height:100vh}}main{{background:#fff;border:1px solid #E3E5EA;border-radius:12px;\
padding:40px 48px;text-align:center;max-width:520px}}h1{{font-size:22px;margin:0 0 8px;color:#001D9C}}p{{margin:0;color:#5B6070}}</style>\
</head><body><main>{cuerpo}</main></body></html>",
        t = escapar_html(titulo),
    );
    let mut r = (estado, Html(html)).into_response();
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    r
}

pub async fn provisoria(app: &App, id: &str, puerto: Option<&str>, req: Request) -> Response {
    if req.uri().path() == "/" && (req.method() == Method::GET || req.method() == Method::HEAD) {
        pagina_provisoria(app, id, puerto, req.headers()).await
    } else {
        no_encontrado_texto()
    }
}

async fn pagina_provisoria(app: &App, id: &str, puerto: Option<&str>, encabezados: &HeaderMap) -> Response {
    match pagina_provisoria_interna(app, id, puerto, encabezados).await {
        Ok(r) => r,
        Err(_) => pagina(
            StatusCode::SERVICE_UNAVAILABLE,
            "Campus IA",
            "<h1>Servicio no disponible</h1><p>Probá de nuevo en unos minutos.</p>",
            "frame-ancestors 'none'",
        ),
    }
}

async fn pagina_provisoria_interna(
    app: &App,
    id: &str,
    puerto: Option<&str>,
    encabezados: &HeaderMap,
) -> Result<Response, sqlx::Error> {
    let barra = match puerto {
        Some(p) => format!("{}://{}.{}:{}", app.cfg.esquema(), id, app.cfg.dominio_base, p),
        None => format!("{}://{}.{}", app.cfg.esquema(), id, app.cfg.dominio_base),
    };
    let csp = format!("frame-ancestors {barra}");
    let nombre: Option<String> =
        sqlx::query_scalar("SELECT nombre FROM cursos WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    let Some(nombre) = nombre else {
        return Ok(pagina(StatusCode::NOT_FOUND, "Campus IA", "<h1>No encontrado</h1><p>Este curso no existe.</p>", &csp));
    };
    let Some(sesion) = sesion_de_cookie(app, encabezados).await? else {
        return Ok(pagina(
            StatusCode::UNAUTHORIZED,
            "Campus IA",
            "<h1>Tenés que iniciar sesión</h1><p>Entrá a Campus IA para ver este curso.</p>",
            &csp,
        ));
    };
    let inscripto: Option<String> = sqlx::query_scalar("SELECT rol FROM inscripciones WHERE curso_id = ? AND usuario_id = ?")
        .bind(id)
        .bind(sesion.usuario_id)
        .fetch_optional(&app.db)
        .await?;
    if inscripto.is_none() {
        return Ok(pagina(
            StatusCode::FORBIDDEN,
            "Campus IA",
            "<h1>Sin acceso</h1><p>No tenés acceso a este curso.</p>",
            &csp,
        ));
    }
    let cuerpo = format!("<h1>{}</h1><p>Curso en preparación</p>", escapar_html(&nombre));
    Ok(pagina(StatusCode::OK, &nombre, &cuerpo, &csp))
}

async fn api_no_encontrada() -> Response {
    ApiError::no_encontrado().into_response()
}

pub fn router(app: Estado) -> Router {
    let api = Router::new()
        .route("/api/config", get(login::config))
        .route("/api/login/codigo", post(login::pedir_codigo))
        .route("/api/login/verificar", post(login::verificar))
        .route("/api/yo", get(cuenta::yo))
        .route("/api/mis-cursos", get(cuenta::mis_cursos))
        .route("/api/logout", post(cuenta::logout))
        .route("/api/reautenticacion/codigo", post(login::reautenticacion_codigo))
        .route("/api/reautenticacion/verificar", post(login::reautenticacion_verificar))
        .route("/api/admin/universidad", get(admin::ver_universidad))
        .route("/api/admin/personas", get(admin::personas))
        .route("/api/admin/personas/{id}/profesor", put(admin::marcar_profesor))
        .route("/api/admin/invitaciones", post(admin::invitaciones))
        .route("/api/admin/cursos", get(admin::cursos))
        .route("/api/admin/dominios", post(admin::agregar_dominio))
        .route("/api/admin/dominios/{dominio}", delete(admin::quitar_dominio))
        .route("/api/admin/auditoria", get(admin::auditoria))
        .route("/api/owner/universidades", get(owner::universidades).post(owner::crear_universidad))
        .route("/api/owner/universidades/{id}/administradores", post(owner::invitar_administrador))
        .route("/api/owner/universidades/{id}/dominios", post(owner::agregar_dominio))
        .route("/api/owner/uso", get(owner::uso))
        .route("/api/cursos", post(cursos::crear))
        .route("/api/cursos/{id}", get(cursos::ver))
        .route("/api/cursos/{id}/inscriptos", get(cursos::listar_inscriptos).post(cursos::agregar_inscriptos))
        .route(
            "/api/cursos/{id}/inscriptos/siu",
            post(cursos::importar_siu).layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route("/api/cursos/{id}/inscriptos/{usuario}", put(cursos::cambiar_rol).delete(cursos::quitar))
        .route("/api/cursos/{id}/transferir", post(cursos::transferir))
        .route("/api/cursos/{id}/reintentar", post(cursos::reintentar))
        .route(
            "/api/cursos/{id}/codigo",
            get(cursos::ver_codigo).post(cursos::generar_codigo).put(cursos::cambiar_codigo),
        )
        .route("/api/unirse", post(cursos::unirse))
        .route("/api/cursos/{id}/espacio", get(agente::ver_espacio).post(agente::encender_espacio))
        .route("/api/cursos/{id}/agente", get(agente::ver_agente).post(agente::pedir_agente))
        .route("/api/cursos/{id}/uso", get(agente::ver_uso))
        .route("/api/cursos/{id}/versiones", get(publicar::ver_versiones))
        .route("/api/cursos/{id}/versiones/{n}/volver", post(publicar::volver))
        .route("/api/cursos/{id}/publicar", post(publicar::publicar))
        .route("/api/cursos/{id}/publicaciones", get(publicar::ver_publicaciones))
        .route("/api/cursos/{id}/publicaciones/{pid}", get(publicar::ver_publicacion))
        .route("/api/owner/proveedores", get(owner::ver_proveedores).put(owner::cambiar_proveedores))
        .route("/api/owner/estado", get(estado::ver))
        .route("/api/cursos/{id}/archivos", get(archivos::p_listar).post(archivos::p_subir))
        .route("/api/cursos/{id}/archivos/{archivo}", get(archivos::p_bajar))
        .route("/api/cursos/{id}/entregas", get(registros::p_entregas).post(registros::p_entregar))
        .route("/api/cursos/{id}/notas", get(registros::p_notas).post(registros::p_poner_nota))
        .route("/api/cursos/{id}/notas/historial", get(registros::p_historial))
        .route("/api/admin/personas/{id}/suspender", post(inhabilitar::admin_suspender))
        .route("/api/admin/personas/{id}/reactivar", post(inhabilitar::admin_reactivar))
        .route("/api/admin/personas/{id}/baja", post(inhabilitar::admin_baja))
        .route("/api/owner/personas/{id}/suspender", post(inhabilitar::owner_suspender))
        .route("/api/owner/personas/{id}/reactivar", post(inhabilitar::owner_reactivar))
        .route("/api/owner/personas/{id}/baja", post(inhabilitar::owner_baja))
        .route("/api/owner/universidades/{id}/deshabilitar", post(inhabilitar::deshabilitar_universidad))
        .route("/api/owner/universidades/{id}/rehabilitar", post(inhabilitar::rehabilitar_universidad))
        .route("/api/cursos/{id}/archivar", post(inhabilitar::archivar))
        .route("/api/cursos/{id}/desarchivar", post(inhabilitar::desarchivar))
        .route("/api/admin/cursos/{id}/archivar", post(inhabilitar::admin_archivar))
        .route("/api/admin/cursos/{id}/desarchivar", post(inhabilitar::admin_desarchivar))
        .route("/api/admin/cursos/{id}/transferir", post(inhabilitar::admin_transferir))
        .route("/api/owner/universidades/{id}/administradores/{usuario}", delete(roles::quitar_administrador))
        .route("/api/owner/owners", get(roles::owners).post(roles::poner_owner))
        .route("/api/owner/owners/{id}", delete(roles::quitar_owner))
        .route("/api/cursos/{id}/confirmaciones", get(acciones::listar_confirmaciones))
        .route("/api/cursos/{id}/confirmaciones/{cid}/aprobar", post(acciones::aprobar))
        .route("/api/cursos/{id}/confirmaciones/{cid}/rechazar", post(acciones::rechazar))
        .route("/api/owner/personas/{id}/sesiones", get(sesiones_owner::listar))
        .route("/api/owner/personas/{id}/sesiones/cerrar", post(sesiones_owner::cerrar_todas))
        .route("/api/owner/personas/{id}/sesiones/{sid}", delete(sesiones_owner::cerrar_una))
        .route("/api/owner/cupos", get(cupos::owner_cupos))
        .route("/api/owner/universidades/{id}/cupo", put(cupos::owner_poner_cupo))
        .route("/api/admin/cupos", get(cupos::admin_cupos))
        .route("/api/admin/cupos/predeterminado", put(cupos::admin_predeterminado))
        .route("/api/admin/cupos/profesores/{usuario}", put(cupos::admin_cupo_profesor))
        .route("/api/cursos/{id}/cupo", get(cupos::curso_cupo))
        .fallback(api_no_encontrada);
    api.layer(middleware::from_fn_with_state(app.clone(), filtro))
        .layer(middleware::from_fn(cerrar_si_queda_cuerpo))
        .with_state(app)
}
