//! Bearer-token auth gate for `/api/*` routes.
//!
//! The token is a shared secret between the supervisor (which passes it via
//! `WORKBENCH_TOKEN`) and the browser client (entered once on the login
//! screen). Comparison is constant-time; the token is never logged.

use std::path::PathBuf;

use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::Response,
};

/// Resolve the token file path: `$HOME/.workbench/token`.
fn token_file() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".workbench").join("token"))
}

/// Generate a fresh 256-bit token, URL-safe base64 without padding.
fn generate_token() -> String {
    use base64::Engine as _;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Persist a token with owner-only permissions (best effort).
#[cfg(unix)]
fn write_token_file(path: &PathBuf, token: &str) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(token.as_bytes())
        });
}

#[cfg(not(unix))]
fn write_token_file(path: &PathBuf, token: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, token);
}

/// Load the auth token:
///
/// 1. `WORKBENCH_TOKEN` env (supervisor-managed, highest priority)
/// 2. `$HOME/.workbench/token` (persists across restarts)
/// 3. generate + persist (first boot)
pub fn load_token() -> String {
    if let Ok(t) = std::env::var("WORKBENCH_TOKEN") {
        let t = t.trim().to_owned();
        if !t.is_empty() {
            return t;
        }
    }
    if let Some(path) = token_file() {
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_owned();
            if !t.is_empty() {
                return t;
            }
        }
        let token = generate_token();
        write_token_file(&path, &token);
        return token;
    }
    generate_token()
}

/// Constant-time string equality: length check first, then XOR accumulation.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    if ab.len() != bb.len() {
        return false;
    }
    ab.iter()
        .zip(bb.iter())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

/// Extract a candidate token: `Authorization: Bearer <t>` or `?token=<t>`.
/// The query form exists for WebSocket URLs and plain `<a download>` links,
/// which cannot set custom headers. Tokens are URL-safe base64, so no
/// percent-decoding is required.
fn extract_token(req: &Request) -> Option<String> {
    if let Some(v) = req.headers().get(AUTHORIZATION) {
        if let Ok(s) = v.to_str() {
            if let Some(t) = s.strip_prefix("Bearer ") {
                let t = t.trim();
                if !t.is_empty() {
                    return Some(t.to_owned());
                }
            }
        }
    }
    req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == "token" && !v.is_empty()).then(|| v.to_owned())
        })
    })
}

/// Axum middleware: everything under `/api/` requires the bearer token.
/// Static assets and the SPA shell stay public — the login screen lives there.
pub async fn require_auth(
    State(expected): State<String>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if !req.uri().path().starts_with("/api/") {
        return Ok(next.run(req).await);
    }
    match extract_token(&req) {
        Some(t) if constant_time_eq(&t, &expected) => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare_is_exact() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("", "abc"));
    }

    #[test]
    fn generated_token_is_url_safe() {
        let t = generate_token();
        assert_eq!(t.len(), 43); // 32 bytes -> 43 base64 chars, no padding
        assert!(t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }
}
