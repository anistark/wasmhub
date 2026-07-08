//! Integration tests for RuntimeLoader with mock HTTP servers.
//!
//! Tests cover: manifest fetching, runtime downloading, CDN fallback,
//! retry logic, SHA256 integrity verification, and cache interactions.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tempfile::TempDir;
use wasmhub::{GlobalManifest, RuntimeInfo, RuntimeLoader, RuntimeManifest, RuntimeVersion};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fake WASM binary (starts with the WASM magic number for realism).
fn fake_wasm_binary() -> Vec<u8> {
    let mut data = vec![0x00, 0x61, 0x73, 0x6d]; // \0asm magic
    data.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // version 1
    data.extend_from_slice(b"fake wasm payload for testing");
    data
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hasher.finalize();
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn make_runtime_manifest(lang: &str, version: &str, wasm: &[u8], base_url: &str) -> String {
    let manifest = RuntimeManifest {
        language: lang.to_string(),
        versions: {
            let mut m = HashMap::new();
            m.insert(
                version.to_string(),
                RuntimeVersion {
                    file: format!("{lang}-{version}.wasm"),
                    size: wasm.len() as u64,
                    sha256: sha256_hex(wasm),
                    released: "2026-01-01T00:00:00Z".to_string(),
                    wasi: "wasip1".to_string(),
                    features: vec![],
                    url: format!("{base_url}/{lang}-{version}.wasm"),
                },
            );
            m
        },
    };
    serde_json::to_string(&manifest).unwrap()
}

fn make_global_manifest(lang: &str, version: &str) -> String {
    let manifest = GlobalManifest {
        version: "0.1.4".to_string(),
        languages: {
            let mut m = HashMap::new();
            m.insert(
                lang.to_string(),
                RuntimeInfo {
                    latest: version.to_string(),
                    lts: None,
                    versions: vec![version.to_string()],
                    source: "https://example.com".to_string(),
                    license: "MIT".to_string(),
                },
            );
            m
        },
    };
    serde_json::to_string(&manifest).unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_download_runtime_success() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let lang = "go";
    let version = "1.23";

    // Mount manifest endpoint
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                version,
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    // Mount binary endpoint
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(wasm.clone()))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(0)
        .build()
        .unwrap();

    let runtime = loader
        .get_runtime(wasmhub::Language::Go, version)
        .await
        .unwrap();

    assert_eq!(runtime.language, wasmhub::Language::Go);
    assert_eq!(runtime.version, version);
    assert_eq!(runtime.sha256, sha256_hex(&wasm));
    assert!(runtime.path.exists());
}

#[tokio::test]
async fn test_download_runtime_cached() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let lang = "go";
    let version = "1.23";

    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                version,
                &wasm,
                &server.uri(),
            )),
        )
        .expect(1) // manifest should only be fetched once (second call is cached)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(wasm.clone()))
        .expect(1) // binary downloaded only once
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(0)
        .build()
        .unwrap();

    // First call — downloads
    let r1 = loader
        .get_runtime(wasmhub::Language::Go, version)
        .await
        .unwrap();

    // Second call — should come from cache (no additional HTTP requests)
    let r2 = loader
        .get_runtime(wasmhub::Language::Go, version)
        .await
        .unwrap();

    assert_eq!(r1.sha256, r2.sha256);
    assert_eq!(r1.path, r2.path);
}

#[tokio::test]
async fn test_download_integrity_failure() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let tampered_wasm = b"this is not the real binary".to_vec();
    let lang = "go";
    let version = "1.23";

    // Manifest has the real SHA256
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                version,
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    // But server returns tampered binary
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(tampered_wasm))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(0)
        .build()
        .unwrap();

    let result = loader.get_runtime(wasmhub::Language::Go, version).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("Integrity check failed"),
        "Expected integrity error, got: {err}"
    );
}

#[tokio::test]
async fn test_download_version_not_found() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let lang = "go";

    // Manifest only has version 1.23
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                "1.23",
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(0)
        .build()
        .unwrap();

    let result = loader.get_runtime(wasmhub::Language::Go, "9.99").await;

    assert!(result.is_err());
    assert!(
        result.unwrap_err().to_string().contains("not found"),
        "Expected version-not-found error"
    );
}

#[tokio::test]
async fn test_download_manifest_not_found() {
    let server = MockServer::start().await;

    // No mocks mounted — all requests return 404
    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(0)
        .build()
        .unwrap();

    let result = loader.get_runtime(wasmhub::Language::Go, "1.23").await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_retry_on_server_error() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let lang = "go";
    let version = "1.23";

    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                version,
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    // First two requests return 500, third succeeds
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(500))
        .up_to_n_times(2)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(wasm.clone()))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(3)
        .initial_backoff_ms(10) // fast retries for tests
        .max_backoff_ms(50)
        .build()
        .unwrap();

    let runtime = loader
        .get_runtime(wasmhub::Language::Go, version)
        .await
        .unwrap();

    assert_eq!(runtime.sha256, sha256_hex(&wasm));
}

#[tokio::test]
async fn test_retry_exhausted() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();
    let lang = "go";
    let version = "1.23";

    Mock::given(method("GET"))
        .and(path(format!("/{lang}-manifest.json")))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                lang,
                version,
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    // Always return 500
    Mock::given(method("GET"))
        .and(path(format!("/{lang}-{version}.wasm")))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .max_retries(2)
        .initial_backoff_ms(10)
        .max_backoff_ms(20)
        .build()
        .unwrap();

    let result = loader.get_runtime(wasmhub::Language::Go, version).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_list_available() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_global_manifest("go", "1.23")),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .build()
        .unwrap();

    let manifest = loader.list_available().await.unwrap();
    assert_eq!(manifest.version, "0.1.4");
    assert!(manifest.languages.contains_key("go"));
    assert_eq!(manifest.languages["go"].latest, "1.23");
}

#[tokio::test]
async fn test_get_latest_version() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_global_manifest("go", "1.23")),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .build()
        .unwrap();

    let latest = loader
        .get_latest_version(wasmhub::Language::Go)
        .await
        .unwrap();
    assert_eq!(latest, "1.23");
}

#[tokio::test]
async fn test_fetch_runtime_manifest() {
    let server = MockServer::start().await;
    let wasm = fake_wasm_binary();

    Mock::given(method("GET"))
        .and(path("/go-manifest.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(make_runtime_manifest(
                "go",
                "1.23",
                &wasm,
                &server.uri(),
            )),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let loader = RuntimeLoader::builder()
        .cache_dir(tmp.path().to_path_buf())
        .base_url(server.uri())
        .build()
        .unwrap();

    let manifest = loader
        .fetch_runtime_manifest(wasmhub::Language::Go)
        .await
        .unwrap();

    assert_eq!(manifest.language, "go");
    assert!(manifest.versions.contains_key("1.23"));
    assert_eq!(manifest.versions["1.23"].sha256, sha256_hex(&wasm));
}
