# Muse Workbench — Backend

Rust (Axum 0.8) backend for the Muse Workbench: a WebSocket PTY terminal with
full terminal semantics, file management jailed to a workspace root, an
AES-256-GCM encrypted credential vault, and system stats.

## Build & run

```bash
# Rust toolchain lives at ~/.local/rust (persistent home install)
export PATH="$HOME/.local/rust/bin:$PATH"

cargo build            # or: cargo build --release
./target/debug/muse-workbench-backend
```

The server listens on `127.0.0.1:3001` by default. Logs via `tracing`
(`RUST_LOG=...` to tune, e.g. `RUST_LOG=debug`).

## Environment

| Variable          | Default  | Description                                              |
|-------------------|----------|----------------------------------------------------------|
| `PORT`            | `3001`   | TCP port to listen on (binds `127.0.0.1`)                |
| `WORKBENCH_ROOT`  | `./data` | Workspace root; all file APIs are jailed inside it       |
| `SHELL`           | `bash`   | Shell binary spawned for PTY sessions                    |
| `VAULT_KEY`       | *(none)* | Base64-encoded 32-byte AES key. If unset, one is generated and saved to `{root}/.vault_key` (mode `0600`) |
| `RUST_LOG`        | `info`   | Log filter                                               |

CORS allows `http://localhost:5173` and `http://127.0.0.1:5173` (the frontend
dev server).

## API

All errors are JSON: `{ "error": "..." }` with an appropriate status code.

### Health

- `GET /api/health` → `{ "status": "ok", "version": "0.1.0" }`

### Terminal (WebSocket)

- `GET /api/terminal/ws?cols=80&rows=24` — upgrade to WebSocket, spawns `$SHELL`
  in a PTY rooted at `WORKBENCH_ROOT`.

  Client → server (JSON text frames):
  ```json
  {"type": "input", "data": "ls\n"}
  {"type": "resize", "cols": 100, "rows": 30}
  ```
  Server → client:
  ```json
  {"type": "output", "data": "..."}
  {"type": "exit", "code": 0}
  ```

### Files

`path` is always a unix-style path **relative to the workspace root**.
Traversal (`..` escaping the root), absolute paths and NUL bytes are rejected
with `403`/`400`.

- `GET  /api/files/list?path=` → `{ "entries": [{ "name", "path", "kind": "file"|"dir", "size", "modified" }] }`
- `GET  /api/files/read?path=` → `{ "content", "truncated" }` (text; files over 1 MiB are truncated and flagged)
- `POST /api/files/write` `{ "path", "content" }`
- `POST /api/files/mkdir` `{ "path" }`
- `POST /api/files/delete` `{ "path" }` (files and directories, recursive)
- `POST /api/files/rename` `{ "from", "to" }`
- `GET  /api/files/download?path=` → raw bytes as an attachment
- `POST /api/files/upload` → multipart form with fields `file` (bytes) and `path` (destination; if it names an existing directory the uploaded filename is appended)

### Vault (encrypted credential store)

Entries: `{ id, name, provider, kind, created_at, updated_at }` where
`provider` is e.g. `github`/`openai`/`anthropic`/`custom` and
`kind` is `api_key` | `token` | `password` | `certificate` | `other`.
Secrets are encrypted with AES-256-GCM (random 96-bit nonce per entry) and
stored in `{root}/vault.json`; the list endpoint never returns secrets.

- `GET    /api/vault/entries` → metadata list (no secrets)
- `POST   /api/vault/entries` `{ "name", "provider", "kind", "secret" }` → `{ "id" }`
- `GET    /api/vault/entries/{id}/reveal` → `{ "secret" }` (explicit decrypt)
- `PUT    /api/vault/entries/{id}` `{ "name"?, "provider"?, "kind"?, "secret"? }` → updated metadata
- `DELETE /api/vault/entries/{id}` → `{ "ok": true }`

### System

- `GET /api/system/stats` → `{ "hostname", "uptime_secs", "cpu_usage", "mem_total", "mem_used", "load_avg": { "one", "five", "fifteen" } }`
  (`mem_*` in bytes, `cpu_usage` in percent)

## Design notes

- **Functional style**: immutable bindings by default; pure functions
  (`resolve`, `decode_client_msg`/`encode_server_msg`, `encrypt`/`decrypt`,
  `shape_stats`, `from_env`) are separated from IO, which lives in handlers
  and `main`. Iterator combinators and `map`/`and_then`/`ok_or_else` are used
  instead of imperative loops where natural.
- **Newtypes**: `SafePath` (lexically jail-checked path), `VaultId`,
  `SecretString` (zeroized on drop, `Debug` prints `[REDACTED]`).
- **Typed errors**: every fallible path returns `error::AppError` (thiserror);
  no `unwrap`/`expect` anywhere in the binary.
- **Security**: only key-based SSH-style auth model here — the vault key file
  is `0600`; the server binds loopback only; put it behind your own auth if
  you expose it.
