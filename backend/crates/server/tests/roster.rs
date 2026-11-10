mod common;

use australis_core::{
    directory::{self, MemberRole, NewUser},
    Access, Role,
};
use axum::http::{Method, StatusCode};
use common::{Part, TestApp, TestUser};
use serde_json::{json, Value};

const XLSX: &[u8] = include_bytes!("fixtures/roster/students.xlsx");
const SEMICOLON_BOM: &[u8] = include_bytes!("fixtures/roster/semicolon_bom.csv");
const WINDOWS_1252: &[u8] = include_bytes!("fixtures/roster/windows1252.csv");

fn imports_url(campus: i64) -> String {
    format!("/api/campuses/{campus}/roster/imports")
}

async fn upload(
    app: &TestApp,
    who: &TestUser,
    campus: i64,
    name: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    app.post_multipart(
        &imports_url(campus),
        Some(&who.cookie),
        vec![Part::file("file", name, "application/octet-stream", bytes)],
    )
    .await
}

async fn paste(app: &TestApp, who: &TestUser, campus: i64, text: &str) -> (StatusCode, Value) {
    app.post_json(
        &imports_url(campus),
        Some(&who.cookie),
        json!({ "text": text }),
    )
    .await
}

async fn confirm(app: &TestApp, who: &TestUser, campus: i64, import: i64) -> (StatusCode, Value) {
    app.post_json(
        &format!("{}/{import}/confirm", imports_url(campus)),
        Some(&who.cookie),
        json!({}),
    )
    .await
}

fn row<'a>(preview: &'a Value, email: &str) -> &'a Value {
    preview["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["email"] == email)
        .unwrap_or_else(|| panic!("no row for {email}: {preview}"))
}

fn flags(row: &Value) -> Vec<&str> {
    row["flags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect()
}

async fn count(app: &TestApp, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(&app.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn xlsx_is_parsed_and_only_name_and_email_are_kept() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let (status, preview) = upload(&app, &professor, campus, "alumnos.xlsx", XLSX).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(preview["total"], 2);
    assert_eq!(preview["importable"], 2);
    let first = row(&preview, "lucia.gomez@alumnos.test");
    assert_eq!(first["full_name"], "Lucía Gómez");
    assert_eq!(first["line"], 2);
    // The DNI column never reaches the response or the database.
    assert!(!preview.to_string().contains("30111222"));
    let stored: Vec<(String, String)> =
        sqlx::query_as("SELECT full_name, email FROM roster_import_rows")
            .fetch_all(&app.db)
            .await
            .unwrap();
    assert_eq!(stored.len(), 2);
    assert!(stored
        .iter()
        .all(|(n, e)| !n.contains("3011") && !e.contains("3011")));
}

#[tokio::test]
async fn semicolon_csv_with_bom_and_accents() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let (status, preview) = upload(&app, &professor, campus, "a.csv", SEMICOLON_BOM).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(preview["total"], 2);
    assert_eq!(
        row(&preview, "jose.munoz@alumnos.test")["full_name"],
        "José Muñoz"
    );
    assert_eq!(
        row(&preview, "ines.alvarez@alumnos.test")["full_name"],
        "Inés Álvarez"
    );
}

#[tokio::test]
async fn windows_1252_csv_keeps_accents() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let (status, preview) = upload(&app, &professor, campus, "a.csv", WINDOWS_1252).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(
        row(&preview, "jose.munoz@alumnos.test")["full_name"],
        "José Muñoz"
    );
    assert_eq!(
        row(&preview, "ines.alvarez@alumnos.test")["full_name"],
        "Inés Álvarez"
    );
}

#[tokio::test]
async fn pasted_text_is_parsed() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let text = "Ana Pérez <ana@alumnos.test>\nLuis Gómez, luis@alumnos.test\nmaria@alumnos.test María Ruiz\n";
    let (status, preview) = paste(&app, &professor, campus, text).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(preview["total"], 3);
    assert_eq!(row(&preview, "ana@alumnos.test")["full_name"], "Ana Pérez");
    assert_eq!(
        row(&preview, "luis@alumnos.test")["full_name"],
        "Luis Gómez"
    );
    assert_eq!(
        row(&preview, "maria@alumnos.test")["full_name"],
        "María Ruiz"
    );

    let (status, _) = paste(&app, &professor, campus, "   \n").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn every_flag_is_reported() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let member = app.seed_student(campus).await;
    let other_student = app.login_as(Role::Student).await;
    let teacher = app.login_as(Role::Professor).await;

    let text = format!(
        "Nombre;Correo\n\
         Nueva Persona;nueva@alumnos.test\n\
         Nueva Repetida;NUEVA@alumnos.test\n\
         Sin Arroba;sin@arroba\n\
         Ya Miembro;{}\n\
         Con Cuenta;{}\n\
         Es Docente;{}\n",
        member.email, other_student.email, teacher.email
    );
    let (status, preview) = paste(&app, &professor, campus, &text).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(preview["total"], 6);
    assert_eq!(preview["importable"], 2);

    assert!(flags(row(&preview, "nueva@alumnos.test")).len() <= 1);
    let rows = preview["rows"].as_array().unwrap();
    let dup = rows.iter().find(|r| r["line"] == 3).unwrap();
    assert_eq!(flags(dup), vec!["duplicate_in_file"]);
    assert_eq!(dup["importable"], false);
    assert_eq!(flags(row(&preview, "sin@arroba")), vec!["invalid_email"]);
    assert_eq!(
        flags(row(&preview, &member.email)),
        vec!["existing_account", "already_member"]
    );
    assert_eq!(
        flags(row(&preview, &other_student.email)),
        vec!["existing_account"]
    );
    assert_eq!(row(&preview, &other_student.email)["importable"], true);
    assert_eq!(
        flags(row(&preview, &teacher.email)),
        vec!["non_student_account"]
    );
    assert_eq!(row(&preview, &teacher.email)["importable"], false);
    assert_eq!(preview["counts"]["invalid_email"], 1);
    assert_eq!(preview["counts"]["duplicate_in_file"], 1);
}

#[tokio::test]
async fn confirm_creates_users_members_and_invites() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let existing = app.login_as(Role::Student).await;

    let text = format!(
        "Nombre;Correo\nLucía Gómez;lucia@alumnos.test\nMartín Pérez;martin@alumnos.test\nCon Cuenta;{}\nRota;rota\n",
        existing.email
    );
    let (_, preview) = paste(&app, &professor, campus, &text).await;
    let import = preview["id"].as_i64().unwrap();

    // Another professor of a different campus cannot confirm it.
    let outsider = app.login_as(Role::Professor).await;
    let (status, _) = confirm(&app, &outsider, campus, import).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, result) = confirm(&app, &professor, campus, import).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["created"], 2);
    assert_eq!(result["added_existing"], 1);
    assert_eq!(result["skipped"], 1);
    // Only the two new accounts need a link; the existing one signs in as usual.
    let invites = result["invites"].as_array().unwrap();
    assert_eq!(invites.len(), 2);
    let base = &app.state.config.app_base_url;
    for invite in invites {
        assert!(invite["invite_url"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{base}/invite/")));
    }

    let mut conn = app.db.acquire().await.unwrap();
    let lucia = directory::find_user_by_email(&mut conn, "lucia@alumnos.test")
        .await
        .unwrap()
        .expect("user created");
    assert_eq!(lucia.role, Role::Student);
    assert!(!lucia.has_password);
    let member = directory::find_member(&mut conn, campus, lucia.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(member.role, MemberRole::Student);
    assert!(directory::find_member(&mut conn, campus, existing.id)
        .await
        .unwrap()
        .is_some());
    drop(conn);

    // The invite link works: the student sets a password and signs in.
    let token = invites[0]["invite_url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let (status, _) = app
        .post_json(
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "una-clave-larga-123" }),
        )
        .await;
    assert!(status.is_success(), "{status}");

    // The stored rows are purged and the import cannot be confirmed twice.
    assert_eq!(count(&app, "roster_import_rows").await, 0);
    let (status, _) = confirm(&app, &professor, campus, import).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, members) = app
        .get(
            &format!("/api/campuses/{campus}/members"),
            Some(&professor.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(members.as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn an_existing_professor_email_never_yields_an_invite() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    // A professor account that never activated: the riskiest case for an invite takeover.
    let mut conn = app.db.acquire().await.unwrap();
    let invited = directory::create_user(
        &mut conn,
        NewUser {
            email: "docente.pendiente@test.example",
            full_name: "Docente Pendiente",
            role: Role::Professor,
            password_hash: None,
        },
    )
    .await
    .unwrap();
    drop(conn);
    let secretary = app.login_as(Role::Secretary).await;

    let text = format!(
        "Nombre;Correo\nDocente Pendiente;{}\nSecretaria;{}\nAdmin;{}\n",
        invited.email, secretary.email, professor.email
    );
    let (_, preview) = paste(&app, &professor, campus, &text).await;
    assert_eq!(preview["importable"], 0);
    for email in [&invited.email, &secretary.email, &professor.email] {
        assert!(flags(row(&preview, email)).contains(&"non_student_account"));
    }
    let (status, result) = confirm(&app, &professor, campus, preview["id"].as_i64().unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["invites"].as_array().unwrap().len(), 0);
    assert_eq!(result["skipped"], 3);
    assert_eq!(count(&app, "core_invites").await, 0);
    let mut conn = app.db.acquire().await.unwrap();
    assert!(directory::find_member(&mut conn, campus, invited.id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn discard_purges_the_stored_rows() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let (_, preview) = paste(&app, &professor, campus, "Ana;ana@alumnos.test\n").await;
    let import = preview["id"].as_i64().unwrap();
    assert_eq!(count(&app, "roster_import_rows").await, 1);
    let (status, _) = app
        .post_json(
            &format!("{}/{import}/discard", imports_url(campus)),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(count(&app, "roster_import_rows").await, 0);
    let (status, _) = confirm(&app, &professor, campus, import).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(count(&app, "core_users").await, 1);
}

#[tokio::test]
async fn an_import_of_another_campus_is_not_found() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let other_campus = app.seed_campus(&professor).await;
    let (_, preview) = paste(&app, &professor, campus, "Ana;ana@alumnos.test\n").await;
    let (status, _) = confirm(
        &app,
        &professor,
        other_campus,
        preview["id"].as_i64().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn guests_students_and_anonymous_cannot_import_or_list() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let guest = app.seed_guest(campus).await;
    let student = app.seed_student(campus).await;

    for who in [&guest, &student] {
        let (status, _) = paste(&app, who, campus, "Ana;ana@alumnos.test\n").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = upload(&app, who, campus, "a.csv", SEMICOLON_BOM).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .get(
                &format!("/api/campuses/{campus}/members"),
                Some(&who.cookie),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .post_json(
                &format!("/api/campuses/{campus}/members/{}/suspend", student.id),
                Some(&who.cookie),
                json!({ "reason": "x" }),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .post_json(
                &format!("/api/campuses/{campus}/teachers"),
                Some(&who.cookie),
                json!({ "email": professor.email }),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, _) = app
        .post_json(&imports_url(campus), None, json!({ "text": "a@b.co" }))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(count(&app, "roster_imports").await, 0);

    // The secretary can, without being a member.
    let secretary = app.login_as(Role::Secretary).await;
    let (status, _) = paste(&app, &secretary, campus, "Ana;ana@alumnos.test\n").await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn suspend_keeps_the_row_and_audits_who_when_and_why() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let url = format!("/api/campuses/{campus}/members/{}", student.id);

    let (status, _) = app
        .post_json(
            &format!("{url}/suspend"),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = app
        .post_json(
            &format!("{url}/suspend"),
            Some(&professor.cookie),
            json!({ "reason": "  " }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, member) = app
        .post_json(
            &format!("{url}/suspend"),
            Some(&professor.cookie),
            json!({ "reason": "Baja a pedido del estudiante" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{member}");
    assert_eq!(member["status"], "suspended");

    // The row is still there, listed as suspended, and the student lost access.
    let (_, members) = app
        .get(
            &format!("/api/campuses/{campus}/members"),
            Some(&professor.cookie),
        )
        .await;
    let listed = members
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == student.id)
        .expect("suspended member is still listed");
    assert_eq!(listed["status"], "suspended");
    assert_eq!(listed["suspended_reason"], "Baja a pedido del estudiante");
    let mut conn = app.db.acquire().await.unwrap();
    let access =
        australis_core::require_campus(&mut conn, &student.current(), campus, Access::View).await;
    assert!(matches!(access, Err(australis_core::AppError::Forbidden)));
    drop(conn);

    let audit: (Option<i64>, String, String, Option<String>, String) = sqlx::query_as(
        "SELECT actor_id, action, created_at, reason, entity FROM core_audit_log
         WHERE entity = 'member' AND action = 'suspend' AND subject_user_id = ?",
    )
    .bind(student.id)
    .fetch_one(&app.db)
    .await
    .unwrap();
    assert_eq!(audit.0, Some(professor.id));
    assert!(!audit.2.is_empty());
    assert_eq!(audit.3.as_deref(), Some("Baja a pedido del estudiante"));

    let (status, _) = app
        .post_json(
            &format!("{url}/reactivate"),
            Some(&professor.cookie),
            json!({ "reason": "Se reincorpora" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut conn = app.db.acquire().await.unwrap();
    australis_core::require_campus(&mut conn, &student.current(), campus, Access::View)
        .await
        .expect("access is back");
}

#[tokio::test]
async fn professors_and_oneself_cannot_be_suspended_here() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    for (who, target) in [(&secretary, professor.id), (&professor, professor.id)] {
        let (status, _) = app
            .post_json(
                &format!("/api/campuses/{campus}/members/{target}/suspend"),
                Some(&who.cookie),
                json!({ "reason": "x" }),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus}/members/999/suspend"),
            Some(&professor.cookie),
            json!({ "reason": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reinvite_only_for_a_never_activated_account() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let active = app.seed_student(campus).await;

    let (_, preview) = paste(&app, &professor, campus, "Ana;ana@alumnos.test\n").await;
    let (_, result) = confirm(&app, &professor, campus, preview["id"].as_i64().unwrap()).await;
    let ana = result["invites"][0]["user_id"].as_i64().unwrap();
    let old_url = result["invites"][0]["invite_url"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, body) = app
        .post_json(
            &format!("/api/campuses/{campus}/members/{ana}/invite"),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_url = body["invite_url"].as_str().unwrap();
    assert_ne!(new_url, old_url);
    // The earlier link stopped working.
    let old_token = old_url.rsplit('/').next().unwrap();
    let (status, _) = app
        .get(&format!("/api/auth/invites/{old_token}"), None)
        .await;
    assert_ne!(status, StatusCode::OK);

    // An account with a password never gets a link: it would be a password reset.
    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus}/members/{}/invite", active.id),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Nor for someone who is not a member of this campus.
    let stranger = app.login_as(Role::Student).await;
    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus}/members/{}/invite", stranger.id),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn guest_teacher_is_added_by_email() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let colleague = app.login_as(Role::Professor).await;
    let student = app.login_as(Role::Student).await;
    let url = format!("/api/campuses/{campus}/teachers");

    let (status, member) = app
        .post_json(
            &url,
            Some(&professor.cookie),
            json!({ "email": colleague.email.to_uppercase() }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{member}");
    assert_eq!(member["role"], "guest");
    // A guest can teach but not manage.
    let (status, _) = paste(&app, &colleague, campus, "Ana;ana@alumnos.test").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &url,
            Some(&professor.cookie),
            json!({ "email": colleague.email }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = app
        .post_json(
            &url,
            Some(&professor.cookie),
            json!({ "email": student.email }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = app
        .post_json(
            &url,
            Some(&professor.cookie),
            json!({ "email": "nadie@test.example" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn no_route_deletes_users_or_members() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let users = count(&app, "core_users").await;
    let members = count(&app, "core_members").await;

    for uri in [
        format!("/api/campuses/{campus}/members/{}", student.id),
        format!("/api/campuses/{campus}/members"),
        format!("/api/campuses/{campus}/teachers"),
        format!("/api/campuses/{campus}/roster/imports"),
    ] {
        for method in [Method::DELETE, Method::PUT, Method::PATCH] {
            let response = app
                .send(
                    common::request(method.clone(), &uri, Some(&professor.cookie))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await;
            assert!(
                response.status == StatusCode::METHOD_NOT_ALLOWED
                    || response.status == StatusCode::NOT_FOUND,
                "{method} {uri}: {}",
                response.status
            );
        }
    }
    assert_eq!(count(&app, "core_users").await, users);
    assert_eq!(count(&app, "core_members").await, members);
}

async fn invited_account(app: &TestApp, email: &str, role: Role) -> i64 {
    let mut conn = app.db.acquire().await.unwrap();
    directory::create_user(
        &mut conn,
        NewUser {
            email,
            full_name: "Pendiente",
            role,
            password_hash: None,
        },
    )
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn a_pending_professor_cannot_be_taken_over_through_guest_and_reinvite() {
    let app = TestApp::new().await;
    let attacker = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&attacker).await;
    let pending = invited_account(&app, "pendiente@test.example", Role::Professor).await;

    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus}/teachers"),
            Some(&attacker.cookie),
            json!({ "email": "pendiente@test.example" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Even if the account were a guest member, reinvite covers students only.
    let mut conn = app.db.acquire().await.unwrap();
    directory::add_member(&mut conn, attacker.id, campus, pending, MemberRole::Guest)
        .await
        .unwrap();
    drop(conn);
    let (status, body) = app
        .post_json(
            &format!("/api/campuses/{campus}/members/{pending}/invite"),
            Some(&attacker.cookie),
            json!({}),
        )
        .await;
    assert!(!status.is_success(), "{body}");
    assert_eq!(count(&app, "core_invites").await, 0);
}

#[tokio::test]
async fn confirming_never_issues_a_link_for_an_existing_account() {
    let app = TestApp::new().await;
    let prof_b = app.login_as(Role::Professor).await;
    let campus_b = app.seed_campus(&prof_b).await;
    let prof_a = app.login_as(Role::Professor).await;
    let campus_a = app.seed_campus(&prof_a).await;

    let (_, preview) = paste(&app, &prof_b, campus_b, "S;s@alumnos.test\n").await;
    let (_, result) = confirm(&app, &prof_b, campus_b, preview["id"].as_i64().unwrap()).await;
    let student = result["invites"][0]["user_id"].as_i64().unwrap();
    let url = result["invites"][0]["invite_url"].as_str().unwrap();
    let token = url.rsplit('/').next().unwrap().to_string();

    let (_, preview) = paste(&app, &prof_a, campus_a, "S;s@alumnos.test\n").await;
    assert_eq!(preview["importable"], 1);
    let (status, result) = confirm(&app, &prof_a, campus_a, preview["id"].as_i64().unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["added_existing"], 1);
    assert_eq!(result["invites"].as_array().unwrap().len(), 0);
    // B's link still works.
    let (status, _) = app.get(&format!("/api/auth/invites/{token}"), None).await;
    assert_eq!(status, StatusCode::OK);

    // And A cannot re-issue it for a student who also belongs to another campus.
    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus_a}/members/{student}/invite"),
            Some(&prof_a.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = app.get(&format!("/api/auth/invites/{token}"), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn extra_columns_are_dropped_without_a_header_or_a_name_column() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let text = "Ana Pérez;30111222;Comisión 2;ana@alumnos.test\n";
    let (status, preview) = paste(&app, &professor, campus, text).await;
    assert_eq!(status, StatusCode::CREATED, "{preview}");
    assert_eq!(row(&preview, "ana@alumnos.test")["full_name"], "Ana Pérez");
    assert!(!preview.to_string().contains("30111222"));

    // A header with an email column but no name column stores no name from other columns.
    let (_, preview) = paste(
        &app,
        &professor,
        campus,
        "DNI;Email\n30111222;luis@alumnos.test\n",
    )
    .await;
    let luis = row(&preview, "luis@alumnos.test");
    assert_eq!(luis["full_name"], "");
    assert_eq!(luis["importable"], false);
    assert!(!preview.to_string().contains("30111222"));
    let stored: Vec<String> = sqlx::query_scalar("SELECT full_name FROM roster_import_rows")
        .fetch_all(&app.db)
        .await
        .unwrap();
    assert!(stored.iter().all(|n| !n.contains("3011")));
}
