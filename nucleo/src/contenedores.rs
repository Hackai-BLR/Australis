use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::{ConfigContenedores, SinRoot};

#[derive(Clone, Debug)]
pub struct InfoContenedor {
    pub corriendo: bool,
    pub ip: Option<IpAddr>,
}

pub struct EspecContenedor {
    pub nombre: String,
    pub imagen: String,
    pub curso: String,
    pub datos: String,
    pub entorno: Vec<(String, String)>,
}

pub struct InfoRed {
    pub puerta: Option<IpAddr>,
    pub subred: Option<String>,
}

pub enum EscuchaApi {
    Tcp(tokio::net::TcpListener),
    Unix(tokio::net::UnixListener),
}

pub struct Acceso {
    pub escucha: EscuchaApi,
    pub url_api: String,
    pub socket_cursos: Option<PathBuf>,
    pub descripcion: String,
}

#[async_trait]
pub trait ProveedorDeContenedores: Send + Sync {
    async fn preparar_red(&self) -> anyhow::Result<InfoRed>;
    async fn abrir_acceso(&self, red: &InfoRed) -> anyhow::Result<Acceso>;
    async fn imagen_existe(&self, imagen: &str) -> anyhow::Result<bool>;
    async fn construir_imagen(&self, imagen: &str, curso: &str, archivo: &str, contexto: Vec<u8>, limite: Duration) -> anyhow::Result<()>;
    async fn inspeccionar(&self, nombre: &str) -> anyhow::Result<Option<InfoContenedor>>;
    async fn crear(&self, espec: &EspecContenedor) -> anyhow::Result<()>;
    async fn arrancar(&self, nombre: &str) -> anyhow::Result<()>;
    async fn detener(&self, nombre: &str) -> anyhow::Result<()>;
    async fn borrar(&self, nombre: &str) -> anyhow::Result<()>;
}

pub struct ProveedorCli {
    cli: String,
    prefijo: String,
    red: String,
    memoria: String,
    cpus: String,
    pids: i64,
    puerto_api: u16,
    direccion_api: Option<String>,
    url_api: Option<String>,
    sin_root: SinRoot,
    pid_red: Option<PathBuf>,
    subdir: String,
}

fn recortar(s: &str) -> String {
    let s = s.trim();
    let n = s.chars().count();
    if n > 2000 {
        s.chars().skip(n - 2000).collect()
    } else {
        s.to_string()
    }
}

pub(crate) struct Salida {
    pub exito: bool,
    pub stdout: String,
    pub stderr: String,
}

const ENTORNO_CLI: [&str; 7] = ["PATH", "HOME", "DOCKER_HOST", "XDG_RUNTIME_DIR", "DOCKER_CONFIG", "DOCKER_CONTEXT", "CONTAINER_HOST"];

impl ProveedorCli {
    pub fn nuevo(cfg: &ConfigContenedores) -> ProveedorCli {
        ProveedorCli {
            cli: cfg.cli.clone(),
            prefijo: cfg.prefijo.clone(),
            red: cfg.red.clone(),
            memoria: cfg.memoria.clone(),
            cpus: cfg.cpus.clone(),
            pids: cfg.pids,
            puerto_api: cfg.puerto_api,
            direccion_api: cfg.direccion_api.clone(),
            url_api: cfg.url_api.clone(),
            sin_root: cfg.sin_root,
            pid_red: cfg.pid_red.clone(),
            subdir: format!("campusia-{}", cfg.prefijo),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn derivado(
        &self,
        red: &str,
        puerto: u16,
        direccion: Option<String>,
        url: Option<String>,
        subdir: &str,
        memoria: &str,
        cpus: &str,
        pids: i64,
    ) -> ProveedorCli {
        ProveedorCli {
            cli: self.cli.clone(),
            prefijo: self.prefijo.clone(),
            red: red.to_string(),
            memoria: memoria.to_string(),
            cpus: cpus.to_string(),
            pids,
            puerto_api: puerto,
            direccion_api: direccion,
            url_api: url,
            sin_root: self.sin_root,
            pid_red: self.pid_red.clone(),
            subdir: format!("campusia-{}-{subdir}", self.prefijo),
        }
    }

    pub fn red(&self) -> &str {
        &self.red
    }

    pub fn prefijo(&self) -> &str {
        &self.prefijo
    }

    pub fn limites(&self) -> (String, String, i64) {
        (self.memoria.clone(), self.cpus.clone(), self.pids)
    }

    pub async fn sin_root(&self) -> anyhow::Result<bool> {
        self.es_sin_root().await
    }

    pub async fn renombrar(&self, de: &str, a: &str) -> anyhow::Result<()> {
        self.propio(de).await?.ok_or_else(|| anyhow::anyhow!("El contenedor {de} no existe"))?;
        self.exigir(&["rename", de, a]).await?;
        Ok(())
    }

    pub(crate) fn comando(&self) -> Command {
        let mut c = Command::new(&self.cli);
        c.kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.env_clear();
        for k in ENTORNO_CLI {
            if let Ok(v) = std::env::var(k) {
                c.env(k, v);
            }
        }
        c
    }

    pub(crate) async fn correr(&self, args: &[&str]) -> anyhow::Result<Salida> {
        let mut c = self.comando();
        c.args(args);
        let r = tokio::time::timeout(Duration::from_secs(120), c.output())
            .await
            .map_err(|_| anyhow::anyhow!("{} {} no terminó a tiempo", self.cli, args.first().unwrap_or(&"")))?
            .map_err(|e| anyhow::anyhow!("no se pudo ejecutar {}: {e}", self.cli))?;
        Ok(Salida {
            exito: r.status.success(),
            stdout: String::from_utf8_lossy(&r.stdout).to_string(),
            stderr: String::from_utf8_lossy(&r.stderr).to_string(),
        })
    }

    pub(crate) async fn exigir(&self, args: &[&str]) -> anyhow::Result<String> {
        let s = self.correr(args).await?;
        if !s.exito {
            anyhow::bail!("{} {} falló: {}", self.cli, args.first().unwrap_or(&""), recortar(&s.stderr));
        }
        Ok(s.stdout)
    }

    async fn es_sin_root(&self) -> anyhow::Result<bool> {
        match self.sin_root {
            SinRoot::Si => Ok(true),
            SinRoot::No => Ok(false),
            SinRoot::Auto => {
                let s = self.correr(&["info", "--format", "{{json .SecurityOptions}}"]).await?;
                Ok(s.exito && s.stdout.contains("rootless"))
            }
        }
    }

    fn archivo_pid_red(&self) -> anyhow::Result<PathBuf> {
        if let Some(p) = &self.pid_red {
            return Ok(p.clone());
        }
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
            for candidato in [dir.join("dockerd-rootless").join("child_pid"), dir.join("docker.pid")] {
                if candidato.exists() {
                    return Ok(candidato);
                }
            }
        }
        anyhow::bail!("No se encontró el proceso de Docker sin root: definí CONTENEDORES_PID_RED o XDG_RUNTIME_DIR")
    }

    fn directorio_puente(&self) -> anyhow::Result<PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let dir = base.join(&self.subdir);
        std::fs::create_dir_all(&dir).map_err(|e| anyhow::anyhow!("No se pudo crear {}: {e}", dir.display()))?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(dir)
    }

    fn etiqueta_prefijo(&self) -> String {
        format!("campusia.prefijo={}", self.prefijo)
    }

    pub(crate) async fn propio(&self, nombre: &str) -> anyhow::Result<Option<Value>> {
        let s = self.correr(&["container", "inspect", nombre]).await?;
        if !s.exito {
            return Ok(None);
        }
        let v: Value = serde_json::from_str(&s.stdout)?;
        let Some(info) = v.as_array().and_then(|a| a.first()).cloned() else { return Ok(None) };
        let prefijo = info.pointer("/Config/Labels").and_then(|l| l.get("campusia.prefijo")).and_then(Value::as_str);
        if prefijo != Some(self.prefijo.as_str()) {
            anyhow::bail!("El contenedor {nombre} no pertenece al prefijo {}", self.prefijo);
        }
        Ok(Some(info))
    }
}

#[async_trait]
impl ProveedorDeContenedores for ProveedorCli {
    async fn preparar_red(&self) -> anyhow::Result<InfoRed> {
        let existe = self.correr(&["network", "inspect", &self.red]).await?;
        let salida = if existe.exito {
            existe.stdout
        } else {
            let etiqueta = self.etiqueta_prefijo();
            self.exigir(&[
                "network",
                "create",
                "--driver",
                "bridge",
                "--internal",
                "-o",
                "com.docker.network.bridge.enable_icc=false",
                "--label",
                &etiqueta,
                &self.red,
            ])
            .await?;
            self.exigir(&["network", "inspect", &self.red]).await?
        };
        let v: Value = serde_json::from_str(&salida)?;
        let red = v.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
        if red.get("Internal").and_then(Value::as_bool) != Some(true) {
            anyhow::bail!("La red {} existe pero no es interna", self.red);
        }
        let puerta = red
            .pointer("/IPAM/Config")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| c.get("Gateway").and_then(Value::as_str))
            .filter_map(|g| g.split('/').next().and_then(|g| g.parse::<IpAddr>().ok()))
            .find(|ip| ip.is_ipv4());
        let subred = red
            .pointer("/IPAM/Config")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| c.get("Subnet").and_then(Value::as_str))
            .find(|s| crate::config::Red::leer(s).map(|r| r.direccion.is_ipv4()).unwrap_or(false))
            .map(str::to_string);
        Ok(InfoRed { puerta, subred })
    }

    async fn abrir_acceso(&self, red: &InfoRed) -> anyhow::Result<Acceso> {
        let dir_api = match (&self.direccion_api, red.puerta) {
            (Some(d), _) => d.clone(),
            (None, Some(p)) => p.to_string(),
            (None, None) => anyhow::bail!("La red {} no tiene puerta de enlace: definí DIRECCION_API_CURSOS", self.red),
        };
        let dir_socket: SocketAddr = format!("{}:{}", dir_api, self.puerto_api)
            .parse()
            .map_err(|_| anyhow::anyhow!("DIRECCION_API_CURSOS o PUERTO_API_CURSOS inválidos"))?;
        let url_api = self.url_api.clone().unwrap_or_else(|| format!("http://{dir_socket}"));
        if !self.es_sin_root().await? {
            let escucha = tokio::net::TcpListener::bind(dir_socket)
                .await
                .map_err(|e| anyhow::anyhow!("No se pudo abrir la escucha de la API para cursos en {dir_socket}: {e}"))?;
            let descripcion = escucha.local_addr()?.to_string();
            return Ok(Acceso { escucha: EscuchaApi::Tcp(escucha), url_api, socket_cursos: None, descripcion });
        }
        let pid_archivo = self.archivo_pid_red()?;
        let dir = self.directorio_puente()?;
        let api = dir.join("api.sock");
        let cursos = dir.join("cursos.sock");
        let escucha = crate::puente::escucha_unix(&api)?;
        crate::puente::iniciar(crate::puente::Destino {
            pid_archivo: pid_archivo.clone(),
            escucha: dir_socket,
            api: api.clone(),
            cursos: cursos.clone(),
            subred: red.subred.clone(),
        })
        .await?;
        let descripcion = format!("{dir_socket} dentro de la red de Docker sin root ({}), por {}", pid_archivo.display(), api.display());
        Ok(Acceso { escucha: EscuchaApi::Unix(escucha), url_api, socket_cursos: Some(cursos), descripcion })
    }

    async fn imagen_existe(&self, imagen: &str) -> anyhow::Result<bool> {
        Ok(self.correr(&["image", "inspect", imagen]).await?.exito)
    }

    async fn construir_imagen(&self, imagen: &str, curso: &str, archivo: &str, contexto: Vec<u8>, limite: Duration) -> anyhow::Result<()> {
        let etiqueta_prefijo = self.etiqueta_prefijo();
        let etiqueta_curso = format!("campusia.curso={curso}");
        let mut c = self.comando();
        c.stdin(Stdio::piped()).args([
            "build",
            "-t",
            imagen,
            "--label",
            &etiqueta_prefijo,
            "--label",
            &etiqueta_curso,
            "-f",
            archivo,
            "-",
        ]);
        let mut hijo = c.spawn().map_err(|e| anyhow::anyhow!("no se pudo ejecutar {}: {e}", self.cli))?;
        let mut entrada = hijo.stdin.take().ok_or_else(|| anyhow::anyhow!("sin entrada para la construcción"))?;
        let escritura = tokio::spawn(async move {
            let r = entrada.write_all(&contexto).await;
            drop(entrada);
            r
        });
        let r = tokio::time::timeout(limite, hijo.wait_with_output())
            .await
            .map_err(|_| anyhow::anyhow!("La construcción de la imagen superó el tiempo máximo"))??;
        let _ = escritura.await;
        if !r.status.success() {
            let mut texto = String::from_utf8_lossy(&r.stdout).to_string();
            texto.push_str(&String::from_utf8_lossy(&r.stderr));
            anyhow::bail!("La construcción de la imagen falló: {}", recortar(&texto));
        }
        Ok(())
    }

    async fn inspeccionar(&self, nombre: &str) -> anyhow::Result<Option<InfoContenedor>> {
        let Some(info) = self.propio(nombre).await? else { return Ok(None) };
        let corriendo = info.pointer("/State/Running").and_then(Value::as_bool).unwrap_or(false);
        let ip = info
            .pointer("/NetworkSettings/Networks")
            .and_then(|r| r.get(&self.red))
            .and_then(|r| r.get("IPAddress"))
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<IpAddr>().ok());
        Ok(Some(InfoContenedor { corriendo, ip }))
    }

    async fn crear(&self, e: &EspecContenedor) -> anyhow::Result<()> {
        let mut args: Vec<String> = vec![
            "create".into(),
            "--name".into(),
            e.nombre.clone(),
            "--label".into(),
            self.etiqueta_prefijo(),
            "--label".into(),
            format!("campusia.curso={}", e.curso),
            "--network".into(),
            self.red.clone(),
            "--read-only".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--memory".into(),
            self.memoria.clone(),
            "--memory-swap".into(),
            self.memoria.clone(),
            "--cpus".into(),
            self.cpus.clone(),
            "--pids-limit".into(),
            self.pids.to_string(),
            "--restart".into(),
            "no".into(),
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,size=64m".into(),
            "--mount".into(),
            format!("type=bind,source={},target=/datos", e.datos),
        ];
        let mut c = self.comando();
        for (k, v) in &e.entorno {
            args.push("-e".into());
            args.push(k.clone());
            c.env(k, v);
        }
        args.push(e.imagen.clone());
        c.args(&args);
        let r = tokio::time::timeout(Duration::from_secs(120), c.output())
            .await
            .map_err(|_| anyhow::anyhow!("{} create no terminó a tiempo", self.cli))?
            .map_err(|err| anyhow::anyhow!("no se pudo ejecutar {}: {err}", self.cli))?;
        if !r.status.success() {
            anyhow::bail!("{} create falló: {}", self.cli, recortar(&String::from_utf8_lossy(&r.stderr)));
        }
        Ok(())
    }

    async fn arrancar(&self, nombre: &str) -> anyhow::Result<()> {
        self.propio(nombre).await?.ok_or_else(|| anyhow::anyhow!("El contenedor {nombre} no existe"))?;
        self.exigir(&["start", nombre]).await?;
        Ok(())
    }

    async fn detener(&self, nombre: &str) -> anyhow::Result<()> {
        if self.propio(nombre).await?.is_none() {
            return Ok(());
        }
        self.exigir(&["stop", "-t", "5", nombre]).await?;
        Ok(())
    }

    async fn borrar(&self, nombre: &str) -> anyhow::Result<()> {
        if self.propio(nombre).await?.is_none() {
            return Ok(());
        }
        self.exigir(&["rm", "-f", nombre]).await?;
        Ok(())
    }
}
