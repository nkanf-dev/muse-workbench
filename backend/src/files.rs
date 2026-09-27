//! File management REST API, jailed inside the workspace root.
//!
//! Every path that reaches the filesystem goes through the pure function
//! [`resolve`], which lexically normalizes a root-relative unix-style path
//! and rejects anything that would escape the root (`..` traversal, absolute
//! paths, NUL bytes). The resulting [`SafePath`] newtype is the only way
//! handlers touch the filesystem.
//!
//! Routes:
//! - `GET  /api/files/list?path=`      -> `{ entries: [...] }`
//! - `GET  /api/files/read?path=`      -> `{ content, truncated }`
//! - `POST /api/files/write`           -> `{ path, content }`
//! - `POST /api/files/mkdir`           -> `{ path }`
//! - `POST /api/files/delete`          -> `{ path }`
//! - `POST /api/files/rename`          -> `{ from, to }`
//! - `GET  /api/files/download?path=`  -> byte stream (attachment)
//! - `POST /api/files/upload`          -> multipart (`file` + `path`)

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::{
    extract::{Multipart, Query, State},
    http::header,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::AppError, AppState};

/// Upper bound for inline file reads; larger files are truncated.
const READ_LIMIT: u64 = 1024 * 1024;

/// An absolute path guaranteed (lexically) to live inside the workspace root.
///
/// Constructible only via [`resolve`].
#[derive(Debug, Clone)]
pub struct SafePath(PathBuf);

impl SafePath {
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// Render as a root-relative unix-style path (`""` for the root itself).
    pub fn relative_to(&self, root: &Path) -> String {
        self.0
            .strip_prefix(root)
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default()
    }
}

/// Files owned by the workbench itself; never exposed through the file API.
/// They hold the vault encryption key and the encrypted vault — reading them
/// here would leak key material, deleting them would destroy all secrets.
const PROTECTED_NAMES: &[&str] = &[".vault_key", "vault.json"];

fn is_protected(name: &str) -> bool {
    PROTECTED_NAMES.contains(&name)
}

/// Pure: resolve a root-relative unix-style path against `root`.
///
/// Rejects absolute paths, NUL bytes and any `..` sequence that would climb
/// above `root`. `.` segments and duplicate slashes are normalized away.
/// Workbench-owned files (vault key / vault store) are rejected as well.
pub fn resolve(root: &Path, raw: &str) -> Result<SafePath, AppError> {
    if raw.starts_with('/') {
        return Err(AppError::Forbidden("absolute paths are not allowed".into()));
    }
    if raw.contains('\0') {
        return Err(AppError::BadRequest("path contains NUL byte".into()));
    }
    let mut stack: Vec<&str> = Vec::new();
    for component in raw.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                stack
                    .pop()
                    .ok_or_else(|| AppError::Forbidden("path escapes workspace root".into()))?;
            }
            name => stack.push(name),
        }
    }
    if let [single] = stack.as_slice() {
        if is_protected(single) {
            return Err(AppError::Forbidden(
                "workbench system file is not accessible".into(),
            ));
        }
    }
    let absolute = stack
        .iter()
        .fold(root.to_path_buf(), |acc, name| acc.join(name));
    Ok(SafePath(absolute))
}

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

fn query_path(q: &PathQuery) -> &str {
    q.path.as_deref().unwrap_or("")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub entries: Vec<FileEntry>,
}

fn file_entry(root: &Path, path: &Path) -> Option<FileEntry> {
    let meta = path.symlink_metadata().ok()?;
    let file_type = meta.file_type();
    // Never follow or expose symlinks outside the jail.
    if file_type.is_symlink() {
        return None;
    }
    let kind = if file_type.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::File
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let relative = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(FileEntry {
        name,
        path: relative,
        kind,
        size: meta.len(),
        modified,
    })
}

/// GET /api/files/list?path=
pub async fn list_handler(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<ListResponse>, AppError> {
    let root = &state.config.root;
    let dir = resolve(root, query_path(&q))?;
    let read_dir = tokio::fs::read_dir(dir.as_path())
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::NotFound(format!("directory not found: {}", query_path(&q)))
            }
            _ => AppError::Io(e),
        })?;
    let mut entries: Vec<FileEntry> = Vec::new();
    let mut read_dir = read_dir;
    while let Some(entry) = read_dir.next_entry().await? {
        // Hide workbench-owned files (vault key / vault store).
        if is_protected(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if let Some(info) = file_entry(root, &entry.path()) {
            entries.push(info);
        }
    }
    // Directories first, then alphabetical — pure ordering.
    entries.sort_by(|a, b| {
        let rank = |k: &EntryKind| match k {
            EntryKind::Dir => 0,
            EntryKind::File => 1,
        };
        rank(&a.kind).cmp(&rank(&b.kind)).then(a.name.cmp(&b.name))
    });
    Ok(Json(ListResponse { entries }))
}

#[derive(Debug, Serialize)]
pub struct ReadResponse {
    pub content: String,
    pub truncated: bool,
}

/// GET /api/files/read?path=
pub async fn read_handler(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<ReadResponse>, AppError> {
    let root = &state.config.root;
    let raw = query_path(&q);
    let file = resolve(root, raw)?;
    let bytes = tokio::fs::read(file.as_path()).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(format!("file not found: {raw}")),
        std::io::ErrorKind::IsADirectory => AppError::BadRequest("path is a directory".into()),
        _ => AppError::Io(e),
    })?;
    let truncated = bytes.len() as u64 > READ_LIMIT;
    let head: &[u8] = if truncated {
        &bytes[..READ_LIMIT as usize]
    } else {
        &bytes[..]
    };
    Ok(Json(ReadResponse {
        content: String::from_utf8_lossy(head).into_owned(),
        truncated,
    }))
}

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    pub path: String,
    pub content: String,
}

/// POST /api/files/write
pub async fn write_handler(
    State(state): State<AppState>,
    Json(req): Json<WriteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = &state.config.root;
    let file = resolve(root, &req.path)?;
    if let Some(parent) = file.as_path().parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(file.as_path(), req.content.as_bytes()).await?;
    Ok(Json(serde_json::json!({ "ok": true, "path": file.relative_to(root) })))
}

#[derive(Debug, Deserialize)]
pub struct MkdirRequest {
    pub path: String,
}

/// POST /api/files/mkdir
pub async fn mkdir_handler(
    State(state): State<AppState>,
    Json(req): Json<MkdirRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = &state.config.root;
    let dir = resolve(root, &req.path)?;
    tokio::fs::create_dir_all(dir.as_path()).await?;
    Ok(Json(serde_json::json!({ "ok": true, "path": dir.relative_to(root) })))
}

#[derive(Debug, Deserialize)]
pub struct DeleteRequest {
    pub path: String,
}

/// POST /api/files/delete
pub async fn delete_handler(
    State(state): State<AppState>,
    Json(req): Json<DeleteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = &state.config.root;
    let target = resolve(root, &req.path)?;
    if target.relative_to(root).is_empty() {
        return Err(AppError::Forbidden("refusing to delete workspace root".into()));
    }
    let meta = tokio::fs::symlink_metadata(target.as_path())
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::NotFound(format!("path not found: {}", req.path))
            }
            _ => AppError::Io(e),
        })?;
    if meta.file_type().is_symlink() {
        tokio::fs::remove_file(target.as_path()).await?;
    } else if meta.is_dir() {
        tokio::fs::remove_dir_all(target.as_path()).await?;
    } else {
        tokio::fs::remove_file(target.as_path()).await?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub from: String,
    pub to: String,
}

/// POST /api/files/rename
pub async fn rename_handler(
    State(state): State<AppState>,
    Json(req): Json<RenameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = &state.config.root;
    let from = resolve(root, &req.from)?;
    let to = resolve(root, &req.to)?;
    if !tokio::fs::try_exists(from.as_path()).await? {
        return Err(AppError::NotFound(format!("path not found: {}", req.from)));
    }
    if let Some(parent) = to.as_path().parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(from.as_path(), to.as_path()).await?;
    Ok(Json(serde_json::json!({ "ok": true, "path": to.relative_to(root) })))
}

/// GET /api/files/download?path= — raw byte stream as an attachment.
pub async fn download_handler(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, AppError> {
    let root = &state.config.root;
    let raw = query_path(&q);
    let file = resolve(root, raw)?;
    let bytes = tokio::fs::read(file.as_path()).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(format!("file not found: {raw}")),
        _ => AppError::Io(e),
    })?;
    let filename = file
        .as_path()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let disposition = axum::http::HeaderValue::from_str(&format!(
        "attachment; filename=\"{filename}\""
    ))
    .map_err(|_| AppError::BadRequest("invalid filename for download".into()))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("application/octet-stream"),
            ),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    ))
}

/// POST /api/files/upload — multipart with `file` (bytes) + `path` (destination).
///
/// `path` is the destination file path relative to the root; if it points at
/// an existing directory, the uploaded filename is appended.
pub async fn upload_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = &state.config.root;
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_name: Option<String> = None;
    let mut dest_raw: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Multipart(e.to_string()))?
    {
        match field.name() {
            Some("file") => {
                file_name = field.file_name().map(str::to_string);
                file_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::Multipart(e.to_string()))?
                        .to_vec(),
                );
            }
            Some("path") => {
                dest_raw = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::Multipart(e.to_string()))?,
                );
            }
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or_else(|| AppError::BadRequest("missing `file` field".into()))?;
    let dest_raw = dest_raw.ok_or_else(|| AppError::BadRequest("missing `path` field".into()))?;
    let mut dest = resolve(root, dest_raw.trim())?;

    // If the destination is an existing directory, place the file inside it.
    if tokio::fs::try_exists(dest.as_path()).await?
        && tokio::fs::metadata(dest.as_path()).await?.is_dir()
    {
        let name = file_name
            .filter(|n| !n.is_empty())
            .ok_or_else(|| AppError::BadRequest("uploaded file has no name".into()))?;
        let file_part = SafePath(dest.as_path().join(&name));
        // Re-validate: the joined name must still be inside the root.
        dest = resolve(root, &file_part.relative_to(root))?;
    }

    if let Some(parent) = dest.as_path().parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(dest.as_path(), &bytes).await?;
    Ok(Json(
        serde_json::json!({ "ok": true, "path": dest.relative_to(root), "size": bytes.len() }),
    ))
}
