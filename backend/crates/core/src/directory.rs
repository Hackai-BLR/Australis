//! Users, campuses, memberships and invites: the kernel tables every module needs.
//!
//! Modules never query `core_*` tables themselves; they call these functions. Each takes a
//! connection, so it composes into the caller's transaction (`&mut *tx`).
//!
//! Rules enforced here:
//! - Nothing deletes a user or a member. A removed person is suspended, and the change is
//!   audited with who, when and why. (Database triggers also abort such a DELETE.)
//! - An invite can only be issued for an account that has no password, and accepting one
//!   fails if a password is already set, so an invite can never take over an account.
//! - Only the name and the email of a person are stored.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::{
    access::Access,
    audit::{self, AuditEntry},
    auth::{self, CurrentUser, Role},
    AppError, AppResult, Config,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum UserStatus {
    /// Created, but the person has not set a password yet.
    Invited,
    Active,
    Suspended,
}

/// The role of a user inside one campus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum MemberRole {
    /// Runs the campus: shapes it, imports students, grades, teaches.
    Professor,
    /// A guest teacher: grades and teaches, but cannot shape or import.
    Guest,
    Student,
}

impl MemberRole {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberRole::Professor => "professor",
            MemberRole::Guest => "guest",
            MemberRole::Student => "student",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum MemberStatus {
    Active,
    Suspended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub full_name: String,
    pub role: Role,
    pub status: UserStatus,
    pub created_at: String,
    pub has_password: bool,
}

impl From<User> for CurrentUser {
    fn from(user: User) -> Self {
        CurrentUser {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Campus {
    pub id: i64,
    pub name: String,
    pub owner_id: i64,
    pub created_at: String,
}

/// A campus as one user sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CampusForUser {
    pub id: i64,
    pub name: String,
    pub owner_id: i64,
    pub created_at: String,
    /// `None` for a secretary who is not a member.
    pub member_role: Option<MemberRole>,
    /// The highest access level the user has on this campus.
    pub access: Access,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Member {
    pub campus_id: i64,
    pub user_id: i64,
    pub role: MemberRole,
    pub status: MemberStatus,
    pub created_at: String,
    pub suspended_at: Option<String>,
    pub suspended_by: Option<i64>,
    pub suspended_reason: Option<String>,
}

/// A member with the person's details, for rosters and grids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct MemberDetail {
    pub user_id: i64,
    pub email: String,
    pub full_name: String,
    pub user_role: Role,
    pub user_status: UserStatus,
    pub role: MemberRole,
    pub status: MemberStatus,
    pub created_at: String,
    pub suspended_at: Option<String>,
    pub suspended_reason: Option<String>,
}

const USER_SELECT: &str = "SELECT u.id, u.email, u.full_name, u.role, u.status, u.created_at,
        (u.password_hash IS NOT NULL) AS has_password
    FROM core_users u";

const MEMBER_SELECT: &str = "SELECT campus_id, user_id, role, status, created_at, suspended_at,
        suspended_by, suspended_reason
    FROM core_members";

// ---------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------

pub struct NewUser<'a> {
    pub email: &'a str,
    pub full_name: &'a str,
    pub role: Role,
    /// `None` creates an invited account that needs an invite to set its password.
    pub password_hash: Option<String>,
}

/// Creates a user. 409 if the email is taken (emails compare case-insensitively).
pub async fn create_user(conn: &mut SqliteConnection, new: NewUser<'_>) -> AppResult<User> {
    let email = normalize_email(new.email)?;
    let full_name = required_text(new.full_name, "the name", 200)?;
    let status = if new.password_hash.is_some() {
        UserStatus::Active
    } else {
        UserStatus::Invited
    };
    let result = sqlx::query(
        "INSERT INTO core_users (email, full_name, role, password_hash, status)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&email)
    .bind(&full_name)
    .bind(new.role)
    .bind(new.password_hash)
    .bind(status)
    .execute(&mut *conn)
    .await
    .map_err(|err| conflict_as(err, "a user with that email already exists"))?;
    find_user(conn, result.last_insert_rowid())
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn find_user(conn: &mut SqliteConnection, user_id: i64) -> AppResult<Option<User>> {
    let user = sqlx::query_as::<_, User>(&format!("{USER_SELECT} WHERE u.id = ?"))
        .bind(user_id)
        .fetch_optional(conn)
        .await?;
    Ok(user)
}

pub async fn find_user_by_email(
    conn: &mut SqliteConnection,
    email: &str,
) -> AppResult<Option<User>> {
    let user = sqlx::query_as::<_, User>(&format!("{USER_SELECT} WHERE u.email = ?"))
        .bind(email.trim().to_lowercase())
        .fetch_optional(conn)
        .await?;
    Ok(user)
}

/// Every user, by name. For the secretary.
pub async fn list_users(conn: &mut SqliteConnection) -> AppResult<Vec<User>> {
    let users = sqlx::query_as::<_, User>(&format!(
        "{USER_SELECT} ORDER BY u.full_name COLLATE NOCASE, u.id"
    ))
    .fetch_all(conn)
    .await?;
    Ok(users)
}

/// A user together with the stored password hash, for sign-in only.
pub struct Credentials {
    pub user: User,
    pub password_hash: Option<String>,
}

pub async fn find_credentials(
    conn: &mut SqliteConnection,
    email: &str,
) -> AppResult<Option<Credentials>> {
    let Some(user) = find_user_by_email(conn, email).await? else {
        return Ok(None);
    };
    let password_hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM core_users WHERE id = ?")
            .bind(user.id)
            .fetch_one(conn)
            .await?;
    Ok(Some(Credentials {
        user,
        password_hash,
    }))
}

/// Suspends an account and ends its sessions. The reason is required and audited.
pub async fn suspend_user(
    conn: &mut SqliteConnection,
    actor_id: i64,
    user_id: i64,
    reason: &str,
) -> AppResult<User> {
    let reason = required_text(reason, "the reason", 500)?;
    if actor_id == user_id {
        return Err(AppError::Unprocessable(
            "you cannot suspend your own account".into(),
        ));
    }
    let mut tx = crate::begin_nested(conn).await?;
    let before = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if before.status == UserStatus::Suspended {
        return Err(AppError::Conflict("the user is already suspended".into()));
    }
    sqlx::query("UPDATE core_users SET status = ? WHERE id = ?")
        .bind(UserStatus::Suspended)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    auth::revoke_user_sessions(&mut tx, user_id).await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: None,
            entity: "user",
            entity_id: user_id,
            subject_user_id: Some(user_id),
            action: "suspend",
            before: Some(json!({ "status": before.status })),
            after: Some(json!({ "status": UserStatus::Suspended })),
            reason: Some(&reason),
        },
    )
    .await?;
    let user = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(user)
}

/// Lifts a suspension. The account goes back to active, or to invited if it never had a
/// password. The reason is required and audited.
pub async fn reactivate_user(
    conn: &mut SqliteConnection,
    actor_id: i64,
    user_id: i64,
    reason: &str,
) -> AppResult<User> {
    let reason = required_text(reason, "the reason", 500)?;
    let mut tx = crate::begin_nested(conn).await?;
    let before = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if before.status != UserStatus::Suspended {
        return Err(AppError::Conflict("the user is not suspended".into()));
    }
    let status = if before.has_password {
        UserStatus::Active
    } else {
        UserStatus::Invited
    };
    sqlx::query("UPDATE core_users SET status = ? WHERE id = ?")
        .bind(status)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: None,
            entity: "user",
            entity_id: user_id,
            subject_user_id: Some(user_id),
            action: "reactivate",
            before: Some(json!({ "status": before.status })),
            after: Some(json!({ "status": status })),
            reason: Some(&reason),
        },
    )
    .await?;
    let user = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(user)
}

// ---------------------------------------------------------------------------------------
// Campuses
// ---------------------------------------------------------------------------------------

/// Creates the campus identity row and makes the owner its first professor member. The
/// campus module stores the content in its own tables, keyed by the returned id.
pub async fn create_campus(
    conn: &mut SqliteConnection,
    actor_id: i64,
    name: &str,
    owner_id: i64,
) -> AppResult<Campus> {
    let name = required_text(name, "the campus name", 200)?;
    let mut tx = crate::begin_nested(conn).await?;
    let result = sqlx::query("INSERT INTO core_campuses (name, owner_id) VALUES (?, ?)")
        .bind(&name)
        .bind(owner_id)
        .execute(&mut *tx)
        .await?;
    let campus_id = result.last_insert_rowid();
    add_member(
        &mut tx,
        actor_id,
        campus_id,
        owner_id,
        MemberRole::Professor,
    )
    .await?;
    let campus = find_campus(&mut tx, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(campus)
}

pub async fn find_campus(conn: &mut SqliteConnection, campus_id: i64) -> AppResult<Option<Campus>> {
    let campus = sqlx::query_as::<_, Campus>(
        "SELECT id, name, owner_id, created_at FROM core_campuses WHERE id = ?",
    )
    .bind(campus_id)
    .fetch_optional(conn)
    .await?;
    Ok(campus)
}

#[derive(sqlx::FromRow)]
struct CampusRow {
    id: i64,
    name: String,
    owner_id: i64,
    created_at: String,
    member_role: Option<MemberRole>,
}

/// The campuses a user can open: every campus for a secretary, otherwise the ones where the
/// user is an active member. A student's courses are exactly this list.
pub async fn campuses_for_user(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
) -> AppResult<Vec<CampusForUser>> {
    let is_secretary = user.role == Role::Secretary;
    let rows = sqlx::query_as::<_, CampusRow>(
        "SELECT c.id, c.name, c.owner_id, c.created_at, m.role AS member_role
         FROM core_campuses c
         LEFT JOIN core_members m
            ON m.campus_id = c.id AND m.user_id = ?1 AND m.status = 'active'
         WHERE ?2 OR m.user_id IS NOT NULL
         ORDER BY c.name COLLATE NOCASE, c.id",
    )
    .bind(user.id)
    .bind(is_secretary)
    .fetch_all(conn)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let access = if is_secretary {
                Access::Manage
            } else {
                Access::of_member(row.member_role?)
            };
            Some(CampusForUser {
                id: row.id,
                name: row.name,
                owner_id: row.owner_id,
                created_at: row.created_at,
                member_role: row.member_role,
                access,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------

/// Adds a user to a campus. A student account can only be a student member; professor and
/// guest memberships need a professor or secretary account. 409 if already a member (also
/// when suspended: reactivate instead).
pub async fn add_member(
    conn: &mut SqliteConnection,
    actor_id: i64,
    campus_id: i64,
    user_id: i64,
    role: MemberRole,
) -> AppResult<Member> {
    let mut tx = crate::begin_nested(conn).await?;
    let user = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    find_campus(&mut tx, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let fits = match role {
        MemberRole::Student => user.role == Role::Student,
        MemberRole::Professor | MemberRole::Guest => user.role != Role::Student,
    };
    if !fits {
        return Err(AppError::Unprocessable(format!(
            "a {} account cannot be a {} member of a campus",
            user.role.as_str(),
            role.as_str()
        )));
    }
    sqlx::query("INSERT INTO core_members (campus_id, user_id, role) VALUES (?, ?, ?)")
        .bind(campus_id)
        .bind(user_id)
        .bind(role)
        .execute(&mut *tx)
        .await
        .map_err(|err| conflict_as(err, "the user is already a member of this campus"))?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: Some(campus_id),
            entity: "member",
            entity_id: user_id,
            subject_user_id: Some(user_id),
            action: "add",
            before: None,
            after: Some(json!({ "role": role, "status": MemberStatus::Active })),
            reason: None,
        },
    )
    .await?;
    let member = find_member(&mut tx, campus_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(member)
}

pub async fn find_member(
    conn: &mut SqliteConnection,
    campus_id: i64,
    user_id: i64,
) -> AppResult<Option<Member>> {
    let member = sqlx::query_as::<_, Member>(&format!(
        "{MEMBER_SELECT} WHERE campus_id = ? AND user_id = ?"
    ))
    .bind(campus_id)
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    Ok(member)
}

/// Every member of a campus, suspended ones included: professors, then guests, then
/// students, each by name.
pub async fn list_members(
    conn: &mut SqliteConnection,
    campus_id: i64,
) -> AppResult<Vec<MemberDetail>> {
    let members = sqlx::query_as::<_, MemberDetail>(
        "SELECT m.user_id, u.email, u.full_name, u.role AS user_role, u.status AS user_status,
                m.role, m.status, m.created_at, m.suspended_at, m.suspended_reason
         FROM core_members m
         JOIN core_users u ON u.id = m.user_id
         WHERE m.campus_id = ?
         ORDER BY CASE m.role WHEN 'professor' THEN 0 WHEN 'guest' THEN 1 ELSE 2 END,
                  u.full_name COLLATE NOCASE, u.id",
    )
    .bind(campus_id)
    .fetch_all(conn)
    .await?;
    Ok(members)
}

/// Suspends a member: the row stays, access ends. The reason is required and audited.
pub async fn suspend_member(
    conn: &mut SqliteConnection,
    actor_id: i64,
    campus_id: i64,
    user_id: i64,
    reason: &str,
) -> AppResult<Member> {
    let reason = required_text(reason, "the reason", 500)?;
    let mut tx = crate::begin_nested(conn).await?;
    let before = find_member(&mut tx, campus_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if before.status == MemberStatus::Suspended {
        return Err(AppError::Conflict("the member is already suspended".into()));
    }
    sqlx::query(
        "UPDATE core_members
         SET status = 'suspended', suspended_at = datetime('now'), suspended_by = ?,
             suspended_reason = ?
         WHERE campus_id = ? AND user_id = ?",
    )
    .bind(actor_id)
    .bind(&reason)
    .bind(campus_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: Some(campus_id),
            entity: "member",
            entity_id: user_id,
            subject_user_id: Some(user_id),
            action: "suspend",
            before: Some(json!({ "status": before.status })),
            after: Some(json!({ "status": MemberStatus::Suspended })),
            reason: Some(&reason),
        },
    )
    .await?;
    let member = find_member(&mut tx, campus_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(member)
}

/// Lifts a member's suspension. The reason is required and audited; the earlier suspension
/// stays in the audit log.
pub async fn reactivate_member(
    conn: &mut SqliteConnection,
    actor_id: i64,
    campus_id: i64,
    user_id: i64,
    reason: &str,
) -> AppResult<Member> {
    let reason = required_text(reason, "the reason", 500)?;
    let mut tx = crate::begin_nested(conn).await?;
    let before = find_member(&mut tx, campus_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if before.status != MemberStatus::Suspended {
        return Err(AppError::Conflict("the member is not suspended".into()));
    }
    sqlx::query(
        "UPDATE core_members
         SET status = 'active', suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL
         WHERE campus_id = ? AND user_id = ?",
    )
    .bind(campus_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: Some(campus_id),
            entity: "member",
            entity_id: user_id,
            subject_user_id: Some(user_id),
            action: "reactivate",
            before: Some(json!({
                "status": before.status,
                "suspended_at": before.suspended_at,
                "suspended_by": before.suspended_by,
                "suspended_reason": before.suspended_reason,
            })),
            after: Some(json!({ "status": MemberStatus::Active })),
            reason: Some(&reason),
        },
    )
    .await?;
    let member = find_member(&mut tx, campus_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(member)
}

// ---------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------

/// Issues (or re-issues) an invite and returns its token; only the token's hash is stored.
/// Earlier unused invites of the same account stop working. 409 if the account already has
/// a password or is suspended: an invite is never a password reset.
pub async fn create_invite(
    conn: &mut SqliteConnection,
    created_by: i64,
    user_id: i64,
    ttl_hours: i64,
) -> AppResult<String> {
    let mut tx = crate::begin_nested(conn).await?;
    let user = find_user(&mut tx, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if user.has_password {
        return Err(AppError::Conflict(
            "the account already has a password; an invite cannot be issued".into(),
        ));
    }
    if user.status == UserStatus::Suspended {
        return Err(AppError::Conflict("the account is suspended".into()));
    }
    sqlx::query(
        "UPDATE core_invites SET revoked_at = datetime('now')
         WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    let token = auth::new_token();
    sqlx::query(
        "INSERT INTO core_invites (token_hash, user_id, created_by, expires_at)
         VALUES (?, ?, ?, datetime('now', ?))",
    )
    .bind(auth::hash_token(&token))
    .bind(user_id)
    .bind(created_by)
    .bind(format!("+{ttl_hours} hours"))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(token)
}

/// The link a person opens to set their password. The frontend owns the `/invite/{token}`
/// page.
pub fn invite_url(config: &Config, token: &str) -> String {
    format!("{}/invite/{token}", config.app_base_url)
}

/// The account an invite token is for, if the invite can still be accepted.
pub async fn find_invite(conn: &mut SqliteConnection, token: &str) -> AppResult<Option<User>> {
    let user = sqlx::query_as::<_, User>(&format!(
        "{USER_SELECT}
         JOIN core_invites i ON i.user_id = u.id
         WHERE i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL
           AND i.expires_at > datetime('now')
           AND u.password_hash IS NULL AND u.status = 'invited'"
    ))
    .bind(auth::hash_token(token))
    .fetch_optional(conn)
    .await?;
    Ok(user)
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    user_id: i64,
    used: bool,
    revoked: bool,
    expired: bool,
}

/// Accepts an invite: sets the account's first password and activates it. 404 for an
/// unknown token; 409 if the invite was used, replaced or has expired, or if the account
/// already has a password; 403 if the account is suspended.
pub async fn accept_invite(
    conn: &mut SqliteConnection,
    token: &str,
    password_hash: &str,
) -> AppResult<User> {
    let token_hash = auth::hash_token(token);
    let mut tx = crate::begin_nested(conn).await?;
    let invite = sqlx::query_as::<_, InviteRow>(
        "SELECT user_id, (used_at IS NOT NULL) AS used, (revoked_at IS NOT NULL) AS revoked,
                (expires_at <= datetime('now')) AS expired
         FROM core_invites WHERE token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if invite.used || invite.revoked || invite.expired {
        return Err(AppError::Conflict("the invite is no longer valid".into()));
    }
    let user = find_user(&mut tx, invite.user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if user.status == UserStatus::Suspended {
        return Err(AppError::Forbidden);
    }
    // The WHERE clause is the guard: an account that already has a password is never changed.
    let updated = sqlx::query(
        "UPDATE core_users SET password_hash = ?, status = 'active'
         WHERE id = ? AND password_hash IS NULL",
    )
    .bind(password_hash)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "the account already has a password".into(),
        ));
    }
    sqlx::query("UPDATE core_invites SET used_at = datetime('now') WHERE token_hash = ?")
        .bind(&token_hash)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: None,
            entity: "user",
            entity_id: user.id,
            subject_user_id: Some(user.id),
            action: "activate",
            before: Some(json!({ "status": user.status })),
            after: Some(json!({ "status": UserStatus::Active })),
            reason: None,
        },
    )
    .await?;
    let user = find_user(&mut tx, user.id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    Ok(user)
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/// Trims and lowercases an email. 422 unless it looks like `name@domain`.
pub fn normalize_email(email: &str) -> AppResult<String> {
    let email = email.trim().to_lowercase();
    let valid = match email.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains('@')
                && !email.chars().any(char::is_whitespace)
                && email.len() <= 254
        }
        None => false,
    };
    if valid {
        Ok(email)
    } else {
        Err(AppError::Unprocessable("the email is not valid".into()))
    }
}

fn required_text(value: &str, what: &str, max_chars: usize) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Unprocessable(format!("{what} is required")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Unprocessable(format!(
            "{what} is longer than {max_chars} characters"
        )));
    }
    Ok(value.to_string())
}

fn conflict_as(err: sqlx::Error, message: &str) -> AppError {
    match AppError::from(err) {
        AppError::Conflict(_) => AppError::Conflict(message.into()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_normalised_and_checked() {
        assert_eq!(
            normalize_email("  Ana.Perez@Example.COM ").unwrap(),
            "ana.perez@example.com"
        );
        for bad in [
            "",
            "ana",
            "ana@",
            "@example.com",
            "ana@example",
            "a b@example.com",
            "a@b@c.com",
        ] {
            assert!(normalize_email(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn required_text_trims_and_limits() {
        assert_eq!(required_text("  hola ", "x", 10).unwrap(), "hola");
        assert!(required_text("   ", "x", 10).is_err());
        assert!(required_text("abcdef", "x", 5).is_err());
    }
}
