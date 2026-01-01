use std::io;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Runtime not found: {language} {version}")]
    RuntimeNotFound { language: String, version: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] io::Error),

    #[error("Integrity check failed: expected {expected}, got {actual}")]
    IntegrityCheckFailed { expected: String, actual: String },

    #[error("JSON parsing error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Invalid language: {0}")]
    InvalidLanguage(String),

    #[error("Manifest not found for {language}")]
    ManifestNotFound { language: String },

    #[error("Version {version} not found for {language}")]
    VersionNotFound { language: String, version: String },

    #[error("{0}")]
    Other(String),
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::InvalidLanguage(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = Error::RuntimeNotFound {
            language: "python".to_string(),
            version: "3.11.7".to_string(),
        };
        assert_eq!(err.to_string(), "Runtime not found: python 3.11.7");

        let err = Error::IntegrityCheckFailed {
            expected: "abc123".to_string(),
            actual: "def456".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Integrity check failed: expected abc123, got def456"
        );

        let err = Error::InvalidLanguage("foo".to_string());
        assert_eq!(err.to_string(), "Invalid language: foo");
    }

    #[test]
    fn test_error_from_string() {
        let err: Error = "unknown language".to_string().into();
        assert_eq!(err.to_string(), "Invalid language: unknown language");
    }
}
