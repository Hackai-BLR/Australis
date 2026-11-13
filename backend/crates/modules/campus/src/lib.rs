//! `campus` module: campus templates, the campus document and its revision history.
//!
//! The kernel owns the campus identity row and the members (`core_*`); this module owns the
//! content (`campus_documents`, `campus_revisions`). Every write to the document goes through
//! [`save_document`], which writes the revision in the same transaction. The AI shaping
//! package plugs in through [`shaping`].

use std::collections::HashMap;

use australis_core::{
    begin_write, directory, require_campus, require_role, Access, AppError, AppResult, AppState,
    CampusAccess, CurrentUser, Role,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;

pub mod document;
mod settings;
mod shaping;
pub mod store;
pub mod templates;

pub use document::{Block, Document, Section, SectionKind, WidgetKind};
pub use store::{
    get_document, init_document, save_document, Revision, RevisionInfo, SaveMeta, StoredDocument,
    Via,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/campus-templates", get(list_templates))
        .route("/campuses", get(list_campuses).post(create_campus))
        .route("/campuses/{id}", get(get_campus))
        .route("/campuses/{id}/document", axum::routing::put(put_document))
        .route("/campuses/{id}/revisions", get(list_revisions))
        .route("/campuses/{id}/revisions/{rev}", get(get_revision))
        .route("/campuses/{id}/revisions/{rev}/restore", post(restore))
        .merge(shaping::router())
        .merge(settings::router())
}

// --- responses ------------------------------------------------------------------------------

/// A campus with its document, as one user sees it.
#[derive(Debug, Serialize)]
struct CampusView {
    id: i64,
    name: String,
    owner_id: i64,
    created_at: String,
    /// The caller's highest access level on this campus.
    access: Access,
    member_role: Option<directory::MemberRole>,
    template_key: String,
    version: i64,
    updated_at: String,
    document: Document,
}

async fn view(
    conn: &mut SqliteConnection,
    access: &CampusAccess,
    campus_id: i64,
) -> AppResult<CampusView> {
    let stored = get_document(conn, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut document = stored.document;
    if !access.can(Access::Teach) {
        // Students do not see sections the professor has hidden.
        document.sections.retain(|section| section.visible);
    }
    Ok(CampusView {
        id: access.campus.id,
        name: access.campus.name.clone(),
        owner_id: access.campus.owner_id,
        created_at: access.campus.created_at.clone(),
        access: access.level,
        member_role: access.member_role,
        template_key: stored.template_key,
        version: stored.version,
        updated_at: stored.updated_at,
        document,
    })
}

// --- templates ------------------------------------------------------------------------------

async fn list_templates(_user: CurrentUser) -> AppResult<Json<Vec<templates::Template>>> {
    Ok(Json(templates::all()?))
}

// --- campuses -------------------------------------------------------------------------------

async fn list_campuses(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<directory::CampusForUser>>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(directory::campuses_for_user(&mut conn, &user).await?))
}

#[derive(Deserialize)]
struct CreateCampus {
    name: String,
    template_key: String,
}

async fn create_campus(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateCampus>,
) -> AppResult<(StatusCode, Json<CampusView>)> {
    require_role(&user, &[Role::Professor, Role::Secretary])?;
    let template = templates::find(&body.template_key)?
        .ok_or_else(|| AppError::Unprocessable("unknown template".into()))?;
    let mut tx = begin_write(&state.db).await?;
    // The creator becomes the campus's professor member.
    let campus = directory::create_campus(&mut tx, user.id, &body.name, user.id).await?;
    init_document(
        &mut tx,
        campus.id,
        &template.key,
        template.document,
        user.id,
        &format!("Campus creado con la plantilla «{}»", template.name),
    )
    .await?;
    let access = require_campus(&mut tx, &user, campus.id, Access::Manage).await?;
    let created = view(&mut tx, &access, campus.id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn get_campus(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<CampusView>> {
    let mut conn = state.db.acquire().await?;
    let access = require_campus(&mut conn, &user, id, Access::View).await?;
    Ok(Json(view(&mut conn, &access, id).await?))
}

// --- document -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct PutDocument {
    /// The version the change was made on.
    version: i64,
    document: Value,
    summary: Option<String>,
}

async fn put_document(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<PutDocument>,
) -> AppResult<Json<CampusView>> {
    let mut tx = begin_write(&state.db).await?;
    let access = require_campus(&mut tx, &user, id, Access::Manage).await?;
    let document = Document::from_value(body.document)?;
    save_document(
        &mut tx,
        id,
        body.version,
        document,
        SaveMeta {
            user_id: user.id,
            via: Via::Editor,
            summary: body.summary.as_deref().unwrap_or(""),
            proposal_id: None,
        },
    )
    .await?;
    let saved = view(&mut tx, &access, id).await?;
    tx.commit().await?;
    Ok(Json(saved))
}

// --- revisions ------------------------------------------------------------------------------

#[derive(Serialize)]
struct RevisionEntry {
    #[serde(flatten)]
    info: RevisionInfo,
    created_by_name: Option<String>,
}

async fn author_names(conn: &mut SqliteConnection, ids: &[i64]) -> AppResult<HashMap<i64, String>> {
    let mut names = HashMap::new();
    for &id in ids {
        if let std::collections::hash_map::Entry::Vacant(slot) = names.entry(id) {
            if let Some(user) = directory::find_user(conn, id).await? {
                slot.insert(user.full_name);
            }
        }
    }
    Ok(names)
}

async fn list_revisions(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<RevisionEntry>>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, id, Access::Teach).await?;
    let revisions = store::list_revisions(&mut conn, id).await?;
    let author_ids: Vec<i64> = revisions.iter().map(|rev| rev.created_by).collect();
    let names = author_names(&mut conn, &author_ids).await?;
    Ok(Json(
        revisions
            .into_iter()
            .map(|info| RevisionEntry {
                created_by_name: names.get(&info.created_by).cloned(),
                info,
            })
            .collect(),
    ))
}

async fn get_revision(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, rev)): Path<(i64, i64)>,
) -> AppResult<Json<Revision>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, id, Access::Teach).await?;
    let revision = store::get_revision(&mut conn, id, rev)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(revision))
}

/// Restoring never rewrites history: the old content becomes a new, latest revision.
async fn restore(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, rev)): Path<(i64, i64)>,
) -> AppResult<Json<CampusView>> {
    let mut tx = begin_write(&state.db).await?;
    let access = require_campus(&mut tx, &user, id, Access::Manage).await?;
    let revision = store::get_revision(&mut tx, id, rev)
        .await?
        .ok_or(AppError::NotFound)?;
    let current = get_document(&mut tx, id).await?.ok_or(AppError::NotFound)?;
    save_document(
        &mut tx,
        id,
        current.version,
        revision.document,
        SaveMeta {
            user_id: user.id,
            via: Via::Restore,
            summary: &format!("Se restauró la versión {rev}"),
            proposal_id: None,
        },
    )
    .await?;
    let restored = view(&mut tx, &access, id).await?;
    tx.commit().await?;
    Ok(Json(restored))
}
