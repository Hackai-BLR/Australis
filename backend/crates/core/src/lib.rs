//! Shared kernel. Modules depend on this crate and never on each other.
//!
//! - `config`, `error`: configuration and the error type of every handler.
//! - `auth`, `access`: sessions, the `CurrentUser` extractor, roles and campus access levels.
//! - `directory`: users, campuses, members and invites (the `core_*` tables).
//! - `audit`, `settings`: the append-only audit log and the rules kept as settings.
//! - `ai`, `zoom`, `slides`: outside providers behind traits, with placeholder
//!   implementations. This build makes no outside call.
//! - `files`, `live`, `http`: upload storage, in-process pub/sub and HTTP helpers.
//!
//! Database functions take `&mut SqliteConnection`. Pass `&mut conn` from
//! `state.db.acquire()` for a single call, or `&mut tx` from [`begin_write`] to make several
//! calls (and the module's own statements) one transaction.

use std::{str::FromStr, sync::Arc, time::Duration};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions},
    Sqlite, Transaction,
};

pub mod access;
pub mod ai;
pub mod audit;
pub mod auth;
pub mod config;
pub mod directory;
pub mod error;
pub mod files;
pub mod http;
pub mod live;
pub mod settings;
pub mod slides;
pub mod zoom;

pub use access::{require_campus, require_role, Access, CampusAccess};
pub use auth::{CurrentUser, Role};
pub use config::Config;
pub use error::{AppError, AppResult, ProviderError};

use ai::{AiProvider, PlaceholderAi};
use files::FileStore;
use live::LiveHub;
use slides::{NoConverter, SlideConverter};
use zoom::{PlaceholderZoom, ZoomProvider};

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<Config>,
    pub ai: Arc<dyn AiProvider>,
    pub zoom: Arc<dyn ZoomProvider>,
    pub slides: Arc<dyn SlideConverter>,
    pub files: FileStore,
    pub live: Arc<LiveHub>,
}

impl AppState {
    /// A state where every outside provider is its placeholder: scripted AI replies, a
    /// simulated Zoom and no PowerPoint converter.
    pub fn with_placeholders(db: SqlitePool, config: Config) -> Self {
        Self {
            db,
            ai: Arc::new(PlaceholderAi::new()),
            zoom: Arc::new(PlaceholderZoom::new(config.app_base_url.clone())),
            slides: Arc::new(NoConverter),
            files: FileStore::new(config.upload_dir.clone()),
            live: Arc::new(LiveHub::new()),
            config: Arc::new(config),
        }
    }
}

pub async fn connect(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
}

/// Starts a write transaction (`BEGIN IMMEDIATE`). It takes the write lock up front, so two
/// requests that read and then write wait for each other instead of one failing with
/// "database is locked". Use it for every transaction that writes.
pub async fn begin_write(db: &SqlitePool) -> AppResult<Transaction<'static, Sqlite>> {
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}
