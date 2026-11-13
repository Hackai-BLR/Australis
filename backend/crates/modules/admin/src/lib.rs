//! `admin` module: the secretary's cross-campus screens (F13). Read-only: one list of campuses
//! and one of people, with text search and filters, and the campuses of one person.
//! Everything is read through `australis_core::directory`, which also applies the university
//! scope of an administrator. No table of its own, so no migration.

use australis_core::{
    directory::{self, CampusSummary, User, UserMembership, UserStatus},
    require_role, AppError, AppResult, AppState, CurrentUser, Role,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/campuses", get(campuses))
        .route("/admin/people", get(people))
        .route("/admin/people/{id}", get(person))
}

#[derive(Deserialize)]
struct CampusQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
struct PeopleQuery {
    q: Option<String>,
    role: Option<String>,
    status: Option<String>,
}

/// A person as the secretary's list shows them: no password data.
#[derive(Debug, Serialize)]
struct Person {
    id: i64,
    email: String,
    full_name: String,
    role: Role,
    status: UserStatus,
    created_at: String,
}

impl From<User> for Person {
    fn from(user: User) -> Self {
        Person {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            status: user.status,
            created_at: user.created_at,
        }
    }
}

#[derive(Serialize)]
struct PersonDetail {
    #[serde(flatten)]
    person: Person,
    memberships: Vec<UserMembership>,
}

/// Lowercased search text, or `None` when the box is empty.
fn needle(q: &Option<String>) -> Option<String> {
    q.as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase)
}

fn parse_role(value: Option<&str>) -> AppResult<Option<Role>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("student") => Ok(Some(Role::Student)),
        Some("professor") => Ok(Some(Role::Professor)),
        Some("secretary") => Ok(Some(Role::Secretary)),
        Some(_) => Err(AppError::Unprocessable(
            "the role filter is not valid".into(),
        )),
    }
}

fn parse_status(value: Option<&str>) -> AppResult<Option<UserStatus>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("invited") => Ok(Some(UserStatus::Invited)),
        Some("active") => Ok(Some(UserStatus::Active)),
        Some("suspended") => Ok(Some(UserStatus::Suspended)),
        Some(_) => Err(AppError::Unprocessable(
            "the status filter is not valid".into(),
        )),
    }
}

async fn campuses(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<CampusQuery>,
) -> AppResult<Json<Vec<CampusSummary>>> {
    let mut conn = state.db.acquire().await?;
    let mut list = directory::list_campus_summaries(&mut conn, &user).await?;
    if let Some(needle) = needle(&query.q) {
        list.retain(|campus| campus.name.to_lowercase().contains(&needle));
    }
    Ok(Json(list))
}

async fn people(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<PeopleQuery>,
) -> AppResult<Json<Vec<Person>>> {
    require_role(&user, &[Role::Secretary])?;
    let role = parse_role(query.role.as_deref())?;
    let status = parse_status(query.status.as_deref())?;
    let needle = needle(&query.q);
    let mut conn = state.db.acquire().await?;
    let list = directory::list_users_for(&mut conn, &user)
        .await?
        .into_iter()
        .filter(|u| role.is_none_or(|r| u.role == r))
        .filter(|u| status.is_none_or(|s| u.status == s))
        .filter(|u| {
            needle.as_deref().is_none_or(|n| {
                u.full_name.to_lowercase().contains(n) || u.email.to_lowercase().contains(n)
            })
        })
        .map(Person::from)
        .collect();
    Ok(Json(list))
}

async fn person(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<PersonDetail>> {
    require_role(&user, &[Role::Secretary])?;
    let mut conn = state.db.acquire().await?;
    let memberships = directory::list_memberships_of_user(&mut conn, &user, id).await?;
    let found = directory::find_user(&mut conn, id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(PersonDetail {
        person: found.into(),
        memberships,
    }))
}
