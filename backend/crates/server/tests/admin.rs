//! F13: the secretary's read-only lists of campuses and people.

mod common;

use australis_core::{
    directory::{self, MemberRole},
    Role,
};
use axum::http::StatusCode;
use common::TestApp;
use serde_json::{json, Value};

fn names(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item[key].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn only_the_secretary_reads_the_lists() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let id = student.id;
    for uri in [
        "/api/admin/campuses".to_string(),
        "/api/admin/people".to_string(),
        format!("/api/admin/people/{id}"),
    ] {
        let (status, _) = app.get(&uri, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        for user in [&professor, &student] {
            let (status, _) = app.get(&uri, Some(&user.cookie)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        }
    }
}

#[tokio::test]
async fn lists_every_campus_with_counts_and_searches_by_name() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let first = app.seed_campus(&professor).await;
    let second = app.seed_campus(&professor).await;
    app.seed_student(first).await;
    let gone = app.seed_student(first).await;
    app.seed_guest(second).await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        directory::suspend_member(&mut conn, secretary.id, first, gone.id, "Baja")
            .await
            .unwrap();
    }

    let (status, body) = app
        .get("/api/admin/campuses", Some(&secretary.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 2);
    let one = list.iter().find(|c| c["id"] == first).unwrap();
    assert_eq!(one["students"], 1);
    assert_eq!(one["professors"], 1);
    assert_eq!(one["suspended"], 1);
    let two = list.iter().find(|c| c["id"] == second).unwrap();
    assert_eq!(two["guests"], 1);

    let (_, body) = app
        .get(
            &format!("/api/admin/campuses?q={}", "TEST%20CAMPUS%20"),
            Some(&secretary.cookie),
        )
        .await;
    assert_eq!(body.as_array().unwrap().len(), 2);
    let (_, body) = app
        .get("/api/admin/campuses?q=no-existe", Some(&secretary.cookie))
        .await;
    assert!(body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn people_filter_by_text_role_and_status() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let other = app.seed_student(campus).await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        directory::suspend_user(&mut conn, secretary.id, other.id, "Baja")
            .await
            .unwrap();
    }
    let cookie = Some(secretary.cookie.as_str());

    let (status, all) = app.get("/api/admin/people", cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all.as_array().unwrap().len(), 4);
    assert!(all[0].get("password_hash").is_none());
    assert!(all[0].get("has_password").is_none());

    let (_, students) = app.get("/api/admin/people?role=student", cookie).await;
    assert_eq!(students.as_array().unwrap().len(), 2);
    let (_, professors) = app.get("/api/admin/people?role=professor", cookie).await;
    assert_eq!(names(&professors, "email"), vec![professor.email.clone()]);

    let (_, suspended) = app.get("/api/admin/people?status=suspended", cookie).await;
    assert_eq!(names(&suspended, "email"), vec![other.email.clone()]);
    let (_, both) = app
        .get("/api/admin/people?role=student&status=active", cookie)
        .await;
    assert_eq!(names(&both, "email"), vec![student.email.clone()]);

    let part = student.email.to_uppercase();
    let (_, found) = app
        .get(&format!("/api/admin/people?q={part}"), cookie)
        .await;
    assert_eq!(names(&found, "email"), vec![student.email.clone()]);
    let (_, by_name) = app
        .get(
            &format!(
                "/api/admin/people?q={}",
                professor.full_name.replace(' ', "%20")
            ),
            cookie,
        )
        .await;
    assert_eq!(names(&by_name, "email"), vec![professor.email.clone()]);

    let (status, _) = app.get("/api/admin/people?role=dean", cookie).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = app.get("/api/admin/people?status=gone", cookie).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_person_links_to_each_of_their_campuses() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let first = app.seed_campus(&professor).await;
    let second = app.seed_campus(&professor).await;
    let student = app.seed_student(first).await;
    app.add_member(second, &student, MemberRole::Student).await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        directory::suspend_member(&mut conn, secretary.id, second, student.id, "Baja")
            .await
            .unwrap();
    }

    let (status, body) = app
        .get(
            &format!("/api/admin/people/{}", student.id),
            Some(&secretary.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["email"], student.email);
    assert_eq!(body["role"], "student");
    assert!(body.get("password_hash").is_none());
    let memberships = body["memberships"].as_array().unwrap();
    assert_eq!(memberships.len(), 2);
    // The list is ordered by campus name, and the seeded names ("Test campus 9",
    // "Test campus 10") do not sort in creation order, so look each one up by id.
    let status_of = |campus: i64| {
        memberships
            .iter()
            .find(|m| m["campus_id"] == campus)
            .unwrap_or_else(|| panic!("no membership for campus {campus}"))["status"]
            .clone()
    };
    assert_eq!(status_of(first), "active");
    assert_eq!(status_of(second), "suspended");

    let (status, _) = app
        .get("/api/admin/people/99999", Some(&secretary.cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_university_administrator_sees_only_their_university() {
    let app = TestApp::new().await;
    let admin = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let outsider = app.login_as(Role::Professor).await;
    let mine = app.seed_campus(&professor).await;
    let theirs = app.seed_campus(&outsider).await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        directory::set_university(&mut conn, admin.id, Some("uni-a"), true)
            .await
            .unwrap();
        directory::set_university(&mut conn, professor.id, Some("uni-a"), false)
            .await
            .unwrap();
        directory::set_university(&mut conn, outsider.id, Some("uni-b"), false)
            .await
            .unwrap();
        sqlx::query("UPDATE core_campuses SET university = 'uni-a' WHERE id = ?")
            .bind(mine)
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("UPDATE core_campuses SET university = 'uni-b' WHERE id = ?")
            .bind(theirs)
            .execute(&mut *conn)
            .await
            .unwrap();
    }
    let cookie = Some(admin.cookie.as_str());

    let (_, campuses) = app.get("/api/admin/campuses", cookie).await;
    assert_eq!(campuses.as_array().unwrap().len(), 1);
    assert_eq!(campuses[0]["id"], mine);
    let (_, people) = app.get("/api/admin/people", cookie).await;
    let emails = names(&people, "email");
    assert!(emails.contains(&professor.email));
    assert!(!emails.contains(&outsider.email));
    let (status, _) = app
        .get(&format!("/api/admin/people/{}", outsider.id), cookie)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
