//! Muse Workbench backend — wiring only.
//!
//! Reads [`config::Config`], builds shared [`AppState`], mounts the routes
//! from each module and serves on `127.0.0.1:3001` (or `$PORT`).
//!
//! Error handling note: `main` itself never panics on startup failures.
//! `run()` returns `Result`, and `main` prints the typed [`error::AppError`]
//! and exits non-zero — no `unwrap`/`expect` anywhere in the binary.

mod auth;
mod config;
mod error;
mod files;
mod system;
mod terminal;
mod vault;

use std::sync::Arc;

use axum::{
    http::HeaderValue,
    middleware,
    routing::{get, post, put},
    Json, Router,
};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::error::AppError;

/// Shared state threaded through every handler.
#[derive(Clone)]
pub struct AppState {
    pub config: config::Config,
    pub vault: Arc<vault::Vault>,
}

/// `GET /api/health` -> `{ status: "ok", version }`.
async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("fatal: failed to start muse-workbench-backend: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), AppError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "muse_workbench_backend=info,tower_http=info".into()),
        )
        .init();

    let config = config::from_env();
    tracing::info!(
        port = config.port,
        root = %config.root.display(),
        shell = %config.shell,
        static_dir = %config.static_dir.display(),
        "starting muse-workbench-backend"
    );
    if !config.static_dir.join("index.html").is_file() {
        tracing::warn!(
            static_dir = %config.static_dir.display(),
            "frontend bundle not found; serving API only. Set WORKBENCH_STATIC_DIR."
        );
    }

    // Edge IO: ensure the workspace root exists, then canonicalize it once so
    // every later path check compares against a stable absolute prefix.
    std::fs::create_dir_all(&config.root)?;
    let root = config.root.canonicalize().map_err(AppError::Io)?;
    let config = config::Config { root, ..config };

    let vault = Arc::new(vault::Vault::load_or_init(&config.root)?);
    let state = AppState {
        config: config.clone(),
        vault,
    };

    let origins: Vec<HeaderValue> = ["http://localhost:5173", "http://127.0.0.1:5173"]
        .iter()
        .map(|o| o.parse())
        .collect::<Result<_, _>>()
        .map_err(|_| AppError::BadRequest("invalid CORS origin".to_string()))?;
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/terminal/ws", get(terminal::ws_handler))
        .route("/api/files/list", get(files::list_handler))
        .route("/api/files/read", get(files::read_handler))
        .route("/api/files/write", post(files::write_handler))
        .route("/api/files/mkdir", post(files::mkdir_handler))
        .route("/api/files/delete", post(files::delete_handler))
        .route("/api/files/rename", post(files::rename_handler))
        .route("/api/files/download", get(files::download_handler))
        .route("/api/files/upload", post(files::upload_handler))
        .route(
            "/api/vault/entries",
            get(vault::list_handler).post(vault::create_handler),
        )
        .route(
            "/api/vault/entries/{id}/reveal",
            get(vault::reveal_handler),
        )
        .route(
            "/api/vault/entries/{id}",
            put(vault::update_handler).delete(vault::delete_handler),
        )
        .route("/api/system/stats", get(system::stats_handler))
        // SPA + static assets. Unmatched non-/api paths fall back to
        // index.html (the frontend uses hash routing, so this is a safety net).
        .fallback_service({
            let index = config.static_dir.join("index.html");
            ServeDir::new(&config.static_dir).not_found_service(ServeFile::new(index))
        })
        // Layer order: the LAST layer added is the outermost, so requests flow
        // CORS -> auth -> routes. Preflight OPTIONS is answered by the CORS
        // layer before auth sees it.
        .layer(middleware::from_fn_with_state(
            auth::load_token(),
            auth::require_auth,
        ))
        .layer(cors)
        .with_state(state);

    let addr = format!("127.0.0.1:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await.map_err(AppError::Io)
}
