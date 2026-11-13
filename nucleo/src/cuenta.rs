use axum::extract::State;
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::*;
use crate::util::*;

pub async fn yo(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let sesion = match &ctx.via {
        Via::Sesion { vence, .. } => json!({
            "tipo": "cookie",
            "vence": fecha(*vence),
            "reautenticada_hasta": json_nulo(ctx.reautenticada_hasta(&app.cfg).map(fecha)),
        }),
        Via::Agente => return Err(ApiError::no_autenticado()),
    };
    Ok(ok(json!({"usuario": ctx.usuario.json(), "sesion": sesion})))
}

pub async fn mis_cursos(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let filas = sqlx::query(&format!(
        "SELECT c.id, c.nombre, c.periodo, c.color, c.version_publicada, {} AS rol, c.archivado_en IS NOT NULL AS archivado FROM inscripciones i \
         JOIN cursos c ON c.id = i.curso_id JOIN usuarios u ON u.id = i.usuario_id WHERE i.usuario_id = ? \
         AND NOT (c.archivado_en IS NOT NULL AND {} = 'alumno')",
        crate::cursos::ROL_EFECTIVO,
        crate::cursos::ROL_EFECTIVO
    ))
    .bind(ctx.usuario.id)
    .fetch_all(&app.db)
    .await?;
    let mut cursos: Vec<(String, Value)> = filas
        .iter()
        .map(|f| {
            let nombre: String = f.get("nombre");
            (
                sin_acentos(&nombre),
                json!({
                    "id": f.get::<String, _>("id"),
                    "tipo": crate::cursos::modulos::TIPO_LIBRE,
                    "nombre": nombre,
                    "periodo": f.get::<String, _>("periodo"),
                    "color": f.get::<String, _>("color"),
                    "rol": f.get::<String, _>("rol"),
                    "version_publicada": f.get::<Option<i64>, _>("version_publicada"),
                    "archivado": f.get::<i64, _>("archivado") != 0,
                }),
            )
        })
        .collect();
    for m in crate::cursos::modulos::de_la_persona(&app, ctx.usuario.id).await? {
        let nombre = m["nombre"].as_str().unwrap_or_default().to_string();
        cursos.push((sin_acentos(&nombre), m));
    }
    cursos.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ok(json!({"cursos": cursos.into_iter().map(|c| c.1).collect::<Vec<_>>()})))
}

pub async fn logout(State(app): State<Estado>, ctx: Ctx) -> Resultado {
    let sesion = ctx.solo_sesion()?;
    sqlx::query("UPDATE sesiones SET revocada = 1 WHERE id = ?").bind(sesion).execute(&app.db).await?;
    Ok(con_cookie(sin_contenido(), cookie_sesion(&app.cfg, "", 0)))
}
