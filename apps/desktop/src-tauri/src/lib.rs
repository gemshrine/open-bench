mod bridge;
mod files;

use bridge::BridgeState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, RunEvent, State};

type Bridge = Arc<BridgeState>;

#[derive(Serialize)]
struct BridgeInfo {
    port: u16,
    workspace: String,
    clients: usize,
}

/// Called by the webview once its `bridge-request` listener is installed.
#[tauri::command]
fn bridge_info(state: State<'_, Bridge>) -> BridgeInfo {
    state.ready.store(true, Ordering::SeqCst);
    BridgeInfo {
        port: *state.port.lock().unwrap(),
        workspace: state.workspace.to_string_lossy().to_string(),
        clients: state.clients(),
    }
}

#[tauri::command]
fn bridge_respond(state: State<'_, Bridge>, conn_id: u64, line: String) -> bool {
    state.respond(conn_id, line)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    files::read_limited(&PathBuf::from(path))
}

#[tauri::command]
fn write_text_file(path: String, text: String) -> Result<(), String> {
    files::write_atomic(&PathBuf::from(path), &text)
}

#[derive(Serialize)]
struct ReadResult {
    text: String,
    path: String,
}

#[tauri::command]
fn workspace_read(state: State<'_, Bridge>, relative_path: String) -> Result<ReadResult, String> {
    let p = files::resolve_in_workspace(&state.workspace, &relative_path)?;
    Ok(ReadResult { text: files::read_limited(&p)?, path: p.to_string_lossy().to_string() })
}

#[tauri::command]
fn workspace_write(state: State<'_, Bridge>, relative_path: String, text: String) -> Result<String, String> {
    let p = files::resolve_in_workspace(&state.workspace, &relative_path)?;
    files::write_atomic(&p, &text)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn workspace_dir(state: State<'_, Bridge>) -> String {
    state.workspace.to_string_lossy().to_string()
}

/// Per-user location of the discovery file; must match apps/mcp-server/src/discovery.ts.
fn discovery_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("OPENBENCH_BRIDGE_FILE") {
        return PathBuf::from(p);
    }
    let base = app.path().config_dir().unwrap_or_else(|_| std::env::temp_dir());
    base.join("OpenBench").join("bridge.json")
}

fn workspace_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("OPENBENCH_WORKSPACE") {
        return PathBuf::from(p);
    }
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).unwrap_or_else(|_| std::env::temp_dir());
    base.join("OpenBench")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let workspace = workspace_path(&handle);
            std::fs::create_dir_all(&workspace).ok();
            let state = Arc::new(BridgeState::new(bridge::random_token(), workspace, discovery_path(&handle)));
            app.manage(state.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = bridge::serve(handle, state).await {
                    eprintln!("OpenBench bridge failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_info,
            bridge_respond,
            read_text_file,
            write_text_file,
            workspace_read,
            workspace_write,
            workspace_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenBench");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Bridge>() {
                state.remove_discovery();
            }
        }
    });
}
