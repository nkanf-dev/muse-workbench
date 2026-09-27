//! WebSocket PTY terminal.
//!
//! Route: `GET /api/terminal/ws?cols=<u16>&rows=<u16>`
//!
//! Wire protocol (JSON text frames):
//! - client -> server: `{"type":"input","data":"..."}` |
//!   `{"type":"resize","cols":N,"rows":M}`
//! - server -> client: `{"type":"output","data":"..."}` |
//!   `{"type":"exit","code":N}`
//!
//! Message encoding/decoding is done by the pure functions
//! [`decode_client_msg`] / [`encode_server_msg`]; all IO lives in
//! [`ws_handler`] and the pump tasks it spawns.

use std::io::{Read, Write};
use std::path::PathBuf;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::{error::AppError, AppState};

/// Query string for the WS endpoint.
#[derive(Debug, Deserialize)]
pub struct TermQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// Messages the client may send. Pure data; see [`decode_client_msg`].
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

/// Messages the server sends. Pure data; see [`encode_server_msg`].
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMsg {
    Output { data: String },
    Exit { code: i32 },
}

/// Pure: parse one client text frame.
pub fn decode_client_msg(text: &str) -> Result<ClientMsg, AppError> {
    serde_json::from_str(text).map_err(AppError::Json)
}

/// Pure: render one server message as a JSON text frame.
pub fn encode_server_msg(msg: &ServerMsg) -> Result<String, AppError> {
    serde_json::to_string(msg).map_err(AppError::Json)
}

/// Commands fed to the PTY writer thread.
enum PtyInput {
    Data(Vec<u8>),
    Resize(u16, u16),
}

/// Axum handler: upgrade to WebSocket and attach a fresh PTY running `shell`.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<TermQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let cols = query.cols.unwrap_or(80).max(1);
    let rows = query.rows.unwrap_or(24).max(1);
    let shell = state.config.shell.clone();
    let cwd = state.config.root.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, shell, cwd, cols, rows))
}

async fn handle_socket(socket: WebSocket, shell: String, cwd: PathBuf, cols: u16, rows: u16) {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::error!("openpty failed: {e}");
            return;
        }
    };

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("spawn shell failed: {e}");
            return;
        }
    };
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            tracing::error!("clone pty reader failed: {e}");
            return;
        }
    };
    let master = pair.master;
    let writer = match master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            tracing::error!("take pty writer failed: {e:#}");
            return;
        }
    };

    // PTY -> channel -> websocket (blocking read on a dedicated thread).
    let (pty_out_tx, mut pty_out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: child exited
                Ok(n) => {
                    if pty_out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // websocket -> channel -> PTY (blocking write on a dedicated thread).
    let (pty_in_tx, pty_in_rx) = mpsc::channel::<PtyInput>(64);
    std::thread::spawn(move || {
        let mut writer = writer;
        let mut rx = pty_in_rx;
        while let Some(msg) = rx.blocking_recv() {
            match msg {
                PtyInput::Data(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                }
                PtyInput::Resize(cols, rows) => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
        }
    });

    // Child exit watcher.
    let (exit_tx, mut exit_rx) = oneshot::channel::<i32>();
    std::thread::spawn(move || {
        let mut child = child;
        let code = child
            .wait()
            .ok()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        let _ = exit_tx.send(code);
    });

    let (mut ws_tx, mut ws_rx) = socket.split();

    loop {
        tokio::select! {
            Some(chunk) = pty_out_rx.recv() => {
                // PTY bytes may not be valid UTF-8; lossy conversion keeps the
                // stream flowing instead of failing the whole frame.
                let data = String::from_utf8_lossy(&chunk).into_owned();
                let frame = match encode_server_msg(&ServerMsg::Output { data }) {
                    Ok(frame) => frame,
                    Err(e) => {
                        tracing::warn!("encode output failed: {e}");
                        break;
                    }
                };
                if ws_tx.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => match decode_client_msg(&text) {
                        Ok(ClientMsg::Input { data }) => {
                            if pty_in_tx.send(PtyInput::Data(data.into_bytes())).await.is_err() {
                                break;
                            }
                        }
                        Ok(ClientMsg::Resize { cols, rows }) => {
                            if pty_in_tx.send(PtyInput::Resize(cols.max(1), rows.max(1))).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => tracing::warn!("ignoring malformed client frame: {e}"),
                    },
                    Some(Ok(Message::Close(_))) | None => break,
                    // Binary / ping / pong frames carry no terminal meaning.
                    _ => {}
                }
            }
            code = &mut exit_rx => {
                let code = code.unwrap_or(-1);
                if let Ok(frame) = encode_server_msg(&ServerMsg::Exit { code }) {
                    let _ = ws_tx.send(Message::Text(frame.into())).await;
                }
                break;
            }
        }
    }

    let _ = ws_tx.close().await;
}
