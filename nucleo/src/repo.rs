use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub struct SalidaGit {
    pub exito: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

#[derive(Clone)]
pub enum Lugar {
    Repo(PathBuf),
    Separado { git: PathBuf, trabajo: PathBuf },
    SoloGit(PathBuf),
}

const AJUSTES: [&str; 26] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "safe.directory=*",
    "-c",
    "user.name=Campus IA",
    "-c",
    "user.email=cursos@campusia.invalid",
    "-c",
    "gc.auto=0",
    "-c",
    "core.symlinks=true",
    "-c",
    "init.defaultBranch=main",
    "-c",
    "advice.detachedHead=false",
];

pub async fn git_con(lugar: &Lugar, args: &[&str], entrada: Option<Vec<u8>>) -> anyhow::Result<SalidaGit> {
    let mut c = Command::new("git");
    c.kill_on_drop(true).env_clear();
    if let Ok(ruta) = std::env::var("PATH") {
        c.env("PATH", ruta);
    }
    c.env("HOME", "/nonexistent")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Campus IA")
        .env("GIT_AUTHOR_EMAIL", "cursos@campusia.invalid")
        .env("GIT_COMMITTER_NAME", "Campus IA")
        .env("GIT_COMMITTER_EMAIL", "cursos@campusia.invalid")
        .env("LC_ALL", "C")
        .current_dir("/");
    match lugar {
        Lugar::Repo(dir) => {
            c.arg("-C").arg(dir);
        }
        Lugar::Separado { git, trabajo } => {
            c.arg(format!("--git-dir={}", git.display())).arg(format!("--work-tree={}", trabajo.display()));
            c.current_dir(trabajo);
        }
        Lugar::SoloGit(git) => {
            c.arg(format!("--git-dir={}", git.display()));
        }
    }
    c.args(AJUSTES).args(args);
    c.stdin(if entrada.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut hijo = c.spawn().map_err(|e| anyhow::anyhow!("no se pudo ejecutar git: {e}"))?;
    if let Some(datos) = entrada {
        if let Some(mut e) = hijo.stdin.take() {
            tokio::spawn(async move {
                let _ = e.write_all(&datos).await;
            });
        }
    }
    let r = tokio::time::timeout(Duration::from_secs(600), hijo.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("git {} no terminó a tiempo", args.first().unwrap_or(&"")))??;
    Ok(SalidaGit { exito: r.status.success(), stdout: r.stdout, stderr: String::from_utf8_lossy(&r.stderr).trim().to_string() })
}

pub async fn git(lugar: &Lugar, args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let s = git_con(lugar, args, None).await?;
    if !s.exito {
        anyhow::bail!("git {} falló: {}", args.first().unwrap_or(&""), s.stderr);
    }
    Ok(s.stdout)
}

pub async fn git_texto(lugar: &Lugar, args: &[&str]) -> anyhow::Result<String> {
    Ok(String::from_utf8_lossy(&git(lugar, args).await?).trim().to_string())
}

pub async fn git_ok(lugar: &Lugar, args: &[&str]) -> bool {
    matches!(git_con(lugar, args, None).await, Ok(s) if s.exito)
}

pub async fn resolver(lugar: &Lugar, referencia: &str) -> Option<String> {
    let s = git_con(lugar, &["rev-parse", "--verify", "--quiet", referencia], None).await.ok()?;
    if !s.exito {
        return None;
    }
    let t = String::from_utf8_lossy(&s.stdout).trim().to_string();
    if t.len() == 40 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(t)
    } else {
        None
    }
}

pub fn quitar(ruta: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(ruta) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(ruta),
        Ok(_) => std::fs::remove_file(ruta),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn abrir_permisos(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut pila = vec![dir.to_path_buf()];
    while let Some(d) = pila.pop() {
        let Ok(m) = std::fs::symlink_metadata(&d) else { continue };
        if m.file_type().is_symlink() {
            continue;
        }
        let modo = m.permissions().mode();
        let nuevo = if m.is_dir() { modo | 0o777 } else { modo | 0o666 };
        if nuevo != modo {
            let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(nuevo));
        }
        if m.is_dir() {
            if let Ok(entradas) = std::fs::read_dir(&d) {
                for e in entradas.flatten() {
                    if e.file_name() == "node_modules" {
                        continue;
                    }
                    pila.push(e.path());
                }
            }
        }
    }
}
