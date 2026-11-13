mod acciones;
mod admin;
mod agente;
mod agente_config;
mod api_cursos;
mod archivos;
mod auth;
mod config;
mod contenedores;
mod cuenta;
mod cupos;
mod cursos;
mod datos;
mod db;
mod email;
mod endurecimiento;
mod enrutador;
mod espacios;
mod estado;
mod identidad;
mod inhabilitar;
mod login;
mod modelo;
mod owner;
mod prueba;
mod proxy_salida;
mod publicar;
mod puente;
mod registros;
mod repo;
mod roles;
mod servidor;
mod sesiones_owner;
mod siu;
mod supervisor;
mod util;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::auth::App;
use crate::config::Config;
use crate::util::*;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 1 && args[0] == "leer-siu" {
        return siu::proceso_lector();
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("no se pudo iniciar el runtime: {e}");
            return ExitCode::from(1);
        }
    };
    let resultado = rt.block_on(async move {
        match args.first().map(String::as_str) {
            None => servir().await,
            Some("migrar") if args.len() == 1 => migrar().await,
            Some("crear-owner") if args.len() == 2 => crear_owner(&args[1]).await,
            Some("quitar-owner") if args.len() == 2 => quitar_owner(&args[1]).await,
            Some("sembrar") if args.len() == 2 => sembrar(&args[1]).await,
            Some("clave-publica") if args.len() == 1 => clave_publica().await,
            Some("puente") if args.len() == 5 => puente::servir(&args[1..]).await,
            Some("retirar-archivo") if args.len() == 4 => retirar_archivo(&args[1], &args[2], &args[3]).await,
            _ => Err(anyhow::anyhow!(
                "Uso: campusia-nucleo [migrar | crear-owner <email> | quitar-owner <email> | sembrar <archivo.json> | clave-publica | retirar-archivo <curso> <archivo_id> <motivo>]"
            )),
        }
    });
    match resultado {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e:#}");
            ExitCode::from(1)
        }
    }
}

async fn base_migrada() -> anyhow::Result<sqlx::SqlitePool> {
    let url = config::database_url().map_err(anyhow::Error::msg)?;
    let pool = db::conectar(&url).await?;
    db::migrar(&pool).await?;
    Ok(pool)
}

async fn retirar_archivo(curso: &str, archivo: &str, motivo: &str) -> anyhow::Result<()> {
    let raiz = std::env::var("RAIZ_ARCHIVOS").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "/srv/campusia/archivos".into());
    let pool = base_migrada().await?;
    let r = archivos::retirar(&pool, std::path::Path::new(&raiz), curso, archivo, motivo).await;
    pool.close().await;
    let liberados = r?;
    println!("Archivo retirado: {liberados} bytes liberados");
    Ok(())
}

async fn migrar() -> anyhow::Result<()> {
    let pool = base_migrada().await?;
    pool.close().await;
    println!("Migraciones al día");
    Ok(())
}

async fn clave_publica() -> anyhow::Result<()> {
    let semilla = config::identidad_clave_privada().map_err(anyhow::Error::msg)?;
    let pool = base_migrada().await?;
    let identidad = identidad::Identidad::cargar(&pool, semilla.as_deref()).await?;
    pool.close().await;
    println!("{}", identidad.publica());
    Ok(())
}

async fn crear_owner(crudo: &str) -> anyhow::Result<()> {
    let email = normalizar_email(crudo).ok_or_else(|| anyhow::anyhow!("Mail inválido: {crudo}"))?;
    let pool = base_migrada().await?;
    let ahora = ahora_txt();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO usuarios (email, nombre, universidad_id, owner, pendiente, creado_en) VALUES (?, ?, NULL, 1, 0, ?) \
         ON CONFLICT(email) DO UPDATE SET owner = 1, suspendida_en = NULL, suspendida_por = NULL, baja_en = NULL",
    )
    .bind(&email)
    .bind(nombre_desde_email(&email))
    .bind(&ahora)
    .execute(&mut *tx)
    .await?;
    db::auditar(&mut *tx, None, None, "owner_creado", &format!("Owner {email} creado desde la línea de comandos"), None).await?;
    tx.commit().await?;
    pool.close().await;
    println!("Owner listo: {email}");
    Ok(())
}

async fn quitar_owner(crudo: &str) -> anyhow::Result<()> {
    let email = normalizar_email(crudo).ok_or_else(|| anyhow::anyhow!("Mail inválido: {crudo}"))?;
    let pool = base_migrada().await?;
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?").bind(&email).fetch_optional(&pool).await?;
    let resultado = match id {
        Some(id) => roles::quitar_owner_de(&pool, id).await?,
        None => roles::QuitarOwner::NoEsOwner,
    };
    let salida = match resultado {
        roles::QuitarOwner::NoEsOwner => Err(anyhow::anyhow!("{email} no es owner")),
        roles::QuitarOwner::Ultimo => Err(anyhow::anyhow!("No se puede quitar al último owner")),
        roles::QuitarOwner::Quitado { email, universidad } => {
            db::auditar(&pool, universidad, None, "owner_quitado", &format!("Owner {email} quitado desde la línea de comandos"), None)
                .await?;
            println!("Owner quitado: {email}");
            Ok(())
        }
    };
    pool.close().await;
    salida
}

fn booleano(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_bool).unwrap_or(false) as i64
}

fn texto(v: &Value, k: &str) -> anyhow::Result<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow::anyhow!("Falta el campo {k}"))
}

async fn sembrar(ruta: &str) -> anyhow::Result<()> {
    if !config::es_desarrollo().map_err(anyhow::Error::msg)? {
        anyhow::bail!("sembrar solo funciona con ENTORNO=desarrollo");
    }
    let contenido = std::fs::read_to_string(ruta)?;
    let datos: Value = serde_json::from_str(&contenido)?;
    let pool = base_migrada().await?;
    let ahora = ahora_txt();
    let mes = mes_actual();
    let mut tx = pool.begin().await?;
    let vacio = Vec::new();
    let mut universidades = std::collections::HashMap::new();
    for u in datos.get("universidades").and_then(Value::as_array).unwrap_or(&vacio) {
        let nombre = texto(u, "nombre")?;
        let limite = u.get("limite_usd").and_then(Value::as_f64).unwrap_or(20.0);
        let cupo = match u.get("cupo_tokens") {
            None | Some(Value::Null) => (limite * 1_000_000.0).round() as i64,
            Some(v) => v.as_i64().filter(|n| (0..=cupos::MAXIMO_TOKENS).contains(n)).ok_or_else(|| anyhow::anyhow!("cupo_tokens inválido en {nombre}"))?,
        };
        let id: i64 = sqlx::query_scalar("INSERT INTO universidades (nombre, limite_usd, cupo_tokens, creada_en) VALUES (?, ?, ?, ?) RETURNING id")
            .bind(&nombre)
            .bind(limite)
            .bind(cupo)
            .bind(&ahora)
            .fetch_one(&mut *tx)
            .await?;
        for d in u.get("dominios").and_then(Value::as_array).unwrap_or(&vacio) {
            let d = d.as_str().and_then(normalizar_dominio).ok_or_else(|| anyhow::anyhow!("Dominio inválido"))?;
            sqlx::query("INSERT INTO dominios (dominio, universidad_id) VALUES (?, ?)").bind(d).bind(id).execute(&mut *tx).await?;
        }
        universidades.insert(nombre, id);
    }
    let uni_de = |v: &Value| -> anyhow::Result<Option<i64>> {
        match v.get("universidad").and_then(Value::as_str) {
            None => Ok(None),
            Some(n) => universidades.get(n).copied().map(Some).ok_or_else(|| anyhow::anyhow!("Universidad desconocida: {n}")),
        }
    };
    for u in datos.get("usuarios").and_then(Value::as_array).unwrap_or(&vacio) {
        let email = normalizar_email(&texto(u, "email")?).ok_or_else(|| anyhow::anyhow!("Mail inválido"))?;
        let nombre = u.get("nombre").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| nombre_desde_email(&email));
        sqlx::query(
            "INSERT INTO usuarios (email, nombre, universidad_id, profesor, administrador, owner, pendiente, creado_en) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&email)
        .bind(nombre)
        .bind(uni_de(u)?)
        .bind(booleano(u, "profesor"))
        .bind(booleano(u, "administrador"))
        .bind(booleano(u, "owner"))
        .bind(booleano(u, "pendiente"))
        .bind(&ahora)
        .execute(&mut *tx)
        .await?;
    }
    for c in datos.get("cursos").and_then(Value::as_array).unwrap_or(&vacio) {
        let id = texto(c, "id")?;
        let uni = uni_de(c)?.ok_or_else(|| anyhow::anyhow!("El curso {id} no tiene universidad"))?;
        sqlx::query(
            "INSERT INTO cursos (id, nombre, periodo, color, universidad_id, version_publicada, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(texto(c, "nombre")?)
        .bind(texto(c, "periodo")?)
        .bind(texto(c, "color")?)
        .bind(uni)
        .bind(c.get("version_publicada").and_then(Value::as_i64))
        .bind(&ahora)
        .execute(&mut *tx)
        .await?;
        if let Some(usd) = c.get("uso_usd_mes").and_then(Value::as_f64) {
            sqlx::query("INSERT INTO uso_agente (curso_id, mes, usd) VALUES (?, ?, ?)")
                .bind(&id)
                .bind(&mes)
                .bind(usd)
                .execute(&mut *tx)
                .await?;
        }
        for i in c.get("inscripciones").and_then(Value::as_array).unwrap_or(&vacio) {
            let email = normalizar_email(&texto(i, "email")?).ok_or_else(|| anyhow::anyhow!("Mail inválido"))?;
            let usuario: i64 = sqlx::query_scalar("SELECT id FROM usuarios WHERE email = ?")
                .bind(&email)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Usuario desconocido: {email}"))?;
            sqlx::query("INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, ?, ?)")
                .bind(&id)
                .bind(usuario)
                .bind(texto(i, "rol")?)
                .bind(&ahora)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    pool.close().await;
    println!("Datos de prueba cargados");
    Ok(())
}

async fn senal_de_fin() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

async fn servir() -> anyhow::Result<()> {
    let cfg = Config::desde_entorno().map_err(anyhow::Error::msg)?;
    let pool = db::conectar(&cfg.database_url).await?;
    db::migrar(&pool).await?;
    login::cargar_envios(&pool, cfg.espera_codigo_inicial_ms).await?;
    estado::preparar(&cfg);
    let tiempos = endurecimiento::Tiempos::de(&cfg);
    let correo = email::crear(&cfg);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()?;
    let direccion: SocketAddr = format!("{}:{}", cfg.direccion, cfg.puerto)
        .parse()
        .map_err(|_| anyhow::anyhow!("DIRECCION o PUERTO inválidos"))?;
    let identidad = identidad::Identidad::cargar(&pool, cfg.identidad_clave_privada.as_deref()).await?;
    let mut escucha_cursos = None;
    let mut socket_cursos = None;
    let mut fase3 = None;
    let supervisor = match cfg.contenedores.clone() {
        None => None,
        Some(cc) => {
            let proveedor = contenedores::ProveedorCli::nuevo(&cc);
            let red = contenedores::ProveedorDeContenedores::preparar_red(&proveedor)
                .await
                .map_err(|e| anyhow::anyhow!("No se pudo preparar la red de los cursos {}: {e:#}", cc.red))?;
            let acceso = contenedores::ProveedorDeContenedores::abrir_acceso(&proveedor, &red).await?;
            eprintln!("API para cursos escuchando en {}", acceso.descripcion);
            escucha_cursos = Some(acceso.escucha);
            socket_cursos = acceso.socket_cursos.clone();
            let sup = Arc::new(supervisor::Supervisor::nuevo(
                cc,
                Box::new(proveedor),
                pool.clone(),
                cfg.session_secret.clone(),
                identidad.publica(),
                acceso.url_api,
                acceso.socket_cursos,
                (cfg.arranque_curso_seg, cfg.inactividad_seg, cfg.construccion_max_seg),
            )?);
            sup.al_arrancar().await?;
            fase3 = Some(espacios::preparar(&cfg, &sup.cfg, pool.clone(), identidad.publica(), sup.clone()).await?);
            Some(sup)
        }
    };
    let proxy = enrutador::cliente_proxy(socket_cursos.as_deref())?;
    let revision = Duration::from_secs(cfg.revision_inactividad_seg as u64);
    let intermediario = Arc::new(modelo::Intermediario::nuevo(&cfg.agente)?);
    let espacios = fase3.as_ref().map(|f| f.espacios.clone());
    let app = Arc::new(App { cfg, db: pool.clone(), email: correo, http, proxy, identidad, supervisor: supervisor.clone(), espacios, intermediario });
    if let Some(f) = fase3 {
        espacios::lanzar(app.clone(), f);
    }
    if let Some(sup) = supervisor {
        tokio::spawn(sup.vigilar_inactividad(revision));
    }
    if let Some(escucha) = escucha_cursos {
        let rutas = endurecimiento::cursos(api_cursos::router(app.clone()), &app);
        tokio::spawn(async move {
            let r = match escucha {
                contenedores::EscuchaApi::Tcp(l) => endurecimiento::servir_tcp(l, rutas, tiempos, std::future::pending()).await,
                contenedores::EscuchaApi::Unix(l) => endurecimiento::servir_unix(l, rutas, tiempos).await,
            };
            if let Err(e) = r {
                eprintln!("la API para cursos se detuvo: {e}");
            }
        });
    }
    let rutas = endurecimiento::principal(servidor::router(app.clone()), app);
    let escucha = tokio::net::TcpListener::bind(direccion).await?;
    eprintln!("campusia-nucleo escuchando en {}", escucha.local_addr()?);
    endurecimiento::servir_tcp(escucha, rutas, tiempos, senal_de_fin()).await?;
    pool.close().await;
    Ok(())
}
