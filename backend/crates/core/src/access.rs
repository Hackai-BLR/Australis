//! Who may do what.
//!
//! Account roles are student, professor and secretary. Inside a campus a member is a
//! professor, a guest (teacher) or a student. Handlers ask for one of three levels:
//!
//! | Level  | Who has it                                   | Used for                          |
//! |--------|----------------------------------------------|-----------------------------------|
//! | Manage | the secretary; a professor member            | shaping, importing, settings      |
//! | Teach  | Manage, plus a guest member                  | grading, classes, presenting      |
//! | View   | Teach, plus an active student member         | reading the campus                |
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
    let level = if user.role == Role::Secretary {
        Some(Access::Manage)
    } else {
        member_role.map(Access::of_member)
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
