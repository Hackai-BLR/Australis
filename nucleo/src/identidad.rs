use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use serde_json::json;
use sqlx::sqlite::SqlitePool;

pub struct Identidad {
    clave: SigningKey,
}

pub struct Persona<'a> {
    pub curso: &'a str,
    pub usuario: i64,
    pub email: &'a str,
    pub nombre: &'a str,
    pub rol: &'a str,
}

pub const CURSO_AUSTRALIS: &str = "australis";

pub struct PersonaAustralis<'a> {
    pub usuario: i64,
    pub email: &'a str,
    pub nombre: &'a str,
    pub rol: &'a str,
    pub administrador: bool,
}

impl<'a> PersonaAustralis<'a> {
    pub fn de_usuario(u: &'a crate::auth::Usuario) -> PersonaAustralis<'a> {
        let rol = if u.owner {
            "dueño"
        } else if u.profesor {
            "profesor"
        } else {
            "alumno"
        };
        PersonaAustralis { usuario: u.id, email: &u.email, nombre: &u.nombre, rol, administrador: u.administrador }
    }
}

fn desde_semilla(semilla: &str) -> anyhow::Result<SigningKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(semilla.as_bytes())
        .map_err(|_| anyhow::anyhow!("La clave de identidad no es base64url válido"))?;
    let arreglo: [u8; 32] =
        bytes.try_into().map_err(|_| anyhow::anyhow!("La clave de identidad tiene que tener 32 bytes"))?;
    Ok(SigningKey::from_bytes(&arreglo))
}

impl Identidad {
    pub async fn cargar(db: &SqlitePool, desde_entorno: Option<&str>) -> anyhow::Result<Identidad> {
        if let Some(s) = desde_entorno {
            return Ok(Identidad { clave: desde_semilla(s)? });
        }
        let guardada: Option<String> =
            sqlx::query_scalar("SELECT valor FROM configuracion WHERE clave = 'identidad_clave_privada'")
                .fetch_optional(db)
                .await?;
        if let Some(s) = guardada {
            return Ok(Identidad { clave: desde_semilla(&s)? });
        }
        let mut semilla = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut semilla);
        let texto = URL_SAFE_NO_PAD.encode(semilla);
        sqlx::query("INSERT OR IGNORE INTO configuracion (clave, valor) VALUES ('identidad_clave_privada', ?)")
            .bind(&texto)
            .execute(db)
            .await?;
        let final_: String =
            sqlx::query_scalar("SELECT valor FROM configuracion WHERE clave = 'identidad_clave_privada'")
                .fetch_one(db)
                .await?;
        Ok(Identidad { clave: desde_semilla(&final_)? })
    }

    pub fn publica(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.clave.verifying_key().to_bytes())
    }

    pub fn firmar(&self, p: &Persona, vigencia: i64) -> String {
        self.firmar_carga(
            json!({
                "v": 1,
                "curso": p.curso,
                "usuario": p.usuario.to_string(),
                "email": p.email,
                "nombre": p.nombre,
                "rol": p.rol,
            }),
            vigencia,
        )
    }

    pub fn firmar_australis(&self, p: &PersonaAustralis, vigencia: i64) -> String {
        self.firmar_carga(
            json!({
                "v": 1,
                "curso": CURSO_AUSTRALIS,
                "usuario": p.usuario.to_string(),
                "email": p.email,
                "nombre": p.nombre,
                "rol": p.rol,
                "administrador": p.administrador,
            }),
            vigencia,
        )
    }

    fn firmar_carga(&self, mut carga: serde_json::Value, vigencia: i64) -> String {
        let emitido = chrono::Utc::now().timestamp();
        carga["emitido"] = json!(emitido);
        carga["vence"] = json!(emitido + vigencia);
        let c = URL_SAFE_NO_PAD.encode(carga.to_string().as_bytes());
        let firma = self.clave.sign(c.as_bytes());
        format!("{c}.{}", URL_SAFE_NO_PAD.encode(firma.to_bytes()))
    }
}
