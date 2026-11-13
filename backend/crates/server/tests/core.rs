//! Kernel rules: sessions, the access matrix, the AI quota, the audit log, invites, file
//! storage and settings.

mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use australis_core::{
    access::{require_campus, require_role, Access},
    ai::{
        self, AiProvider, AiReply, AiRequest, AiTool, Reservation, UsageQuery, UsageStatus,
        FEATURE_SHAPING,
    },
    audit::{self, AuditEntry, AuditQuery},
    auth,
    directory::{self, MemberRole, MemberStatus, NewUser, UserStatus},
    http::upload_body_limit,
    settings, AppError, AppState, CurrentUser, ProviderError, Role,
};
use axum::{
    body::{Body, Bytes},
    http::{Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use common::{Part, TestApp, TestUser};
use serde_json::json;

// ---------------------------------------------------------------------------------------
// Sessions and the CurrentUser extractor
// ---------------------------------------------------------------------------------------

async fn whoami(user: CurrentUser) -> Json<CurrentUser> {
    Json(user)
}

fn whoami_router(app: &TestApp) -> Router {
    Router::new()
        .route("/whoami", get(whoami))
        .with_state(app.state.clone())
}

async fn whoami_status(router: &Router, cookie: Option<&str>) -> StatusCode {
    let request = common::request(Method::GET, "/whoami", cookie)
        .body(Body::empty())
        .unwrap();
    common::send(router, request).await.status
}

#[tokio::test]
async fn no_cookie_is_401() {
    let app = TestApp::new().await;
    let router = whoami_router(&app);

    let request = common::request(Method::GET, "/whoami", None)
        .body(Body::empty())
        .unwrap();
    let response = common::send(&router, request).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json(), json!({ "error": "not signed in" }));

    for cookie in [
        "australis_session=",
        "australis_session=not-a-real-token",
        "other=1",
    ] {
        assert_eq!(
            whoami_status(&router, Some(cookie)).await,
            StatusCode::UNAUTHORIZED,
            "{cookie}"
        );
    }
}

#[tokio::test]
async fn a_session_cookie_identifies_the_user_in_the_frozen_shape() {
    let app = TestApp::new().await;
    let router = whoami_router(&app);
    let professor = app.login_as(Role::Professor).await;

    let request = common::request(Method::GET, "/whoami", Some(&professor.cookie))
        .body(Body::empty())
        .unwrap();
    let response = common::send(&router, request).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.json(),
        json!({
            "id": professor.id,
            "email": professor.email,
            "full_name": professor.full_name,
            "role": "professor",
        })
    );
}

#[tokio::test]
async fn expired_revoked_and_suspended_sessions_are_401() {
    let app = TestApp::new().await;
    let router = whoami_router(&app);
    let mut conn = app.db.acquire().await.unwrap();

    // Expired.
    let expired = app.login_as(Role::Student).await;
    assert_eq!(
        whoami_status(&router, Some(&expired.cookie)).await,
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE core_sessions SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?",
    )
    .bind(expired.id)
    .execute(&app.db)
    .await
    .unwrap();
    assert_eq!(
        whoami_status(&router, Some(&expired.cookie)).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(auth::purge_expired_sessions(&mut conn).await.unwrap(), 1);

    // Revoked (sign-out).
    let revoked = app.login_as(Role::Student).await;
    let token = revoked.cookie.split_once('=').unwrap().1;
    auth::revoke_session(&mut conn, token).await.unwrap();
    assert_eq!(
        whoami_status(&router, Some(&revoked.cookie)).await,
        StatusCode::UNAUTHORIZED
    );

    // Suspended account: its sessions end, and a new one would not work either.
    let secretary = app.login_as(Role::Secretary).await;
    let suspended = app.login_as(Role::Professor).await;
    directory::suspend_user(&mut conn, secretary.id, suspended.id, "left the program")
        .await
        .unwrap();
    assert_eq!(
        whoami_status(&router, Some(&suspended.cookie)).await,
        StatusCode::UNAUTHORIZED
    );
    let token = auth::create_session(&mut conn, suspended.id, 1)
        .await
        .unwrap();
    assert_eq!(
        auth::user_for_session(&mut conn, &token).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn only_the_token_hash_is_stored() {
    let app = TestApp::new().await;
    let user = app.login_as(Role::Student).await;
    let token = user.cookie.split_once('=').unwrap().1;
    let stored: String =
        sqlx::query_scalar("SELECT token_hash FROM core_sessions WHERE user_id = ?")
            .bind(user.id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_ne!(stored, token);
    assert_eq!(stored, auth::hash_token(token));
}

#[tokio::test]
async fn sign_in_opens_a_session_only_for_an_active_account_with_the_right_password() {
    let app = TestApp::new().await;
    let router = whoami_router(&app);
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let invited = invited_student(&app, "sin-clave@test.example").await;

    let (user, token) = auth::sign_in(
        &app.state,
        &professor.email.to_uppercase(),
        common::TEST_PASSWORD,
    )
    .await
    .unwrap();
    assert_eq!(user, professor.current());
    let cookie = auth::session_cookie(&app.state.config, &token);
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(whoami_status(&router, Some(cookie)).await, StatusCode::OK);

    // Every failure looks the same.
    let mut conn = app.db.acquire().await.unwrap();
    directory::suspend_user(&mut conn, secretary.id, professor.id, "left")
        .await
        .unwrap();
    drop(conn);
    for (email, password) in [
        (secretary.email.as_str(), "wrong-password"),
        ("nobody@test.example", common::TEST_PASSWORD),
        (invited.email.as_str(), common::TEST_PASSWORD),
        (invited.email.as_str(), ""),
        (professor.email.as_str(), common::TEST_PASSWORD),
    ] {
        let err = auth::sign_in(&app.state, email, password)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Unauthorized), "{email}");
    }
}

// ---------------------------------------------------------------------------------------
// Access matrix
// ---------------------------------------------------------------------------------------

/// The highest level the user has on the campus, or the error of asking for View.
async fn level(app: &TestApp, user: &TestUser, campus_id: i64) -> Result<Access, StatusCode> {
    let mut conn = app.db.acquire().await.unwrap();
    require_campus(&mut conn, &user.current(), campus_id, Access::View)
        .await
        .map(|access| access.level)
        .map_err(|err| err.status())
}

async fn allowed(app: &TestApp, user: &TestUser, campus_id: i64, needed: Access) -> bool {
    let mut conn = app.db.acquire().await.unwrap();
    match require_campus(&mut conn, &user.current(), campus_id, needed).await {
        Ok(access) => {
            assert!(access.can(needed));
            true
        }
        Err(AppError::Forbidden) => false,
        Err(other) => panic!("unexpected error: {other}"),
    }
}

#[tokio::test]
async fn access_matrix() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let owner = app.login_as(Role::Professor).await;
    let other_professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let other_campus = app.seed_campus(&other_professor).await;
    let guest = app.seed_guest(campus).await;
    let student = app.seed_student(campus).await;
    let outsider = app.login_as(Role::Student).await;

    // Secretary: everything on any campus, without being a member.
    for id in [campus, other_campus] {
        assert!(allowed(&app, &secretary, id, Access::Manage).await);
        assert_eq!(level(&app, &secretary, id).await, Ok(Access::Manage));
    }

    // Professor: Manage on their own campus, nothing on someone else's.
    assert!(allowed(&app, &owner, campus, Access::Manage).await);
    assert!(allowed(&app, &owner, campus, Access::Teach).await);
    assert!(allowed(&app, &owner, campus, Access::View).await);
    for needed in [Access::View, Access::Teach, Access::Manage] {
        assert!(!allowed(&app, &owner, other_campus, needed).await);
        assert!(!allowed(&app, &other_professor, campus, needed).await);
    }

    // Guest teacher: Teach and View, never Manage.
    assert!(allowed(&app, &guest, campus, Access::View).await);
    assert!(allowed(&app, &guest, campus, Access::Teach).await);
    assert!(!allowed(&app, &guest, campus, Access::Manage).await);
    assert_eq!(level(&app, &guest, campus).await, Ok(Access::Teach));
    assert!(!allowed(&app, &guest, other_campus, Access::View).await);

    // Student: View only, and only where they are a member.
    assert!(allowed(&app, &student, campus, Access::View).await);
    assert!(!allowed(&app, &student, campus, Access::Teach).await);
    assert!(!allowed(&app, &student, campus, Access::Manage).await);
    assert!(!allowed(&app, &student, other_campus, Access::View).await);
    assert!(!allowed(&app, &outsider, campus, Access::View).await);

    // A campus that does not exist is 404 for everyone.
    assert_eq!(
        level(&app, &secretary, 9_999).await,
        Err(StatusCode::NOT_FOUND)
    );
    assert_eq!(
        level(&app, &student, 9_999).await,
        Err(StatusCode::NOT_FOUND)
    );
}

#[tokio::test]
async fn suspended_members_have_no_access_until_reactivated() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let student = app.seed_student(campus).await;
    let guest = app.seed_guest(campus).await;
    let mut conn = app.db.acquire().await.unwrap();

    directory::suspend_member(
        &mut conn,
        owner.id,
        campus,
        student.id,
        "dropped the course",
    )
    .await
    .unwrap();
    directory::suspend_member(&mut conn, owner.id, campus, guest.id, "module finished")
        .await
        .unwrap();
    assert_eq!(
        level(&app, &student, campus).await,
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        level(&app, &guest, campus).await,
        Err(StatusCode::FORBIDDEN)
    );

    directory::reactivate_member(&mut conn, owner.id, campus, student.id, "re-enrolled")
        .await
        .unwrap();
    assert_eq!(level(&app, &student, campus).await, Ok(Access::View));
}

#[tokio::test]
async fn require_role_checks_the_account_role() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await.current();
    let professor = app.login_as(Role::Professor).await.current();
    let student = app.login_as(Role::Student).await.current();

    assert!(require_role(&secretary, &[Role::Secretary]).is_ok());
    assert!(require_role(&professor, &[Role::Secretary, Role::Professor]).is_ok());
    assert!(matches!(
        require_role(&professor, &[Role::Secretary]),
        Err(AppError::Forbidden)
    ));
    assert!(matches!(
        require_role(&student, &[Role::Secretary, Role::Professor]),
        Err(AppError::Forbidden)
    ));
}

// ---------------------------------------------------------------------------------------
// Directory: members, suspension, campuses
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_suspended_member_is_kept_and_the_change_is_audited() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let student = app.seed_student(campus).await;
    let mut conn = app.db.acquire().await.unwrap();

    // A reason is required.
    let err = directory::suspend_member(&mut conn, owner.id, campus, student.id, "   ")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let member = directory::suspend_member(&mut conn, owner.id, campus, student.id, "dropped out")
        .await
        .unwrap();
    assert_eq!(member.status, MemberStatus::Suspended);
    assert_eq!(member.suspended_by, Some(owner.id));
    assert_eq!(member.suspended_reason.as_deref(), Some("dropped out"));
    assert!(member.suspended_at.is_some());

    // Suspending twice is a conflict, not a second audit row.
    let err = directory::suspend_member(&mut conn, owner.id, campus, student.id, "again")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);

    // The row is still there, marked.
    let members = directory::list_members(&mut conn, campus).await.unwrap();
    assert_eq!(members.len(), 2);
    let listed = members.iter().find(|m| m.user_id == student.id).unwrap();
    assert_eq!(listed.status, MemberStatus::Suspended);
    assert_eq!(listed.role, MemberRole::Student);
    assert_eq!(members[0].role, MemberRole::Professor);

    // Who, when and why.
    let log = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus),
            entity_prefix: Some("member"),
            subject_user_id: Some(student.id),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    let actions: Vec<&str> = log.iter().map(|row| row.action.as_str()).collect();
    assert_eq!(actions, ["suspend", "add"]);
    assert_eq!(log[0].actor_id, Some(owner.id));
    assert_eq!(log[0].actor_name.as_deref(), Some(owner.full_name.as_str()));
    assert_eq!(log[0].reason.as_deref(), Some("dropped out"));
    assert_eq!(log[0].after, Some(json!({ "status": "suspended" })));
    assert!(!log[0].created_at.is_empty());

    directory::reactivate_member(&mut conn, owner.id, campus, student.id, "came back")
        .await
        .unwrap();
    let log = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus),
            subject_user_id: Some(student.id),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(log[0].action, "reactivate");
    assert_eq!(
        log[0].before.as_ref().unwrap()["suspended_reason"],
        "dropped out"
    );
}

#[tokio::test]
async fn users_and_members_cannot_be_deleted() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let student = app.seed_student(campus).await;

    let err = sqlx::query("DELETE FROM core_members WHERE user_id = ?")
        .bind(student.id)
        .execute(&app.db)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("never deleted"), "{err}");

    // Clear the rows that reference the user so that only the trigger can stop the delete.
    sqlx::query("DELETE FROM core_sessions WHERE user_id = ?")
        .bind(student.id)
        .execute(&app.db)
        .await
        .unwrap();
    let err = sqlx::query("DELETE FROM core_users WHERE id = ?")
        .bind(student.id)
        .execute(&app.db)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("never deleted"), "{err}");

    let mut conn = app.db.acquire().await.unwrap();
    assert!(directory::find_user(&mut conn, student.id)
        .await
        .unwrap()
        .is_some());
    assert!(directory::find_member(&mut conn, campus, student.id)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn membership_roles_must_fit_the_account_role() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let student = app.login_as(Role::Student).await;
    let professor = app.login_as(Role::Professor).await;
    let mut conn = app.db.acquire().await.unwrap();

    for (user, role) in [
        (&student, MemberRole::Professor),
        (&student, MemberRole::Guest),
        (&professor, MemberRole::Student),
    ] {
        let err = directory::add_member(&mut conn, owner.id, campus, user.id, role)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(
        directory::list_members(&mut conn, campus)
            .await
            .unwrap()
            .len(),
        1
    );

    directory::add_member(&mut conn, owner.id, campus, student.id, MemberRole::Student)
        .await
        .unwrap();
    let err = directory::add_member(&mut conn, owner.id, campus, student.id, MemberRole::Student)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);

    let err = directory::add_member(&mut conn, owner.id, 9_999, student.id, MemberRole::Student)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_users_campuses_are_their_active_memberships() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let other_professor = app.login_as(Role::Professor).await;
    let first = app.seed_campus(&professor).await;
    let second = app.seed_campus(&professor).await;
    let third = app.seed_campus(&other_professor).await;
    let student = app.seed_student(first).await;
    app.add_member(second, &student, MemberRole::Student).await;
    let mut conn = app.db.acquire().await.unwrap();

    let ids = |list: Vec<directory::CampusForUser>| -> Vec<i64> {
        let mut ids: Vec<i64> = list.into_iter().map(|campus| campus.id).collect();
        ids.sort();
        ids
    };

    let courses = directory::campuses_for_user(&mut conn, &student.current())
        .await
        .unwrap();
    assert!(courses.iter().all(|c| c.access == Access::View));
    assert!(courses
        .iter()
        .all(|c| c.member_role == Some(MemberRole::Student)));
    assert_eq!(ids(courses), vec![first, second]);

    directory::suspend_member(&mut conn, professor.id, second, student.id, "dropped")
        .await
        .unwrap();
    let courses = directory::campuses_for_user(&mut conn, &student.current())
        .await
        .unwrap();
    assert_eq!(ids(courses), vec![first]);

    let own = directory::campuses_for_user(&mut conn, &professor.current())
        .await
        .unwrap();
    assert!(own.iter().all(|c| c.access == Access::Manage));
    assert_eq!(ids(own), vec![first, second]);

    let all = directory::campuses_for_user(&mut conn, &secretary.current())
        .await
        .unwrap();
    assert!(all
        .iter()
        .all(|c| c.access == Access::Manage && c.member_role.is_none()));
    assert_eq!(ids(all), vec![first, second, third]);
}

#[tokio::test]
async fn suspending_a_user_is_audited_and_reversible() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let mut conn = app.db.acquire().await.unwrap();

    let err = directory::suspend_user(&mut conn, secretary.id, secretary.id, "oops")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let err = directory::suspend_user(&mut conn, secretary.id, professor.id, "")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let user = directory::suspend_user(&mut conn, secretary.id, professor.id, "contract ended")
        .await
        .unwrap();
    assert_eq!(user.status, UserStatus::Suspended);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM core_sessions WHERE user_id = ?")
        .bind(professor.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(sessions, 0);

    let user = directory::reactivate_user(&mut conn, secretary.id, professor.id, "renewed")
        .await
        .unwrap();
    assert_eq!(user.status, UserStatus::Active);

    let log = audit::list(
        &mut conn,
        AuditQuery {
            entity_prefix: Some("user"),
            entity_id: Some(professor.id),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    let summary: Vec<(&str, Option<&str>)> = log
        .iter()
        .map(|row| (row.action.as_str(), row.reason.as_deref()))
        .collect();
    assert_eq!(
        summary,
        [
            ("reactivate", Some("renewed")),
            ("suspend", Some("contract ended"))
        ]
    );
    assert!(log.iter().all(|row| row.actor_id == Some(secretary.id)));
}

#[tokio::test]
async fn a_duplicate_email_is_a_409() {
    let app = TestApp::new().await;
    let mut conn = app.db.acquire().await.unwrap();
    let new_user = |email: &'static str| NewUser {
        email,
        full_name: "Ana Pérez",
        role: Role::Student,
        password_hash: None,
    };
    let user = directory::create_user(&mut conn, new_user("Ana.Perez@Test.Example"))
        .await
        .unwrap();
    assert_eq!(user.email, "ana.perez@test.example");
    assert_eq!(user.status, UserStatus::Invited);
    assert!(!user.has_password);

    let err = directory::create_user(&mut conn, new_user(" ana.perez@test.example "))
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    assert_eq!(err.to_string(), "a user with that email already exists");

    let err = directory::create_user(&mut conn, new_user("not-an-email"))
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let found = directory::find_user_by_email(&mut conn, "ANA.PEREZ@test.example")
        .await
        .unwrap();
    assert_eq!(found, Some(user));
}

// ---------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_audit_log_is_append_only() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let mut conn = app.db.acquire().await.unwrap();

    let id = audit::record(
        &mut conn,
        AuditEntry {
            actor_id: Some(professor.id),
            campus_id: Some(campus),
            entity: "grades.entry",
            entity_id: 7,
            subject_user_id: None,
            action: "update",
            before: Some(json!({ "score": 6 })),
            after: Some(json!({ "score": 8 })),
            reason: Some("regrade"),
        },
    )
    .await
    .unwrap();

    let err = sqlx::query("UPDATE core_audit_log SET reason = 'changed' WHERE id = ?")
        .bind(id)
        .execute(&app.db)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");

    let err = sqlx::query("DELETE FROM core_audit_log WHERE id = ?")
        .bind(id)
        .execute(&app.db)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");

    let err = sqlx::query("DELETE FROM core_audit_log")
        .execute(&app.db)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");

    let log = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus),
            entity_prefix: Some("grades."),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].id, id);
    assert_eq!(log[0].reason.as_deref(), Some("regrade"));
    assert_eq!(log[0].before, Some(json!({ "score": 6 })));
    assert_eq!(log[0].after, Some(json!({ "score": 8 })));
    assert_eq!(log[0].campus_id, Some(campus));
}

#[tokio::test]
async fn an_audit_row_rolls_back_with_its_transaction() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM core_audit_log")
            .fetch_one(&app.db)
            .await
            .unwrap()
    };
    let before = count().await;

    let entry = || AuditEntry {
        actor_id: Some(professor.id),
        campus_id: Some(campus),
        entity: "grades.item",
        entity_id: 1,
        subject_user_id: None,
        action: "create",
        before: None,
        after: None,
        reason: None,
    };

    let mut tx = australis_core::begin_write(&app.db).await.unwrap();
    audit::record(&mut tx, entry()).await.unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(count().await, before);

    let mut tx = australis_core::begin_write(&app.db).await.unwrap();
    audit::record(&mut tx, entry()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(count().await, before + 1);
}

// ---------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------

async fn invited_student(app: &TestApp, email: &str) -> directory::User {
    let mut conn = app.db.acquire().await.unwrap();
    directory::create_user(
        &mut conn,
        NewUser {
            email,
            full_name: "Invited Student",
            role: Role::Student,
            password_hash: None,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn an_invite_sets_the_first_password_exactly_once() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let invited = invited_student(&app, "nueva@test.example").await;
    let mut conn = app.db.acquire().await.unwrap();
    let ttl = app.state.config.invite_ttl_hours;

    let token = directory::create_invite(&mut conn, professor.id, invited.id, ttl)
        .await
        .unwrap();
    assert_eq!(
        directory::invite_url(&app.state.config, &token),
        format!("http://localhost:5173/invite/{token}")
    );
    let stored: String =
        sqlx::query_scalar("SELECT token_hash FROM core_invites WHERE user_id = ?")
            .bind(invited.id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_ne!(stored, token);

    let pending = directory::find_invite(&mut conn, &token).await.unwrap();
    assert_eq!(pending.map(|user| user.id), Some(invited.id));

    let hash = auth::hash_password(&app.state.config, "first-password")
        .await
        .unwrap();
    let user = directory::accept_invite(&mut conn, &token, &hash)
        .await
        .unwrap();
    assert_eq!(user.status, UserStatus::Active);
    assert!(user.has_password);

    // The same link cannot set a password again.
    let other = auth::hash_password(&app.state.config, "second-password")
        .await
        .unwrap();
    let err = directory::accept_invite(&mut conn, &token, &other)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    assert_eq!(
        directory::find_invite(&mut conn, &token).await.unwrap(),
        None
    );
    let credentials = directory::find_credentials(&mut conn, "nueva@test.example")
        .await
        .unwrap()
        .unwrap();
    let stored = credentials.password_hash.unwrap();
    assert!(auth::verify_password(&stored, "first-password").await);
    assert!(!auth::verify_password(&stored, "second-password").await);
}

#[tokio::test]
async fn an_invite_is_never_issued_for_an_account_with_a_password() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let mut conn = app.db.acquire().await.unwrap();
    let ttl = app.state.config.invite_ttl_hours;

    // An importer cannot get a password-setting link for an existing account.
    for target in [&secretary, &professor] {
        let err = directory::create_invite(&mut conn, professor.id, target.id, ttl)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);
    }
    let invites: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM core_invites")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(invites, 0);

    let err = directory::create_invite(&mut conn, professor.id, 9_999, ttl)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn accepting_fails_if_a_password_is_already_set() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let invited = invited_student(&app, "carrera@test.example").await;
    let mut conn = app.db.acquire().await.unwrap();
    let token = directory::create_invite(&mut conn, professor.id, invited.id, 24)
        .await
        .unwrap();

    // The account gets a password some other way while the invite is still open.
    let existing = auth::hash_password(&app.state.config, "existing-password")
        .await
        .unwrap();
    sqlx::query("UPDATE core_users SET password_hash = ?, status = 'active' WHERE id = ?")
        .bind(&existing)
        .bind(invited.id)
        .execute(&app.db)
        .await
        .unwrap();

    assert_eq!(
        directory::find_invite(&mut conn, &token).await.unwrap(),
        None
    );
    let attacker = auth::hash_password(&app.state.config, "attacker-password")
        .await
        .unwrap();
    let err = directory::accept_invite(&mut conn, &token, &attacker)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM core_users WHERE id = ?")
        .bind(invited.id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(stored, existing);
}

#[tokio::test]
async fn reissued_expired_and_unknown_invites() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let invited = invited_student(&app, "reenvio@test.example").await;
    let mut conn = app.db.acquire().await.unwrap();
    let hash = auth::hash_password(&app.state.config, "some-password")
        .await
        .unwrap();

    // Re-issuing replaces the earlier link.
    let first = directory::create_invite(&mut conn, professor.id, invited.id, 24)
        .await
        .unwrap();
    let second = directory::create_invite(&mut conn, professor.id, invited.id, 24)
        .await
        .unwrap();
    assert_ne!(first, second);
    assert_eq!(
        directory::find_invite(&mut conn, &first).await.unwrap(),
        None
    );
    let err = directory::accept_invite(&mut conn, &first, &hash)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    assert!(directory::find_invite(&mut conn, &second)
        .await
        .unwrap()
        .is_some());

    // Expired.
    sqlx::query("UPDATE core_invites SET expires_at = datetime('now', '-1 minute')")
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        directory::find_invite(&mut conn, &second).await.unwrap(),
        None
    );
    let err = directory::accept_invite(&mut conn, &second, &hash)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);

    // Unknown.
    let err = directory::accept_invite(&mut conn, "no-such-token", &hash)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);

    // Nothing above gave the account a password.
    let user = directory::find_user(&mut conn, invited.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!user.has_password);
    assert_eq!(user.status, UserStatus::Invited);

    // A fresh link after all that still works.
    let third = directory::create_invite(&mut conn, professor.id, invited.id, 24)
        .await
        .unwrap();
    directory::accept_invite(&mut conn, &third, &hash)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn seeded_settings_can_be_read() {
    let app = TestApp::new().await;
    let mut conn = app.db.acquire().await.unwrap();

    let scale = settings::grading_scale(&mut conn, 1).await.unwrap();
    assert_eq!((scale.min, scale.max, scale.pass), (1.0, 10.0, 4.0));
    assert!(!scale.confirmed, "the default scale is a guess");
    assert!(scale.contains(1.0) && scale.contains(10.0));
    assert!(!scale.contains(0.5) && !scale.contains(10.5));

    let rule = settings::final_rule(&mut conn, 1).await.unwrap();
    assert_eq!(rule.kind, "weighted_mean");
    assert!(!rule.confirmed);

    let quota: i64 = settings::get(&mut conn, settings::AI_SHAPING_DAILY_QUOTA)
        .await
        .unwrap();
    assert_eq!(quota, 20);
    assert_eq!(settings::utc_offset_minutes(&mut conn).await.unwrap(), -180);
    assert_eq!(
        settings::local_time_modifier(&mut conn).await.unwrap(),
        "-180 minutes"
    );
    let today = settings::local_today(&mut conn).await.unwrap();
    assert_eq!(today.len(), 10, "{today}");

    assert_eq!(
        settings::get_value(&mut conn, "no.such.key").await.unwrap(),
        None
    );
    let err = settings::get::<i64>(&mut conn, "no.such.key")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn settings_are_read_from_the_table_not_from_constants() {
    let app = TestApp::new().await;
    sqlx::query("UPDATE core_settings SET value_json = ? WHERE key = 'grading.scale'")
        .bind(r#"{"min":0,"max":100,"pass":60,"confirmed":true}"#)
        .execute(&app.db)
        .await
        .unwrap();
    let mut conn = app.db.acquire().await.unwrap();
    let scale = settings::grading_scale(&mut conn, 1).await.unwrap();
    assert_eq!((scale.min, scale.max, scale.pass), (0.0, 100.0, 60.0));
    assert!(scale.confirmed);
}

// ---------------------------------------------------------------------------------------
// AI quota and usage log
// ---------------------------------------------------------------------------------------

async fn set_quota(app: &TestApp, value_json: &str) {
    sqlx::query("UPDATE core_settings SET value_json = ? WHERE key = 'ai.shaping.daily_quota'")
        .bind(value_json)
        .execute(&app.db)
        .await
        .unwrap();
}

async fn quota_calls(app: &TestApp, user_id: i64) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(SUM(calls), 0) FROM core_ai_quota WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&app.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_quota_denies_call_n_plus_one() {
    let app = TestApp::new().await;
    set_quota(&app, "3").await;
    let professor = app.login_as(Role::Professor).await;
    let other = app.login_as(Role::Professor).await;
    let mut conn = app.db.acquire().await.unwrap();

    for _ in 0..3 {
        ai::reserve(&mut conn, professor.id, FEATURE_SHAPING)
            .await
            .unwrap();
    }
    for _ in 0..2 {
        let err = ai::reserve(&mut conn, professor.id, FEATURE_SHAPING)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);
    }
    assert_eq!(quota_calls(&app, professor.id).await, 3);

    let status = ai::quota_status(&mut conn, professor.id, FEATURE_SHAPING)
        .await
        .unwrap();
    assert_eq!((status.limit, status.used, status.remaining), (3, 3, 0));

    // The quota is per user.
    let reservation = ai::reserve(&mut conn, other.id, FEATURE_SHAPING)
        .await
        .unwrap();

    // A released call can be used again.
    ai::release(&mut conn, &reservation).await.unwrap();
    assert_eq!(quota_calls(&app, other.id).await, 0);
    ai::reserve(&mut conn, other.id, FEATURE_SHAPING)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_quota_fails_closed() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let mut conn = app.db.acquire().await.unwrap();

    // Limit 0: not even the first call of the day.
    for value in ["0", "-5", "\"twenty\"", "null", "{\"limit\":20}"] {
        set_quota(&app, value).await;
        let err = ai::reserve(&mut conn, professor.id, FEATURE_SHAPING)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS, "{value}");
    }

    // A feature with no quota setting gets nothing.
    let err = ai::reserve(&mut conn, professor.id, "no-such-feature")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);

    // The setting row is gone.
    sqlx::query("DELETE FROM core_settings WHERE key = 'ai.shaping.daily_quota'")
        .execute(&app.db)
        .await
        .unwrap();
    let err = ai::reserve(&mut conn, professor.id, FEATURE_SHAPING)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);

    assert_eq!(quota_calls(&app, professor.id).await, 0);
    let status = ai::quota_status(&mut conn, professor.id, FEATURE_SHAPING)
        .await
        .unwrap();
    assert_eq!((status.limit, status.used, status.remaining), (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_quota_holds_under_concurrent_reservations() {
    let app = TestApp::new().await;
    set_quota(&app, "7").await;
    let professor = app.login_as(Role::Professor).await;

    let mut tasks = Vec::new();
    for _ in 0..20 {
        let db = app.db.clone();
        let user_id = professor.id;
        tasks.push(tokio::spawn(async move {
            let mut conn = db.acquire().await.unwrap();
            ai::reserve(&mut conn, user_id, FEATURE_SHAPING).await
        }));
    }
    let mut granted = 0;
    let mut denied = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => granted += 1,
            Err(AppError::TooManyRequests(_)) => denied += 1,
            Err(other) => panic!("unexpected error: {other}"),
        }
    }
    assert_eq!((granted, denied), (7, 13));
    assert_eq!(quota_calls(&app, professor.id).await, 7);
}

fn shaping_request(instruction: &str) -> AiRequest {
    AiRequest {
        feature: FEATURE_SHAPING.into(),
        instruction: instruction.into(),
        tools: vec![AiTool {
            name: "add_section".into(),
            description: "Adds a section to the campus".into(),
            input_schema: json!({ "type": "object" }),
        }],
        ..AiRequest::default()
    }
}

/// Counts calls; fails when told to.
struct CountingAi {
    calls: Arc<AtomicUsize>,
    fail: bool,
}

#[async_trait]
impl AiProvider for CountingAi {
    fn name(&self) -> &'static str {
        "counting"
    }

    fn is_placeholder(&self) -> bool {
        false
    }

    async fn complete(
        &self,
        _request: &AiRequest,
        reservation: &Reservation,
    ) -> Result<AiReply, ProviderError> {
        assert_eq!(reservation.feature, FEATURE_SHAPING);
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(ProviderError::Failed("the provider is down".into()));
        }
        Ok(AiReply {
            text: "ok".into(),
            tool_calls: Vec::new(),
            model: "test-model".into(),
            input_tokens: 120,
            output_tokens: 30,
        })
    }
}

async fn app_with_ai(fail: bool) -> (TestApp, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingAi {
        calls: calls.clone(),
        fail,
    };
    let app = TestApp::with(|state: &mut AppState| state.ai = Arc::new(provider)).await;
    (app, calls)
}

#[tokio::test]
async fn an_ai_call_is_logged_and_marked_simulated_with_the_placeholder() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let outcome = ai::run(
        &app.state,
        professor.id,
        Some(campus),
        &shaping_request("Agregá una semana sobre ética antes del examen"),
    )
    .await
    .unwrap();
    assert!(outcome.simulated);
    assert_eq!(outcome.reply.tool_calls.len(), 1);
    assert_eq!(outcome.reply.tool_calls[0].name, "add_section");

    let mut conn = app.db.acquire().await.unwrap();
    let usage = ai::list_usage(
        &mut conn,
        UsageQuery {
            campus_id: Some(campus),
            ..UsageQuery::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].id, outcome.usage_id);
    assert_eq!(usage[0].user_id, professor.id);
    assert_eq!(usage[0].user_name, professor.full_name);
    assert_eq!(usage[0].feature, FEATURE_SHAPING);
    assert_eq!(usage[0].provider, "placeholder");
    assert_eq!(usage[0].status, UsageStatus::Ok);
    assert!(usage[0].simulated);
    assert!(usage[0].input_tokens > 0 && usage[0].output_tokens > 0);
    assert_eq!(quota_calls(&app, professor.id).await, 1);
}

#[tokio::test]
async fn an_exhausted_quota_is_a_429_before_any_provider_call() {
    let (app, calls) = app_with_ai(false).await;
    set_quota(&app, "2").await;
    let professor = app.login_as(Role::Professor).await;
    let request = shaping_request("agregá la bibliografía");

    for _ in 0..2 {
        let outcome = ai::run(&app.state, professor.id, None, &request)
            .await
            .unwrap();
        assert!(!outcome.simulated);
    }
    let err = ai::run(&app.state, professor.id, None, &request)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "the provider was not called"
    );

    let mut conn = app.db.acquire().await.unwrap();
    let usage = ai::list_usage(
        &mut conn,
        UsageQuery {
            user_id: Some(professor.id),
            feature: Some(FEATURE_SHAPING),
            ..UsageQuery::default()
        },
    )
    .await
    .unwrap();
    let statuses: Vec<UsageStatus> = usage.iter().map(|row| row.status).collect();
    assert_eq!(
        statuses,
        [UsageStatus::Refused, UsageStatus::Ok, UsageStatus::Ok]
    );
    assert_eq!(usage[1].model, "test-model");
    assert_eq!((usage[1].input_tokens, usage[1].output_tokens), (120, 30));
}

#[tokio::test]
async fn a_provider_error_gives_the_reserved_call_back() {
    let (app, calls) = app_with_ai(true).await;
    set_quota(&app, "1").await;
    let professor = app.login_as(Role::Professor).await;
    let request = shaping_request("agregá la bibliografía");

    // Even with a limit of 1, a failing provider never locks the user out.
    for _ in 0..3 {
        let err = ai::run(&app.state, professor.id, None, &request)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(quota_calls(&app, professor.id).await, 0);

    let mut conn = app.db.acquire().await.unwrap();
    let usage = ai::list_usage(&mut conn, UsageQuery::default())
        .await
        .unwrap();
    assert_eq!(usage.len(), 3);
    assert!(usage.iter().all(|row| row.status == UsageStatus::Error));
}

// ---------------------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_file_store_generates_keys_and_rejects_traversal() {
    let app = TestApp::new().await;
    let files = &app.state.files;

    let key = files.save("PDF", b"%PDF-1.4 test").await.unwrap();
    assert_eq!(key.len(), 32 + 4);
    assert!(key.ends_with(".pdf"));
    assert_eq!(files.read(&key).await.unwrap(), b"%PDF-1.4 test");
    assert!(files.path(&key).unwrap().starts_with(files.root()));
    let other = files.save("pdf", b"another").await.unwrap();
    assert_ne!(key, other);

    // A real file right outside the root must stay out of reach.
    let outside = files.root().parent().unwrap().join(format!("{key}.secret"));
    std::fs::write(&outside, b"secret").unwrap();
    let outside_name = outside.file_name().unwrap().to_str().unwrap().to_string();

    for bad in [
        format!("../{outside_name}"),
        format!("..\\{outside_name}"),
        outside.display().to_string(),
        format!("{key}/../../{outside_name}"),
        "../../etc/passwd".to_string(),
        "/etc/passwd".to_string(),
        "..".to_string(),
        String::new(),
        key.to_uppercase(),
        key.replace(".pdf", ""),
    ] {
        let status = |err: AppError| err.status();
        assert_eq!(
            files.path(&bad).map_err(status),
            Err(StatusCode::BAD_REQUEST),
            "{bad:?}"
        );
        assert_eq!(
            files.read(&bad).await.map_err(status),
            Err(StatusCode::BAD_REQUEST),
            "{bad:?}"
        );
        assert_eq!(
            files.remove(&bad).await.map_err(status),
            Err(StatusCode::BAD_REQUEST),
            "{bad:?}"
        );
    }
    assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
    std::fs::remove_file(&outside).unwrap();

    // The extension is a label, never a path.
    for bad in ["", "../x", "pdf/..", "a b", "waytoolongext"] {
        let err = files.save(bad, b"x").await.unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST, "{bad:?}");
    }

    files.remove(&key).await.unwrap();
    let err = files.read(&key).await.unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);
    files.remove(&key).await.unwrap();
}

// ---------------------------------------------------------------------------------------
// Upload body limit
// ---------------------------------------------------------------------------------------

async fn body_size(body: Bytes) -> Json<serde_json::Value> {
    Json(json!({ "bytes": body.len() }))
}

#[tokio::test]
async fn upload_routes_accept_bodies_over_the_two_megabyte_default() {
    let router = Router::new()
        .route("/plain", post(body_size))
        .route("/upload", post(body_size).layer(upload_body_limit()));
    let three_megabytes = vec![b'x'; 3 * 1024 * 1024];
    let part = || {
        vec![Part::file(
            "file",
            "deck.pdf",
            "application/pdf",
            three_megabytes.clone(),
        )]
    };

    let response = common::send(&router, common::multipart_request("/upload", None, part())).await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.json()["bytes"].as_u64().unwrap() > 3 * 1024 * 1024);

    let response = common::send(&router, common::multipart_request("/plain", None, part())).await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
}
