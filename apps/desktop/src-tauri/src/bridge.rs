//! Loopback bridge between the MCP server process and this GUI.
//!
//! * Listens on 127.0.0.1 only (random port unless OPENBENCH_BRIDGE_PORT is set).
//! * Writes a discovery file (`bridge.json`: port, random token, pid, workspace) into the
//!   per-user config directory; the MCP server reads it. The file is removed on exit.
//! * Protocol: newline-delimited JSON. The first message must be
//!   `{"type":"hello","token":…,"protocol":1}`; a wrong token closes the connection.
//!   Browsers cannot speak this raw protocol, and HTTP requests fail the hello check.
//! * Authenticated requests are forwarded to the webview (`bridge-request` event), where
//!   the single engine instance executes them; the answer comes back via `bridge_respond`.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub const PROTOCOL: u64 = 1;
const MAX_LINE: usize = 4 * 1024 * 1024;

pub struct BridgeState {
    pub port: Mutex<u16>,
    pub token: String,
    pub workspace: PathBuf,
    pub discovery_file: PathBuf,
    /// Set once the webview has registered its request listener.
    pub ready: AtomicBool,
    next_conn: AtomicU64,
    conns: Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>,
}

#[derive(Serialize, Clone)]
struct RequestEvent {
    #[serde(rename = "connId")]
    conn_id: u64,
    id: Value,
    method: String,
    params: Value,
}

pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS random generator unavailable");
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Constant-time comparison so the token cannot be guessed byte by byte from timing.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl BridgeState {
    pub fn new(token: String, workspace: PathBuf, discovery_file: PathBuf) -> Self {
        Self {
            port: Mutex::new(0),
            token,
            workspace,
            discovery_file,
            ready: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            conns: Mutex::new(HashMap::new()),
        }
    }

    pub fn clients(&self) -> usize {
        self.conns.lock().map(|c| c.len()).unwrap_or(0)
    }

    pub fn respond(&self, conn_id: u64, line: String) -> bool {
        if let Ok(conns) = self.conns.lock() {
            if let Some(tx) = conns.get(&conn_id) {
                return tx.send(line).is_ok();
            }
        }
        false
    }

    pub fn write_discovery(&self) -> Result<(), String> {
        let port = *self.port.lock().unwrap();
        let info = json!({
            "protocol": PROTOCOL,
            "port": port,
            "token": self.token,
            "pid": std::process::id(),
            "workspace": self.workspace.to_string_lossy(),
        });
        if let Some(dir) = self.discovery_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        crate::files::write_atomic(&self.discovery_file, &serde_json::to_string_pretty(&info).unwrap())?;
        restrict_permissions(&self.discovery_file);
        Ok(())
    }

    /// Removes the discovery file only if it still belongs to this process.
    pub fn remove_discovery(&self) {
        if let Ok(text) = std::fs::read_to_string(&self.discovery_file) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if v.get("pid").and_then(Value::as_u64) == Some(std::process::id() as u64) {
                    let _ = std::fs::remove_file(&self.discovery_file);
                }
            }
        }
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {
    // On Windows the per-user %APPDATA% directory is already private to the user.
}

pub async fn serve(app: AppHandle, state: Arc<BridgeState>) -> Result<(), String> {
    let port: u16 = std::env::var("OPENBENCH_BRIDGE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("bridge bind: {e}"))?;
    let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
    *state.port.lock().unwrap() = actual;
    state.write_discovery()?;
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => continue,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            handle_conn(app, state, stream).await;
        });
    }
}

fn error_response(id: &Value, code: &str, message: &str) -> String {
    json!({"type": "response", "id": id, "ok": false, "error": {"code": code, "message": message}}).to_string()
}

async fn read_line_limited<R: AsyncBufReadExt + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<String>> {
    buf.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(None);
        }
        if let Some(pos) = available.iter().position(|b| *b == b'\n') {
            buf.extend_from_slice(&available[..pos]);
            reader.consume(pos + 1);
            return Ok(Some(String::from_utf8_lossy(buf).into_owned()));
        }
        let n = available.len();
        buf.extend_from_slice(available);
        reader.consume(n);
        if buf.len() > MAX_LINE {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line too long"));
        }
    }
}

async fn handle_conn(app: AppHandle, state: Arc<BridgeState>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut buf = Vec::new();

    // Authentication.
    let hello = match tokio::time::timeout(std::time::Duration::from_secs(5), read_line_limited(&mut reader, &mut buf)).await {
        Ok(Ok(Some(line))) => line,
        _ => return,
    };
    let ok = serde_json::from_str::<Value>(&hello)
        .ok()
        .filter(|v| v.get("type").and_then(Value::as_str) == Some("hello"))
        .map(|v| {
            let token_ok = v.get("token").and_then(Value::as_str).map(|t| token_eq(t, &state.token)).unwrap_or(false);
            let proto_ok = v.get("protocol").and_then(Value::as_u64) == Some(PROTOCOL);
            (token_ok, proto_ok)
        });
    match ok {
        Some((true, true)) => {}
        Some((true, false)) => {
            let msg = json!({"type": "hello_error", "error": {"code": "INVALID_ARGUMENT", "message": format!("Несовместимая версия протокола моста (GUI: {PROTOCOL})")}});
            let _ = write_half.write_all(format!("{msg}\n").as_bytes()).await;
            return;
        }
        _ => {
            let msg = json!({"type": "hello_error", "error": {"code": "GUI_NOT_RUNNING", "message": "Неверный токен моста: перезапустите MCP-сервер после запуска OpenBench"}});
            let _ = write_half.write_all(format!("{msg}\n").as_bytes()).await;
            return;
        }
    }
    let hello_ok = json!({"type": "hello_ok", "protocol": PROTOCOL, "app": "OpenBench"});
    if write_half.write_all(format!("{hello_ok}\n").as_bytes()).await.is_err() {
        return;
    }

    let conn_id = state.next_conn.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.conns.lock().unwrap().insert(conn_id, tx.clone());
    let _ = app.emit("bridge-clients", json!({"clients": state.clients()}));

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() || write_half.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    loop {
        let line = match read_line_limited(&mut reader, &mut buf).await {
            Ok(Some(l)) => l,
            _ => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(error_response(&Value::Null, "INVALID_ARGUMENT", "Некорректный JSON"));
                continue;
            }
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        if msg.get("type").and_then(Value::as_str) != Some("request") || !id.is_u64() {
            let _ = tx.send(error_response(&id, "INVALID_ARGUMENT", "Ожидалось сообщение type=request с числовым id"));
            continue;
        }
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        if !state.ready.load(Ordering::SeqCst) {
            let _ = tx.send(error_response(&id, "GUI_NOT_RUNNING", "Интерфейс OpenBench ещё загружается, повторите запрос"));
            continue;
        }
        let event = RequestEvent { conn_id, id: id.clone(), method, params: msg.get("params").cloned().unwrap_or(json!({})) };
        if app.emit_to("main", "bridge-request", event).is_err() {
            let _ = tx.send(error_response(&id, "GUI_NOT_RUNNING", "Окно OpenBench недоступно"));
        }
    }

    state.conns.lock().unwrap().remove(&conn_id);
    drop(tx);
    let _ = writer.await;
    let _ = app.emit("bridge-clients", json!({"clients": state.clients()}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
        assert_eq!(random_token().len(), 64);
        assert_ne!(random_token(), random_token());
    }
}
