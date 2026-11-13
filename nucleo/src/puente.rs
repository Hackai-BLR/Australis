use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::process::{Child, ChildStdin, Command};

use crate::config::Red;

pub const ENCABEZADO_FALLA: &str = "x-campusia-puente";
const MAXIMO_CABECERA: usize = 32 * 1024;
const PUERTO_CURSO: u16 = 3000;

#[derive(Clone)]
pub struct Destino {
    pub pid_archivo: PathBuf,
    pub escucha: SocketAddr,
    pub api: PathBuf,
    pub cursos: PathBuf,
    pub subred: Option<String>,
}

fn leer_pid(archivo: &Path) -> anyhow::Result<String> {
    let texto = std::fs::read_to_string(archivo)
        .map_err(|e| anyhow::anyhow!("No se pudo leer el proceso de Docker sin root en {}: {e}", archivo.display()))?;
    let pid = texto.trim().to_string();
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        anyhow::bail!("{} no tiene un número de proceso válido", archivo.display());
    }
    Ok(pid)
}

struct Proceso {
    hijo: Child,
    _entrada: ChildStdin,
    pid: String,
}

async fn lanzar(d: &Destino) -> anyhow::Result<Proceso> {
    let pid = leer_pid(&d.pid_archivo)?;
    let ejecutable = std::env::current_exe()?;
    let mut c = Command::new("nsenter");
    c.env_clear();
    if let Ok(ruta) = std::env::var("PATH") {
        c.env("PATH", ruta);
    }
    c.args(["-U", "--preserve-credentials", "-n", "-t", &pid])
        .arg(&ejecutable)
        .arg("puente")
        .arg(d.escucha.to_string())
        .arg(&d.api)
        .arg(&d.cursos)
        .arg(d.subred.clone().unwrap_or_else(|| "-".to_string()))
        .current_dir("/")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut hijo = c.spawn().map_err(|e| anyhow::anyhow!("No se pudo ejecutar nsenter: {e}"))?;
    let entrada = hijo.stdin.take().ok_or_else(|| anyhow::anyhow!("El puente no tiene entrada"))?;
    let salida = hijo.stdout.take().ok_or_else(|| anyhow::anyhow!("El puente no tiene salida"))?;
    let mut lineas = BufReader::new(salida).lines();
    let listo = tokio::time::timeout(Duration::from_secs(15), lineas.next_line()).await;
    match listo {
        Ok(Ok(Some(l))) if l.trim() == "listo" => Ok(Proceso { hijo, _entrada: entrada, pid }),
        _ => {
            let _ = hijo.kill().await;
            anyhow::bail!(
                "El puente hacia la red de los cursos no arrancó en el espacio de red del proceso {pid} ({})",
                d.escucha
            )
        }
    }
}

async fn pid_cambiado(archivo: &Path, pid: &str) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Ok(nuevo) = leer_pid(archivo) {
            if nuevo != pid {
                return;
            }
        }
    }
}

async fn vigilar(d: Destino, mut p: Proceso) {
    loop {
        tokio::select! {
            r = p.hijo.wait() => eprintln!("el puente hacia la red de los cursos terminó: {r:?}"),
            _ = pid_cambiado(&d.pid_archivo, &p.pid) => {
                eprintln!("Docker sin root cambió de proceso: se reinicia el puente");
                let _ = p.hijo.kill().await;
            }
        }
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            match lanzar(&d).await {
                Ok(nuevo) => {
                    p = nuevo;
                    eprintln!("puente hacia la red de los cursos reiniciado");
                    break;
                }
                Err(e) => eprintln!("{e:#}"),
            }
        }
    }
}

pub async fn iniciar(d: Destino) -> anyhow::Result<()> {
    let p = lanzar(&d).await?;
    tokio::spawn(vigilar(d, p));
    Ok(())
}

pub fn escucha_unix(ruta: &Path) -> anyhow::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(ruta);
    let l = UnixListener::bind(ruta).map_err(|e| anyhow::anyhow!("No se pudo abrir {}: {e}", ruta.display()))?;
    std::fs::set_permissions(ruta, std::fs::Permissions::from_mode(0o600))?;
    Ok(l)
}

fn destino_de_cabecera(cabecera: &[u8], subred: Option<&Red>) -> Option<SocketAddr> {
    let texto = std::str::from_utf8(cabecera).ok()?;
    let host = texto.split("\r\n").skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("host").then(|| v.trim().to_string())
    })?;
    let (ip, puerto) = host.rsplit_once(':')?;
    let ip: IpAddr = ip.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    let puerto: u16 = puerto.parse().ok()?;
    if puerto != PUERTO_CURSO || ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return None;
    }
    if let Some(r) = subred {
        if !r.contiene(ip) {
            return None;
        }
    }
    Some(SocketAddr::new(ip, puerto))
}

async fn fallar(s: &mut UnixStream) {
    let r = format!("HTTP/1.1 502 Bad Gateway\r\n{ENCABEZADO_FALLA}: sin-conexion\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    let _ = s.write_all(r.as_bytes()).await;
    let _ = s.shutdown().await;
}

async fn hacia_curso(mut s: UnixStream, subred: Option<Red>) {
    let mut cabecera = Vec::with_capacity(2048);
    let mut buf = [0u8; 4096];
    loop {
        let n = match tokio::time::timeout(Duration::from_secs(30), s.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => return,
        };
        cabecera.extend_from_slice(&buf[..n]);
        if cabecera.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if cabecera.len() > MAXIMO_CABECERA {
            return fallar(&mut s).await;
        }
    }
    let Some(destino) = destino_de_cabecera(&cabecera, subred.as_ref()) else {
        return fallar(&mut s).await;
    };
    let mut curso = match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(destino)).await {
        Ok(Ok(c)) => c,
        _ => return fallar(&mut s).await,
    };
    if curso.write_all(&cabecera).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut s, &mut curso).await;
}

async fn hacia_api(mut s: TcpStream, api: PathBuf) {
    let Ok(mut u) = UnixStream::connect(&api).await else { return };
    let _ = tokio::io::copy_bidirectional(&mut s, &mut u).await;
}

pub async fn servir(args: &[String]) -> anyhow::Result<()> {
    let [escucha, api, cursos, subred] = args else {
        anyhow::bail!("Uso: campusia-nucleo puente <escucha> <api> <cursos> <subred>")
    };
    let escucha: SocketAddr = escucha.parse().map_err(|_| anyhow::anyhow!("Dirección inválida: {escucha}"))?;
    let api = PathBuf::from(api);
    let subred = if subred == "-" {
        None
    } else {
        Some(Red::leer(subred).ok_or_else(|| anyhow::anyhow!("Subred inválida: {subred}"))?)
    };
    let tcp = TcpListener::bind(escucha)
        .await
        .map_err(|e| anyhow::anyhow!("El puente no pudo abrir la escucha de la API para cursos en {escucha}: {e}"))?;
    let unix = escucha_unix(Path::new(cursos))?;
    let mut out = tokio::io::stdout();
    out.write_all(b"listo\n").await?;
    out.flush().await?;
    eprintln!("puente: API para cursos en {escucha}");
    tokio::spawn(async {
        let mut entrada = tokio::io::stdin();
        let mut b = [0u8; 64];
        while let Ok(n) = entrada.read(&mut b).await {
            if n == 0 {
                break;
            }
        }
        std::process::exit(0);
    });
    tokio::spawn(async move {
        loop {
            if let Ok((s, _)) = tcp.accept().await {
                tokio::spawn(hacia_api(s, api.clone()));
            }
        }
    });
    loop {
        if let Ok((s, _)) = unix.accept().await {
            tokio::spawn(hacia_curso(s, subred.clone()));
        }
    }
}
