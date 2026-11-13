use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey};
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
const TOLERANCIA_FUTURO_SEG: i64 = 30;
const VIGENCIA_MAXIMA_SEG: i64 = 120;

pub struct PersonaAustralis<'a> {
    pub usuario: i64,
    pub email: &'a str,
    pub nombre: &'a str,
    pub rol: &'a str,
    pub universidad: Option<i64>,
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
        PersonaAustralis { usuario: u.id, email: &u.email, nombre: &u.nombre, rol, universidad: u.universidad_id, administrador: !u.owner && u.administrador && u.universidad_id.is_some() }
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
                "universidad": p.universidad.map(|id| id.to_string()),
                "administrador": p.administrador,
            }),
            vigencia,
        )
    }

    pub fn verificar_australis(&self, valor: &str, ahora: i64) -> Option<String> {
        let (carga, firma) = valor.split_once('.')?;
        let firma = Signature::from_slice(&URL_SAFE_NO_PAD.decode(firma).ok()?).ok()?;
        self.clave.verifying_key().verify_strict(carga.as_bytes(), &firma).ok()?;
        let c: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(carga).ok()?).ok()?;
        let emitido = c["emitido"].as_i64()?;
        let vence = c["vence"].as_i64()?;
        if c["v"].as_i64()? != 1
            || c["curso"].as_str()? != CURSO_AUSTRALIS
            || vence <= ahora
            || emitido > ahora + TOLERANCIA_FUTURO_SEG
            || vence - emitido > VIGENCIA_MAXIMA_SEG
        {
            return None;
        }
        Some(c["email"].as_str()?.to_string())
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

#[cfg(test)]
mod pruebas {
    use super::*;

    fn identidad() -> Identidad {
        Identidad { clave: SigningKey::from_bytes(&[7u8; 32]) }
    }

    fn persona() -> PersonaAustralis<'static> {
        PersonaAustralis { usuario: 1, email: "a@b.test", nombre: "N", rol: "profesor", universidad: Some(1), administrador: false }
    }

    #[test]
    fn verifica_la_propia_firma_dentro_de_la_vigencia() {
        let i = identidad();
        let v = i.firmar_australis(&persona(), 60);
        let ahora = chrono::Utc::now().timestamp();
        assert_eq!(i.verificar_australis(&v, ahora).as_deref(), Some("a@b.test"));
        assert_eq!(i.verificar_australis(&v, ahora + 61), None);
        assert_eq!(i.verificar_australis(&v, ahora - 31), None);
        assert!(i.verificar_australis(&v, ahora - 29).is_some());
    }

    #[test]
    fn rechaza_vigencia_excesiva_y_otro_destino() {
        let i = identidad();
        let ahora = chrono::Utc::now().timestamp();
        assert_eq!(i.verificar_australis(&i.firmar_australis(&persona(), 121), ahora), None);
        let curso = i.firmar(&Persona { curso: "x", usuario: 1, email: "a@b.test", nombre: "N", rol: "profesor" }, 60);
        assert_eq!(i.verificar_australis(&curso, ahora), None);
    }
}
