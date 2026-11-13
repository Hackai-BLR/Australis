use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::{Body, HttpBody};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use futures_util::TryStreamExt;
use sqlx::Row;

use crate::auth::*;
use crate::identidad::{Persona, PersonaAustralis};
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

fn cliente_australis() -> &'static reqwest::Client {
    static CLIENTE: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENTE.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(Duration::from_secs(600))
            .build()
            .expect("cliente de Australis")
    })
}

fn es_ruta_api(ruta: &str) -> bool {
    ruta == "/api" || ruta.starts_with("/api/")
}

fn rechazo_australis(api: bool, estado: StatusCode, error: ApiError, titulo: &str, cuerpo: &str) -> Response {
    if api {
        error.into_response()
    } else {
        pagina(estado, titulo, cuerpo, "frame-ancestors 'none'")
    }
}

pub async fn atender_australis(app: &App, puerto: Option<&str>, req: Request) -> Response {
    match atender_australis_interno(app, puerto, req).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error en el enrutador de Australis: {e:#}");
            pagina(
                StatusCode::SERVICE_UNAVAILABLE,
                "Campus IA",
                "<h1>Servicio no disponible</h1><p>Probá de nuevo en unos minutos.</p>",
                "frame-ancestors 'none'",
            )
        }
    }
}

async fn atender_australis_interno(app: &App, puerto: Option<&str>, req: Request) -> anyhow::Result<Response> {
    let api = es_ruta_api(req.uri().path());
    let Some(destino) = app.cfg.australis_url.as_deref() else {
        return Ok(con_reintento(rechazo_australis(
            api,
            StatusCode::SERVICE_UNAVAILABLE,
            ApiError::servicio_no_disponible(),
            "Campus IA",
            "<h1>El campus no está disponible</h1><p>Probá de nuevo en unos minutos.</p>",
        )));
    };
    let usuario = match sesion_de_cookie(app, req.headers()).await? {
        Some(sesion) => usuario_por_id(&app.db, sesion.usuario_id).await?,
        None => None,
    };
    let Some(usuario) = usuario else {
        let entrada = match puerto {
            Some(p) => format!("{}://{}:{}/", app.cfg.esquema(), app.cfg.dominio_base, p),
            None => format!("{}://{}/", app.cfg.esquema(), app.cfg.dominio_base),
        };
        let cuerpo = format!(
            "<h1>Tenés que iniciar sesión</h1><p><a href=\"{}\">Entrá a Campus IA</a> para ver el campus.</p>",
            escapar_html(&entrada)
        );
        return Ok(rechazo_australis(api, StatusCode::UNAUTHORIZED, ApiError::no_autenticado(), "Campus IA", &cuerpo));
    };
    if crate::inhabilitar::cuenta_inhabilitada(&app.db, usuario.id).await? {
        return Ok(rechazo_australis(
            api,
            StatusCode::FORBIDDEN,
            ApiError::prohibido(),
            "Campus IA",
            "<h1>Sin acceso</h1><p>Tu cuenta no tiene acceso al campus.</p>",
        ));
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        let propio = origen_de(app, crate::servidor::SUBDOMINIO_AUSTRALIS, puerto);
        let origen = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if origen != Some(propio.as_str()) {
            return Ok(rechazo_australis(
                api,
                StatusCode::FORBIDDEN,
                ApiError::origen_invalido(),
                "Campus IA",
                "<h1>Sin acceso</h1><p>Origen no permitido.</p>",
            ));
        }
    }
    let identidad = app
        .identidad
        .firmar_australis(&PersonaAustralis::de_usuario(&usuario), app.cfg.identidad_vigencia_seg);
    let cambio = cambio_de_inscriptos(req.method(), req.uri().path());
    let respuesta = reenviar_a_australis(cliente_australis(), destino, &identidad, req).await;
    if let Some(campus) = cambio {
        if respuesta.status().is_success() && crate::cursos::modulos::sincronizar_campus_externo(app, &usuario, campus).await.is_err() {
            return Ok(crate::cursos::modulos::sincronizacion_fallida_para_australis());
        }
    }
    Ok(respuesta)
}

fn cambio_de_inscriptos(metodo: &Method, ruta: &str) -> Option<i64> {
    if *metodo != Method::POST {
        return None;
    }
    let partes: Vec<&str> = ruta.trim_matches('/').split('/').collect();
    match partes.as_slice() {
        ["api", "campuses", campus, "roster", "imports", _, "confirm"]
        | ["api", "campuses", campus, "members", _, "suspend" | "reactivate" | "invite"]
        | ["api", "campuses", campus, "teachers"] => campus.parse().ok(),
        _ => None,
    }
}

pub(crate) async fn reenviar_a_australis(
    cliente: &reqwest::Client,
    destino: &str,
    identidad: &str,
    req: Request,
) -> Response {
    const CSP: &str = "frame-ancestors 'none'";
    let falla = |estado: StatusCode, cuerpo: &str| con_reintento(pagina(estado, "Campus IA", cuerpo, CSP));
    let (partes, cuerpo) = req.into_parts();
    let demasiado_grande = || pagina(StatusCode::PAYLOAD_TOO_LARGE, "Campus IA", "<h1>Demasiado grande</h1>", CSP);
    let declarado = partes
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declarado.map(|n| n > MAXIMO_CUERPO as u64).unwrap_or(false) {
        return demasiado_grande();
    }
    let mut cuerpo = match cuerpo.size_hint().exact() {
        Some(n) if n <= MAXIMO_EN_MEMORIA as u64 => match axum::body::to_bytes(cuerpo, MAXIMO_EN_MEMORIA).await {
            Ok(b) => Cuerpo::Fijo(b),
            Err(_) => return demasiado_grande(),
        },
        _ => Cuerpo::Flujo(Some(cuerpo)),
    };
    let mut encabezados = partes.headers.clone();
    quitar_encabezados(&mut encabezados);
    for n in [header::COOKIE, header::AUTHORIZATION, header::HOST, header::CONTENT_LENGTH, header::PROXY_AUTHORIZATION] {
        encabezados.remove(n);
    }
    let campus: Vec<HeaderName> = encabezados.keys().filter(|k| k.as_str().starts_with("x-campus")).cloned().collect();
    for k in campus {
        encabezados.remove(k);
    }
    let Ok(valor) = HeaderValue::from_str(identidad) else {
        return falla(StatusCode::SERVICE_UNAVAILABLE, "<h1>Servicio no disponible</h1>");
    };
    encabezados.insert(HeaderName::from_static("x-campus-identidad"), valor);
    let ruta = partes.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string());
    let ruta = if ruta.starts_with('/') { ruta } else { format!("/{ruta}") };
    let url = format!("{destino}{ruta}");
    match cliente.request(partes.method.clone(), &url).headers(encabezados).body(cuerpo.tomar()).send().await {
        Ok(r) => respuesta(r, CSP),
        Err(e) => {
            eprintln!("Australis no respondió: {e}");
            falla(StatusCode::BAD_GATEWAY, "<h1>El campus no respondió</h1><p>Probá de nuevo en unos segundos.</p>")
        }
    }
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

#[cfg(test)]
mod pruebas {
    use super::*;
    use crate::identidad::Identidad;
    use crate::servidor::{clasificar, Host};
    use axum::routing::any;
    use axum::{Json, Router};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use serde_json::{json, Value};

    const SEMILLA: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    async fn identidad() -> Identidad {
        let db = sqlx::sqlite::SqlitePool::connect("sqlite::memory:").await.unwrap();
        Identidad::cargar(&db, Some(SEMILLA)).await.unwrap()
    }

    fn usuario(owner: bool, profesor: bool, administrador: bool) -> Usuario {
        Usuario {
            id: 9,
            email: "ana@demo.test".to_string(),
            nombre: "Ana Demo".to_string(),
            universidad_id: Some(1),
            universidad_nombre: Some("Demo".to_string()),
            profesor,
            administrador,
            owner,
        }
    }

    fn verificar(identidad: &Identidad, valor: &str) -> Value {
        let (carga, firma) = valor.split_once('.').unwrap();
        let clave = VerifyingKey::from_bytes(&URL_SAFE_NO_PAD.decode(identidad.publica()).unwrap().try_into().unwrap()).unwrap();
        let firma = Signature::from_slice(&URL_SAFE_NO_PAD.decode(firma).unwrap()).unwrap();
        clave.verify(carga.as_bytes(), &firma).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(carga).unwrap()).unwrap()
    }

    async fn destino_eco() -> String {
        let eco = |req: Request| async move {
            let encabezados: serde_json::Map<String, Value> = req
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), Value::String(v.to_str().unwrap_or("").to_string())))
                .collect();
            let ruta = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
            let metodo = req.method().to_string();
            let cuerpo = axum::body::to_bytes(req.into_body(), 1024).await.unwrap();
            let mut r = Json(json!({
                "encabezados": encabezados,
                "ruta": ruta,
                "metodo": metodo,
                "cuerpo": String::from_utf8_lossy(&cuerpo),
            }))
            .into_response();
            r.headers_mut().append(header::SET_COOKIE, HeaderValue::from_static("australis_session=x; Path=/"));
            r
        };
        let escucha = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let direccion = escucha.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(escucha, Router::new().fallback(any(eco))).await.unwrap();
        });
        format!("http://{direccion}")
    }

    #[test]
    fn el_nombre_reservado_es_un_host_de_australis() {
        assert_eq!(clasificar("campus.campusia.tech", "campusia.tech"), Host::Australis);
        assert_eq!(clasificar("campus-curso.campusia.tech", "campusia.tech"), Host::Curso("campus".to_string()));
        assert_eq!(clasificar("campus.otro.tech", "campusia.tech"), Host::Ajeno);
        assert_eq!(clasificar("www.campusia.tech", "campusia.tech"), Host::Plataforma);
        assert_eq!(clasificar("campusia.tech", "campusia.tech"), Host::Plataforma);
    }

    #[tokio::test]
    async fn la_identidad_lleva_el_rol_de_la_plataforma() {
        let i = identidad().await;
        let casos = [
            (usuario(true, false, false), "dueño", false),
            (usuario(false, true, false), "profesor", false),
            (usuario(false, false, true), "alumno", false),
            (usuario(false, true, true), "profesor", false),
            (usuario(false, false, false), "alumno", false),
        ];
        for (u, rol, administrador) in casos {
            let firmada = i.firmar_australis(&PersonaAustralis::de_usuario(&u), 60);
            let carga = verificar(&i, &firmada);
            assert_eq!(carga["v"], 1);
            assert_eq!(carga["curso"], "australis");
            assert_eq!(carga["usuario"], "9");
            assert_eq!(carga["email"], "ana@demo.test");
            assert_eq!(carga["rol"], rol);
            assert_eq!(carga["administrador"], administrador);
            assert_eq!(carga["vence"].as_i64().unwrap() - carga["emitido"].as_i64().unwrap(), 60);
        }
    }

    #[tokio::test]
    async fn reenvia_sin_cookies_con_la_identidad_firmada_y_sin_cookies_de_vuelta() {
        let i = identidad().await;
        let destino = destino_eco().await;
        let firmada = i.firmar_australis(&PersonaAustralis::de_usuario(&usuario(false, true, false)), 60);
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/campuses?x=1")
            .header(header::COOKIE, "campusia_sesion=secreta")
            .header(header::AUTHORIZATION, "Bearer algo")
            .header("x-campus-identidad", "falsificada")
            .header("x-campus-otro", "1")
            .header(header::ORIGIN, "http://campus.localhost")
            .body(Body::from("hola"))
            .unwrap();
        let r = reenviar_a_australis(&reqwest::Client::new(), &destino, &firmada, req).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(!r.headers().contains_key(header::SET_COOKIE));
        let cuerpo = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let eco: Value = serde_json::from_slice(&cuerpo).unwrap();
        assert_eq!(eco["ruta"], "/api/campuses?x=1");
        assert_eq!(eco["metodo"], "POST");
        assert_eq!(eco["cuerpo"], "hola");
        let h = &eco["encabezados"];
        assert!(h.get("cookie").is_none());
        assert!(h.get("authorization").is_none());
        assert!(h.get("x-campus-otro").is_none());
        let recibida = h["x-campus-identidad"].as_str().unwrap();
        assert_ne!(recibida, "falsificada");
        assert_eq!(verificar(&i, recibida)["rol"], "profesor");
    }

    #[tokio::test]
    async fn si_australis_no_responde_devuelve_un_error_con_reintento() {
        let req = Request::builder().uri("/api/health").body(Body::empty()).unwrap();
        let r = reenviar_a_australis(&reqwest::Client::new(), "http://127.0.0.1:1", "a.b", req).await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        assert!(r.headers().contains_key(header::RETRY_AFTER));
    }

    struct CorreoMudo;

    #[async_trait::async_trait]
    impl crate::email::ProveedorDeEmail for CorreoMudo {
        async fn enviar(&self, _mail: &crate::email::Mail) -> anyhow::Result<()> {
            Ok(())
        }
    }

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";

    async fn app_con_australis(destino: &str) -> App {
        let ruta = std::env::temp_dir().join(format!("campusia-enrutador-{}.db", token_aleatorio()));
        for (k, v) in [
            ("SESSION_SECRET", "0123456789abcdef0123456789abcdef"),
            ("PROVEEDOR_EMAIL", "archivo"),
            ("ARCHIVO_EMAIL", "/dev/null"),
            ("DOMINIO_BASE", "campusia.test"),
            ("TURNSTILE_SITE_KEY", "x"),
            ("TURNSTILE_SECRET", "x"),
            ("ENTORNO", "desarrollo"),
        ] {
            std::env::set_var(k, v);
        }
        std::env::set_var("DATABASE_URL", format!("sqlite://{}", ruta.display()));
        std::env::set_var("AUSTRALIS_URL", destino);
        let cfg = crate::config::Config::desde_entorno().unwrap();
        let db = crate::db::conectar(&cfg.database_url).await.unwrap();
        crate::db::migrar(&db).await.unwrap();
        let identidad = Identidad::cargar(&db, Some(SEMILLA)).await.unwrap();
        let intermediario = std::sync::Arc::new(crate::modelo::Intermediario::nuevo(&cfg.agente).unwrap());
        App {
            cfg,
            db,
            email: Box::new(CorreoMudo),
            http: reqwest::Client::new(),
            proxy: reqwest::Client::new(),
            identidad,
            supervisor: None,
            espacios: None,
            intermediario,
        }
    }

    async fn persona_con_sesion(app: &App, email: &str) -> i64 {
        let ahora = ahora_txt();
        let id: i64 = sqlx::query_scalar("INSERT INTO usuarios (email, nombre, creado_en) VALUES (?, 'Ana', ?) RETURNING id")
            .bind(email)
            .bind(&ahora)
            .fetch_one(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sesiones (usuario_id, huella, creada_en, vence_en, ultimo_uso) VALUES (?, ?, ?, ?, ?)")
            .bind(id)
            .bind(huella(&app.cfg.session_secret, TOKEN))
            .bind(&ahora)
            .bind(fecha(en_segundos(3600)))
            .bind(&ahora)
            .execute(&app.db)
            .await
            .unwrap();
        id
    }

    fn pedido(metodo: Method, cookie: bool, origen: Option<&str>) -> Request {
        let mut b = Request::builder().method(metodo).uri("/api/campuses");
        if cookie {
            b = b.header(header::COOKIE, format!("{COOKIE}={TOKEN}"));
        }
        if let Some(o) = origen {
            b = b.header(header::ORIGIN, o);
        }
        b.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn australis_exige_sesion_origen_propio_y_cuenta_habilitada() {
        let destino = destino_eco().await;
        let app = app_con_australis(&destino).await;
        let id = persona_con_sesion(&app, "ana@demo.test").await;
        let propio = origen_de(&app, crate::servidor::SUBDOMINIO_AUSTRALIS, None);

        let sin_sesion = atender_australis(&app, None, pedido(Method::GET, false, None)).await;
        assert_eq!(sin_sesion.status(), StatusCode::UNAUTHORIZED);

        let lectura = atender_australis(&app, None, pedido(Method::GET, true, None)).await;
        assert_eq!(lectura.status(), StatusCode::OK);

        let sin_origen = atender_australis(&app, None, pedido(Method::POST, true, None)).await;
        assert_eq!(sin_origen.status(), StatusCode::FORBIDDEN);
        let ajeno = atender_australis(&app, None, pedido(Method::POST, true, Some("http://evil.test"))).await;
        assert_eq!(ajeno.status(), StatusCode::FORBIDDEN);
        let escritura = atender_australis(&app, None, pedido(Method::POST, true, Some(&propio))).await;
        assert_eq!(escritura.status(), StatusCode::OK);

        sqlx::query("UPDATE usuarios SET suspendida_en = ? WHERE id = ?")
            .bind(ahora_txt())
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
        let suspendida = atender_australis(&app, None, pedido(Method::GET, true, None)).await;
        assert_eq!(suspendida.status(), StatusCode::FORBIDDEN);

        sqlx::query("INSERT INTO universidades (id, nombre, creada_en, deshabilitada_en) VALUES (1, 'Demo', ?, ?)")
            .bind(ahora_txt())
            .bind(ahora_txt())
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("UPDATE usuarios SET suspendida_en = NULL, universidad_id = 1 WHERE id = ?")
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
        let deshabilitada = atender_australis(&app, None, pedido(Method::GET, true, None)).await;
        assert_eq!(deshabilitada.status(), StatusCode::FORBIDDEN);
    }
}
