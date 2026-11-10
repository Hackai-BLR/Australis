//! Uploaded files on disk under `UPLOAD_DIR`.
//!
//! The store generates every key (`<32 hex characters>.<extension>`); nothing the client
//! sends becomes part of a path. A key that does not have exactly that shape is rejected
//! before the file system is touched, which rules out path traversal.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use rand::RngCore;

use crate::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct FileStore {
    root: Arc<PathBuf>,
}

impl FileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Arc::new(root.into()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Stores the bytes under a new key and returns the key. The extension only labels the
    /// file type: 1 to 8 ASCII letters or digits, for example `pdf`.
    pub async fn save(&self, extension: &str, bytes: &[u8]) -> AppResult<String> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        if !is_valid_extension(&extension) {
            return Err(AppError::BadRequest("invalid file extension".into()));
        }
        let mut id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut id);
        let key = format!("{}.{extension}", hex::encode(id));
        tokio::fs::create_dir_all(self.root.as_ref()).await?;
        tokio::fs::write(self.root.join(&key), bytes).await?;
        Ok(key)
    }

    /// The path of a stored file. 400 for a key this store could not have generated.
    pub fn path(&self, key: &str) -> AppResult<PathBuf> {
        if !is_valid_key(key) {
            return Err(AppError::BadRequest("invalid file key".into()));
        }
        Ok(self.root.join(key))
    }

    /// Reads a stored file. 404 if it does not exist.
    pub async fn read(&self, key: &str) -> AppResult<Vec<u8>> {
        match tokio::fs::read(self.path(key)?).await {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(AppError::NotFound),
            Err(err) => Err(err.into()),
        }
    }

    /// Removes a stored file. A missing file is not an error.
    pub async fn remove(&self, key: &str) -> AppResult<()> {
        match tokio::fs::remove_file(self.path(key)?).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }
}

fn is_valid_extension(extension: &str) -> bool {
    (1..=8).contains(&extension.len())
        && extension
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn is_valid_key(key: &str) -> bool {
    match key.split_once('.') {
        Some((stem, extension)) => {
            stem.len() == 32
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && is_valid_extension(extension)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_generated_keys_are_valid() {
        assert!(is_valid_key("0123456789abcdef0123456789abcdef.pdf"));
        for bad in [
            "",
            "../secret.pdf",
            "..",
            "0123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcdef.",
            "0123456789abcdef0123456789abcdef.pdf/../x",
            "0123456789abcdef0123456789abcdef.p.df",
            "0123456789ABCDEF0123456789ABCDEF.pdf",
            "/etc/passwd",
            "C:\\windows\\win.ini",
            "0123456789abcdef0123456789abcde/.pdf",
        ] {
            assert!(!is_valid_key(bad), "{bad:?} should be rejected");
        }
    }
}
