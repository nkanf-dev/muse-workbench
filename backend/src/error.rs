//! Typed application errors, rendered as JSON problem bodies.
//!
//! Every fallible operation in the service returns [`AppError`]; the
//! [`IntoResponse`] impl maps it to `{ "error": "..." }` with an appropriate
//! status code. Internal details are logged server-side and never leaked to
//! clients for 5xx errors.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// All errors the service can produce.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("forbidden: {0}")]
    Forbidden(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("pty error: {0}")]
    Pty(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("multipart error: {0}")]
    Multipart(String),

    #[error("system error: {0}")]
    System(String),
}

impl AppError {
    /// Split the error into an HTTP status and a client-safe message.
    fn status_and_message(&self) -> (StatusCode, String) {
        match self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            // Everything else is an internal failure: log the detail,
            // hand the client a generic message.
            other => {
                tracing::error!(error = %other, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = self.status_and_message();
        (status, Json(json!({ "error": message }))).into_response()
    }
}
