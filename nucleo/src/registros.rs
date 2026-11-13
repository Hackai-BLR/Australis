use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use crate::archivos::{archivo_json_con, id_valido};
use crate::auth::{App, Ctx, Estado};
use crate::datos::{self, actividad_valida, filtros, id_persona, rol_en, Actor, Filtros};
use crate::util::*;

fn no_es_alumno() -> ApiError {
    ApiError::nuevo(StatusCode::BAD_REQUEST, "no_es_alumno", "Solo se ponen notas a alumnos del curso.")
}

const SQL_ENTREGA: &str = "SELECT e.id, e.actividad, e.texto, e.via, e.creada_en, e.usuario_id, u.nombre, u.email, e.archivo_id, \
     a.id AS a_id, a.nombre AS a_nombre, a.extension AS a_extension, a.tamano AS a_tamano, a.sha256 AS a_sha256, \
     a.material AS a_material, a.usuario_id AS a_usuario_id, ua.nombre AS a_usuario_nombre, a.creado_en AS a_creado_en \
     FROM entregas e JOIN usuarios u ON u.id = e.usuario_id LEFT JOIN archivos a ON a.id = e.archivo_id \
     LEFT JOIN usuarios ua ON ua.id = a.usuario_id WHERE e.curso_id = ?";

fn entrega_json(actor: &Actor, f: &SqliteRow) -> Value {
    let archivo = match f.get::<Option<String>, _>("a_id") {
        Some(_) => archivo_json_con(actor, f, "a_"),
        None => Value::Null,
    };
    json!({
        "id": f.get::<i64, _>("id"),
        "actividad": f.get::<String, _>("actividad"),
        "texto": f.get::<Option<String>, _>("texto"),
        "archivo": archivo,
        "usuario": {
            "id": actor.persona(f.get::<i64, _>("usuario_id")),
            "nombre": f.get::<String, _>("nombre"),
            "email": f.get::<String, _>("email"),
        },
        "fecha": f.get::<String, _>("creada_en"),
        "via": f.get::<String, _>("via"),
    })
}

const SQL_NOTA: &str = "SELECT n.id, n.actividad, n.valor, n.comentario, n.anterior, n.via, n.creada_en, n.usuario_id, \
     u.nombre, u.email, n.autor_id, au.nombre AS autor_nombre FROM notas n JOIN usuarios u ON u.id = n.usuario_id \
     JOIN usuarios au ON au.id = n.autor_id WHERE n.curso_id = ?";

fn nota_json(actor: &Actor, f: &SqliteRow, con_anterior: bool) -> Value {
    let mut v = json!({
        "id": f.get::<i64, _>("id"),
        "actividad": f.get::<String, _>("actividad"),
        "valor": f.get::<String, _>("valor"),
        "comentario": f.get::<Option<String>, _>("comentario"),
        "usuario": {
            "id": actor.persona(f.get::<i64, _>("usuario_id")),
            "nombre": f.get::<String, _>("nombre"),
            "email": f.get::<String, _>("email"),
        },
        "autor": {
            "id": actor.persona(f.get::<i64, _>("autor_id")),
            "nombre": f.get::<String, _>("autor_nombre"),
        },
        "fecha": f.get::<String, _>("creada_en"),
        "via": f.get::<String, _>("via"),
    });
    if con_anterior {
        v["anterior"] = json!(f.get::<Option<String>, _>("anterior"));
    }
    v
}

fn con_filtros(base: &str, prefijo: &str, f: &Filtros) -> String {
    let mut sql = base.to_string();
    if f.actividad.is_some() {
        sql.push_str(&format!(" AND {prefijo}.actividad = ?"));
    }
    if f.usuario.is_some() {
        sql.push_str(&format!(" AND {prefijo}.usuario_id = ?"));
    }
    sql
}

async fn filas(app: &App, sql: &str, curso: &str, f: &Filtros) -> Result<Vec<SqliteRow>, sqlx::Error> {
    let mut q = sqlx::query(sql).bind(curso);
    if let Some(a) = &f.actividad {
        q = q.bind(a);
    }
    if let Some(u) = f.usuario {
        q = q.bind(u);
    }
    q.fetch_all(&app.db).await
}

pub async fn listar_entregas(app: &App, actor: &Actor, cruda: Option<&str>) -> Resultado {
    let f = filtros(actor, cruda)?;
    let sql = format!("{} ORDER BY e.id", con_filtros(SQL_ENTREGA, "e", &f));
    let lista: Vec<Value> = filas(app, &sql, &actor.curso, &f).await?.iter().map(|x| entrega_json(actor, x)).collect();
    Ok(ok(json!({"entregas": lista})))
}

pub async fn entregar(app: &App, actor: &Actor, encabezados: &HeaderMap, cuerpo: &Bytes) -> Resultado {
    let d = cuerpo_json(encabezados, cuerpo)?;
    let actividad = texto_de(&d, "actividad").filter(|a| actividad_valida(a)).ok_or_else(ApiError::datos_invalidos)?;
    let texto = match d.get("texto") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.chars().count() > 20_000 {
                return Err(ApiError::datos_invalidos());
            }
            if s.trim().is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => return Err(ApiError::datos_invalidos()),
    };
    let archivo = match d.get("archivo_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if id_valido(s) => Some(s.clone()),
        Some(_) => return Err(ApiError::datos_invalidos()),
    };
    if texto.is_none() && archivo.is_none() {
        return Err(ApiError::datos_invalidos());
    }
    if let Some(a) = &archivo {
        let propio: Option<i64> = sqlx::query_scalar("SELECT 1 FROM archivos WHERE id = ? AND curso_id = ? AND usuario_id = ? \
             AND id NOT IN (SELECT archivo_id FROM archivos_retirados)")
            .bind(a)
            .bind(&actor.curso)
            .bind(actor.id)
            .fetch_optional(&app.db)
            .await?;
        if propio.is_none() {
            return Err(ApiError::no_encontrado());
        }
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO entregas (curso_id, usuario_id, actividad, texto, archivo_id, via, creada_en) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&actor.curso)
    .bind(actor.id)
    .bind(actividad)
    .bind(&texto)
    .bind(&archivo)
    .bind(actor.via())
    .bind(ahora_txt())
    .fetch_one(&app.db)
    .await?;
    let f = sqlx::query(&format!("{SQL_ENTREGA} AND e.id = ?")).bind(&actor.curso).bind(id).fetch_one(&app.db).await?;
    Ok(json_estado(StatusCode::CREATED, entrega_json(actor, &f)))
}

pub async fn listar_notas(app: &App, actor: &Actor, cruda: Option<&str>, historial: bool) -> Resultado {
    if historial && !actor.docente() {
        return Err(ApiError::prohibido());
    }
    let f = filtros(actor, cruda)?;
    let mut sql = con_filtros(SQL_NOTA, "n", &f);
    if historial {
        sql.push_str(" ORDER BY n.id");
    } else {
        sql.push_str(
            " AND n.id = (SELECT MAX(m.id) FROM notas m WHERE m.curso_id = n.curso_id AND m.usuario_id = n.usuario_id AND m.actividad = n.actividad)",
        );
    }
    let mut lista = filas(app, &sql, &actor.curso, &f).await?;
    if !historial {
        lista.sort_by_cached_key(|x| {
            (x.get::<String, _>("actividad"), sin_acentos(&x.get::<String, _>("nombre")), x.get::<String, _>("email"))
        });
    }
    let notas: Vec<Value> = lista.iter().map(|x| nota_json(actor, x, historial)).collect();
    Ok(ok(json!({"notas": notas})))
}

pub async fn poner_nota(app: &App, actor: &Actor, encabezados: &HeaderMap, cuerpo: &Bytes) -> Resultado {
    if !actor.docente() {
        return Err(ApiError::prohibido());
    }
    let d = cuerpo_json(encabezados, cuerpo)?;
    let alumno = d.get("usuario_id").and_then(id_persona).ok_or_else(ApiError::datos_invalidos)?;
    let actividad = texto_de(&d, "actividad").filter(|a| actividad_valida(a)).ok_or_else(ApiError::datos_invalidos)?;
    let valor = texto_de(&d, "valor").map(str::trim).ok_or_else(ApiError::datos_invalidos)?;
    let largo = valor.chars().count();
    if largo == 0 || largo > 20 {
        return Err(ApiError::datos_invalidos());
    }
    let comentario = match d.get("comentario") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.chars().count() <= 2000 => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => return Err(ApiError::datos_invalidos()),
    };
    let rol = rol_en(app, &actor.curso, alumno).await?.ok_or_else(ApiError::no_encontrado)?;
    if rol != "alumno" {
        return Err(no_es_alumno());
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO notas (curso_id, usuario_id, actividad, valor, comentario, anterior, autor_id, via, creada_en) \
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT valor FROM notas WHERE curso_id = ?1 AND usuario_id = ?2 AND actividad = ?3 ORDER BY id DESC LIMIT 1), \
         ?6, ?7, ?8) RETURNING id",
    )
    .bind(&actor.curso)
    .bind(alumno)
    .bind(actividad)
    .bind(valor)
    .bind(&comentario)
    .bind(actor.id)
    .bind(actor.via())
    .bind(ahora_txt())
    .fetch_one(&app.db)
    .await?;
    let f = sqlx::query(&format!("{SQL_NOTA} AND n.id = ?")).bind(&actor.curso).bind(id).fetch_one(&app.db).await?;
    Ok(json_estado(StatusCode::CREATED, nota_json(actor, &f, true)))
}

pub async fn p_entregas(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>, RawQuery(q): RawQuery) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:leer").await?;
    listar_entregas(&app, &actor, q.as_deref()).await
}

pub async fn p_entregar(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:escribir").await?;
    entregar(&app, &actor, &encabezados, &cuerpo).await
}

pub async fn p_notas(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>, RawQuery(q): RawQuery) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:leer").await?;
    listar_notas(&app, &actor, q.as_deref(), false).await
}

pub async fn p_historial(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>, RawQuery(q): RawQuery) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:leer").await?;
    listar_notas(&app, &actor, q.as_deref(), true).await
}

pub async fn p_poner_nota(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:escribir").await?;
    poner_nota(&app, &actor, &encabezados, &cuerpo).await
}

pub async fn c_entregas(State(app): State<Estado>, RawQuery(q): RawQuery, encabezados: HeaderMap) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    listar_entregas(&app, &actor, q.as_deref()).await
}

pub async fn c_entregar(State(app): State<Estado>, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    entregar(&app, &actor, &encabezados, &cuerpo).await
}

pub async fn c_notas(State(app): State<Estado>, RawQuery(q): RawQuery, encabezados: HeaderMap) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    listar_notas(&app, &actor, q.as_deref(), false).await
}

pub async fn c_historial(State(app): State<Estado>, RawQuery(q): RawQuery, encabezados: HeaderMap) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    listar_notas(&app, &actor, q.as_deref(), true).await
}

pub async fn c_poner_nota(State(app): State<Estado>, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    poner_nota(&app, &actor, &encabezados, &cuerpo).await
}
