//! Modules add migrations in fixed number ranges, so a branch can add a lower-numbered file
//! after a higher-numbered one is already applied. This proves sqlx applies it.

use std::path::{Path, PathBuf};

use rand::RngCore;
use sqlx::{migrate::Migrator, SqlitePool};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let mut bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut bytes);
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("australis-migrations-{name}"));
        std::fs::create_dir_all(path.join("migrations")).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn migrate(db: &SqlitePool, dir: &Path) -> Result<(), sqlx::migrate::MigrateError> {
    Migrator::new(dir).await?.run(db).await
}

async fn table_exists(db: &SqlitePool, name: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(name)
    .fetch_one(db)
    .await
    .unwrap()
        == 1
}

#[tokio::test]
async fn a_lower_numbered_migration_added_later_is_applied() {
    let temp = TempDir::new();
    let migrations = temp.0.join("migrations");
    let db = australis_core::connect(&format!("sqlite://{}", temp.0.join("test.db").display()))
        .await
        .unwrap();

    // The kernel (0001) and a module with a high range (0300) are applied first.
    std::fs::write(
        migrations.join("0001_core_a.sql"),
        "CREATE TABLE core_a (id INTEGER);",
    )
    .unwrap();
    std::fs::write(
        migrations.join("0300_grades_c.sql"),
        "CREATE TABLE grades_c (id INTEGER);",
    )
    .unwrap();
    migrate(&db, &migrations).await.unwrap();
    assert!(table_exists(&db, "core_a").await);
    assert!(table_exists(&db, "grades_c").await);
    assert!(!table_exists(&db, "campus_b").await);

    // Then a module with a lower range (0100) lands.
    std::fs::write(
        migrations.join("0100_campus_b.sql"),
        "CREATE TABLE campus_b (id INTEGER);",
    )
    .unwrap();
    migrate(&db, &migrations).await.unwrap();
    assert!(table_exists(&db, "campus_b").await);

    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(versions, vec![1, 100, 300]);

    // Running again changes nothing.
    migrate(&db, &migrations).await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn editing_an_applied_migration_is_refused() {
    let temp = TempDir::new();
    let migrations = temp.0.join("migrations");
    let db = australis_core::connect(&format!("sqlite://{}", temp.0.join("test.db").display()))
        .await
        .unwrap();

    std::fs::write(
        migrations.join("0001_core_a.sql"),
        "CREATE TABLE core_a (id INTEGER);",
    )
    .unwrap();
    migrate(&db, &migrations).await.unwrap();

    std::fs::write(
        migrations.join("0001_core_a.sql"),
        "CREATE TABLE core_a (id INTEGER, extra TEXT);",
    )
    .unwrap();
    assert!(migrate(&db, &migrations).await.is_err());
    db.close().await;
}

#[tokio::test]
async fn the_real_migrations_apply_to_an_empty_database() {
    let temp = TempDir::new();
    let db = australis_server::init_db(&format!("sqlite://{}", temp.0.join("real.db").display()))
        .await
        .unwrap();
    for table in [
        "core_users",
        "core_sessions",
        "core_invites",
        "core_campuses",
        "core_members",
        "core_audit_log",
        "core_settings",
        "core_ai_usage",
        "core_ai_quota",
    ] {
        assert!(table_exists(&db, table).await, "{table} is missing");
    }
    db.close().await;
}
