use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Method, Request};
use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use tower_service::Service;

use crate::auth::{App, Estado, COOKIE};
use crate::util::*;

struct CorreoMudo;

#[async_trait::async_trait]
impl crate::email::ProveedorDeEmail for CorreoMudo {
    async fn enviar(&self, _mail: &crate::email::Mail) -> anyhow::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct Registro {
    identidades: Vec<Value>,
    textos: Vec<String>,
    confirmaciones: usize,
    creados: usize,
    miembros: Vec<Value>,
    listado_roto: bool,
    primer_listado_lento: bool,
    listados: usize,
}

type Compartido = Arc<Mutex<Registro>>;

fn carga(encabezados: &axum::http::HeaderMap) -> Value {
    let h = encabezados.get("x-campus-identidad").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let c = h.split('.').next().unwrap_or_default();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(c).unwrap_or_default()).unwrap_or(Value::Null)
}

async fn australis_falso() -> (String, Compartido) {
    let registro: Compartido = Arc::new(Mutex::new(Registro::default()));
    let r1 = registro.clone();
    let r2 = registro.clone();
    let r3 = registro.clone();
    let r4 = registro.clone();
    let r5 = registro.clone();
    let r6 = registro.clone();
    let r7 = registro.clone();
    let app = Router::new()
        .route("/api/campus-templates", get(|| async { Json(json!([{"key": "basico"}])) }))
        .route(
            "/api/campuses",
            get(move |h: axum::http::HeaderMap| {
                let r = r7.clone();
                async move {
                    let quien = carga(&h);
                    let mut r = r.lock().unwrap();
                    r.listados += 1;
                    let rol = r.miembros.iter().find(|m| m["email"] == quien["email"] && m["status"] == "active").map(|m| m["role"].clone());
                    match rol {
                        Some(rol) => Json(json!([{"id": 7, "name": "Campus", "member_role": rol}])),
                        None => Json(json!([])),
                    }
                }
            })
            .post(move |h: axum::http::HeaderMap, Json(c): Json<Value>| {
                let r = r1.clone();
                async move {
                    let mut r = r.lock().unwrap();
                    let quien = carga(&h);
                    r.identidades.push(quien.clone());
                    r.creados += 1;
                    assert_eq!(c["template_key"], "basico");
                    r.miembros.push(json!({"email": quien["email"], "full_name": "Profe", "role": "professor", "status": "active"}));
                    (axum::http::StatusCode::CREATED, Json(json!({"id": 7})))
                }
            }),
        )
        .route(
            "/api/campuses/7/roster/imports",
            post(move |Json(c): Json<Value>| {
                let r = r2.clone();
                async move {
                    let texto = c["text"].as_str().unwrap().to_string();
                    let mut r = r.lock().unwrap();
                    for linea in texto.lines() {
                        let (nombre, email) = linea.split_once(';').unwrap();
                        r.miembros.push(json!({"email": email, "full_name": nombre, "role": "student", "status": "active"}));
                    }
                    r.textos.push(texto);
                    (axum::http::StatusCode::CREATED, Json(json!({"id": 1})))
                }
            }),
        )
        .route(
            "/api/campuses/7/roster/imports/1/confirm",
            post(move || {
                let r = r3.clone();
                async move {
                    r.lock().unwrap().confirmaciones += 1;
                    Json(json!({"created": 1}))
                }
            }),
        )
        .route(
            "/api/campuses/7/members",
            get(move || {
                let r = r4.clone();
                async move {
                    let (lento, miembros) = {
                        let mut r = r.lock().unwrap();
                        if r.listado_roto {
                            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(Value::Null));
                        }
                        r.listados += 1;
                        (r.primer_listado_lento && r.listados == 1, r.miembros.clone())
                    };
                    if lento {
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    }
                    (axum::http::StatusCode::OK, Json(Value::Array(miembros)))
                }
            }),
        )
        .route(
            "/api/campuses/7/members/{uid}/{accion}",
            post(move |Path((uid, accion)): Path<(usize, String)>| {
                let r = r5.clone();
                async move {
                    let mut r = r.lock().unwrap();
                    match accion.as_str() {
                        "suspend" => r.miembros[uid]["status"] = json!("suspended"),
                        "reactivate" => r.miembros[uid]["status"] = json!("active"),
                        _ => {}
                    }
                    Json(json!({"ok": true}))
                }
            }),
        )
        .route(
            "/api/campuses/7/teachers",
            post(move |Json(c): Json<Value>| {
                let r = r6.clone();
                async move {
                    r.lock().unwrap().miembros.push(json!({"email": c["email"], "full_name": "Invitada", "role": "guest", "status": "active"}));
                    (axum::http::StatusCode::CREATED, Json(json!({"ok": true})))
                }
            }),
        );
    let escucha = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let direccion = escucha.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(escucha, app).await.unwrap();
    });
    (format!("http://{direccion}"), registro)
}

async fn nueva_app(australis: Option<String>) -> Estado {
    let ruta = std::env::temp_dir().join(format!("campusia-modulos-{}.db", token_aleatorio()));
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
    let mut cfg = crate::config::Config::desde_entorno().unwrap();
    cfg.database_url = format!("sqlite://{}", ruta.display());
    cfg.australis_url = australis;
    let db = crate::db::conectar(&cfg.database_url).await.unwrap();
    crate::db::migrar(&db).await.unwrap();
    let identidad =
        crate::identidad::Identidad::cargar(&db, Some("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).await.unwrap();
    let intermediario = Arc::new(crate::modelo::Intermediario::nuevo(&cfg.agente).unwrap());
    Arc::new(App {
        cfg,
        db,
        email: Box::new(CorreoMudo),
        http: reqwest::Client::new(),
        proxy: reqwest::Client::new(),
        identidad,
        supervisor: None,
        espacios: None,
        intermediario,
    })
}

async fn universidad(app: &App, dominio: &str) -> i64 {
    let id: i64 = sqlx::query_scalar("INSERT INTO universidades (nombre, creada_en) VALUES (?, ?) RETURNING id")
        .bind(format!("Univ {dominio}"))
        .bind(ahora_txt())
        .fetch_one(&app.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dominios (dominio, universidad_id) VALUES (?, ?)")
        .bind(dominio)
        .bind(id)
        .execute(&app.db)
        .await
        .unwrap();
    id
}

async fn sesion(app: &App, usuario: i64) -> String {
    let token: String = format!("s{usuario}x{}", token_aleatorio().replace(['-', '_'], "a")).chars().chain("0".repeat(40).chars()).take(40).collect();
    let ahora = ahora_txt();
    sqlx::query("INSERT INTO sesiones (usuario_id, huella, creada_en, vence_en, ultimo_uso) VALUES (?, ?, ?, ?, ?)")
        .bind(usuario)
        .bind(huella(&app.cfg.session_secret, &token))
        .bind(&ahora)
        .bind(fecha(en_segundos(3600)))
        .bind(&ahora)
        .execute(&app.db)
        .await
        .unwrap();
    token
}

async fn persona(app: &App, email: &str, universidad: i64, profesor: bool) -> (i64, String) {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO usuarios (email, nombre, universidad_id, profesor, creado_en) VALUES (?, 'Persona', ?, ?, ?) RETURNING id",
    )
    .bind(email)
    .bind(universidad)
    .bind(i64::from(profesor))
    .bind(ahora_txt())
    .fetch_one(&app.db)
    .await
    .unwrap();
    (id, sesion(app, id).await)
}

async fn pedir(app: &Estado, token: &str, metodo: Method, ruta: &str, cuerpo: Option<Value>) -> (u16, Value) {
    let mut b = Request::builder()
        .method(metodo)
        .uri(ruta)
        .header(header::HOST, "campusia.test")
        .header(header::ORIGIN, "https://campusia.test")
        .header("x-campusia", "1")
        .header(header::COOKIE, format!("{COOKIE}={token}"));
    let cuerpo = match cuerpo {
        Some(c) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            Body::from(c.to_string())
        }
        None => Body::empty(),
    };
    let mut router = crate::servidor::router(app.clone());
    let r = router.call(b.body(cuerpo).unwrap()).await.unwrap();
    let estado = r.status().as_u16();
    let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    (estado, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn curso_libre(app: &App, id: &str, universidad: i64, usuario: i64) {
    let ahora = ahora_txt();
    sqlx::query(
        "INSERT INTO cursos (id, nombre, periodo, color, universidad_id, creado_en) VALUES (?, 'Sistemas Operativos', '2026', '#111111', ?, ?)",
    )
    .bind(id)
    .bind(universidad)
    .bind(&ahora)
    .execute(&app.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, 'dueño', ?)")
        .bind(id)
        .bind(usuario)
        .bind(&ahora)
        .execute(&app.db)
        .await
        .unwrap();
}

async fn id_de(app: &App, email: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?").bind(email).fetch_one(&app.db).await.unwrap()
}

async fn campus_creado(app: &Estado, token: &str) -> i64 {
    let (estado, curso) = pedir(app, token, Method::POST, "/api/cursos-modulos", Some(json!({"nombre": "Gestión de Proyectos"}))).await;
    assert_eq!(estado, 201, "{curso}");
    curso["campus_id"].as_i64().unwrap()
}

#[tokio::test]
async fn crear_un_campus_con_modulos_lo_registra_en_la_universidad_y_firma_como_la_persona() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (profe, token) = persona(&app, "profe@univ.test", uni, true).await;
    let (estado, curso) =
        pedir(&app, &token, Method::POST, "/api/cursos-modulos", Some(json!({"nombre": "Gestión de Proyectos"}))).await;
    assert_eq!(estado, 201, "{curso}");
    assert_eq!(curso["tipo"], "modulos");
    assert_eq!(curso["campus_externo"], 7);
    assert_eq!(curso["rol"], "dueño");
    let guardada: i64 = sqlx::query_scalar("SELECT universidad_id FROM campus_modulos WHERE campus_externo = 7")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(guardada, uni);
    let registro = registro.lock().unwrap();
    assert_eq!(registro.creados, 1);
    assert_eq!(registro.identidades[0]["email"], "profe@univ.test");
    assert_eq!(registro.identidades[0]["rol"], "profesor");
    assert_eq!(registro.identidades[0]["usuario"], profe.to_string());
}

#[tokio::test]
async fn mis_cursos_lista_los_dos_tipos() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (profe, token) = persona(&app, "profe@univ.test", uni, true).await;
    curso_libre(&app, "sistemas-operativos", uni, profe).await;
    campus_creado(&app, &token).await;
    let (estado, lista) = pedir(&app, &token, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(estado, 200);
    let cursos = lista["cursos"].as_array().unwrap();
    assert_eq!(cursos.len(), 2);
    let libre = cursos.iter().find(|c| c["tipo"] == "libre").unwrap();
    assert_eq!(libre["id"], "sistemas-operativos");
    let modulos = cursos.iter().find(|c| c["tipo"] == "modulos").unwrap();
    assert_eq!(modulos["nombre"], "Gestión de Proyectos");
    assert_eq!(modulos["campus_externo"], 7);
}

#[tokio::test]
async fn solo_un_profesor_de_una_universidad_crea_un_campus_con_modulos() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, alumno) = persona(&app, "alumno@univ.test", uni, false).await;
    let (estado, _) = pedir(&app, &alumno, Method::POST, "/api/cursos-modulos", Some(json!({"nombre": "X"}))).await;
    assert_eq!(estado, 403);
    assert_eq!(registro.lock().unwrap().creados, 0);
}

#[tokio::test]
async fn sin_australis_no_se_crea_nada() {
    let app = nueva_app(None).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, token) = persona(&app, "profe@univ.test", uni, true).await;
    let (estado, _) =
        pedir(&app, &token, Method::POST, "/api/cursos-modulos", Some(json!({"nombre": "X", "plantilla": "basico"}))).await;
    assert_eq!(estado, 503);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM campus_modulos").fetch_one(&app.db).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn inscribir_en_el_nucleo_llega_a_australis_y_queda_registrado() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (estado, r) = pedir(
        &app,
        &profe,
        Method::POST,
        &format!("/api/cursos-modulos/{id}/inscriptos"),
        Some(json!({"emails": ["Ana.Perez@univ.test", "luis@univ.test"]})),
    )
    .await;
    assert_eq!(estado, 200, "{r}");
    assert_eq!(r["agregados"], 2);
    {
        let registro = registro.lock().unwrap();
        assert_eq!(registro.textos.len(), 1);
        assert!(registro.textos[0].contains("ana.perez@univ.test"));
        assert!(registro.textos[0].contains("luis@univ.test"));
        assert_eq!(registro.confirmaciones, 1);
    }
    let (estado, lista) = pedir(&app, &profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 200);
    let emails: Vec<&str> = lista["inscriptos"].as_array().unwrap().iter().map(|i| i["email"].as_str().unwrap()).collect();
    assert!(emails.contains(&"ana.perez@univ.test") && emails.contains(&"luis@univ.test"));
    let ana = id_de(&app, "ana.perez@univ.test").await;
    let rol: String =
        sqlx::query_scalar("SELECT rol FROM inscripciones_modulos WHERE usuario_id = ?").bind(ana).fetch_one(&app.db).await.unwrap();
    assert_eq!(rol, "alumno");
}

#[tokio::test]
async fn no_se_inscribe_a_quien_es_de_otra_universidad_y_australis_no_se_entera() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    universidad(&app, "otra.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (estado, r) =
        pedir(&app, &profe, Method::POST, &format!("/api/cursos-modulos/{id}/inscriptos"), Some(json!({"emails": ["x@otra.test"]}))).await;
    assert_eq!(estado, 400, "{r}");
    assert!(registro.lock().unwrap().textos.is_empty());
}

#[tokio::test]
async fn lo_que_se_inscribe_en_australis_llega_al_nucleo_al_sincronizar() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    {
        let mut r = registro.lock().unwrap();
        r.miembros.push(json!({"email": "marta@univ.test", "full_name": "Marta Gómez", "role": "student", "status": "active"}));
        r.miembros.push(json!({"email": "pablo@univ.test", "full_name": "Pablo Ruiz", "role": "student", "status": "suspended"}));
    }
    let (estado, r) = pedir(&app, &profe, Method::POST, &format!("/api/cursos-modulos/{id}/sincronizar"), None).await;
    assert_eq!(estado, 200, "{r}");
    assert_eq!(r["agregados"], 2);
    let (_, lista) = pedir(&app, &profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    let todos = lista["inscriptos"].as_array().unwrap();
    let marta = todos.iter().find(|i| i["email"] == "marta@univ.test").unwrap();
    assert_eq!(marta["nombre"], "Marta Gómez");
    assert_eq!(marta["suspendida"], false);
    let pablo = todos.iter().find(|i| i["email"] == "pablo@univ.test").unwrap();
    assert_eq!(pablo["suspendida"], true);
    let filas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inscripciones_modulos").fetch_one(&app.db).await.unwrap();
    assert_eq!(filas, 3);
    assert_eq!(super::de_la_persona(&app, id_de(&app, "marta@univ.test").await).await.unwrap().len(), 1);
    assert_eq!(super::de_la_persona(&app, id_de(&app, "pablo@univ.test").await).await.unwrap().len(), 0);
}

#[tokio::test]
async fn un_alumno_ve_el_campus_en_mis_cursos_pero_no_puede_inscribir_ni_sincronizar() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    pedir(&app, &profe, Method::POST, &format!("/api/cursos-modulos/{id}/inscriptos"), Some(json!({"emails": ["ana@univ.test"]}))).await;
    let ana = sesion(&app, id_de(&app, "ana@univ.test").await).await;
    let (_, lista) = pedir(&app, &ana, Method::GET, "/api/mis-cursos", None).await;
    let cursos = lista["cursos"].as_array().unwrap();
    assert_eq!(cursos.len(), 1);
    assert_eq!(cursos[0]["rol"], "alumno");
    let antes = registro.lock().unwrap().textos.len();
    let (estado, _) =
        pedir(&app, &ana, Method::POST, &format!("/api/cursos-modulos/{id}/inscriptos"), Some(json!({"emails": ["otro@univ.test"]}))).await;
    assert_eq!(estado, 403);
    let (estado, _) = pedir(&app, &ana, Method::POST, &format!("/api/cursos-modulos/{id}/sincronizar"), None).await;
    assert_eq!(estado, 403);
    assert_eq!(registro.lock().unwrap().textos.len(), antes);
    let (_, ajeno) = persona(&app, "ajeno@univ.test", uni, false).await;
    let (estado, _) = pedir(&app, &ajeno, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 404);
}

#[tokio::test]
async fn un_alumno_no_lee_la_lista_de_inscriptos() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    pedir(
        &app,
        &profe,
        Method::POST,
        &format!("/api/cursos-modulos/{id}/inscriptos"),
        Some(json!({"emails": ["ana@univ.test", "luis@univ.test"]})),
    )
    .await;
    let ana = sesion(&app, id_de(&app, "ana@univ.test").await).await;
    let (estado, cuerpo) = pedir(&app, &ana, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 403);
    assert!(!cuerpo.to_string().contains("luis@univ.test"));
}

#[tokio::test]
async fn sincronizar_no_trae_a_personas_de_otra_universidad_ni_de_otro_dominio() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let otra = universidad(&app, "otra.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    persona(&app, "x@otra.test", otra, false).await;
    let id = campus_creado(&app, &profe).await;
    {
        let mut r = registro.lock().unwrap();
        for e in ["x@otra.test", "someone@gmail.com", "ok@univ.test"] {
            r.miembros.push(json!({"email": e, "full_name": "Persona", "role": "student", "status": "active"}));
        }
    }
    let (estado, r) = pedir(&app, &profe, Method::POST, &format!("/api/cursos-modulos/{id}/sincronizar"), None).await;
    assert_eq!(estado, 200, "{r}");
    assert_eq!(r["agregados"], 1);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usuarios WHERE email = 'someone@gmail.com'").fetch_one(&app.db).await.unwrap();
    assert_eq!(n, 0);
    let x = id_de(&app, "x@otra.test").await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inscripciones_modulos WHERE usuario_id = ?")
        .bind(x)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn mis_cursos_de_un_docente_trae_lo_inscripto_en_australis() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    campus_creado(&app, &profe).await;
    registro
        .lock()
        .unwrap()
        .miembros
        .push(json!({"email": "marta@univ.test", "full_name": "Marta Gómez", "role": "student", "status": "active"}));
    let (estado, _) = pedir(&app, &profe, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(estado, 200);
    let marta = id_de(&app, "marta@univ.test").await;
    assert_eq!(super::de_la_persona(&app, marta).await.unwrap().len(), 1);
    registro.lock().unwrap().miembros.last_mut().unwrap()["status"] = json!("suspended");
    pedir(&app, &profe, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(super::de_la_persona(&app, marta).await.unwrap().len(), 0);
}

#[tokio::test]
async fn confirmar_una_importacion_en_australis_inscribe_en_el_nucleo_sin_sincronizar() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let propio = crate::enrutador::origen_de(&app, crate::servidor::SUBDOMINIO_AUSTRALIS, None);
    let host = propio.split("://").nth(1).unwrap().to_string();
    let mut resultados = Vec::new();
    for (ruta, cuerpo) in [
        ("/api/campuses/7/roster/imports", Some(json!({"text": "Marta Gomez;marta@univ.test"}))),
        ("/api/campuses/7/roster/imports/1/confirm", None),
    ] {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri(ruta)
            .header(header::HOST, &host)
            .header(header::ORIGIN, &propio)
            .header(header::COOKIE, format!("{COOKIE}={profe}"));
        let cuerpo = match cuerpo {
            Some(c) => {
                b = b.header(header::CONTENT_TYPE, "application/json");
                Body::from(c.to_string())
            }
            None => Body::empty(),
        };
        let mut router = crate::servidor::router(app.clone());
        resultados.push(router.call(b.body(cuerpo).unwrap()).await.unwrap().status().as_u16());
    }
    assert!(resultados.iter().all(|e| *e < 300), "{resultados:?}");
    let (_, lista) = pedir(&app, &profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    let todos = lista["inscriptos"].as_array().unwrap();
    assert!(todos.iter().any(|i| i["email"] == "marta@univ.test"), "{lista}");
}

async fn por_australis(app: &Estado, profe: &str, ruta: &str, cuerpo: Option<Value>) -> (u16, Value) {
    let propio = crate::enrutador::origen_de(app, crate::servidor::SUBDOMINIO_AUSTRALIS, None);
    let host = propio.split("://").nth(1).unwrap().to_string();
    let mut b = Request::builder()
        .method(Method::POST)
        .uri(ruta)
        .header(header::HOST, &host)
        .header(header::ORIGIN, &propio)
        .header(header::COOKIE, format!("{COOKIE}={profe}"));
    let cuerpo = match cuerpo {
        Some(c) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            Body::from(c.to_string())
        }
        None => Body::empty(),
    };
    let mut router = crate::servidor::router(app.clone());
    let respuesta = router.call(b.body(cuerpo).unwrap()).await.unwrap();
    let estado = respuesta.status().as_u16();
    let bytes = axum::body::to_bytes(respuesta.into_body(), 1 << 20).await.unwrap();
    (estado, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn estado_en_el_nucleo(app: &Estado, profe: &str, id: i64, email: &str) -> Option<bool> {
    let (_, lista) = pedir(app, profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    lista["inscriptos"].as_array().unwrap().iter().find(|i| i["email"] == email).map(|i| i["suspendida"].as_bool().unwrap())
}

#[tokio::test]
async fn suspender_y_reactivar_en_australis_llega_al_nucleo_en_el_mismo_pedido() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    registro.lock().unwrap().miembros.push(json!({"email": "marta@univ.test", "full_name": "Marta", "role": "student", "status": "active"}));
    let (estado, _) = por_australis(&app, &profe, "/api/campuses/7/members/1/suspend", Some(json!({"reason": "baja"}))).await;
    assert_eq!(estado, 200);
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "marta@univ.test").await, Some(true));
    let (estado, _) = por_australis(&app, &profe, "/api/campuses/7/members/1/reactivate", Some(json!({"reason": "vuelve"}))).await;
    assert_eq!(estado, 200);
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "marta@univ.test").await, Some(false));
}

#[tokio::test]
async fn agregar_un_docente_invitado_en_australis_llega_al_nucleo() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (estado, _) = por_australis(&app, &profe, "/api/campuses/7/teachers", Some(json!({"email": "otra@univ.test"}))).await;
    assert_eq!(estado, 201);
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "otra@univ.test").await, Some(false));
}

#[tokio::test]
async fn reenviar_la_invitacion_en_australis_sincroniza_sin_error() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    registro.lock().unwrap().miembros.push(json!({"email": "marta@univ.test", "full_name": "Marta", "role": "student", "status": "active"}));
    let (estado, _) = por_australis(&app, &profe, "/api/campuses/7/members/1/invite", None).await;
    assert_eq!(estado, 200);
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "marta@univ.test").await, Some(false));
}

#[tokio::test]
async fn si_el_cambio_no_llega_al_nucleo_el_pedido_lo_muestra() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    campus_creado(&app, &profe).await;
    registro.lock().unwrap().miembros.push(json!({"email": "marta@univ.test", "full_name": "Marta", "role": "student", "status": "active"}));
    registro.lock().unwrap().listado_roto = true;
    let (estado, cuerpo) = por_australis(&app, &profe, "/api/campuses/7/members/1/suspend", Some(json!({"reason": "baja"}))).await;
    assert_eq!(estado, 502);
    assert_eq!(cuerpo["codigo"], "sincronizacion_fallida");
    assert!(cuerpo["error"].as_str().unwrap().contains("no llegó"));
}

#[tokio::test]
async fn dos_cambios_a_la_vez_dejan_al_nucleo_igual_que_australis() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    registro.lock().unwrap().miembros.push(json!({"email": "marta@univ.test", "full_name": "Marta", "role": "student", "status": "active"}));
    registro.lock().unwrap().primer_listado_lento = true;
    let (a, b) = tokio::join!(
        por_australis(&app, &profe, "/api/campuses/7/members/1/suspend", Some(json!({"reason": "baja"}))),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            por_australis(&app, &profe, "/api/campuses/7/members/1/reactivate", Some(json!({"reason": "vuelve"}))).await
        }
    );
    assert_eq!((a.0, b.0), (200, 200));
    assert_eq!(registro.lock().unwrap().miembros[1]["status"], "active");
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "marta@univ.test").await, Some(false));
}

#[tokio::test]
async fn un_docente_invitado_de_otro_dominio_no_llega_al_nucleo_y_el_pedido_lo_muestra() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (estado, cuerpo) = por_australis(&app, &profe, "/api/campuses/7/teachers", Some(json!({"email": "otra@gmail.com"}))).await;
    assert_eq!(estado, 502);
    assert_eq!(cuerpo["codigo"], "invitado_fuera_del_dominio");
    assert!(cuerpo["error"].as_str().unwrap().contains("otra@gmail.com"));
    assert_eq!(estado_en_el_nucleo(&app, &profe, id, "otra@gmail.com").await, None);
}

async fn administrador(app: &App, email: &str, universidad: i64) -> String {
    let (id, token) = persona(app, email, universidad, false).await;
    sqlx::query("UPDATE usuarios SET administrador = 1 WHERE id = ?").bind(id).execute(&app.db).await.unwrap();
    token
}

#[tokio::test]
async fn lo_que_se_importa_en_australis_llega_al_alumno_sin_sincronizar_a_mano() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (_, ana) = persona(&app, "ana@univ.test", uni, false).await;
    let (_, antes) = pedir(&app, &ana, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(antes["cursos"].as_array().unwrap().len(), 0);
    registro
        .lock()
        .unwrap()
        .miembros
        .push(json!({"email": "ana@univ.test", "full_name": "Ana", "role": "student", "status": "active"}));
    let (estado, despues) = pedir(&app, &ana, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(estado, 200);
    let cursos = despues["cursos"].as_array().unwrap();
    assert_eq!(cursos.len(), 1, "{despues}");
    assert_eq!(cursos[0]["campus_id"], id);
    assert_eq!(cursos[0]["rol"], "alumno");
    let (_, lista) = pedir(&app, &profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert!(lista["inscriptos"].as_array().unwrap().iter().any(|i| i["email"] == "ana@univ.test"));
    registro.lock().unwrap().miembros.last_mut().unwrap()["status"] = json!("suspended");
    let (_, fuera) = pedir(&app, &ana, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(fuera["cursos"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn el_administrador_de_la_universidad_ve_el_campus_con_modulos_y_sus_inscriptos() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let otra = universidad(&app, "otra.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    pedir(&app, &profe, Method::POST, &format!("/api/cursos-modulos/{id}/inscriptos"), Some(json!({"emails": ["ana@univ.test"]}))).await;
    let admin = administrador(&app, "admin@univ.test", uni).await;
    let (estado, lista) = pedir(&app, &admin, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 200, "{lista}");
    assert_eq!(lista["inscriptos"].as_array().unwrap().len(), 2);
    let (estado, cursos) = pedir(&app, &admin, Method::GET, "/api/admin/cursos", None).await;
    assert_eq!(estado, 200);
    let campus = cursos["cursos"].as_array().unwrap().iter().find(|c| c["tipo"] == "modulos").expect("campus listed");
    assert_eq!(campus["id"], format!("campus-{id}"));
    assert_eq!(campus["alumnos"], 1);
    assert_eq!(campus["profesores"], 1);
    assert_eq!(campus["dueno"]["email"], "profe@univ.test");
    let ajeno = administrador(&app, "admin@otra.test", otra).await;
    let (estado, _) = pedir(&app, &ajeno, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 404);
}

#[tokio::test]
async fn una_universidad_sin_campus_con_modulos_no_llama_a_australis_en_mis_cursos() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, ana) = persona(&app, "ana@univ.test", uni, false).await;
    let (estado, _) = pedir(&app, &ana, Method::GET, "/api/mis-cursos", None).await;
    assert_eq!(estado, 200);
    assert_eq!(registro.lock().unwrap().listados, 0);
}

#[tokio::test]
async fn lo_importado_en_australis_aparece_en_la_lista_y_en_los_conteos_sin_abrir_mis_cursos() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let admin = administrador(&app, "admin@univ.test", uni).await;
    {
        let mut r = registro.lock().unwrap();
        r.miembros.push(json!({"email": "ana@univ.test", "full_name": "Ana", "role": "student", "status": "active"}));
        r.miembros.push(json!({"email": "nueva@univ.test", "full_name": "Nueva", "role": "student", "status": "active"}));
    }
    let (_, cursos) = pedir(&app, &admin, Method::GET, "/api/admin/cursos", None).await;
    let campus = cursos["cursos"].as_array().unwrap().iter().find(|c| c["tipo"] == "modulos").unwrap();
    assert_eq!(campus["alumnos"], 2, "{cursos}");
    let (_, lista) = pedir(&app, &admin, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    let emails: Vec<&str> = lista["inscriptos"].as_array().unwrap().iter().map(|i| i["email"].as_str().unwrap()).collect();
    assert!(emails.contains(&"ana@univ.test") && emails.contains(&"nueva@univ.test"), "{lista}");
    registro.lock().unwrap().miembros.push(json!({"email": "otra@univ.test", "full_name": "Otra", "role": "student", "status": "active"}));
    let (_, lista) = pedir(&app, &profe, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert!(lista["inscriptos"].as_array().unwrap().iter().any(|i| i["email"] == "otra@univ.test"), "{lista}");
}

async fn owner_sin_universidad(app: &App, email: &str) -> String {
    let id: i64 = sqlx::query_scalar("INSERT INTO usuarios (email, nombre, owner, creado_en) VALUES (?, 'Owner', 1, ?) RETURNING id")
        .bind(email)
        .bind(ahora_txt())
        .fetch_one(&app.db)
        .await
        .unwrap();
    sesion(app, id).await
}

#[tokio::test]
async fn el_owner_sin_universidad_ve_los_campus_con_modulos_de_todas_las_universidades() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let otra = universidad(&app, "otra.test").await;
    let (profe_id, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let id_otra: i64 = sqlx::query_scalar(
        "INSERT INTO campus_modulos (campus_externo, nombre, universidad_id, creado_por, creado_en) VALUES (8, 'Otro', ?, ?, ?) RETURNING id",
    )
    .bind(otra)
    .bind(profe_id)
    .bind(ahora_txt())
    .fetch_one(&app.db)
    .await
    .unwrap();
    let owner = owner_sin_universidad(&app, "owner@campusia.test").await;
    let (estado, cursos) = pedir(&app, &owner, Method::GET, "/api/admin/cursos", None).await;
    assert_eq!(estado, 200, "{cursos}");
    let ids: Vec<String> =
        cursos["cursos"].as_array().unwrap().iter().filter(|c| c["tipo"] == "modulos").map(|c| c["id"].to_string()).collect();
    assert!(ids.contains(&format!("\"campus-{id}\"")) && ids.contains(&format!("\"campus-{id_otra}\"")), "{cursos}");
    for campus in [id, id_otra] {
        let (estado, lista) = pedir(&app, &owner, Method::GET, &format!("/api/cursos-modulos/{campus}/inscriptos"), None).await;
        assert_eq!(estado, 200, "{lista}");
        let emails: Vec<&str> = lista["inscriptos"].as_array().unwrap().iter().map(|i| i["email"].as_str().unwrap()).collect();
        if campus == id {
            assert_eq!(emails, vec!["profe@univ.test"], "{lista}");
        } else {
            assert!(emails.is_empty(), "{lista}");
        }
    }
    let (estado, _) = pedir(&app, &profe, Method::GET, "/api/admin/cursos", None).await;
    assert_eq!(estado, 403);
}

async fn filas_de_auditoria(app: &App) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM auditoria WHERE accion = 'inscripcion_modulos'").fetch_one(&app.db).await.unwrap()
}

#[tokio::test]
async fn las_vistas_de_solo_lectura_no_escriben_auditoria_si_nada_cambio() {
    let (url, registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let admin = administrador(&app, "admin@univ.test", uni).await;
    let base = filas_de_auditoria(&app).await;
    for _ in 0..2 {
        pedir(&app, &admin, Method::GET, "/api/admin/cursos", None).await;
        pedir(&app, &admin, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
        pedir(&app, &profe, Method::GET, "/api/mis-cursos", None).await;
    }
    assert_eq!(filas_de_auditoria(&app).await, base);
    registro.lock().unwrap().miembros.push(json!({"email": "ana@univ.test", "full_name": "Ana", "role": "student", "status": "active"}));
    pedir(&app, &admin, Method::GET, "/api/admin/cursos", None).await;
    assert_eq!(filas_de_auditoria(&app).await, base + 1);
}

#[tokio::test]
async fn un_owner_con_universidad_lista_todas_las_universidades_con_cursos_libres_y_campus() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let otra = universidad(&app, "otra.test").await;
    let (profe_id, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let (otro_id, _) = persona(&app, "otro@otra.test", otra, true).await;
    curso_libre(&app, "libre-uno", otra, otro_id).await;
    curso_libre(&app, "libre-dos", uni, profe_id).await;
    let (owner_id, owner) = persona(&app, "owner@univ.test", uni, false).await;
    sqlx::query("UPDATE usuarios SET owner = 1 WHERE id = ?").bind(owner_id).execute(&app.db).await.unwrap();
    let (estado, cursos) = pedir(&app, &owner, Method::GET, "/api/admin/cursos", None).await;
    assert_eq!(estado, 200, "{cursos}");
    let ids: Vec<String> = cursos["cursos"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
    for esperado in ["libre-uno".to_string(), "libre-dos".to_string(), format!("campus-{id}")] {
        assert!(ids.contains(&esperado), "{esperado} falta en {cursos}");
    }
    let (estado, lista) = pedir(&app, &owner, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert_eq!(estado, 200);
    assert_eq!(lista["inscriptos"][0]["email"], "profe@univ.test");
}

#[tokio::test]
async fn un_owner_suspendido_no_ve_ni_el_listado_ni_los_inscriptos() {
    let (url, _registro) = australis_falso().await;
    let app = nueva_app(Some(url)).await;
    let uni = universidad(&app, "univ.test").await;
    let (_, profe) = persona(&app, "profe@univ.test", uni, true).await;
    let id = campus_creado(&app, &profe).await;
    let owner = owner_sin_universidad(&app, "owner@campusia.test").await;
    sqlx::query("UPDATE usuarios SET suspendida_en = '2026-01-01T00:00:00Z' WHERE email = 'owner@campusia.test'").execute(&app.db).await.unwrap();
    let (a, _) = pedir(&app, &owner, Method::GET, "/api/admin/cursos", None).await;
    let (b, _) = pedir(&app, &owner, Method::GET, &format!("/api/cursos-modulos/{id}/inscriptos"), None).await;
    assert!(a >= 400 && b >= 400, "{a} {b}");
}
