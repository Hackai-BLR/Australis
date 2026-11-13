use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

use crate::util::ahora_txt;

pub async fn conectar(url: &str) -> anyhow::Result<SqlitePool> {
    let opciones = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opciones).await?;
    Ok(pool)
}

pub async fn migrar(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::migrate!("./migraciones").run(pool).await?;
    Ok(())
}

tokio::task_local! {
    pub static POR_AGENTE: bool;
}

pub async fn auditar<'e, E>(
    ejecutor: E,
    universidad_id: Option<i64>,
    actor_id: Option<i64>,
    accion: &str,
    detalle: &str,
    ip: Option<&str>,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let agente = POR_AGENTE.try_with(|a| *a).unwrap_or(false);
    let detalle = if agente { format!("{detalle} (pedido por el agente)") } else { detalle.to_string() };
    sqlx::query("INSERT INTO auditoria (fecha, universidad_id, actor_id, accion, detalle, ip, agente) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(ahora_txt())
        .bind(universidad_id)
        .bind(actor_id)
        .bind(accion)
        .bind(detalle)
        .bind(ip)
        .bind(agente as i64)
        .execute(ejecutor)
        .await?;
    Ok(())
}
