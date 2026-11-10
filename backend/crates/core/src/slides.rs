//! PowerPoint conversion behind a trait.
//!
//! This build has no converter: `NoConverter` always answers "not configured", so the
//! slides module accepts PDF uploads and rejects `.pptx` with a clear 422.

use async_trait::async_trait;

use crate::ProviderError;

#[async_trait]
pub trait SlideConverter: Send + Sync {
    /// Short name, for example `none`.
    fn name(&self) -> &'static str;
    /// False when `.pptx` files cannot be converted; the UI then asks for a PDF.
    fn is_configured(&self) -> bool;
    /// Converts a `.pptx` file into a PDF.
    async fn pptx_to_pdf(&self, pptx: &[u8]) -> Result<Vec<u8>, ProviderError>;
}

pub struct NoConverter;

#[async_trait]
impl SlideConverter for NoConverter {
    fn name(&self) -> &'static str {
        "none"
    }

    fn is_configured(&self) -> bool {
        false
    }

    async fn pptx_to_pdf(&self, _pptx: &[u8]) -> Result<Vec<u8>, ProviderError> {
        Err(ProviderError::NotConfigured("PowerPoint conversion"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppError;

    #[tokio::test]
    async fn no_converter_maps_to_a_422() {
        let err = NoConverter.pptx_to_pdf(b"PK").await.unwrap_err();
        let err = AppError::from(err);
        assert!(matches!(err, AppError::Unprocessable(_)));
        assert_eq!(err.to_string(), "PowerPoint conversion is not configured");
    }
}
