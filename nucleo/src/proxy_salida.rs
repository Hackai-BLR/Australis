use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::config::Red;
use crate::contenedores::EscuchaApi;

const MAXIMO_CABECERA: usize = 16 * 1024;

pub struct ProxySalida {
    permitidos: Vec<String>,
    subred: Option<Red>,
}

async fn responder<S: AsyncWrite + Unpin>(s: &mut S, estado: &str) {
    let r = format!("HTTP/1.1 {estado}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    let _ = s.write_all(r.as_bytes()).await;
    let _ = s.shutdown().await;
}

impl ProxySalida {
    pub fn nuevo(permitidos: Vec<String>, subred: Option<Red>) -> ProxySalida {
        ProxySalida { permitidos, subred }
    }

    fn destino(&self, linea: &str) -> Result<String, &'static str> {
        let mut partes = linea.split(' ');
        let metodo = partes.next().unwrap_or("");
        let objetivo = partes.next().unwrap_or("");
        let version = partes.next().unwrap_or("");
        if partes.next().is_some() || !version.starts_with("HTTP/1.") {
            return Err("400 Bad Request");
        }
        if metodo != "CONNECT" {
            return Err("405 Method Not Allowed");
        }
        let Some((host, puerto)) = objetivo.rsplit_once(':') else { return Err("403 Forbidden") };
        let host = host.to_ascii_lowercase();
        if puerto != "443" || !self.permitidos.iter().any(|p| *p == host) {
            return Err("403 Forbidden");
        }
        Ok(host)
    }

    async fn atender<S: AsyncRead + AsyncWrite + Unpin>(self: Arc<Self>, mut s: S) {
        let mut cabecera = Vec::with_capacity(1024);
        let mut buf = [0u8; 2048];
        let fin = loop {
            let n = match tokio::time::timeout(Duration::from_secs(15), s.read(&mut buf)).await {
                Ok(Ok(n)) if n > 0 => n,
                _ => return,
            };
            cabecera.extend_from_slice(&buf[..n]);
            if let Some(p) = cabecera.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            if cabecera.len() > MAXIMO_CABECERA {
                return responder(&mut s, "431 Request Header Fields Too Large").await;
            }
        };
        let texto = String::from_utf8_lossy(&cabecera[..fin]).to_string();
        let primera = texto.split("\r\n").next().unwrap_or("");
        let host = match self.destino(primera) {
            Ok(h) => h,
            Err(e) => return responder(&mut s, e).await,
        };
        let remoto = match tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host.as_str(), 443))).await {
            Ok(Ok(r)) => r,
            _ => return responder(&mut s, "502 Bad Gateway").await,
        };
        let mut remoto = remoto;
        if s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() {
            return;
        }
        if fin < cabecera.len() && remoto.write_all(&cabecera[fin..]).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut s, &mut remoto).await;
    }

    pub async fn servir(self: Arc<Self>, escucha: EscuchaApi) {
        match escucha {
            EscuchaApi::Tcp(l) => loop {
                let Ok((s, par)) = l.accept().await else { continue };
                if let Some(r) = &self.subred {
                    if !r.contiene(par.ip()) {
                        drop(s);
                        continue;
                    }
                }
                tokio::spawn(self.clone().atender(s));
            },
            EscuchaApi::Unix(l) => loop {
                let Ok((s, _)) = l.accept().await else { continue };
                tokio::spawn(self.clone().atender(s));
            },
        }
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn destinos() {
        let p = ProxySalida::nuevo(vec!["registry.npmjs.org".into()], None);
        assert_eq!(p.destino("CONNECT registry.npmjs.org:443 HTTP/1.1"), Ok("registry.npmjs.org".to_string()));
        assert_eq!(p.destino("CONNECT REGISTRY.npmjs.org:443 HTTP/1.1"), Ok("registry.npmjs.org".to_string()));
        assert!(p.destino("CONNECT registry.npmjs.org:80 HTTP/1.1").is_err());
        assert!(p.destino("CONNECT registry.npmjs.org.evil.com:443 HTTP/1.1").is_err());
        assert!(p.destino("CONNECT 1.1.1.1:443 HTTP/1.1").is_err());
        assert_eq!(p.destino("GET http://example.com/ HTTP/1.1"), Err("405 Method Not Allowed"));
    }
}
