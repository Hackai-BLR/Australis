//! Runtime configuration, read once from the environment and shared as `Arc<Config>`.
//! The variable names are frozen; `.env.example` lists them all.

use std::path::PathBuf;

/// Argon2id cost. The default follows the OWASP minimum; tests use `for_tests()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Argon2Cost {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Argon2Cost {
    fn default() -> Self {
        Self {
            memory_kib: 19_456,
            iterations: 2,
            parallelism: 1,
        }
    }
}

impl Argon2Cost {
    /// The cheapest cost Argon2 accepts, so tests that sign in stay fast.
    pub fn for_tests() -> Self {
        Self {
            memory_kib: 8,
            iterations: 1,
            parallelism: 1,
        }
    }
}

/// How the caller is identified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Email and password with a session cookie. For local development and the tests.
    Password,
    /// The Campus IA core signs who the caller is and forwards the request with the
    /// `X-Campus-Identidad` header; the password routes and invites are off.
    Header,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Password => "password",
            AuthMode::Header => "header",
        }
    }
}

#[derive(Clone)]
pub struct Config {
    /// `DATABASE_URL`
    pub database_url: String,
    /// `BIND_ADDR`
    pub bind_addr: String,
    /// `SESSION_TTL_HOURS`
    pub session_ttl_hours: i64,
    /// `COOKIE_SECURE`: add `Secure` to the session cookie (needs HTTPS).
    pub cookie_secure: bool,
    /// `UPLOAD_DIR`: root of the `FileStore`.
    pub upload_dir: PathBuf,
    /// `MAX_UPLOAD_MB`: body limit of upload routes.
    pub max_upload_mb: u64,
    /// `APP_BASE_URL`: origin of the frontend, used to build invite links.
    pub app_base_url: String,
    /// `AI_PROVIDER`: only `placeholder` exists in this build.
    pub ai_provider: String,
    /// `AI_API_KEY`: unused until a real provider exists.
    pub ai_api_key: Option<String>,
    /// `ZOOM_PROVIDER`: only `placeholder` exists in this build.
    pub zoom_provider: String,
    /// `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`: unused until a real provider exists.
    pub zoom_account_id: Option<String>,
    pub zoom_client_id: Option<String>,
    pub zoom_client_secret: Option<String>,
    /// `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`: create the first secretary at startup.
    pub seed_admin_email: Option<String>,
    pub seed_admin_password: Option<String>,
    /// `SEED_DEMO`: also create fake professor and student accounts.
    pub seed_demo: bool,
    /// `AUTH_MODE`: `password` (default) or `header`.
    pub auth_mode: AuthMode,
    /// `IDENTITY_PUBLIC_KEY`: the core's Ed25519 public key (32 bytes, base64url without
    /// padding). Required when `AUTH_MODE=header`.
    pub identity_key: Option<ed25519_dalek::VerifyingKey>,
    /// How long an invite link works. Not an environment variable.
    pub invite_ttl_hours: i64,
    /// Not an environment variable; tests lower it.
    pub argon2: Argon2Cost,
}

pub const PLACEHOLDER_PROVIDER: &str = "placeholder";
pub const DEFAULT_MAX_UPLOAD_MB: u64 = 25;

impl Default for Config {
    fn default() -> Self {
        Self {
            database_url: "sqlite://australis.db".into(),
            bind_addr: "0.0.0.0:8080".into(),
            session_ttl_hours: 168,
            cookie_secure: false,
            upload_dir: PathBuf::from("uploads"),
            max_upload_mb: DEFAULT_MAX_UPLOAD_MB,
            app_base_url: "http://localhost:5173".into(),
            ai_provider: PLACEHOLDER_PROVIDER.into(),
            ai_api_key: None,
            zoom_provider: PLACEHOLDER_PROVIDER.into(),
            zoom_account_id: None,
            zoom_client_id: None,
            zoom_client_secret: None,
            seed_admin_email: None,
            seed_admin_password: None,
            seed_demo: false,
            auth_mode: AuthMode::Password,
            identity_key: None,
            invite_ttl_hours: 24 * 14,
            argon2: Argon2Cost::default(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid configuration: {0}")]
pub struct ConfigError(pub String);

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Builds the configuration from any name-to-value lookup. An unset or empty variable
    /// takes its default.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let defaults = Self::default();

        let session_ttl_hours = match get("SESSION_TTL_HOURS") {
            Some(raw) => parse_positive("SESSION_TTL_HOURS", &raw)?,
            None => defaults.session_ttl_hours,
        };
        let max_upload_mb = match get("MAX_UPLOAD_MB") {
            Some(raw) => parse_positive("MAX_UPLOAD_MB", &raw)? as u64,
            None => defaults.max_upload_mb,
        };

        let auth_mode = match get("AUTH_MODE").map(|mode| mode.to_lowercase()).as_deref() {
            None | Some("password") => AuthMode::Password,
            Some("header") => AuthMode::Header,
            Some(other) => {
                return Err(ConfigError(format!(
                    "AUTH_MODE must be password or header, got {other:?}"
                )))
            }
        };
        let identity_key = get("IDENTITY_PUBLIC_KEY")
            .map(|raw| parse_public_key(&raw))
            .transpose()?;
        if auth_mode == AuthMode::Header && identity_key.is_none() {
            return Err(ConfigError(
                "AUTH_MODE=header needs IDENTITY_PUBLIC_KEY".into(),
            ));
        }

        Ok(Self {
            database_url: get("DATABASE_URL").unwrap_or(defaults.database_url),
            bind_addr: get("BIND_ADDR").unwrap_or(defaults.bind_addr),
            session_ttl_hours,
            cookie_secure: parse_bool("COOKIE_SECURE", get("COOKIE_SECURE"))?,
            upload_dir: get("UPLOAD_DIR")
                .map(PathBuf::from)
                .unwrap_or(defaults.upload_dir),
            max_upload_mb,
            app_base_url: get("APP_BASE_URL")
                .map(|url| url.trim_end_matches('/').to_string())
                .unwrap_or(defaults.app_base_url),
            ai_provider: get("AI_PROVIDER")
                .map(|name| name.to_lowercase())
                .unwrap_or(defaults.ai_provider),
            ai_api_key: get("AI_API_KEY"),
            zoom_provider: get("ZOOM_PROVIDER")
                .map(|name| name.to_lowercase())
                .unwrap_or(defaults.zoom_provider),
            zoom_account_id: get("ZOOM_ACCOUNT_ID"),
            zoom_client_id: get("ZOOM_CLIENT_ID"),
            zoom_client_secret: get("ZOOM_CLIENT_SECRET"),
            seed_admin_email: get("SEED_ADMIN_EMAIL"),
            seed_admin_password: get("SEED_ADMIN_PASSWORD"),
            seed_demo: parse_bool("SEED_DEMO", get("SEED_DEMO"))?,
            auth_mode,
            identity_key,
            invite_ttl_hours: defaults.invite_ttl_hours,
            argon2: defaults.argon2,
        })
    }

    pub fn max_upload_bytes(&self) -> usize {
        mb_to_bytes(self.max_upload_mb)
    }
}

pub(crate) fn mb_to_bytes(mb: u64) -> usize {
    usize::try_from(mb.saturating_mul(1024 * 1024)).unwrap_or(usize::MAX)
}

fn parse_public_key(raw: &str) -> Result<ed25519_dalek::VerifyingKey, ConfigError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let invalid = || {
        ConfigError(
            "IDENTITY_PUBLIC_KEY must be an Ed25519 public key (32 bytes, base64url)".into(),
        )
    };
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| invalid())?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| invalid())
}

fn parse_positive(name: &str, raw: &str) -> Result<i64, ConfigError> {
    match raw.parse::<i64>() {
        Ok(value) if value > 0 => Ok(value),
        _ => Err(ConfigError(format!(
            "{name} must be a positive whole number, got {raw:?}"
        ))),
    }
}

fn parse_bool(name: &str, raw: Option<String>) -> Result<bool, ConfigError> {
    match raw.as_deref().map(str::to_lowercase).as_deref() {
        None | Some("false" | "0" | "no") => Ok(false),
        Some("true" | "1" | "yes") => Ok(true),
        Some(other) => Err(ConfigError(format!(
            "{name} must be true or false, got {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_unset_variables_take_defaults() {
        let config = Config::from_lookup(|name| match name {
            "AI_API_KEY" | "SEED_DEMO" => Some(String::new()),
            _ => None,
        })
        .unwrap();
        assert_eq!(config.ai_provider, PLACEHOLDER_PROVIDER);
        assert_eq!(config.ai_api_key, None);
        assert!(!config.seed_demo);
        assert_eq!(config.max_upload_mb, DEFAULT_MAX_UPLOAD_MB);
        assert_eq!(config.argon2, Argon2Cost::default());
    }

    #[test]
    fn reads_the_frozen_names() {
        let config = Config::from_lookup(|name| {
            Some(
                match name {
                    "DATABASE_URL" => "sqlite:///data/x.db",
                    "BIND_ADDR" => "127.0.0.1:9000",
                    "SESSION_TTL_HOURS" => "12",
                    "COOKIE_SECURE" => "true",
                    "UPLOAD_DIR" => "/uploads",
                    "MAX_UPLOAD_MB" => "40",
                    "APP_BASE_URL" => "https://campus.example/",
                    "AI_PROVIDER" => "Placeholder",
                    "ZOOM_PROVIDER" => "placeholder",
                    "SEED_ADMIN_EMAIL" => "admin@example.com",
                    "SEED_ADMIN_PASSWORD" => "a-long-password",
                    "SEED_DEMO" => "1",
                    _ => return None,
                }
                .to_string(),
            )
        })
        .unwrap();
        assert_eq!(config.database_url, "sqlite:///data/x.db");
        assert_eq!(config.bind_addr, "127.0.0.1:9000");
        assert_eq!(config.session_ttl_hours, 12);
        assert!(config.cookie_secure);
        assert_eq!(config.upload_dir, PathBuf::from("/uploads"));
        assert_eq!(config.max_upload_bytes(), 40 * 1024 * 1024);
        assert_eq!(config.app_base_url, "https://campus.example");
        assert_eq!(config.ai_provider, "placeholder");
        assert_eq!(
            config.seed_admin_email.as_deref(),
            Some("admin@example.com")
        );
        assert!(config.seed_demo);
    }

    #[test]
    fn header_mode_needs_a_valid_public_key() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let encoded = URL_SAFE_NO_PAD.encode(key.to_bytes());
        let with = |mode: &'static str, key: Option<String>| {
            Config::from_lookup(move |name| match name {
                "AUTH_MODE" => Some(mode.into()),
                "IDENTITY_PUBLIC_KEY" => key.clone(),
                _ => None,
            })
        };
        assert_eq!(
            with("password", None).unwrap().auth_mode,
            AuthMode::Password
        );
        assert!(with("header", None).is_err());
        assert!(with("header", Some("not a key".into())).is_err());
        assert!(with("header", Some(URL_SAFE_NO_PAD.encode([1u8; 8]))).is_err());
        assert!(with("magic", Some(encoded.clone())).is_err());
        let config = with("Header", Some(encoded)).unwrap();
        assert_eq!(config.auth_mode, AuthMode::Header);
        assert_eq!(config.identity_key, Some(key));
        assert_eq!(Config::default().auth_mode, AuthMode::Password);
    }

    #[test]
    fn rejects_bad_values() {
        assert!(
            Config::from_lookup(|name| (name == "SESSION_TTL_HOURS").then(|| "0".into())).is_err()
        );
        assert!(
            Config::from_lookup(|name| (name == "COOKIE_SECURE").then(|| "maybe".into())).is_err()
        );
    }
}
