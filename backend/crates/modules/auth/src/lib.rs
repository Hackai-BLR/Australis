//! Sign-in with email and password, sessions, invites and the secretary's user management.
//!
//! All data access goes through `australis_core` (the `core_*` tables); this module has no
//! tables of its own.

use australis_core::{
    audit::{self, AuditEntry},
    auth::{self, clear_session_cookie, session_cookie, session_token},
    begin_write,
    directory::{self, NewUser, User, UserStatus},
    require_role, AppError, AppResult, AppState, CurrentUser, Role,
};
use axum::{
    extract::{Path, State},
    http::{header::SET_COOKIE, HeaderMap, HeaderName, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/invites/{token}", get(show_invite))
        .route("/auth/invites/{token}/accept", post(accept_invite))
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", patch(update_user))
}

type Cookie = [(HeaderName, String); 1];

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> AppResult<(Cookie, Json<CurrentUser>)> {
    let (user, token) = auth::sign_in(&state, &body.email, &body.password).await?;
    Ok((
        [(SET_COOKIE, session_cookie(&state.config, &token))],
        Json(user),
    ))
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<(StatusCode, Cookie)> {
    if let Some(token) = session_token(&headers) {
        let mut conn = state.db.acquire().await?;
        auth::revoke_session(&mut conn, &token).await?;
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(SET_COOKIE, clear_session_cookie(&state.config))],
    ))
}

async fn me(user: CurrentUser) -> Json<CurrentUser> {
    Json(user)
}

// --- invites ----------------------------------------------------------------------------

async fn show_invite(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let user = directory::find_invite(&mut conn, &token)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(json!({
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
    })))
}

#[derive(Deserialize)]
struct AcceptBody {
    password: String,
}

async fn accept_invite(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<AcceptBody>,
) -> AppResult<(Cookie, Json<CurrentUser>)> {
    auth::validate_password(&body.password)?;
    let hash = auth::hash_password(&state.config, &body.password).await?;
    let mut tx = begin_write(&state.db).await?;
    let user = directory::accept_invite(&mut tx, &token, &hash).await?;
    let session = auth::create_session(&mut tx, user.id, state.config.session_ttl_hours).await?;
    tx.commit().await?;
    Ok((
        [(SET_COOKIE, session_cookie(&state.config, &session))],
        Json(user.into()),
    ))
}

// --- user management (secretary only) -----------------------------------------------------

fn require_secretary(user: &CurrentUser) -> AppResult<()> {
    require_role(user, &[Role::Secretary])
}

async fn list_users(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<User>>> {
    require_secretary(&user)?;
    let mut conn = state.db.acquire().await?;
    Ok(Json(directory::list_users(&mut conn).await?))
}

#[derive(Deserialize)]
struct CreateUserBody {
    email: String,
    full_name: String,
    role: Role,
}

async fn create_user(
    State(state): State<AppState>,
    actor: CurrentUser,
    Json(body): Json<CreateUserBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require_secretary(&actor)?;
    if body.role == Role::Student {
        return Err(AppError::Unprocessable(
            "students join a campus through the roster import".into(),
        ));
    }
    let mut tx = begin_write(&state.db).await?;
    let user = directory::create_user(
        &mut tx,
        NewUser {
            email: &body.email,
            full_name: &body.full_name,
            role: body.role,
            password_hash: None,
        },
    )
    .await?;
    let token =
        directory::create_invite(&mut tx, actor.id, user.id, state.config.invite_ttl_hours).await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor.id),
            campus_id: None,
            entity: "user",
            entity_id: user.id,
            subject_user_id: Some(user.id),
            action: "create",
            before: None,
            after: Some(json!({ "role": user.role, "status": user.status })),
            reason: None,
        },
    )
    .await?;
    tx.commit().await?;
    let invite_url = directory::invite_url(&state.config, &token);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "user": user, "invite_url": invite_url })),
    ))
}

#[derive(Deserialize)]
struct UpdateUserBody {
    /// `suspended` or `active`.
    status: UserStatus,
    reason: String,
}

async fn update_user(
    State(state): State<AppState>,
    actor: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserBody>,
) -> AppResult<Json<User>> {
    require_secretary(&actor)?;
    let mut tx = begin_write(&state.db).await?;
    let user = match body.status {
        UserStatus::Suspended => {
            directory::suspend_user(&mut tx, actor.id, id, &body.reason).await?
        }
        UserStatus::Active => {
            directory::reactivate_user(&mut tx, actor.id, id, &body.reason).await?
        }
        UserStatus::Invited => {
            return Err(AppError::Unprocessable(
                "the status must be suspended or active".into(),
            ))
        }
    };
    tx.commit().await?;
    Ok(Json(user))
}
