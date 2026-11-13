mod censura;
mod config;
mod registro;
mod uso;

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpListener;

use censura::Censor;
use config::Config;
use registro::{Linea, Registro};
use uso::{Lector, Uso};

const MAXIMO_CUERPO: usize = 32 * 1024 * 1024;

type Cliente = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

struct Estado {
    config: Config,
    registro: Arc<Registro>,
    cliente: Cliente,
}

enum Origen {
    Destino(Incoming),
    Fijo(Option<Bytes>),
}

struct CuerpoRespuesta {
    origen: Origen,
    censor: Censor,
    lector: Lector,
    terminado: bool,
    linea: Option<Linea>,
    registro: Arc<Registro>,
}

impl Body for CuerpoRespuesta {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let este = self.get_mut();
        if este.terminado {
            return Poll::Ready(None);
        }
        match &mut este.origen {
            Origen::Fijo(datos) => {
                este.terminado = true;
                Poll::Ready(datos.take().map(|d| Ok(Frame::data(d))))
            }
            Origen::Destino(interno) => loop {
                match Pin::new(&mut *interno).poll_frame(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Some(Ok(frame))) => {
                        let Ok(datos) = frame.into_data() else { continue };
                        let salida = este.censor.procesar(&datos);
                        if salida.is_empty() {
                            continue;
                        }
                        este.lector.alimentar(&salida);
                        return Poll::Ready(Some(Ok(Frame::data(Bytes::from(salida)))));
                    }
                    Poll::Ready(Some(Err(e))) => {
                        este.terminado = true;
                        return Poll::Ready(Some(Err(e)));
                    }
                    Poll::Ready(None) => {
                        este.terminado = true;
                        let salida = este.censor.terminar();
                        if salida.is_empty() {
                            return Poll::Ready(None);
                        }
                        este.lector.alimentar(&salida);
                        return Poll::Ready(Some(Ok(Frame::data(Bytes::from(salida)))));
                    }
                }
            },
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.origen {
            Origen::Fijo(d) => d.is_none() || self.terminado,
            Origen::Destino(_) => self.terminado,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.origen {
            Origen::Fijo(Some(d)) if !self.terminado => SizeHint::with_exact(d.len() as u64),
            Origen::Fijo(_) => SizeHint::with_exact(0),
            Origen::Destino(_) => SizeHint::default(),
        }
    }
}

impl Drop for CuerpoRespuesta {
    fn drop(&mut self) {
        if let Some(mut linea) = self.linea.take() {
            self.lector.terminar();
            let pedido = linea.uso.modelo.take();
            linea.uso = self.lector.uso.clone();
            if linea.uso.modelo.is_none() {
                linea.uso.modelo = pedido;
            }
            self.registro.escribir(&linea);
        }
    }
}

fn iguales_tiempo_constante(a: &[u8], b: &[u8]) -> bool {
    let largo = a.len().max(b.len());
    let mut diferencia: u64 = (a.len() ^ b.len()) as u64;
    for i in 0..largo {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diferencia |= std::hint::black_box((x ^ y) as u64);
    }
    std::hint::black_box(diferencia) == 0
}

fn autenticar(config: &Config, headers: &HeaderMap) -> Option<String> {
    let auths: Vec<&HeaderValue> = headers.get_all(hyper::header::AUTHORIZATION).iter().collect();
    let claves: Vec<&HeaderValue> = headers.get_all("x-api-key").iter().collect();
    if auths.len() + claves.len() != 1 {
        return None;
    }
    let credencial: &[u8] = if let Some(a) = auths.first() {
        a.as_bytes().strip_prefix(b"Bearer ")?
    } else {
        claves[0].as_bytes()
    };
    if credencial.is_empty() {
        return None;
    }
    let mut hallado: Option<&str> = None;
    for curso in &config.cursos {
        if iguales_tiempo_constante(credencial, &curso.token) {
            hallado = Some(&curso.id);
        }
    }
    hallado.map(str::to_string)
}

fn ruta_peligrosa(ruta: &str) -> bool {
    let minuscula = ruta.to_ascii_lowercase();
    ["..", "//", "\\", "%2e", "%2f", "%5c"].iter().any(|p| minuscula.contains(p))
}

fn es_de_salto(nombre: &str) -> bool {
    matches!(nombre, "connection" | "keep-alive" | "te" | "trailer" | "trailers" | "transfer-encoding" | "upgrade")
        || nombre.starts_with("proxy-")
}

fn nombrados_en_connection(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn encabezados_hacia_destino(config: &Config, entrantes: &HeaderMap) -> HeaderMap {
    let extra = nombrados_en_connection(entrantes);
    let mut salida = HeaderMap::new();
    let mut betas: Vec<String> = Vec::new();
    for (nombre, valor) in entrantes {
        let n = nombre.as_str();
        if n == "anthropic-beta" {
            if let Ok(v) = valor.to_str() {
                for b in v.split(',').map(str::trim).filter(|b| !b.is_empty()) {
                    if !betas.iter().any(|x| x == b) {
                        betas.push(b.to_string());
                    }
                }
            }
            continue;
        }
        if matches!(n, "authorization" | "x-api-key" | "cookie" | "host" | "content-length" | "accept-encoding")
            || es_de_salto(n)
            || n.starts_with("x-curso")
            || n.starts_with("x-campus")
            || extra.iter().any(|e| e == n)
        {
            continue;
        }
        salida.append(nombre.clone(), valor.clone());
    }
    if !betas.iter().any(|b| b == &config.beta) {
        betas.push(config.beta.clone());
    }
    if let Ok(v) = HeaderValue::from_str(&betas.join(",")) {
        salida.insert(HeaderName::from_static("anthropic-beta"), v);
    }
    let mut auth = b"Bearer ".to_vec();
    auth.extend_from_slice(&config.token_real);
    if let Ok(mut v) = HeaderValue::from_bytes(&auth) {
        v.set_sensitive(true);
        salida.insert(hyper::header::AUTHORIZATION, v);
    }
    salida
}

fn encabezados_hacia_cliente(config: &Config, entrantes: &HeaderMap) -> HeaderMap {
    let extra = nombrados_en_connection(entrantes);
    let mut salida = HeaderMap::new();
    for (nombre, valor) in entrantes {
        let n = nombre.as_str();
        if n == "content-length" || es_de_salto(n) || extra.iter().any(|e| e == n) {
            continue;
        }
        let valor = match censura::reemplazar_todo(valor.as_bytes(), &config.token_real) {
            Some(nuevo) => match HeaderValue::from_bytes(&nuevo) {
                Ok(v) => v,
                Err(_) => continue,
            },
            None => valor.clone(),
        };
        salida.append(nombre.clone(), valor);
    }
    salida
}

fn cuerpo_error(tipo: &str, mensaje: &str) -> Bytes {
    Bytes::from(
        serde_json::json!({"type": "error", "error": {"type": tipo, "message": mensaje}}).to_string(),
    )
}

impl Estado {
    fn respuesta_fija(&self, estado: StatusCode, cuerpo: Bytes, linea: Option<Linea>) -> Response<CuerpoRespuesta> {
        let mut r = Response::new(CuerpoRespuesta {
            origen: Origen::Fijo(Some(cuerpo)),
            censor: Censor::new(self.config.token_real.clone()),
            lector: Lector::new(""),
            terminado: false,
            linea,
            registro: self.registro.clone(),
        });
        *r.status_mut() = estado;
        r.headers_mut().insert(hyper::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        r
    }

    fn error(&self, estado: StatusCode, tipo: &str, mensaje: &str, mut linea: Linea) -> Response<CuerpoRespuesta> {
        linea.estado = estado.as_u16();
        linea.reenviada = false;
        self.respuesta_fija(estado, cuerpo_error(tipo, mensaje), Some(linea))
    }
}

async fn manejar(req: Request<Incoming>, estado: Arc<Estado>) -> Result<Response<CuerpoRespuesta>, Infallible> {
    let ruta = req.uri().path().to_string();
    if ruta == "/salud" && req.method() == Method::GET {
        return Ok(estado.respuesta_fija(StatusCode::OK, Bytes::from_static(b"{\"estado\":\"ok\"}"), None));
    }
    let mut linea = Linea {
        momento: registro::ahora_iso(),
        curso: None,
        metodo: req.method().as_str().to_string(),
        ruta: ruta.clone(),
        estado: 0,
        reenviada: false,
        uso: Uso::default(),
    };
    let config = &estado.config;

    let Some(curso) = autenticar(config, req.headers()) else {
        return Ok(estado.error(StatusCode::UNAUTHORIZED, "authentication_error", "Credencial de curso ausente o inválida.", linea));
    };
    linea.curso = Some(curso);

    if ruta_peligrosa(&ruta) {
        return Ok(estado.error(StatusCode::BAD_REQUEST, "invalid_request_error", "Ruta inválida.", linea));
    }
    if !ruta.starts_with("/v1/") {
        return Ok(estado.error(StatusCode::NOT_FOUND, "not_found_error", "Ruta no permitida.", linea));
    }
    if req.method() != Method::GET && req.method() != Method::POST {
        return Ok(estado.error(StatusCode::METHOD_NOT_ALLOWED, "invalid_request_error", "Método no permitido.", linea));
    }
    let declarado = req
        .headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declarado.is_some_and(|n| n > MAXIMO_CUERPO as u64) {
        return Ok(estado.error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large", "El cuerpo supera los 32 MiB.", linea));
    }

    let consulta = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let destino: Uri = match format!("{}{}{}", config.destino, ruta, consulta).parse() {
        Ok(u) => u,
        Err(_) => return Ok(estado.error(StatusCode::BAD_REQUEST, "invalid_request_error", "Ruta inválida.", linea)),
    };
    let metodo = req.method().clone();
    let encabezados = encabezados_hacia_destino(config, req.headers());

    let cuerpo = match Limited::new(req.into_body(), MAXIMO_CUERPO).collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => {
            if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                return Ok(estado.error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large", "El cuerpo supera los 32 MiB.", linea));
            }
            return Ok(estado.error(StatusCode::BAD_REQUEST, "invalid_request_error", "No se pudo leer el cuerpo.", linea));
        }
    };
    linea.uso.modelo = uso::modelo_pedido(&cuerpo);

    let mut pedido = Request::new(Full::new(cuerpo));
    *pedido.method_mut() = metodo;
    *pedido.uri_mut() = destino;
    *pedido.headers_mut() = encabezados;

    let respuesta = match estado.cliente.request(pedido).await {
        Ok(r) => r,
        Err(_) => {
            return Ok(estado.error(StatusCode::BAD_GATEWAY, "api_error", "No se pudo contactar al destino.", linea));
        }
    };
    let (partes, interno) = respuesta.into_parts();
    linea.estado = partes.status.as_u16();
    linea.reenviada = true;
    let tipo = partes
        .headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut r = Response::new(CuerpoRespuesta {
        origen: Origen::Destino(interno),
        censor: Censor::new(config.token_real.clone()),
        lector: Lector::new(&tipo),
        terminado: false,
        linea: Some(linea),
        registro: estado.registro.clone(),
    });
    *r.status_mut() = partes.status;
    *r.headers_mut() = encabezados_hacia_cliente(config, &partes.headers);
    Ok(r)
}

fn crear_cliente() -> Cliente {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(Some(Duration::from_secs(15)));
    http.set_nodelay(true);
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .wrap_connector(http);
    Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(30))
        .build(https)
}

fn main() {
    let config = match config::cargar() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("intermediario: {e}");
            std::process::exit(1);
        }
    };
    let registro = match Registro::abrir(&config.registro) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            eprintln!("intermediario: {e}");
            std::process::exit(1);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(_) => {
            eprintln!("intermediario: no se pudo iniciar el runtime");
            std::process::exit(1);
        }
    };
    let codigo = runtime.block_on(servir(config, registro));
    std::process::exit(codigo);
}

async fn servir(config: Config, registro: Arc<Registro>) -> i32 {
    let escucha = match TcpListener::bind(config.direccion).await {
        Ok(l) => l,
        Err(_) => {
            eprintln!("intermediario: no se pudo escuchar en {}", config.direccion);
            return 1;
        }
    };
    println!(
        "intermediario escuchando en {} con {} cursos, destino {}",
        config.direccion,
        config.cursos.len(),
        config.destino
    );
    let estado = Arc::new(Estado { config, registro, cliente: crear_cliente() });
    loop {
        let (flujo, _) = match escucha.accept().await {
            Ok(c) => c,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = flujo.set_nodelay(true);
        let estado = estado.clone();
        tokio::spawn(async move {
            let servicio = service_fn(move |req| manejar(req, estado.clone()));
            let _ = http1::Builder::new()
                .max_buf_size(1024 * 1024)
                .serve_connection(TokioIo::new(flujo), servicio)
                .await;
        });
    }
}
