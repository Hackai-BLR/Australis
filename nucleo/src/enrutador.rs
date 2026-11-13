use std::net::SocketAddr;
use std::time::Duration;

use axum::body::{Body, HttpBody};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use futures_util::TryStreamExt;
use sqlx::Row;

use crate::auth::*;
use crate::identidad::Persona;
use crate::supervisor::FallaArranque;
use crate::util::*;

pub(crate) const MAXIMO_CUERPO: usize = 50 * 1024 * 1024;
pub(crate) const MAXIMO_EN_MEMORIA: usize = 64 * 1024;

pub(crate) enum Cuerpo {
    Fijo(axum::body::Bytes),
    Flujo(Option<Body>),
}

impl Cuerpo {
    pub(crate) fn tomar(&mut self) -> reqwest::Body {
        match self {
            Cuerpo::Fijo(b) => reqwest::Body::from(b.clone()),
            Cuerpo::Flujo(c) => {
                let Some(c) = c.take() else { return reqwest::Body::from(Vec::new()) };
                let mut total = 0usize;
                let flujo = c.into_data_stream().map_err(std::io::Error::other).and_then(move |b| {
                    total += b.len();
                    let r = if total > MAXIMO_CUERPO { Err(std::io::Error::other("cuerpo demasiado grande")) } else { Ok(b) };
                    std::future::ready(r)
                });
                reqwest::Body::wrap_stream(flujo)
            }
        }
    }
}

const SALTO_A_SALTO: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub(crate) fn pagina(estado: StatusCode, titulo: &str, cuerpo: &str, csp: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{t}</title><style>body{{margin:0;font-family:Inter,system-ui,sans-serif;background:#F6F7F9;color:#16181F;display:flex;\
align-items:center;justify-content:center;min-height:100vh}}main{{background:#fff;border:1px solid #E4E6EB;border-radius:12px;\
padding:40px 48px;text-align:center;max-width:520px}}h1{{font-size:22px;margin:0 0 8px;color:#001D9C}}p{{margin:0;color:#5E6270}}\
a{{color:#1E4FD6}}</style></head><body><main>{cuerpo}</main></body></html>",
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

pub(crate) fn con_reintento(mut r: Response) -> Response {
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
    r
}

pub(crate) fn origen_de(app: &App, sub: &str, puerto: Option<&str>) -> String {
    match puerto {
        Some(p) => format!("{}://{}.{}:{}", app.cfg.esquema(), sub, app.cfg.dominio_base, p),
        None => format!("{}://{}.{}", app.cfg.esquema(), sub, app.cfg.dominio_base),
    }
}

pub(crate) fn quitar_encabezados(h: &mut HeaderMap) {
    let mut nombrados: Vec<HeaderName> = Vec::new();
    for v in h.get_all(header::CONNECTION) {
        if let Ok(s) = v.to_str() {
            for parte in s.split(',') {
                if let Ok(n) = HeaderName::from_bytes(parte.trim().to_ascii_lowercase().as_bytes()) {
                    nombrados.push(n);
                }
            }
        }
    }
    for n in nombrados {
        h.remove(n);
    }
    for n in SALTO_A_SALTO {
        h.remove(n);
    }
}

pub async fn atender(app: &App, id: &str, puerto: Option<&str>, req: Request) -> Response {
    match atender_interno(app, id, puerto, req).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error en el enrutador de {id}: {e:#}");
            pagina(
                StatusCode::SERVICE_UNAVAILABLE,
                "Campus IA",
                "<h1>Servicio no disponible</h1><p>Probá de nuevo en unos minutos.</p>",
                "frame-ancestors 'none'",
            )
        }
    }
}

async fn atender_interno(app: &App, id: &str, puerto: Option<&str>, req: Request) -> anyhow::Result<Response> {
    let barra = origen_de(app, id, puerto);
    let csp = format!("frame-ancestors {barra}");
    let fila = sqlx::query("SELECT estado FROM cursos WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    let Some(fila) = fila else {
        return Ok(pagina(StatusCode::NOT_FOUND, "Campus IA", "<h1>No encontrado</h1><p>Este curso no existe.</p>", &csp));
    };
    let estado: String = fila.get("estado");
    if let Some((bloqueo, cuerpo)) = crate::inhabilitar::bloqueo_enrutador(app, id, req.headers()).await? {
        return Ok(pagina(bloqueo, "Campus IA", cuerpo, &csp));
    }
    if estado == "sin_repo" {
        return Ok(crate::servidor::provisoria(app, id, puerto, req).await);
    }
    let Some(sesion) = sesion_de_cookie(app, req.headers()).await? else {
        let cuerpo = format!(
            "<h1>Tenés que iniciar sesión</h1><p><a href=\"{}/\" target=\"_top\">Entrá a Campus IA</a> para ver este curso.</p>",
            escapar_html(&barra)
        );
        return Ok(pagina(StatusCode::UNAUTHORIZED, "Campus IA", &cuerpo, &csp));
    };
    let persona = sqlx::query(&format!(
        "SELECT {} AS rol, u.email, u.nombre FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id \
         WHERE i.curso_id = ? AND i.usuario_id = ?",
        crate::cursos::ROL_EFECTIVO
    ))
    .bind(id)
    .bind(sesion.usuario_id)
    .fetch_optional(&app.db)
    .await?;
    let Some(persona) = persona else {
        return Ok(pagina(StatusCode::FORBIDDEN, "Campus IA", "<h1>Sin acceso</h1><p>No tenés acceso a este curso.</p>", &csp));
    };
    let modifica = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if modifica {
        let propio = origen_de(app, &format!("{id}-curso"), puerto);
        let origen = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if origen != Some(propio.as_str()) {
            return Ok(pagina(StatusCode::FORBIDDEN, "Campus IA", "<h1>Sin acceso</h1><p>Origen no permitido.</p>", &csp));
        }
    }
    match estado.as_str() {
        "preparando" => {
            return Ok(con_reintento(pagina(
                StatusCode::SERVICE_UNAVAILABLE,
                "Preparando el curso",
                "<h1>Preparando el curso</h1><p>Esto puede tardar unos minutos.</p>",
                &csp,
            )))
        }
        "error" => {
            return Ok(pagina(
                StatusCode::SERVICE_UNAVAILABLE,
                "Campus IA",
                "<h1>El curso no está disponible</h1><p>Hubo un problema al prepararlo.</p>",
                &csp,
            ))
        }
        _ => {}
    }
    let Some(sup) = app.supervisor.clone() else {
        return Ok(con_reintento(pagina(
            StatusCode::SERVICE_UNAVAILABLE,
            "Campus IA",
            "<h1>El curso no está disponible</h1><p>Probá de nuevo en unos minutos.</p>",
            &csp,
        )));
    };
    let _activo = sup.activo(id);
    let rol: String = persona.get("rol");
    let email: String = persona.get("email");
    let nombre: String = persona.get("nombre");
    let (partes, cuerpo) = req.into_parts();
    let demasiado_grande = || pagina(StatusCode::PAYLOAD_TOO_LARGE, "Campus IA", "<h1>Demasiado grande</h1>", &csp);
    let declarado = partes
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declarado.map(|n| n > MAXIMO_CUERPO as u64).unwrap_or(false) {
        return Ok(demasiado_grande());
    }
    let mut cuerpo = match cuerpo.size_hint().exact() {
        Some(n) if n <= MAXIMO_EN_MEMORIA as u64 => match axum::body::to_bytes(cuerpo, MAXIMO_EN_MEMORIA).await {
            Ok(b) => Cuerpo::Fijo(b),
            Err(_) => return Ok(demasiado_grande()),
        },
        _ => Cuerpo::Flujo(Some(cuerpo)),
    };
    let mut encabezados = partes.headers.clone();
    quitar_encabezados(&mut encabezados);
    for n in [header::COOKIE, header::AUTHORIZATION, header::HOST, header::CONTENT_LENGTH] {
        encabezados.remove(n);
    }
    let campus: Vec<HeaderName> = encabezados.keys().filter(|k| k.as_str().starts_with("x-campus-")).cloned().collect();
    for k in campus {
        encabezados.remove(k);
    }
    let ruta = partes.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string());
    let ruta = if ruta.starts_with('/') { ruta } else { format!("/{ruta}") };
    let mut intento = 0;
    if matches!(cuerpo, Cuerpo::Flujo(_)) {
        sup.olvidar(id);
    }
    loop {
        intento += 1;
        let ip = match sup.asegurar(id).await {
            Ok(ip) => ip,
            Err(FallaArranque::NoListo) | Err(FallaArranque::Error(_)) => {
                return Ok(con_reintento(pagina(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Campus IA",
                    "<h1>El curso se está despertando</h1><p>Probá de nuevo en unos segundos.</p>",
                    &csp,
                )))
            }
        };
        let identidad = app.identidad.firmar(
            &Persona { curso: id, usuario: sesion.usuario_id, email: &email, nombre: &nombre, rol: &rol },
            app.cfg.identidad_vigencia_seg,
        );
        let mut h = encabezados.clone();
        h.insert(HeaderName::from_static("x-campus-identidad"), HeaderValue::from_str(&identidad)?);
        let url = format!("http://{}{}", SocketAddr::new(ip, 3000), ruta);
        let reintentable = matches!(cuerpo, Cuerpo::Fijo(_));
        let pedido = app.proxy.request(partes.method.clone(), &url).headers(h).body(cuerpo.tomar());
        match pedido.send().await {
            Ok(r) if r.headers().contains_key(crate::puente::ENCABEZADO_FALLA) && intento < 2 && reintentable => {
                sup.olvidar(id);
                continue;
            }
            Ok(r) if r.headers().contains_key(crate::puente::ENCABEZADO_FALLA) => {
                sup.olvidar(id);
                return Ok(con_reintento(pagina(
                    StatusCode::BAD_GATEWAY,
                    "Campus IA",
                    "<h1>El curso no respondió</h1><p>Probá de nuevo en unos segundos.</p>",
                    &csp,
                )));
            }
            Ok(r) => return Ok(respuesta(r, &csp)),
            Err(e) if e.is_connect() && intento < 2 && reintentable => {
                sup.olvidar(id);
                continue;
            }
            Err(e) => {
                sup.olvidar(id);
                eprintln!("el curso {id} no respondió: {e}");
                return Ok(con_reintento(pagina(
                    StatusCode::BAD_GATEWAY,
                    "Campus IA",
                    "<h1>El curso no respondió</h1><p>Probá de nuevo en unos segundos.</p>",
                    &csp,
                )));
            }
        }
    }
}

pub(crate) fn respuesta(r: reqwest::Response, csp: &str) -> Response {
    let estado = r.status();
    let mut h = r.headers().clone();
    quitar_encabezados(&mut h);
    h.remove(header::SET_COOKIE);
    h.remove("set-cookie2");
    let flujo = r.bytes_stream().map_err(std::io::Error::other);
    let mut salida = Response::new(Body::from_stream(flujo));
    *salida.status_mut() = estado;
    *salida.headers_mut() = h;
    let s = salida.headers_mut();
    if let Ok(v) = HeaderValue::from_str(csp) {
        s.append(header::CONTENT_SECURITY_POLICY, v);
    }
    s.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    salida
}

pub fn cliente_proxy(socket: Option<&std::path::Path>) -> anyhow::Result<reqwest::Client> {
    let mut b = reqwest::Client::builder();
    if let Some(s) = socket {
        b = b.unix_socket(s.to_path_buf());
    }
    Ok(b
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(300))
        .build()?)
}
