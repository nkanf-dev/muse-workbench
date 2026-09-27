//! Pure configuration loading: read environment variables, apply defaults.
//!
//! No IO is performed here beyond reading env vars; `from_env` is a total
//! function and never panics.

use std::path::PathBuf;

/// Server configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// TCP port to listen on.
    pub port: u16,
    /// Workspace root directory. All file APIs are jailed inside it.
    /// Canonicalized once at startup (see `main.rs`).
    pub root: PathBuf,
    /// Shell binary spawned for PTY sessions.
    pub shell: String,
    /// Directory of the built frontend (`dist`). Served at `/` with an
    /// `index.html` SPA fallback. The server still boots when it is missing
    /// (API-only mode), but logs a warning.
    pub static_dir: PathBuf,
}

/// Build a [`Config`] from the environment, falling back to defaults.
///
/// - `PORT` (default `3001`)
/// - `WORKBENCH_ROOT` (default `./data`)
/// - `SHELL` (default `bash`)
/// - `WORKBENCH_STATIC_DIR` (default `<exe-dir>/static`, then `./frontend/dist`)
pub fn from_env() -> Config {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(3001);

    let root = std::env::var("WORKBENCH_ROOT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./data"));

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "bash".to_string());

    let static_dir = std::env::var("WORKBENCH_STATIC_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|p| p.join("static")))
                .filter(|p| p.join("index.html").is_file())
        })
        .unwrap_or_else(|| PathBuf::from("./frontend/dist"));

    Config {
        port,
        root,
        shell,
        static_dir,
    }
}
