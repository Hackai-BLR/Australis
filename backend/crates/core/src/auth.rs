//! Passwords, sessions and the `CurrentUser` extractor.
//!
//! A session is a random token in an HttpOnly, SameSite=Lax cookie named `australis_session`.
//! Only the SHA-256 of the token is stored, so a copy of the database holds no usable session.
//!
//! With `AUTH_MODE=header` there is no cookie: the Campus IA core signs who the caller is
//! (`X-Campus-Identidad`, see `contratos/identidad-australis.md`) and [`CurrentUser`]
//! verifies it, creates the account on first sight and keeps its role in step with the core.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::{
    extract::FromRequestParts,
    http::{header::COOKIE, request::Parts, HeaderMap},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

use crate::{
    audit::{self, AuditEntry},
    config::{Argon2Cost, AuthMode},
    directory::{self, UserStatus},
    AppError, AppResult, AppState, Config,
};

pub const SESSION_COOKIE: &str = "australis_session";
pub const MIN_PASSWORD_LEN: usize = 8;

/// The header the Campus IA core adds to every request it forwards to Australis.
pub const IDENTITY_HEADER: &str = "x-campus-identidad";
/// The `curso` value of an identity issued for Australis.
pub const IDENTITY_AUDIENCE: &str = "australis";
const IDENTITY_MAX_LIFETIME_SECS: i64 = 120;
const IDENTITY_CLOCK_SKEW_SECS: i64 = 30;

/// The account role. A campus membership has its own role, see `directory::MemberRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Role {
    Student,
    Professor,
    Secretary,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Student => "student",
            Role::Professor => "professor",
            Role::Secretary => "secretary",
        }
    }
}

/// The signed-in user. As a handler argument it rejects the request with 401 when there is
/// no valid session or the account is not active. It serialises to the frozen
/// `{id, email, full_name, role}` shape of `/api/auth/me`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct CurrentUser {
    pub id: i64,
    pub email: String,
    pub full_name: String,
    pub role: Role,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        match state.config.auth_mode {
            AuthMode::Password => {
                let token = session_token(&parts.headers).ok_or(AppError::Unauthorized)?;
                let mut conn = state.db.acquire().await?;
                user_for_session(&mut conn, &token)
                    .await?
                    .ok_or(AppError::Unauthorized)
            }
            AuthMode::Header => {
                let key = state
                    .config
                    .identity_key
                    .as_ref()
                    .ok_or(AppError::Unauthorized)?;
                let value = parts
                    .headers
                    .get(IDENTITY_HEADER)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(AppError::Unauthorized)?;
                let identity =
                    verify_identity(key, value, now_secs()).ok_or(AppError::Unauthorized)?;
                user_for_identity(state, &identity).await
            }
        }
    }
}

/// Who the core says the caller is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub email: String,
    pub full_name: String,
    pub role: Role,
    /// The platform's id of the person's university, if any.
    pub university: Option<String>,
    /// Whether the person administers that university: a secretary limited to its campuses.
    pub administers: bool,
}

#[derive(Deserialize)]
struct IdentityClaims {
    v: i64,
    curso: String,
    email: String,
    #[serde(default)]
    nombre: String,
    rol: String,
    #[serde(default)]
    universidad: Option<String>,
    #[serde(default)]
    administrador: bool,
    emitido: i64,
    vence: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// The Australis role for a platform identity: the owner and a university administrator are
/// the secretary (the administrator only on their own university's campuses, see
/// `directory::university_scope`), a professor mark is a professor, everyone else is a student.
pub fn role_for_platform(rol: &str, administrador: bool) -> Role {
    if rol == "dueño" || administrador {
        Role::Secretary
    } else if rol == "profesor" {
        Role::Professor
    } else {
        Role::Student
    }
}

/// Checks the signed header value (`<payload>.<signature>`, both base64url) against the
/// core's public key. `None` for anything wrong: bad signature, wrong version or audience,
/// expired, issued in the future, or valid for longer than 120 seconds.
pub fn verify_identity(key: &VerifyingKey, header: &str, now: i64) -> Option<Identity> {
    let (payload, signature) = header.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let signature = Signature::from_slice(&signature).ok()?;
    key.verify_strict(payload.as_bytes(), &signature).ok()?;
    let claims: IdentityClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let valid = claims.v == 1
        && claims.curso == IDENTITY_AUDIENCE
        && claims.vence > now
        && claims.vence > claims.emitido
        && claims.vence - claims.emitido <= IDENTITY_MAX_LIFETIME_SECS
        && claims.emitido <= now + IDENTITY_CLOCK_SKEW_SECS;
    let university = claims.universidad.filter(|id| !id.trim().is_empty());
    let administers = claims.rol != "dueño" && claims.administrador && university.is_some();
    valid.then(|| Identity {
        email: claims.email,
        full_name: claims.nombre,
        role: role_for_platform(&claims.rol, administers),
        university,
        administers,
    })
}

/// The account for a verified identity. It is created on first sight (or activated, if the
/// roster import had already invited it) and its name and role follow the core. A suspended
/// account has no access: 403.
async fn user_for_identity(state: &AppState, identity: &Identity) -> AppResult<CurrentUser> {
    let email = directory::normalize_email(&identity.email).map_err(|_| AppError::Unauthorized)?;
    let name: String = identity.full_name.trim().chars().take(200).collect();
    {
        let mut conn = state.db.acquire().await?;
        if let Some(user) = directory::find_user_by_email(&mut conn, &email).await? {
            match user.status {
                UserStatus::Suspended => return Err(AppError::Forbidden),
                UserStatus::Active
                    if user.role == identity.role
                        && (name.is_empty() || user.full_name == name)
                        && directory::platform_university(&mut conn, user.id).await?
                            == (identity.university.clone(), identity.administers) =>
                {
                    return Ok(user.into());
                }
                _ => {}
            }
        }
    }
    let mut tx = crate::begin_write(&state.db).await?;
    let user = match directory::find_user_by_email(&mut tx, &email).await? {
        None => {
            let full_name = if name.is_empty() { &email } else { &name };
            sqlx::query(
                "INSERT INTO core_users (email, full_name, role, password_hash, status)
                 VALUES (?, ?, ?, NULL, 'active')",
            )
            .bind(&email)
            .bind(full_name)
            .bind(identity.role)
            .execute(&mut *tx)
            .await?;
            let user = directory::find_user_by_email(&mut tx, &email)
                .await?
                .ok_or(AppError::NotFound)?;
            directory::set_university(
                &mut tx,
                user.id,
                identity.university.as_deref(),
                identity.administers,
            )
            .await?;
            audit::record(
                &mut tx,
                AuditEntry {
                    actor_id: None,
                    campus_id: None,
                    entity: "user",
                    entity_id: user.id,
                    subject_user_id: Some(user.id),
                    action: "create_from_identity",
                    before: None,
                    after: Some(serde_json::json!({ "role": user.role, "status": user.status })),
                    reason: Some("first sign-in through the platform"),
                },
            )
            .await?;
            user
        }
        Some(before) => {
            if before.status == UserStatus::Suspended {
                return Err(AppError::Forbidden);
            }
            let full_name = if name.is_empty() {
                before.full_name.clone()
            } else {
                name
            };
            sqlx::query(
                "UPDATE core_users SET full_name = ?, role = ?, status = 'active' WHERE id = ?",
            )
            .bind(&full_name)
            .bind(identity.role)
            .bind(before.id)
            .execute(&mut *tx)
            .await?;
            let user = directory::find_user_by_email(&mut tx, &email)
                .await?
                .ok_or(AppError::NotFound)?;
            let before_university = directory::platform_university(&mut tx, user.id).await?;
            directory::set_university(
                &mut tx,
                user.id,
                identity.university.as_deref(),
                identity.administers,
            )
            .await?;
            if before.role != user.role
                || before.status != user.status
                || before_university != (identity.university.clone(), identity.administers)
            {
                audit::record(
                    &mut tx,
                    AuditEntry {
                        actor_id: None,
                        campus_id: None,
                        entity: "user",
                        entity_id: user.id,
                        subject_user_id: Some(user.id),
                        action: "sync_from_identity",
                        before: Some(
                            serde_json::json!({
                                "role": before.role,
                                "status": before.status,
                                "university": before_university.0,
                                "administers": before_university.1,
                            }),
                        ),
                        after: Some(serde_json::json!({
                            "role": user.role,
                            "status": user.status,
                            "university": identity.university,
                            "administers": identity.administers,
                        })),
                        reason: Some("the platform changed the role, the university or activated the account"),
                    },
                )
                .await?;
            }
            user
        }
    };
    tx.commit().await?;
    Ok(user.into())
}

/// The session token carried by the request's cookies, if any.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

/// The active user behind a session token, or `None` if the session is unknown or expired
/// or the account is not active.
pub async fn user_for_session(
    conn: &mut SqliteConnection,
    token: &str,
) -> AppResult<Option<CurrentUser>> {
    let user = sqlx::query_as::<_, CurrentUser>(
        "SELECT u.id, u.email, u.full_name, u.role
         FROM core_sessions s
         JOIN core_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.status = 'active'",
    )
    .bind(hash_token(token))
    .fetch_optional(conn)
    .await?;
    Ok(user)
}

/// Opens a session and returns the token to put in the cookie.
pub async fn create_session(
    conn: &mut SqliteConnection,
    user_id: i64,
    ttl_hours: i64,
) -> AppResult<String> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO core_sessions (token_hash, user_id, expires_at)
         VALUES (?, ?, datetime('now', ?))",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(format!("+{ttl_hours} hours"))
    .execute(conn)
    .await?;
    Ok(token)
}

/// Checks an email and a password and opens a session; returns the user and the token for
/// the cookie. Every failure is the same 401 (unknown email, wrong password, an account
/// that is suspended or has no password yet), so the answer does not reveal which accounts
/// exist.
pub async fn sign_in(
    state: &AppState,
    email: &str,
    password: &str,
) -> AppResult<(CurrentUser, String)> {
    let credentials = {
        let mut conn = state.db.acquire().await?;
        directory::find_credentials(&mut conn, email).await?
    };
    let Some((user, hash)) = credentials.and_then(|found| Some((found.user, found.password_hash?)))
    else {
        return Err(AppError::Unauthorized);
    };
    // No connection is held while the password is checked.
    if user.status != UserStatus::Active || !verify_password(&hash, password).await {
        return Err(AppError::Unauthorized);
    }
    let mut conn = state.db.acquire().await?;
    let token = create_session(&mut conn, user.id, state.config.session_ttl_hours).await?;
    Ok((user.into(), token))
}

/// Ends one session. Unknown tokens are ignored.
pub async fn revoke_session(conn: &mut SqliteConnection, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM core_sessions WHERE token_hash = ?")
        .bind(hash_token(token))
        .execute(conn)
        .await?;
    Ok(())
}

/// Ends every session of a user (used when the account is suspended).
pub async fn revoke_user_sessions(conn: &mut SqliteConnection, user_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM core_sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Removes sessions that have expired. Run at startup.
pub async fn purge_expired_sessions(conn: &mut SqliteConnection) -> AppResult<u64> {
    let result = sqlx::query("DELETE FROM core_sessions WHERE expires_at <= datetime('now')")
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

/// The `Set-Cookie` value that starts a session.
pub fn session_cookie(config: &Config, token: &str) -> String {
    let max_age = config.session_ttl_hours.saturating_mul(3600);
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        secure_suffix(config)
    )
}

/// The `Set-Cookie` value that ends a session in the browser.
pub fn clear_session_cookie(config: &Config) -> String {
    format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        secure_suffix(config)
    )
}

fn secure_suffix(config: &Config) -> &'static str {
    if config.cookie_secure {
        "; Secure"
    } else {
        ""
    }
}

/// A new random token (32 bytes, hex). Used for sessions and invites.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// What is stored for a token.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// 422 unless the password is long enough.
pub fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::Unprocessable(format!(
            "the password needs at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    Ok(())
}

/// Hashes a password with Argon2id off the async runtime.
pub async fn hash_password(config: &Config, password: &str) -> AppResult<String> {
    let cost = config.argon2.clone();
    let password = password.to_string();
    tokio::task::spawn_blocking(move || hash_password_blocking(&password, &cost))
        .await
        .map_err(|err| AppError::Internal(format!("password hashing task: {err}")))?
}

/// Checks a password against a stored hash off the async runtime. A malformed hash is a
/// mismatch.
pub async fn verify_password(hash: &str, password: &str) -> bool {
    let hash = hash.to_string();
    let password = password.to_string();
    tokio::task::spawn_blocking(move || verify_password_blocking(&hash, &password))
        .await
        .unwrap_or(false)
}

pub fn hash_password_blocking(password: &str, cost: &Argon2Cost) -> AppResult<String> {
    let params = Params::new(cost.memory_kib, cost.iterations, cost.parallelism, None)
        .map_err(|err| AppError::Internal(format!("argon2 parameters: {err}")))?;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt = SaltString::encode_b64(&salt)
        .map_err(|err| AppError::Internal(format!("argon2 salt: {err}")))?;
    let hash = Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password(password.as_bytes(), &salt)
        .map_err(|err| AppError::Internal(format!("argon2 hash: {err}")))?;
    Ok(hash.to_string())
}

pub fn verify_password_blocking(hash: &str, password: &str) -> bool {
    // The cost is read from the hash itself, so hashes made with any cost verify.
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn password_round_trip_uses_argon2id() {
        let hash = hash_password_blocking("correct horse", &Argon2Cost::for_tests()).unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password_blocking(&hash, "correct horse"));
        assert!(!verify_password_blocking(&hash, "wrong horse"));
        assert!(!verify_password_blocking("not a hash", "correct horse"));
    }

    fn signed(key: &ed25519_dalek::SigningKey, claims: serde_json::Value) -> String {
        use ed25519_dalek::Signer;
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signature = URL_SAFE_NO_PAD.encode(key.sign(payload.as_bytes()).to_bytes());
        format!("{payload}.{signature}")
    }

    fn claims(rol: &str, administrador: bool, emitido: i64, vence: i64) -> serde_json::Value {
        serde_json::json!({
            "v": 1, "curso": IDENTITY_AUDIENCE, "usuario": "7", "email": "ana@demo.test",
            "nombre": "Ana", "rol": rol, "administrador": administrador,
            "emitido": emitido, "vence": vence,
        })
    }

    #[test]
    fn identity_maps_platform_roles() {
        assert_eq!(role_for_platform("dueño", false), Role::Secretary);
        assert_eq!(role_for_platform("alumno", true), Role::Secretary);
        assert_eq!(role_for_platform("profesor", false), Role::Professor);
        assert_eq!(role_for_platform("alumno", false), Role::Student);
        assert_eq!(role_for_platform("algo raro", false), Role::Student);
    }

    #[test]
    fn identity_checks_signature_audience_and_time() {
        let signing = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
        let other = ed25519_dalek::SigningKey::from_bytes(&[4u8; 32]);
        let key = signing.verifying_key();
        let now = 1_000_000;

        let good = signed(&signing, claims("profesor", false, now - 5, now + 60));
        let identity = verify_identity(&key, &good, now).unwrap();
        assert_eq!(identity.role, Role::Professor);
        assert_eq!(identity.email, "ana@demo.test");

        let forged = signed(&other, claims("dueño", false, now - 5, now + 60));
        assert!(verify_identity(&key, &forged, now).is_none());
        let expired = signed(&signing, claims("alumno", false, now - 100, now - 1));
        assert!(verify_identity(&key, &expired, now).is_none());
        let future = signed(&signing, claims("alumno", false, now + 31, now + 60));
        assert!(verify_identity(&key, &future, now).is_none());
        let long = signed(&signing, claims("alumno", false, now - 5, now + 200));
        assert!(verify_identity(&key, &long, now).is_none());
        let mut wrong_course = claims("alumno", false, now - 5, now + 60);
        wrong_course["curso"] = "otro".into();
        assert!(verify_identity(&key, &signed(&signing, wrong_course), now).is_none());
        let mut wrong_version = claims("alumno", false, now - 5, now + 60);
        wrong_version["v"] = 2.into();
        assert!(verify_identity(&key, &signed(&signing, wrong_version), now).is_none());

        let (payload, _) = good.split_once('.').unwrap();
        assert!(verify_identity(&key, payload, now).is_none());
        assert!(verify_identity(&key, "a.b", now).is_none());
        assert!(verify_identity(&key, "", now).is_none());
    }

    #[test]
    fn finds_the_session_cookie_among_others() {
        let mut headers = HeaderMap::new();
        headers.append(
            COOKIE,
            HeaderValue::from_static("theme=dark; australis_session=abc123"),
        );
        assert_eq!(session_token(&headers).as_deref(), Some("abc123"));

        let mut headers = HeaderMap::new();
        headers.append(COOKIE, HeaderValue::from_static("xaustralis_session=nope"));
        assert_eq!(session_token(&headers), None);
    }

    #[test]
    fn cookie_flags() {
        let mut config = Config::default();
        let cookie = session_cookie(&config, "tok");
        assert!(cookie.starts_with("australis_session=tok; "));
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"));
        config.cookie_secure = true;
        assert!(session_cookie(&config, "tok").ends_with("; Secure"));
        assert!(clear_session_cookie(&config).contains("Max-Age=0"));
    }

    #[test]
    fn tokens_are_random_and_hashed() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_ne!(hash_token(&a), a);
        assert_eq!(hash_token(&a), hash_token(&a));
    }
}
