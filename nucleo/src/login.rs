use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::auth::*;
use crate::config::ModoReautenticacion;
use crate::db::auditar;
use crate::email::{mail_de_codigo, Mail};
use crate::util::*;

pub async fn config(State(app): State<Estado>) -> Resultado {
    Ok(ok(json!({
        "dominio_base": app.cfg.dominio_base,
        "turnstile_site_key": app.cfg.turnstile_site_key,
        "reautenticacion": app.cfg.reautenticacion_modo.nombre(),
    })))
}

pub async fn contar(app: &App, tipo: &str, clave: &str) -> Result<i64, sqlx::Error> {
    let desde = hace_segundos(app.cfg.ventana_limites_seg);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM limites WHERE tipo = ? AND clave = ? AND fecha > ?")
        .bind(tipo)
        .bind(clave)
        .bind(desde)
        .fetch_one(&app.db)
        .await?;
    Ok(n)
}

pub async fn registrar(app: &App, tipo: &str, clave: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO limites (tipo, clave, fecha) VALUES (?, ?, ?)")
        .bind(tipo)
        .bind(clave)
        .bind(ahora_txt())
        .execute(&app.db)
        .await?;
    Ok(())
}

async fn limpiar_limites(app: &App) -> Result<(), sqlx::Error> {
    let limite = hace_segundos(app.cfg.ventana_limites_seg.max(1) * 2);
    sqlx::query("DELETE FROM limites WHERE fecha < ?").bind(limite).execute(&app.db).await?;
    Ok(())
}

async fn verificar_turnstile(app: &App, token: &str, ip: &str) -> Result<bool, ApiError> {
    let formulario = format!(
        "secret={}&response={}&remoteip={}",
        url::form_urlencoded::byte_serialize(app.cfg.turnstile_secret.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(ip.as_bytes()).collect::<String>(),
    );
    let r = app
        .http
        .post(&app.cfg.turnstile_verify_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .timeout(Duration::from_secs(10))
        .body(formulario)
        .send()
        .await
        .map_err(|e| {
            eprintln!("turnstile no responde: {e}");
            ApiError::servicio_no_disponible()
        })?;
    if !r.status().is_success() {
        eprintln!("turnstile respondió {}", r.status());
        return Err(ApiError::servicio_no_disponible());
    }
    let v: Value = r.json().await.map_err(|_| ApiError::servicio_no_disponible())?;
    match v.get("success").and_then(|s| s.as_bool()) {
        Some(b) => Ok(b),
        None => Err(ApiError::servicio_no_disponible()),
    }
}

async fn control_turnstile(app: &App, ip: &str, cuerpo: &Map<String, Value>, forzar: bool) -> Result<(), ApiError> {
    let umbral = app.cfg.umbral_turnstile;
    let pedidos = contar(app, "codigo_ip", ip).await?;
    let fallos = contar(app, "fallo_ip", ip).await?;
    if !forzar && pedidos < umbral && fallos < umbral {
        return Ok(());
    }
    let token = match cuerpo.get("turnstile").and_then(|v| v.as_str()).map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return Err(ApiError::turnstile_requerido(&app.cfg.turnstile_site_key)),
    };
    if token.len() > 4096 {
        return Err(ApiError::turnstile_invalido());
    }
    if verificar_turnstile(app, &token, ip).await? {
        Ok(())
    } else {
        Err(ApiError::turnstile_invalido())
    }
}

pub async fn enviar_mail(app: &App, mail: &Mail, tipo: &str) -> Result<(), ApiError> {
    if let Err(e) = app.email.enviar(mail).await {
        eprintln!("no se pudo enviar el mail: {e:#}");
        return Err(ApiError::servicio_no_disponible());
    }
    sqlx::query("INSERT INTO emails_enviados (tipo, fecha) VALUES (?, ?)")
        .bind(tipo)
        .bind(ahora_txt())
        .execute(&app.db)
        .await?;
    Ok(())
}

fn huella_solicitud(app: &App, datos: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match datos.get("solicitud") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s))
            if (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(Some(huella(&app.cfg.session_secret, &format!("solicitud:{s}"))))
        }
        _ => Err(ApiError::datos_invalidos()),
    }
}

async fn emitir_codigo(
    app: &App,
    email: &str,
    proposito: &str,
    sesion_id: Option<i64>,
    solicitud: Option<&str>,
    ip: &str,
) -> Result<(), ApiError> {
    let codigo = codigo_aleatorio();
    let h = huella(&app.cfg.session_secret, &format!("{email}:{proposito}:{codigo}"));
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "UPDATE codigos_login SET anulado = 1 WHERE email = ? AND proposito = ? AND usado = 0 AND anulado = 0 \
         AND solicitud IS ? AND sesion_id IS ?",
    )
    .bind(email)
    .bind(proposito)
    .bind(solicitud)
    .bind(sesion_id)
    .execute(&mut *tx)
    .await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO codigos_login (email, proposito, sesion_id, huella, vence_en, creado_en, ip, solicitud) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(email)
    .bind(proposito)
    .bind(sesion_id)
    .bind(&h)
    .bind(fecha(en_segundos(app.cfg.codigo_vigencia_seg)))
    .bind(ahora_txt())
    .bind(ip)
    .bind(solicitud)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let mail = mail_de_codigo(email, &codigo, proposito == "reautenticacion");
    if let Err(e) = enviar_mail(app, &mail, proposito).await {
        sqlx::query("UPDATE codigos_login SET anulado = 1 WHERE id = ?").bind(id).execute(&app.db).await?;
        return Err(e);
    }
    Ok(())
}

static ENVIOS: std::sync::Mutex<(f64, bool)> = std::sync::Mutex::new((0.0, false));

pub async fn cargar_envios(db: &sqlx::SqlitePool, inicial_ms: u64) -> Result<(), sqlx::Error> {
    let guardado: Option<(f64, i64)> =
        sqlx::query_as("SELECT media_seg, fallo FROM envios_codigo WHERE id = 1").fetch_optional(db).await?;
    let valor = match guardado {
        Some((media, fallo)) if media.is_finite() && media > 0.0 => (media.min(20.0), fallo != 0),
        _ => (inicial_ms as f64 / 1000.0, false),
    };
    if let Ok(mut e) = ENVIOS.lock() {
        *e = valor;
    }
    Ok(())
}

fn registrar_envio(app: &App, duracion: Duration, fallo: bool) {
    let segundos = duracion.as_secs_f64().min(20.0);
    let valor = match ENVIOS.lock() {
        Ok(mut e) => {
            e.0 = if e.0 == 0.0 { segundos } else { e.0 * 0.7 + segundos * 0.3 };
            e.1 = fallo;
            *e
        }
        Err(_) => return,
    };
    let db = app.db.clone();
    tokio::spawn(async move { guardar_envios(&db, valor).await });
}

async fn guardar_envios(db: &sqlx::SqlitePool, valor: (f64, bool)) {
    let r = sqlx::query(
        "INSERT INTO envios_codigo (id, media_seg, fallo, actualizado_en) VALUES (1, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET media_seg = excluded.media_seg, fallo = excluded.fallo, actualizado_en = excluded.actualizado_en",
    )
    .bind(valor.0)
    .bind(valor.1 as i64)
    .bind(ahora_txt())
    .execute(db)
    .await;
    if let Err(e) = r {
        eprintln!("no se pudo guardar el tiempo de envío de códigos: {e}");
    }
}

async fn simular_envio() -> Result<(), ApiError> {
    use rand::Rng;
    let (media, fallo) = ENVIOS.lock().map(|e| *e).unwrap_or((0.0, false));
    let factor = rand::rngs::OsRng.gen_range(0.85..1.15);
    tokio::time::sleep(Duration::from_secs_f64(media * factor)).await;
    if fallo {
        return Err(ApiError::servicio_no_disponible());
    }
    Ok(())
}

async fn puede_recibir_codigo(app: &App, email: &str) -> Result<bool, sqlx::Error> {
    if !crate::inhabilitar::login_permitido(&app.db, email).await? {
        return Ok(false);
    }
    let dominio: Option<i64> = sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?")
        .bind(dominio_de(email))
        .fetch_optional(&app.db)
        .await?;
    if dominio.is_some() {
        return Ok(true);
    }
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner FROM usuarios WHERE email = ?")
        .bind(email)
        .fetch_optional(&app.db)
        .await?;
    Ok(owner == Some(1))
}

pub async fn pedir_codigo(State(app): State<Estado>, Ip(ip): Ip, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let email = texto_de(&datos, "email").and_then(normalizar_email).ok_or_else(ApiError::email_invalido)?;
    let solicitud = huella_solicitud(&app, &datos)?;
    limpiar_limites(&app).await?;
    let limite = app.cfg.limite_codigos_email;
    let email_ip = format!("{email}|{ip}");
    if contar(&app, "codigo_ip", &ip).await? >= app.cfg.limite_codigos_ip
        || contar(&app, "codigo_email_ip", &email_ip).await? >= limite
    {
        return Err(ApiError::demasiados_intentos());
    }
    let muchos_para_el_mail = contar(&app, "codigo_email", &email).await? >= limite;
    control_turnstile(&app, &ip, &datos, muchos_para_el_mail).await?;
    registrar(&app, "codigo_ip", &ip).await?;
    registrar(&app, "codigo_email", &email).await?;
    registrar(&app, "codigo_email_ip", &email_ip).await?;
    if puede_recibir_codigo(&app, &email).await? {
        let inicio = std::time::Instant::now();
        let r = emitir_codigo(&app, &email, "login", None, solicitud.as_deref(), &ip).await;
        registrar_envio(&app, inicio.elapsed(), r.is_err());
        r?;
    } else {
        simular_envio().await?;
    }
    Ok(ok(json!({"ok": true})))
}

enum Comprobacion {
    Valido,
    Invalido,
}

async fn comprobar_codigo(
    app: &App,
    email: &str,
    proposito: &str,
    sesion_id: Option<i64>,
    solicitud: Option<&str>,
    codigo: &str,
) -> Result<Comprobacion, ApiError> {
    let formato = codigo.len() == 6 && codigo.bytes().all(|b| b.is_ascii_digit());
    let fila = sqlx::query(
        "SELECT id, huella, intentos, sesion_id FROM codigos_login WHERE email = ? AND proposito = ? AND usado = 0 AND anulado = 0 \
         AND vence_en > ? AND solicitud IS ? ORDER BY id DESC LIMIT 1",
    )
    .bind(email)
    .bind(proposito)
    .bind(ahora_txt())
    .bind(solicitud)
    .fetch_optional(&app.db)
    .await?;
    let Some(f) = fila else { return Ok(Comprobacion::Invalido) };
    let id: i64 = f.get("id");
    let guardada: String = f.get("huella");
    let de_sesion: Option<i64> = f.get("sesion_id");
    let misma_sesion = proposito == "login" || (sesion_id.is_some() && de_sesion == sesion_id);
    let coincide = formato && iguales(&huella(&app.cfg.session_secret, &format!("{email}:{proposito}:{codigo}")), &guardada);
    if coincide && misma_sesion {
        let r = sqlx::query("UPDATE codigos_login SET usado = 1 WHERE id = ? AND usado = 0 AND anulado = 0")
            .bind(id)
            .execute(&app.db)
            .await?;
        if r.rows_affected() == 1 {
            return Ok(Comprobacion::Valido);
        }
        return Ok(Comprobacion::Invalido);
    }
    if misma_sesion {
        sqlx::query("UPDATE codigos_login SET intentos = intentos + 1, anulado = CASE WHEN intentos + 1 >= 5 THEN 1 ELSE anulado END WHERE id = ?")
            .bind(id)
            .execute(&app.db)
            .await?;
    }
    Ok(Comprobacion::Invalido)
}

pub async fn verificar(State(app): State<Estado>, Ip(ip): Ip, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    control_turnstile(&app, &ip, &datos, false).await?;
    let solicitud = huella_solicitud(&app, &datos)?;
    let email = texto_de(&datos, "email").and_then(normalizar_email);
    let codigo = texto_de(&datos, "codigo").unwrap_or("").to_string();
    let resultado = match &email {
        Some(e) => comprobar_codigo(&app, e, "login", None, solicitud.as_deref(), &codigo).await?,
        None => Comprobacion::Invalido,
    };
    let (Comprobacion::Valido, Some(email)) = (resultado, email) else {
        registrar(&app, "fallo_ip", &ip).await?;
        return Err(ApiError::codigo_invalido());
    };
    if !crate::inhabilitar::login_permitido(&app.db, &email).await? {
        registrar(&app, "fallo_ip", &ip).await?;
        return Err(ApiError::codigo_invalido());
    }
    let ahora = ahora_txt();
    let usuario = match usuario_por_email(&app.db, &email).await? {
        Some(u) => u,
        None => {
            let uni: Option<i64> = sqlx::query_scalar("SELECT universidad_id FROM dominios WHERE dominio = ?")
                .bind(dominio_de(&email))
                .fetch_optional(&app.db)
                .await?;
            let Some(uni) = uni else {
                registrar(&app, "fallo_ip", &ip).await?;
                return Err(ApiError::codigo_invalido());
            };
            sqlx::query("INSERT OR IGNORE INTO usuarios (email, nombre, universidad_id, creado_en) VALUES (?, ?, ?, ?)")
                .bind(&email)
                .bind(nombre_desde_email(&email))
                .bind(uni)
                .bind(&ahora)
                .execute(&app.db)
                .await?;
            usuario_por_email(&app.db, &email).await?.ok_or_else(ApiError::servicio_no_disponible)?
        }
    };
    sqlx::query("UPDATE usuarios SET pendiente = 0, ultimo_ingreso = ? WHERE id = ?")
        .bind(&ahora)
        .bind(usuario.id)
        .execute(&app.db)
        .await?;
    if let Some(anterior) = sesion_de_cookie(&app, &encabezados).await? {
        sqlx::query("UPDATE sesiones SET revocada = 1 WHERE id = ?").bind(anterior.id).execute(&app.db).await?;
    }
    let privilegiada = usuario.administrador || usuario.owner;
    let duracion = if privilegiada { app.cfg.sesion_privilegiada_seg } else { app.cfg.sesion_comun_seg };
    let token = token_aleatorio();
    let agente = encabezados
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(300).collect::<String>());
    let reautenticada = match app.cfg.reautenticacion_modo {
        ModoReautenticacion::Sesion => Some(ahora.clone()),
        ModoReautenticacion::Codigo => None,
    };
    sqlx::query(
        "INSERT INTO sesiones (usuario_id, huella, creada_en, vence_en, reautenticada_en, ip, agente, ultimo_uso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(usuario.id)
    .bind(huella(&app.cfg.session_secret, &token))
    .bind(&ahora)
    .bind(fecha(en_segundos(duracion)))
    .bind(reautenticada)
    .bind(&ip)
    .bind(agente)
    .bind(&ahora)
    .execute(&app.db)
    .await?;
    auditar(&app.db, usuario.universidad_id, Some(usuario.id), "login", &format!("Ingreso de {}", usuario.email), Some(&ip))
        .await?;
    Ok(con_cookie(ok(json!({"usuario": usuario.json()})), cookie_sesion(&app.cfg, &token, duracion)))
}

pub async fn reautenticacion_codigo(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let sesion = ctx.solo_sesion()?;
    solo_modo_codigo(&app)?;
    let email = ctx.usuario.email.clone();
    let clave = ctx.usuario.id.to_string();
    if contar(&app, "codigo_reautenticacion", &clave).await? >= app.cfg.limite_codigos_email {
        return Err(ApiError::demasiados_intentos());
    }
    registrar(&app, "codigo_reautenticacion", &clave).await?;
    emitir_codigo(&app, &email, "reautenticacion", Some(sesion), None, &ctx.ip).await?;
    Ok(ok(json!({"ok": true})))
}

pub async fn reautenticacion_verificar(
    State(app): State<Estado>,
    ctx: Ctx,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let sesion = ctx.solo_sesion()?;
    solo_modo_codigo(&app)?;
    let datos = cuerpo_json(&encabezados, &cuerpo)?;
    let codigo = texto_de(&datos, "codigo").unwrap_or("").to_string();
    match comprobar_codigo(&app, &ctx.usuario.email, "reautenticacion", Some(sesion), None, &codigo).await? {
        Comprobacion::Valido => {
            let ahora = ahora();
            sqlx::query("UPDATE sesiones SET reautenticada_en = ? WHERE id = ?")
                .bind(fecha(ahora))
                .bind(sesion)
                .execute(&app.db)
                .await?;
            let hasta = ahora + chrono::Duration::seconds(app.cfg.reautenticacion_seg);
            Ok(ok(json!({"reautenticada_hasta": fecha(hasta)})))
        }
        Comprobacion::Invalido => Err(ApiError::codigo_invalido()),
    }
}

fn solo_modo_codigo(app: &App) -> Result<(), ApiError> {
    match app.cfg.reautenticacion_modo {
        ModoReautenticacion::Codigo => Ok(()),
        ModoReautenticacion::Sesion => Err(ApiError::no_encontrado()),
    }
}
