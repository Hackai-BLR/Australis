use std::net::SocketAddr;
use std::time::Duration;

use axum::body::HttpBody;
use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use sqlx::Row;

use crate::auth::*;
use crate::enrutador::{con_reintento, origen_de, pagina, quitar_encabezados, respuesta, Cuerpo, MAXIMO_CUERPO, MAXIMO_EN_MEMORIA};
use crate::identidad::Persona;
use crate::util::*;

fn preparando(csp: &str) -> Response {
    con_reintento(pagina(
        StatusCode::SERVICE_UNAVAILABLE,
        "Preparando la versión de prueba",
        "<h1>Preparando la versión de prueba</h1><p>Esto puede tardar unos minutos.</p>",
        csp,
    ))
}

pub async fn atender(app: &App, id: &str, puerto: Option<&str>, req: Request) -> Response {
    match atender_interno(app, id, puerto, req).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error en el enrutador de prueba de {id}: {e:#}");
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
    let estado: Option<String> = sqlx::query_scalar("SELECT estado FROM cursos WHERE id = ?").bind(id).fetch_optional(&app.db).await?;
    let estado = match estado {
        Some(e) if e != "sin_repo" => e,
        _ => return Ok(pagina(StatusCode::NOT_FOUND, "Campus IA", "<h1>No encontrado</h1>", &csp)),
    };
    if let Some((bloqueo, cuerpo)) = crate::inhabilitar::bloqueo_enrutador(app, id, req.headers()).await? {
        return Ok(pagina(bloqueo, "Campus IA", cuerpo, &csp));
    }
    let Some(sesion) = sesion_de_cookie(app, req.headers()).await? else {
        let cuerpo = format!(
            "<h1>Tenés que iniciar sesión</h1><p><a href=\"{}/\" target=\"_top\">Entrá a Campus IA</a> para ver la versión de prueba.</p>",
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
    let persona = match persona {
        Some(p) if p.get::<String, _>("rol") != "alumno" => p,
        _ => return Ok(pagina(StatusCode::FORBIDDEN, "Campus IA", "<h1>Sin acceso</h1><p>No tenés acceso a esta versión.</p>", &csp)),
    };
    let modifica = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if modifica {
        let propio = origen_de(app, &format!("{id}-prueba"), puerto);
        let origen = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if origen != Some(propio.as_str()) {
            return Ok(pagina(StatusCode::FORBIDDEN, "Campus IA", "<h1>Sin acceso</h1><p>Origen no permitido.</p>", &csp));
        }
    }
    if estado != "listo" {
        return Ok(con_reintento(pagina(
            StatusCode::SERVICE_UNAVAILABLE,
            "Campus IA",
            "<h1>El curso no está disponible</h1><p>Probá de nuevo en unos minutos.</p>",
            &csp,
        )));
    }
    let Some(esp) = app.espacios.clone() else { return Ok(preparando(&csp)) };
    let _activo = esp.activo(id);
    let Some(ip) = esp.esperar_listo(id, Duration::from_secs(esp.cfg.espera_prueba_seg as u64)).await else {
        return Ok(preparando(&csp));
    };
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
    for n in [header::COOKIE, header::AUTHORIZATION, header::HOST, header::CONTENT_LENGTH, header::PROXY_AUTHORIZATION] {
        encabezados.remove(n);
    }
    let campus: Vec<HeaderName> = encabezados.keys().filter(|k| k.as_str().starts_with("x-campus")).cloned().collect();
    for k in campus {
        encabezados.remove(k);
    }
    let identidad = app.identidad.firmar(
        &Persona { curso: id, usuario: sesion.usuario_id, email: &email, nombre: &nombre, rol: &rol },
        app.cfg.identidad_vigencia_seg,
    );
    encabezados.insert(HeaderName::from_static("x-campus-identidad"), HeaderValue::from_str(&identidad)?);
    let ruta = partes.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string());
    let ruta = if ruta.starts_with('/') { ruta } else { format!("/{ruta}") };
    let url = format!("http://{}{}", SocketAddr::new(ip, 3000), ruta);
    let pedido = esp.proxy_http.request(partes.method.clone(), &url).headers(encabezados).body(cuerpo.tomar());
    match pedido.send().await {
        Ok(r) if r.headers().contains_key(crate::puente::ENCABEZADO_FALLA) => {
            esp.olvidar(id);
            Ok(preparando(&csp))
        }
        Ok(r) => Ok(respuesta(r, &csp)),
        Err(e) => {
            esp.olvidar(id);
            if e.is_connect() {
                return Ok(preparando(&csp));
            }
            Ok(con_reintento(pagina(
                StatusCode::BAD_GATEWAY,
                "Campus IA",
                "<h1>La versión de prueba no respondió</h1><p>Probá de nuevo en unos segundos.</p>",
                &csp,
            )))
        }
    }
}
