//! CLI integration tests for the `wasmhub` binary.
//!
//! Uses `assert_cmd` to invoke the compiled CLI binary and verify output.
//! These tests don't hit the network — they test argument parsing, help text,
//! error handling, and cache commands against local state.

use assert_cmd::Command;
use predicates::prelude::*;

fn wasmhub_cmd() -> Command {
    Command::cargo_bin("wasmhub").expect("wasmhub binary not found — build with --features cli")
}

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

#[test]
fn test_help() {
    wasmhub_cmd()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("wasmhub"))
        .stdout(predicate::str::contains("get"))
        .stdout(predicate::str::contains("list"))
        .stdout(predicate::str::contains("info"))
        .stdout(predicate::str::contains("cache"));
}

#[test]
fn test_version() {
    wasmhub_cmd()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains("wasmhub"));
}

#[test]
fn test_no_args_shows_help() {
    // Running with no subcommand should show usage/help info (non-zero exit)
    wasmhub_cmd()
        .assert()
        .failure()
        .stderr(predicate::str::contains("Usage"));
}

// ---------------------------------------------------------------------------
// Subcommand help text
// ---------------------------------------------------------------------------

#[test]
fn test_get_help() {
    wasmhub_cmd()
        .args(["get", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("LANGUAGE"))
        .stdout(predicate::str::contains("VERSION"));
}

#[test]
fn test_list_help() {
    wasmhub_cmd()
        .args(["list", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("LANGUAGE"));
}

#[test]
fn test_info_help() {
    wasmhub_cmd()
        .args(["info", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("LANGUAGE"));
}

#[test]
fn test_cache_help() {
    wasmhub_cmd()
        .args(["cache", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("show"))
        .stdout(predicate::str::contains("clear"));
}

// ---------------------------------------------------------------------------
// Invalid language handling
// ---------------------------------------------------------------------------

#[test]
fn test_get_invalid_language() {
    wasmhub_cmd()
        .args(["get", "foobar"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Unknown language"));
}

#[test]
fn test_info_invalid_language() {
    wasmhub_cmd()
        .args(["info", "notalang"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Unknown language"));
}

// ---------------------------------------------------------------------------
// Cache commands (local-only, no network)
// ---------------------------------------------------------------------------

#[test]
fn test_cache_show() {
    wasmhub_cmd()
        .args(["cache", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Cache Information"))
        .stdout(predicate::str::contains("Location"));
}

#[test]
fn test_cache_clear_invalid_language() {
    wasmhub_cmd()
        .args(["cache", "clear", "invalidlang", "1.0"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Unknown language"));
}

#[test]
fn test_cache_clear_all_no_confirm() {
    // Without --yes, this reads stdin; with empty stdin it should cancel
    wasmhub_cmd()
        .args(["cache", "clear-all"])
        .write_stdin("")
        .assert()
        .success()
        .stdout(predicate::str::contains("Cancelled"));
}

#[test]
fn test_cache_clear_all_with_yes() {
    // --yes skips confirmation
    wasmhub_cmd()
        .args(["cache", "clear-all", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Cleared"));
}

// ---------------------------------------------------------------------------
// Missing required arguments
// ---------------------------------------------------------------------------

#[test]
fn test_get_missing_language() {
    wasmhub_cmd()
        .args(["get"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("required"));
}

#[test]
fn test_info_missing_language() {
    wasmhub_cmd()
        .args(["info"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("required"));
}

#[test]
fn test_cache_clear_missing_args() {
    wasmhub_cmd()
        .args(["cache", "clear"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("required"));
}

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

#[test]
fn test_unknown_subcommand() {
    wasmhub_cmd().args(["banana"]).assert().failure();
}

// ---------------------------------------------------------------------------
// Language alias acceptance (parsing only — network calls will fail, but
// the error message proves parsing succeeded)
// ---------------------------------------------------------------------------

#[test]
fn test_language_aliases_parse() {
    // These may succeed (if network is up) or fail on network.
    // Either way, the error should NOT be "Unknown language",
    // which proves the alias was accepted by the parser.
    for alias in &[
        "node", "nodejs", "py", "python", "rb", "ruby", "php", "go", "golang", "rust", "rs",
    ] {
        let output = wasmhub_cmd()
            .args(["info", alias])
            .output()
            .expect("failed to run wasmhub");

        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("Unknown language"),
            "Alias '{alias}' was rejected as unknown language. stderr: {stderr}"
        );
    }
}
