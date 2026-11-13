//! Who may do what.
//!
//! Account roles are student, professor and secretary. Inside a campus a member is a
//! professor, a guest (teacher) or a student. Handlers ask for one of three levels:
//!
//! | Level  | Who has it                                   | Used for                          |
//! |--------|----------------------------------------------|-----------------------------------|
//! | Manage | the secretary*; a professor member            | shaping, importing, settings      |
//! | Teach  | Manage, plus a guest member                  | grading, classes, presenting      |
//! | View   | Teach, plus an active student member         | reading the campus                |
//!
//! *A university administrator is a secretary only on the campuses of their own university;
//! the owner is one everywhere.
//!
//! A suspended member has no access. A suspended user cannot even sign in (`CurrentUser`
//! rejects the session).

use serde::Serialize;
use sqlx::SqliteConnection;

use crate::{
    auth::{CurrentUser, Role},
    directory::{self, Campus, MemberRole, MemberStatus},
    AppError, AppResult,
};

/// Access levels on one campus, lowest first, so `granted >= Access::Teach` works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    View,
    Teach,
    Manage,
}

impl Access {
    /// The highest level an active member with this role has.
    pub fn of_member(role: MemberRole) -> Self {
        match role {
            MemberRole::Professor => Access::Manage,
            MemberRole::Guest => Access::Teach,
            MemberRole::Student => Access::View,
        }
    }
}

/// What `require_campus` found: the campus and the caller's standing on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CampusAccess {
    pub campus: Campus,
    /// The highest level the caller has (at least the level that was required).
    pub level: Access,
    /// `None` for a secretary who is not a member.
    pub member_role: Option<MemberRole>,
}

impl CampusAccess {
    pub fn can(&self, needed: Access) -> bool {
        self.level >= needed
    }
}

/// 403 unless the user's account role is one of `allowed`.
pub fn require_role(user: &CurrentUser, allowed: &[Role]) -> AppResult<()> {
    if allowed.contains(&user.role) {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

/// 403 unless the secretary may act on this person: the owner may on anyone, a university
/// administrator only on people of their own university. 404 if the person does not exist.
pub async fn require_user_in_scope(
    conn: &mut SqliteConnection,
    actor: &CurrentUser,
    user_id: i64,
) -> AppResult<()> {
    let Some(scope) = directory::university_scope(conn, actor.id).await? else {
        return Ok(());
    };
    let target: Option<(Option<String>, String, bool)> = sqlx::query_as(
        "SELECT university, role, administers_university FROM core_users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    match target {
        None => Err(AppError::NotFound),
        // A secretary with rights on every campus (the owner) is out of reach.
        Some((_, role, administers)) if role == "secretary" && !administers => {
            Err(AppError::Forbidden)
        }
        Some((university, _, _)) if university.as_deref() == Some(scope.as_str()) => Ok(()),
        Some(_) => Err(AppError::Forbidden),
    }
}

/// Checks that the user has at least `needed` on the campus. 404 if the campus does not
/// exist, 403 if the user lacks the level.
pub async fn require_campus(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
    campus_id: i64,
    needed: Access,
) -> AppResult<CampusAccess> {
    let campus = directory::find_campus(conn, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let member_role = directory::find_member(conn, campus_id, user.id)
        .await?
        .filter(|member| member.status == MemberStatus::Active)
        .map(|member| member.role);
    let scope = if user.role == Role::Secretary {
        directory::university_scope(conn, user.id).await?
    } else {
        None
    };
    let level = if user.role == Role::Secretary
        && directory::scope_reaches(scope.as_deref(), campus.university.as_deref())
    {
        Some(Access::Manage)
    } else {
        // A professor or guest seat only counts for an account that still has a teaching
        // role: when the platform takes the professor mark away, the person is a student
        // again and keeps no more than view access.
        member_role.map(|role| {
            let level = Access::of_member(role);
            if user.role == Role::Student {
                level.min(Access::View)
            } else {
                level
            }
        })
    };
    match level {
        Some(level) if level >= needed => Ok(CampusAccess {
            campus,
            level,
            member_role,
        }),
        _ => Err(AppError::Forbidden),
    }
}
