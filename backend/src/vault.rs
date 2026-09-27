//! Encrypted credential vault.
//!
//! Secrets are encrypted at rest with AES-256-GCM. The 32-byte key comes from
//! the `VAULT_KEY` env var (base64); when absent, a key is generated and
//! persisted to `{root}/.vault_key` with mode `0600`. Entries live in
//! `{root}/vault.json`; each entry stores a random 96-bit nonce alongside the
//! ciphertext (both base64).
//!
//! Routes:
//! - `GET    /api/vault/entries`            -> metadata list (no secrets)
//! - `POST   /api/vault/entries`            -> `{ id }`
//! - `GET    /api/vault/entries/:id/reveal` -> `{ secret }` (explicit decrypt)
//! - `PUT    /api/vault/entries/:id`        -> partial update
//! - `DELETE /api/vault/entries/:id`        -> `{ ok: true }`

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroize;

use axum::{
    extract::{Path as AxumPath, State},
    Json,
};

use crate::{error::AppError, AppState};

/// Newtype for vault entry identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VaultId(Uuid);

impl VaultId {
    pub fn new() -> Self {
        VaultId(Uuid::new_v4())
    }
}

impl std::fmt::Display for VaultId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A secret value. Zeroized on drop; never printed in logs or debug output.
#[derive(Zeroize)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        SecretString(value)
    }

    /// Borrow the secret for the narrowest possible scope.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[REDACTED]")
    }
}

/// Kind of credential. Closed set per the API contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    ApiKey,
    Token,
    Password,
    Certificate,
    Other,
}

/// Entry as persisted in `vault.json`. The secret itself is stored as
/// base64 `(nonce, ciphertext)`; metadata stays in cleartext.
#[derive(Debug, Serialize, Deserialize)]
struct StoredEntry {
    id: VaultId,
    name: String,
    provider: String,
    kind: SecretKind,
    nonce: String,
    ciphertext: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// Public metadata view: everything except the secret.
#[derive(Debug, Serialize)]
pub struct EntryMeta {
    pub id: VaultId,
    pub name: String,
    pub provider: String,
    pub kind: SecretKind,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&StoredEntry> for EntryMeta {
    fn from(e: &StoredEntry) -> Self {
        EntryMeta {
            id: e.id,
            name: e.name.clone(),
            provider: e.provider.clone(),
            kind: e.kind,
            created_at: e.created_at,
            updated_at: e.updated_at,
        }
    }
}

/// Pure: encrypt `plaintext`, returning base64 `(nonce, ciphertext)`.
fn encrypt(key: &[u8; 32], plaintext: &str) -> Result<(String, String), AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| AppError::Crypto(format!("encrypt failed: {e}")))?;
    Ok((B64.encode(nonce_bytes), B64.encode(ciphertext)))
}

/// Pure: decrypt base64 `(nonce, ciphertext)` back into a [`SecretString`].
fn decrypt(key: &[u8; 32], nonce_b64: &str, ct_b64: &str) -> Result<SecretString, AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = B64
        .decode(nonce_b64)
        .map_err(|e| AppError::Crypto(format!("bad nonce encoding: {e}")))?;
    let ct_bytes = B64
        .decode(ct_b64)
        .map_err(|e| AppError::Crypto(format!("bad ciphertext encoding: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ct_bytes.as_ref())
        .map_err(|_| AppError::Crypto("decrypt failed: authentication error".into()))?;
    let text = String::from_utf8(plaintext)
        .map_err(|e| AppError::Crypto(format!("decrypted secret is not utf-8: {e}")))?;
    Ok(SecretString::new(text))
}

/// Load the vault key from `VAULT_KEY` (base64, 32 bytes), or generate one and
/// persist it to `key_path` with mode `0600`. IO lives here, at the edge.
fn load_or_generate_key(key_path: &Path) -> Result<[u8; 32], AppError> {
    if let Some(encoded) = std::env::var("VAULT_KEY").ok().filter(|v| !v.trim().is_empty()) {
        let bytes = B64
            .decode(encoded.trim())
            .map_err(|e| AppError::Crypto(format!("VAULT_KEY is not valid base64: {e}")))?;
        return bytes
            .try_into()
            .map_err(|_| AppError::Crypto("VAULT_KEY must decode to exactly 32 bytes".into()));
    }
    if key_path.exists() {
        let encoded = std::fs::read_to_string(key_path)?;
        let bytes = B64
            .decode(encoded.trim())
            .map_err(|e| AppError::Crypto(format!("vault key file is not valid base64: {e}")))?;
        return bytes
            .try_into()
            .map_err(|_| AppError::Crypto("vault key file must hold exactly 32 bytes".into()));
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true).mode(0o600);
        use std::io::Write;
        opts.open(key_path)?
            .write_all(B64.encode(key).as_bytes())?;
    }
    Ok(key)
}

/// The vault: file locations + key + a lock serializing read-modify-write.
pub struct Vault {
    file: PathBuf,
    key: [u8; 32],
    lock: Mutex<()>,
}

impl Vault {
    /// Open (or initialize) the vault under `root`. Called once at startup.
    pub fn load_or_init(root: &Path) -> Result<Self, AppError> {
        let key = load_or_generate_key(&root.join(".vault_key"))?;
        let file = root.join("vault.json");
        if !file.exists() {
            std::fs::write(&file, b"[]")?;
        }
        Ok(Vault {
            file,
            key,
            lock: Mutex::new(()),
        })
    }

    fn read_entries(&self) -> Result<Vec<StoredEntry>, AppError> {
        let _guard = self.lock.lock().map_err(|_| AppError::System("vault lock poisoned".into()))?;
        let raw = std::fs::read(&self.file)?;
        serde_json::from_slice::<Vec<StoredEntry>>(&raw).map_err(AppError::Json)
    }

    fn write_entries(&self, entries: &[StoredEntry]) -> Result<(), AppError> {
        let _guard = self.lock.lock().map_err(|_| AppError::System("vault lock poisoned".into()))?;
        let raw = serde_json::to_vec_pretty(entries).map_err(AppError::Json)?;
        std::fs::write(&self.file, raw)?;
        Ok(())
    }

    pub fn list_meta(&self) -> Result<Vec<EntryMeta>, AppError> {
        self.read_entries()
            .map(|entries| entries.iter().map(EntryMeta::from).collect())
    }

    pub fn add(
        &self,
        name: String,
        provider: String,
        kind: SecretKind,
        secret: SecretString,
    ) -> Result<VaultId, AppError> {
        let (nonce, ciphertext) = encrypt(&self.key, secret.expose())?;
        let now = Utc::now();
        let entry = StoredEntry {
            id: VaultId::new(),
            name,
            provider,
            kind,
            nonce,
            ciphertext,
            created_at: now,
            updated_at: now,
        };
        let id = entry.id;
        let mut entries = self.read_entries()?;
        entries.push(entry);
        self.write_entries(&entries)?;
        Ok(id)
    }

    pub fn reveal(&self, id: VaultId) -> Result<SecretString, AppError> {
        self.read_entries()?
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound(format!("vault entry {id}")))
            .and_then(|e| decrypt(&self.key, &e.nonce, &e.ciphertext))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        id: VaultId,
        name: Option<String>,
        provider: Option<String>,
        kind: Option<SecretKind>,
        secret: Option<SecretString>,
    ) -> Result<EntryMeta, AppError> {
        let mut entries = self.read_entries()?;
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound(format!("vault entry {id}")))?;
        if let Some(name) = name {
            entry.name = name;
        }
        if let Some(provider) = provider {
            entry.provider = provider;
        }
        if let Some(kind) = kind {
            entry.kind = kind;
        }
        if let Some(secret) = secret {
            let (nonce, ciphertext) = encrypt(&self.key, secret.expose())?;
            entry.nonce = nonce;
            entry.ciphertext = ciphertext;
        }
        entry.updated_at = Utc::now();
        let meta = EntryMeta::from(&*entry);
        self.write_entries(&entries)?;
        Ok(meta)
    }

    pub fn delete(&self, id: VaultId) -> Result<(), AppError> {
        let mut entries = self.read_entries()?;
        let before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() == before {
            return Err(AppError::NotFound(format!("vault entry {id}")));
        }
        self.write_entries(&entries)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// HTTP handlers (thin adapters over `Vault`).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub name: String,
    pub provider: String,
    pub kind: SecretKind,
    #[serde(default)]
    pub secret: String,
}

/// GET /api/vault/entries
pub async fn list_handler(State(state): State<AppState>) -> Result<Json<Vec<EntryMeta>>, AppError> {
    state.vault.list_meta().map(Json)
}

/// POST /api/vault/entries
pub async fn create_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("name must not be empty".into()));
    }
    if req.secret.is_empty() {
        return Err(AppError::BadRequest("secret must not be empty".into()));
    }
    let id = state.vault.add(
        req.name,
        req.provider,
        req.kind,
        SecretString::new(req.secret),
    )?;
    Ok(Json(serde_json::json!({ "id": id })))
}

/// GET /api/vault/entries/:id/reveal
pub async fn reveal_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<VaultId>,
) -> Result<Json<serde_json::Value>, AppError> {
    let secret = state.vault.reveal(id)?;
    Ok(Json(serde_json::json!({ "secret": secret.expose() })))
}

#[derive(Debug, Deserialize)]
pub struct UpdateRequest {
    pub name: Option<String>,
    pub provider: Option<String>,
    pub kind: Option<SecretKind>,
    pub secret: Option<String>,
}

/// PUT /api/vault/entries/:id
pub async fn update_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<VaultId>,
    Json(req): Json<UpdateRequest>,
) -> Result<Json<EntryMeta>, AppError> {
    let secret = req.secret.map(SecretString::new);
    state
        .vault
        .update(id, req.name, req.provider, req.kind, secret)
        .map(Json)
}

/// DELETE /api/vault/entries/:id
pub async fn delete_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<VaultId>,
) -> Result<Json<serde_json::Value>, AppError> {
    state.vault.delete(id)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
