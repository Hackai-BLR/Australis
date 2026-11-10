//! Startup seed, gated by environment variables. It runs inside the server process, so it
//! also works in the release image, and it is idempotent: an account that exists is left
//! untouched.
//!
//! - `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD`: create the first secretary if absent.
//! - `SEED_DEMO=true`: also create the fake demo accounts below, with the same password.
//!
//! Every person here is invented.

use australis_core::{
    auth,
    directory::{self, NewUser},
    AppState, Role,
};
use sqlx::SqliteConnection;

const ADMIN_NAME: &str = "Secretaría Australis";

/// Fake accounts for demos: email, name, role.
pub const DEMO_ACCOUNTS: &[(&str, &str, Role)] = &[
    (
        "laura.mendez@demo.australis.example",
        "Laura Méndez",
        Role::Professor,
    ),
    (
        "diego.ferrari@demo.australis.example",
        "Diego Ferrari",
        Role::Professor,
    ),
    (
        "carla.sosa@demo.australis.example",
        "Carla Sosa",
        Role::Student,
    ),
    (
        "tomas.ibarra@demo.australis.example",
        "Tomás Ibarra",
        Role::Student,
    ),
    (
        "valentina.rios@demo.australis.example",
        "Valentina Ríos",
        Role::Student,
    ),
];

/// Creates the configured accounts that do not exist yet and returns how many it created.
pub async fn run(state: &AppState) -> anyhow::Result<usize> {
    let config = &state.config;
    let (Some(email), Some(password)) = (&config.seed_admin_email, &config.seed_admin_password)
    else {
        if config.seed_demo {
            tracing::warn!(
                "SEED_DEMO needs SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD; no account was created"
            );
        }
        return Ok(0);
    };
    auth::validate_password(password)?;

    let mut conn = state.db.acquire().await?;
    let mut created = 0;
    if ensure_account(
        &mut conn,
        state,
        email,
        ADMIN_NAME,
        Role::Secretary,
        password,
    )
    .await?
    {
        created += 1;
    }
    if config.seed_demo {
        for (email, name, role) in DEMO_ACCOUNTS {
            if ensure_account(&mut conn, state, email, name, *role, password).await? {
                created += 1;
            }
        }
    }
    if created > 0 {
        tracing::info!(created, "seed created accounts");
    }
    Ok(created)
}

async fn ensure_account(
    conn: &mut SqliteConnection,
    state: &AppState,
    email: &str,
    full_name: &str,
    role: Role,
    password: &str,
) -> anyhow::Result<bool> {
    if directory::find_user_by_email(conn, email).await?.is_some() {
        return Ok(false);
    }
    let password_hash = auth::hash_password(&state.config, password).await?;
    directory::create_user(
        conn,
        NewUser {
            email,
            full_name,
            role,
            password_hash: Some(password_hash),
        },
    )
    .await?;
    Ok(true)
}
