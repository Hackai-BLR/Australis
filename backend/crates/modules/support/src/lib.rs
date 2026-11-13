//! "Report a problem": any signed-in user files a report from any page. A report about a campus
//! goes to that campus's professors (and the secretary); any other report goes to the secretary.
//! The inbox has two states, open and resolved.

use std::collections::HashMap;

use australis_core::{
    directory, require_campus, require_role, Access, AppError, AppResult, AppState, CurrentUser,
    Role,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

const MAX_PAGE_CHARS: usize = 300;
const MAX_TEXT_CHARS: usize = 4000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/support/reports", get(list_reports).post(create_report))
        .route("/support/reports/{id}", patch(set_status))
}

#[derive(Serialize, sqlx::FromRow)]
struct Report {
    id: i64,
    campus_id: Option<i64>,
    reporter_id: i64,
    reporter_name: String,
    page: String,
    body: String,
    status: String,
    created_at: String,
    resolved_at: Option<String>,
}

const SELECT: &str = "SELECT r.id, r.campus_id, r.reporter_id, r.page, r.body, r.status,
        r.created_at, r.resolved_at, '' AS reporter_name FROM support_reports r";

#[derive(Deserialize)]
struct NewReport {
    page: String,
    campus_id: Option<i64>,
    text: String,
}

async fn fill_names(conn: &mut SqliteConnection, reports: &mut [Report]) -> AppResult<()> {
    let mut names: HashMap<i64, String> = HashMap::new();
    for report in reports {
        if let Some(name) = names.get(&report.reporter_id) {
            report.reporter_name = name.clone();
            continue;
        }
        let name = directory::find_user(conn, report.reporter_id)
            .await?
            .map(|user| user.full_name)
            .unwrap_or_default();
        names.insert(report.reporter_id, name.clone());
        report.reporter_name = name;
    }
    Ok(())
}

async fn one_report(conn: &mut SqliteConnection, id: i64) -> AppResult<Report> {
    let report = sqlx::query_as::<_, Report>(&format!("{SELECT} WHERE r.id = ?"))
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    let mut reports = [report];
    fill_names(conn, &mut reports).await?;
    let [report] = reports;
    Ok(report)
}

async fn create_report(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<NewReport>,
) -> AppResult<(StatusCode, Json<Report>)> {
    let page = body.page.trim().to_string();
    let text = body.text.trim().to_string();
    if page.is_empty() || page.chars().count() > MAX_PAGE_CHARS {
        return Err(AppError::Unprocessable(
            "the page is missing or too long".into(),
        ));
    }
    if text.is_empty() {
        return Err(AppError::Unprocessable("the report text is empty".into()));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::Unprocessable(
            "the report text is too long".into(),
        ));
    }
    let mut tx = australis_core::begin_write(&state.db).await?;
    if let Some(campus_id) = body.campus_id {
        require_campus(&mut tx, &user, campus_id, Access::View).await?;
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO support_reports (campus_id, reporter_id, page, body)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(body.campus_id)
    .bind(user.id)
    .bind(&page)
    .bind(&text)
    .fetch_one(&mut *tx)
    .await?;
    let report = one_report(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(report)))
}

/// Whether the user receives reports of this campus (`None` = reports not about a campus).
async fn receives(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
    campus_id: Option<i64>,
    cache: &mut HashMap<i64, bool>,
) -> AppResult<bool> {
    let Some(campus_id) = campus_id else {
        return Ok(user.role == Role::Secretary);
    };
    if let Some(known) = cache.get(&campus_id) {
        return Ok(*known);
    }
    let allowed = match require_campus(conn, user, campus_id, Access::Manage).await {
        Ok(_) => true,
        Err(AppError::Forbidden | AppError::NotFound) => false,
        Err(other) => return Err(other),
    };
    cache.insert(campus_id, allowed);
    Ok(allowed)
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
}

async fn list_reports(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Vec<Report>>> {
    require_role(&user, &[Role::Professor, Role::Secretary])?;
    let status = match query.status.as_deref() {
        None => None,
        Some(s @ ("open" | "resolved")) => Some(s),
        Some(_) => {
            return Err(AppError::BadRequest(
                "status must be open or resolved".into(),
            ))
        }
    };
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, Report>(&format!(
        "{SELECT} WHERE (? IS NULL OR r.status = ?) ORDER BY r.id DESC"
    ))
    .bind(status)
    .bind(status)
    .fetch_all(&mut *conn)
    .await?;
    let mut cache = HashMap::new();
    let mut visible = Vec::new();
    for row in rows {
        if receives(&mut conn, &user, row.campus_id, &mut cache).await? {
            visible.push(row);
        }
    }
    fill_names(&mut conn, &mut visible).await?;
    Ok(Json(visible))
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
}

async fn set_status(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<StatusBody>,
) -> AppResult<Json<Report>> {
    require_role(&user, &[Role::Professor, Role::Secretary])?;
    if body.status != "open" && body.status != "resolved" {
        return Err(AppError::Unprocessable(
            "status must be open or resolved".into(),
        ));
    }
    let mut tx = australis_core::begin_write(&state.db).await?;
    let campus_id: Option<Option<i64>> =
        sqlx::query_scalar("SELECT campus_id FROM support_reports WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let campus_id = campus_id.ok_or(AppError::NotFound)?;
    // Someone who cannot receive the report must not learn that it exists.
    if !receives(&mut tx, &user, campus_id, &mut HashMap::new()).await? {
        return Err(AppError::NotFound);
    }
    let resolved = body.status == "resolved";
    sqlx::query(
        "UPDATE support_reports SET status = ?,
            resolved_by = CASE WHEN ? THEN ? END,
            resolved_at = CASE WHEN ? THEN datetime('now') END
         WHERE id = ?",
    )
    .bind(&body.status)
    .bind(resolved)
    .bind(user.id)
    .bind(resolved)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let report = one_report(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(report))
}
