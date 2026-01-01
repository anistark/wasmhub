use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    NodeJs,
    Python,
    Ruby,
    Php,
    Go,
    Rust,
}

impl Language {
    pub fn as_str(&self) -> &'static str {
        match self {
            Language::NodeJs => "nodejs",
            Language::Python => "python",
            Language::Ruby => "ruby",
            Language::Php => "php",
            Language::Go => "go",
            Language::Rust => "rust",
        }
    }

    pub fn all() -> &'static [Language] {
        &[
            Language::NodeJs,
            Language::Python,
            Language::Ruby,
            Language::Php,
            Language::Go,
            Language::Rust,
        ]
    }
}

impl FromStr for Language {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "nodejs" | "node" | "node.js" => Ok(Language::NodeJs),
            "python" | "py" => Ok(Language::Python),
            "ruby" | "rb" => Ok(Language::Ruby),
            "php" => Ok(Language::Php),
            "go" | "golang" => Ok(Language::Go),
            "rust" | "rs" => Ok(Language::Rust),
            _ => Err(format!("Unknown language: {}", s)),
        }
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    pub language: Language,
    pub version: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

impl Runtime {
    pub fn new(
        language: Language,
        version: String,
        path: PathBuf,
        size: u64,
        sha256: String,
    ) -> Self {
        Self {
            language,
            version,
            path,
            size,
            sha256,
        }
    }

    pub fn filename(&self) -> String {
        format!("{}-{}.wasm", self.language.as_str(), self.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_language_from_str() {
        assert_eq!("nodejs".parse::<Language>().unwrap(), Language::NodeJs);
        assert_eq!("node".parse::<Language>().unwrap(), Language::NodeJs);
        assert_eq!("node.js".parse::<Language>().unwrap(), Language::NodeJs);
        assert_eq!("python".parse::<Language>().unwrap(), Language::Python);
        assert_eq!("py".parse::<Language>().unwrap(), Language::Python);
        assert_eq!("ruby".parse::<Language>().unwrap(), Language::Ruby);
        assert_eq!("rb".parse::<Language>().unwrap(), Language::Ruby);
        assert_eq!("php".parse::<Language>().unwrap(), Language::Php);
        assert_eq!("go".parse::<Language>().unwrap(), Language::Go);
        assert_eq!("golang".parse::<Language>().unwrap(), Language::Go);
        assert_eq!("rust".parse::<Language>().unwrap(), Language::Rust);
        assert_eq!("rs".parse::<Language>().unwrap(), Language::Rust);

        assert!("unknown".parse::<Language>().is_err());
        assert!("javascript".parse::<Language>().is_err());
    }

    #[test]
    fn test_language_as_str() {
        assert_eq!(Language::NodeJs.as_str(), "nodejs");
        assert_eq!(Language::Python.as_str(), "python");
        assert_eq!(Language::Ruby.as_str(), "ruby");
        assert_eq!(Language::Php.as_str(), "php");
        assert_eq!(Language::Go.as_str(), "go");
        assert_eq!(Language::Rust.as_str(), "rust");
    }

    #[test]
    fn test_language_display() {
        assert_eq!(format!("{}", Language::NodeJs), "nodejs");
        assert_eq!(format!("{}", Language::Python), "python");
    }

    #[test]
    fn test_runtime_new() {
        let runtime = Runtime::new(
            Language::Python,
            "3.11.7".to_string(),
            PathBuf::from("/cache/python-3.11.7.wasm"),
            1024,
            "abc123".to_string(),
        );

        assert_eq!(runtime.language, Language::Python);
        assert_eq!(runtime.version, "3.11.7");
        assert_eq!(runtime.size, 1024);
        assert_eq!(runtime.sha256, "abc123");
    }

    #[test]
    fn test_runtime_filename() {
        let runtime = Runtime::new(
            Language::NodeJs,
            "20.2.0".to_string(),
            PathBuf::from("/cache/nodejs-20.2.0.wasm"),
            2048,
            "def456".to_string(),
        );

        assert_eq!(runtime.filename(), "nodejs-20.2.0.wasm");
    }

    #[test]
    fn test_language_all() {
        let languages = Language::all();
        assert_eq!(languages.len(), 6);
        assert!(languages.contains(&Language::NodeJs));
        assert!(languages.contains(&Language::Python));
        assert!(languages.contains(&Language::Ruby));
        assert!(languages.contains(&Language::Php));
        assert!(languages.contains(&Language::Go));
        assert!(languages.contains(&Language::Rust));
    }
}
