use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use http_body::Frame;
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use serde_json::json;
use tower_service::Service;

use crate::auth::Estado;
use crate::config::Config;
use crate::servidor::{clasificar, separar_host, Host};
use crate::util::ApiError;

const VENTANA: Duration = Duration::from_secs(60);

pub struct Limitador {
    ventanas: Mutex<HashMap<String, (Instant, u64)>>,
}

impl Limitador {
    fn nuevo() -> Limitador {
        Limitador { ventanas: Mutex::new(HashMap::new()) }
    }

    pub fn contar(&self, clave: &str, maximo: u64) -> Result<(), ApiError> {
        let ahora = Instant::now();
        let mut v = self.ventanas.lock().unwrap_or_else(|e| e.into_inner());
        if v.len() > 20_000 {
            v.retain(|_, (inicio, _)| ahora.duration_since(*inicio) < VENTANA);
        }
        let entrada = v.entry(clave.to_string()).or_insert((ahora, 0));
        if ahora.duration_since(entrada.0) >= VENTANA {
            *entrada = (ahora, 0);
        }
        if entrada.1 >= maximo {
            let resta = VENTANA.saturating_sub(ahora.duration_since(entrada.0)).as_secs().max(1);
            let mut e = ApiError::demasiados_intentos();
            e.extra = Some(("reintentar_en", json!(resta)));
            return Err(e);
        }
        entrada.1 += 1;
        Ok(())
    }
}

static LIMITE_API: LazyLock<Limitador> = LazyLock::new(Limitador::nuevo);
static LIMITE_CURSOS: LazyLock<Limitador> = LazyLock::new(Limitador::nuevo);

pub fn limitar_api(cfg: &Config, clave: &str) -> Result<(), ApiError> {
    LIMITE_API.contar(clave, cfg.limite_api_minuto)
}

pub fn limitar_curso(cfg: &Config, curso: &str) -> Result<(), ApiError> {
    LIMITE_CURSOS.contar(curso, cfg.limite_api_curso_minuto)
}

pub fn cuerpo_demasiado_grande() -> ApiError {
    ApiError::nuevo(StatusCode::PAYLOAD_TOO_LARGE, "cuerpo_demasiado_grande", "El pedido es demasiado grande.")
}

const DRENAJE_MAXIMO: u64 = 16 * 1024 * 1024;

fn es_subida(metodo: &axum::http::Method, ruta: &str) -> bool {
    let partes: Vec<&str> = ruta.split('/').collect();
    metodo == axum::http::Method::POST
        && (matches!(partes.as_slice(), ["", "api", "cursos", _, "archivos"]) || partes.as_slice() == ["", "api", "curso", "archivos"])
}

fn limite_de(cfg: &Config, metodo: &axum::http::Method, ruta: &str) -> u64 {
    if es_subida(metodo, ruta) {
        return cfg.archivos_max_bytes;
    }
    let partes: Vec<&str> = ruta.split('/').collect();
    if matches!(partes.as_slice(), ["", "api", "cursos", _, "inscriptos", "siu"] | ["", "api", "curso", "acciones", "inscriptos", "siu"]) {
        return 4 * 1024 * 1024;
    }
    cfg.limite_cuerpo_json as u64
}

fn declarado(req: &Request) -> Option<u64> {
    req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok())
}

async fn rechazar_grande(req: Request, n: u64) -> Response {
    let subida = es_subida(req.method(), req.uri().path());
    if n <= DRENAJE_MAXIMO {
        let mut flujo = req.into_body().into_data_stream();
        let _ = tokio::time::timeout(Duration::from_secs(15), async {
            use futures_util::StreamExt;
            while let Some(Ok(_)) = flujo.next().await {}
        })
        .await;
    }
    let mut r = if subida { crate::archivos::archivo_demasiado_grande() } else { cuerpo_demasiado_grande() }.into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}

fn cerrar_si_grande(r: &mut Response) {
    if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
        r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
}

fn es_json(r: &Response) -> bool {
    r.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("application/json"))
        .unwrap_or(false)
}

fn csp_plataforma(app: &Estado, puerto: Option<&str>) -> String {
    let marcos = match puerto {
        Some(p) => format!("{}://*.{}:{}", app.cfg.esquema(), app.cfg.dominio_base, p),
        None => format!("{}://*.{}", app.cfg.esquema(), app.cfg.dominio_base),
    };
    format!(
        "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src {marcos} https://challenges.cloudflare.com; \
         object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )
}

async fn capa_principal(State(app): State<Estado>, req: Request, next: Next) -> Response {
    let crudo = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()))
        .unwrap_or_default();
    let (nombre, puerto) = separar_host(&crudo);
    let host = clasificar(&nombre, &app.cfg.dominio_base);
    let ruta = req.uri().path().to_string();
    let api = ruta == "/api" || ruta.starts_with("/api/");
    let excedido = match declarado(&req) {
        Some(n) if host == Host::Plataforma && api && n > limite_de(&app.cfg, req.method(), &ruta) => Some(n),
        _ => None,
    };
    let mut r = match excedido {
        Some(n) => rechazar_grande(req, n).await,
        None => next.run(req).await,
    };
    if host == Host::Plataforma {
        if api && r.status() == StatusCode::PAYLOAD_TOO_LARGE && !es_json(&r) {
            r = cuerpo_demasiado_grande().into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        }
        let html = r
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().starts_with("text/html"))
            .unwrap_or(false);
        if html {
            let h = r.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&csp_plataforma(&app, puerto.as_deref())) {
                h.insert(header::CONTENT_SECURITY_POLICY, v);
            }
            h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
            h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            h.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
            h.insert(
                "permissions-policy",
                HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
            );
        }
    }
    cerrar_si_grande(&mut r);
    if !app.cfg.desarrollo {
        r.headers_mut().insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    r
}

async fn capa_cursos(State(app): State<Estado>, req: Request, next: Next) -> Response {
    let ruta = req.uri().path().to_string();
    let mut r = match declarado(&req) {
        Some(n) if n > limite_de(&app.cfg, req.method(), &ruta) => rechazar_grande(req, n).await,
        _ => next.run(req).await,
    };
    if r.status() == StatusCode::PAYLOAD_TOO_LARGE && !es_json(&r) {
        r = cuerpo_demasiado_grande().into_response();
    }
    cerrar_si_grande(&mut r);
    r
}

pub fn principal(rutas: Router, app: Estado) -> Router {
    let limite = app.cfg.limite_cuerpo_json;
    rutas.layer(DefaultBodyLimit::max(limite)).layer(middleware::from_fn_with_state(app, capa_principal))
}

pub fn cursos(rutas: Router, app: &Estado) -> Router {
    rutas.layer(DefaultBodyLimit::max(app.cfg.limite_cuerpo_json)).layer(middleware::from_fn_with_state(app.clone(), capa_cursos))
}

struct ConPlazo {
    interno: Incoming,
    plazo: Pin<Box<tokio::time::Sleep>>,
}

impl http_body::Body for ConPlazo {
    type Data = Bytes;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.interno.is_end_stream() {
            return Poll::Ready(None);
        }
        if self.plazo.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err("se agotó el tiempo para recibir el cuerpo".into())));
        }
        Pin::new(&mut self.interno).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.interno.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.interno.size_hint()
    }
}

#[derive(Clone, Copy)]
pub struct Tiempos {
    encabezados: Duration,
    cuerpo: Duration,
}

impl Tiempos {
    pub fn de(cfg: &Config) -> Tiempos {
        Tiempos {
            encabezados: Duration::from_secs(cfg.tiempo_espera_encabezados_seg),
            cuerpo: Duration::from_secs(cfg.tiempo_espera_cuerpo_seg),
        }
    }
}

fn atender<IO>(io: IO, rutas: Router, remota: Option<SocketAddr>, t: Tiempos, apagado: &GracefulShutdown)
where
    IO: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let servicio = hyper::service::service_fn(move |req: hyper::Request<Incoming>| {
        let mut req = req.map(|b| Body::new(ConPlazo { interno: b, plazo: Box::pin(tokio::time::sleep(t.cuerpo)) }));
        if let Some(a) = remota {
            req.extensions_mut().insert(ConnectInfo(a));
        }
        let mut r = rutas.clone();
        async move { r.call(req).await }
    });
    let conexion = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(t.encabezados)
        .serve_connection(TokioIo::new(io), servicio);
    let conexion = apagado.watch(conexion);
    tokio::spawn(async move {
        let _ = conexion.await;
    });
}

pub async fn servir_tcp<F>(escucha: tokio::net::TcpListener, rutas: Router, t: Tiempos, fin: F) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send,
{
    let apagado = GracefulShutdown::new();
    tokio::pin!(fin);
    loop {
        tokio::select! {
            r = escucha.accept() => match r {
                Ok((io, remota)) => {
                    let _ = io.set_nodelay(true);
                    atender(io, rutas.clone(), Some(remota), t, &apagado);
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            _ = &mut fin => break,
        }
    }
    drop(escucha);
    let _ = tokio::time::timeout(Duration::from_secs(10), apagado.shutdown()).await;
    Ok(())
}

pub async fn servir_unix(escucha: tokio::net::UnixListener, rutas: Router, t: Tiempos) -> std::io::Result<()> {
    let apagado = GracefulShutdown::new();
    loop {
        match escucha.accept().await {
            Ok((io, _)) => atender(io, rutas.clone(), None, t, &apagado),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}
