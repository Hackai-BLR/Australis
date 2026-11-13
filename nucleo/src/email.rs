use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::config::{Config, TipoProveedorEmail};
use crate::util::ahora_txt;

#[derive(Clone, Debug)]
pub struct Mail {
    pub para: String,
    pub asunto: String,
    pub texto: String,
    pub html: String,
}

#[async_trait]
pub trait ProveedorDeEmail: Send + Sync {
    async fn enviar(&self, mail: &Mail) -> anyhow::Result<()>;
}

pub struct ProveedorArchivo {
    ruta: String,
    cerrojo: Mutex<()>,
}

#[async_trait]
impl ProveedorDeEmail for ProveedorArchivo {
    async fn enviar(&self, mail: &Mail) -> anyhow::Result<()> {
        let linea = json!({
            "para": mail.para,
            "asunto": mail.asunto,
            "texto": mail.texto,
            "html": mail.html,
            "fecha": ahora_txt(),
        })
        .to_string()
            + "\n";
        let _guardia = self.cerrojo.lock().await;
        let mut archivo = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.ruta)
            .await
            .with_context(|| format!("no se pudo abrir {}", self.ruta))?;
        archivo.write_all(linea.as_bytes()).await?;
        archivo.flush().await?;
        archivo.sync_data().await?;
        Ok(())
    }
}

pub struct ProveedorBrevo {
    cliente: reqwest::Client,
    url: String,
    clave: String,
    remitente: String,
    nombre_remitente: String,
}

#[async_trait]
impl ProveedorDeEmail for ProveedorBrevo {
    async fn enviar(&self, mail: &Mail) -> anyhow::Result<()> {
        let cuerpo = json!({
            "sender": {"email": self.remitente, "name": self.nombre_remitente},
            "to": [{"email": mail.para}],
            "subject": mail.asunto,
            "textContent": mail.texto,
            "htmlContent": mail.html,
        });
        let r = self
            .cliente
            .post(&self.url)
            .header("api-key", &self.clave)
            .header("accept", "application/json")
            .json(&cuerpo)
            .send()
            .await?;
        if !r.status().is_success() {
            return Err(anyhow!("brevo respondió {}", r.status()));
        }
        Ok(())
    }
}

pub fn crear(cfg: &Config) -> Box<dyn ProveedorDeEmail> {
    match &cfg.proveedor_email {
        TipoProveedorEmail::Archivo { ruta } => Box::new(ProveedorArchivo { ruta: ruta.clone(), cerrojo: Mutex::new(()) }),
        TipoProveedorEmail::Brevo { clave, url } => Box::new(ProveedorBrevo {
            cliente: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("cliente http"),
            url: url.clone(),
            clave: clave.clone(),
            remitente: cfg.email_from.clone(),
            nombre_remitente: cfg.email_from_name.clone(),
        }),
    }
}

pub fn mail_de_codigo(para: &str, codigo: &str, reautenticacion: bool) -> Mail {
    let (asunto, motivo) = if reautenticacion {
        ("Código para confirmar que sos vos", "Usá este código para confirmar que sos vos en Campus IA.")
    } else {
        ("Tu código para entrar a Campus IA", "Usá este código para entrar a Campus IA.")
    };
    let texto = format!(
        "{motivo}\n\n{codigo}\n\nVence en pocos minutos y sirve una sola vez. Si no lo pediste, ignorá este mail."
    );
    let html = format!(
        "<!doctype html><html><body style=\"font-family:Inter,Arial,sans-serif;color:#1a1a1a\">\
<p>{motivo}</p>\
<p style=\"font-size:28px;font-weight:700;letter-spacing:6px;color:#001D9C\">{codigo}</p>\
<p style=\"color:#666\">Vence en pocos minutos y sirve una sola vez. Si no lo pediste, ignorá este mail.</p>\
</body></html>"
    );
    Mail { para: para.to_string(), asunto: asunto.to_string(), texto, html }
}

pub fn mail_de_invitacion(para: &str, quien: &str, universidad: &str, marca: &str, dominio_base: &str) -> Mail {
    let direccion = format!("https://{dominio_base}");
    let asunto = format!("Invitación a Campus IA de {universidad}");
    let texto = format!(
        "{quien} te invitó a Campus IA de {universidad} como {marca}.\n\nEntrá en {direccion} con tu mail. Te vamos a mandar un código para ingresar."
    );
    let e = crate::util::escapar_html;
    let html = format!(
        "<!doctype html><html><body style=\"font-family:Inter,Arial,sans-serif;color:#1a1a1a\">\
<p>{} te invitó a Campus IA de {} como {}.</p>\
<p><a href=\"{d}\" style=\"color:#1E4FD6\">{d}</a></p>\
<p style=\"color:#666\">Entrá con tu mail. Te vamos a mandar un código para ingresar.</p>\
</body></html>",
        e(quien),
        e(universidad),
        e(marca),
        d = e(&direccion)
    );
    Mail { para: para.to_string(), asunto, texto, html }
}
