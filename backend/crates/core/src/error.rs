//! The error type every handler returns. The response body is `{"error": "<message>"}`.

use axum::{http::StatusCode, response::IntoResponse, Json};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 400: the request is malformed.
    #[error("{0}")]
    BadRequest(String),
    /// 401: no valid session.
    #[error("not signed in")]
    Unauthorized,
    /// 403: signed in, but not allowed.
    #[error("not allowed")]
    Forbidden,
    /// 404.
    #[error("not found")]
    NotFound,
    /// 409: the request conflicts with the current state (duplicate, stale version).
    #[error("{0}")]
    Conflict(String),
    /// 422: well-formed, but it breaks a rule (score outside the scale, missing reason).
    #[error("{0}")]
    Unprocessable(String),
    /// 429: a quota is used up.
    #[error("{0}")]
    TooManyRequests(String),
    /// 500 with a detail that is logged and never sent to the client.
    #[error("internal error: {0}")]
    Internal(String),
    /// 500 from the database. Unique violations never land here: they become `Conflict`.
    #[error(transparent)]
    Database(sqlx::Error),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) | AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &err {
            if db.is_unique_violation() {
                return AppError::Conflict("already exists".into());
            }
            if db.is_foreign_key_violation() {
                return AppError::Unprocessable("a referenced record does not exist".into());
            }
        }
        AppError::Database(err)
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Internal(format!("io: {err}"))
    }
}

impl From<ProviderError> for AppError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::NotConfigured(_) => AppError::Unprocessable(err.to_string()),
            ProviderError::Failed(detail) => AppError::Internal(format!("provider: {detail}")),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let status = self.status();
        let message = match &self {
            AppError::Internal(detail) => {
                tracing::error!(%detail, "internal error");
                "internal error".to_string()
            }
            AppError::Database(err) => {
                tracing::error!(error = %err, "database error");
                "internal error".to_string()
            }
            other => other.to_string(),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Failure of an outside provider (AI, Zoom, slide conversion).
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The provider is a placeholder that cannot do this, or it has no credentials.
    #[error("{0} is not configured")]
    NotConfigured(&'static str),
    #[error("{0}")]
    Failed(String),
}
