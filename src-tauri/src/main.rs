// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gpu;
mod lens;
mod lens_source;
mod setup;

use gpu::GpuInfo;
use lens::LensManager;
use setup::{SetupManager, SetupStatus};
#[cfg(debug_assertions)]
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

// ── Lens commands ──────────────────────────────────────────────────

#[tauri::command]
async fn get_lens_status(lens: tauri::State<'_, LensManager>) -> Result<serde_json::Value, String> {
    lens.status().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_lens(lens: tauri::State<'_, LensManager>) -> Result<(), String> {
    lens.start().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_lens(lens: tauri::State<'_, LensManager>) -> Result<(), String> {
    lens.stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn configure_lens(
    lens: tauri::State<'_, LensManager>,
    config: serde_json::Value,
) -> Result<(), String> {
    lens.configure(config).await.map_err(|e| e.to_string())
}

// ── GPU commands ───────────────────────────────────────────────────

#[tauri::command]
fn detect_gpu() -> GpuInfo {
    gpu::detect_gpu()
}

#[tauri::command]
fn detect_all_gpus() -> Vec<GpuInfo> {
    gpu::detect_all()
}

// ── Knowledge Base / Lens config commands ──────────────────────────

#[derive(serde::Serialize)]
struct LensConfigInfo {
    url: String,
    api_key: String,
    top_k: u32,
}

/// Returns the local lens server URL + API key for auto-fill into Custom Knowledge
/// Source. Generates a key on first call if none exists.
#[tauri::command]
async fn get_lens_config() -> Result<LensConfigInfo, String> {
    let key_file = lens::lens_data_dir().join("api_key");
    let api_key = if key_file.exists() {
        std::fs::read_to_string(&key_file)
            .map_err(|e| format!("Failed to read API key: {}", e))?
            .trim()
            .to_string()
    } else {
        let (stdout, stderr, ok) = lens::run_lens_command(&["key"])?;
        if !ok {
            return Err(format!("Failed to generate key: {}", stderr));
        }
        stdout.trim().to_string()
    };
    Ok(LensConfigInfo {
        url: "http://127.0.0.1:8322/query".into(),
        api_key,
        top_k: 5,
    })
}

#[derive(serde::Deserialize)]
struct IngestRequest {
    paths: Vec<String>,
}

#[derive(serde::Serialize)]
struct IngestResult {
    files_seen: u32,
    chunks_indexed: u32,
    skipped: Vec<String>,
}

/// Per-file progress reported by the lens CLI's JSONL stream. Polled by the
/// frontend during long ingest runs so the user sees an N/M counter and the
/// current filename instead of a static "Indexing…" spinner.
#[derive(Default, Clone, serde::Serialize)]
pub struct IngestProgress {
    pub current: u32,
    pub total: u32,
    pub source: String,
    pub chunks_so_far: u32,
    pub started_at_ms: u64,
}

#[derive(Default)]
pub struct IngestState {
    pub progress: std::sync::Mutex<Option<IngestProgress>>,
}

#[tauri::command]
fn get_ingest_progress(state: tauri::State<'_, IngestState>) -> Option<IngestProgress> {
    state.progress.lock().unwrap().clone()
}

/// Ingest documents into the local knowledge base. Handles multiple paths;
/// each is ingested independently and results are summed. Streams the lens
/// CLI's JSONL output so per-file progress lands in IngestState while the
/// command runs — the frontend polls `get_ingest_progress` for the live
/// counter. The final non-event JSON line is the IngestResult.
#[tauri::command]
async fn ingest_documents(
    req: IngestRequest,
    state: tauri::State<'_, IngestState>,
    lens: tauri::State<'_, LensManager>,
) -> Result<IngestResult, String> {
    if req.paths.is_empty() {
        return Err("No paths provided".into());
    }

    fn now_ms() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    let started_at_ms = now_ms();
    // Reset progress at the start of every ingest call so a previous run's
    // tail state doesn't leak into the new operation's UI.
    *state.progress.lock().unwrap() = Some(IngestProgress {
        started_at_ms,
        ..Default::default()
    });

    // Qdrant takes a process-level POSIX file lock on its storage dir, so
    // the ingest subprocess and the long-running lens server can't both
    // hold it (second one in fails with "Storage folder already accessed
    // by another instance"). with_lens_paused stops the server for the
    // duration of the body and restarts it after, so chat / lens queries
    // resume once ingest is done.
    let outcome: Result<IngestResult, String> = with_lens_paused(&lens, async {
        let mut total = IngestResult {
            files_seen: 0,
            chunks_indexed: 0,
            skipped: vec![],
        };

        for path in &req.paths {
            let mut final_line: Option<String> = None;
            let progress_mutex = &state.progress;
            let result = lens::run_lens_command_streaming(&["ingest", "--json", path], |line| {
                let parsed: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                match parsed.get("event").and_then(|v| v.as_str()) {
                    Some("start") => {
                        let total_files = parsed["total"].as_u64().unwrap_or(0) as u32;
                        if let Ok(mut p) = progress_mutex.lock() {
                            if let Some(progress) = p.as_mut() {
                                progress.total = total_files;
                            }
                        }
                    }
                    Some("file") => {
                        if let Ok(mut p) = progress_mutex.lock() {
                            if let Some(progress) = p.as_mut() {
                                progress.current = parsed["index"].as_u64().unwrap_or(0) as u32;
                                progress.total = parsed["total"].as_u64().unwrap_or(progress.total as u64) as u32;
                                progress.source = parsed["source"].as_str().unwrap_or("").to_string();
                                let added = parsed["chunks"].as_u64().unwrap_or(0) as u32;
                                progress.chunks_so_far = progress.chunks_so_far.saturating_add(added);
                            }
                        }
                    }
                    _ => {
                        // No event tag → this is the final result line.
                        final_line = Some(line.to_string());
                    }
                }
            });

            if let Err(e) = result {
                return Err(format!("Ingest of {} failed: {}", path, e));
            }

            let stdout = final_line
                .ok_or_else(|| format!("Ingest of {} produced no result line", path))?;
            let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
                .map_err(|e| format!("Bad ingest JSON: {}", e))?;
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(format!("Ingest error: {}", err));
            }
            total.files_seen += parsed["files_seen"].as_u64().unwrap_or(0) as u32;
            total.chunks_indexed += parsed["chunks_indexed"].as_u64().unwrap_or(0) as u32;
            if let Some(skipped) = parsed["skipped"].as_array() {
                for s in skipped {
                    if let Some(s) = s.as_str() {
                        total.skipped.push(s.into());
                    }
                }
            }
        }

        Ok(total)
    })
    .await;

    // Always clear the progress state so the UI doesn't show "indexing N
    // of M" forever after exit.
    *state.progress.lock().unwrap() = None;

    outcome
}

#[derive(serde::Serialize)]
struct KnowledgeStats {
    total_chunks: u32,
    documents: Vec<DocumentInfo>,
}

#[derive(serde::Serialize)]
struct DocumentInfo {
    source: String,
    chunks: u32,
}

/// Scrub any `Bearer <token>` substrings from a string, so an HTTP error
/// body that echoes our Authorization header (misbehaving proxy, debug
/// middleware) doesn't leak the API key up to the UI or logs.
fn redact_bearer(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("Bearer ") {
        out.push_str(&rest[..idx]);
        out.push_str("Bearer [REDACTED]");
        rest = &rest[idx + "Bearer ".len()..];
        // Skip the token itself — everything up to the next whitespace or
        // string/JSON terminator.
        let token_end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | ',' | '}' | ']' | ';'))
            .unwrap_or(rest.len());
        rest = &rest[token_end..];
    }
    out.push_str(rest);
    out
}

/// Percent-encode a path string per RFC 3986 pchar rules, keeping `/` so
/// multi-segment FastAPI `:path` params still match. Encodes UTF-8 bytes
/// individually, so any non-ASCII byte (including `+`, `?`, `#`, `%`, CR,
/// LF, and the full UTF-8 range) becomes %XX. Replaces an earlier
/// hand-rolled version that only special-cased four characters.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        // unreserved (RFC 3986 §2.3) + '/' for path segments
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// Try to talk to the running lens HTTP server first — that bypasses the
/// qdrant POSIX flock that a CLI subprocess would fight over. Falls back
/// to the CLI when the server isn't up (typically right after setup, before
/// the first start_lens call). Used by stats / delete / clear so they
/// don't require pause-restart cycles for every render.
async fn lens_http_get(path: &str) -> Result<serde_json::Value, String> {
    let key_path = lens::lens_data_dir().join("api_key");
    let api_key = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("Read api_key: {}", e))?
        .trim()
        .to_string();
    let url = format!("http://127.0.0.1:8322{}", path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("HTTP request: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, redact_bearer(&body)));
    }
    resp.json().await.map_err(|e| format!("JSON decode: {}", e))
}

async fn lens_http_delete(path: &str) -> Result<serde_json::Value, String> {
    let key_path = lens::lens_data_dir().join("api_key");
    let api_key = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("Read api_key: {}", e))?
        .trim()
        .to_string();
    let url = format!("http://127.0.0.1:8322{}", path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;
    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("HTTP request: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, redact_bearer(&body)));
    }
    resp.json().await.map_err(|e| format!("JSON decode: {}", e))
}

#[tauri::command]
async fn get_knowledge_stats(lens: tauri::State<'_, LensManager>) -> Result<KnowledgeStats, String> {
    // Prefer the running server's HTTP endpoint — it shares the qdrant
    // handle the server already holds, so no flock conflict. Falls back
    // to the CLI when the server isn't up yet (very early in app lifetime
    // or right after setup before start_lens fires).
    let server_running = lens
        .status()
        .await
        .map(|s| s["running"].as_bool().unwrap_or(false))
        .unwrap_or(false);
    if server_running {
        match lens_http_get("/stats").await {
            Ok(v) => {
                let documents: Vec<DocumentInfo> = v["documents"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|d| Some(DocumentInfo {
                        source: d.get("source")?.as_str()?.into(),
                        chunks: d.get("chunks")?.as_u64()? as u32,
                    })).collect())
                    .unwrap_or_default();
                return Ok(KnowledgeStats {
                    total_chunks: v["total_chunks"].as_u64().unwrap_or(0) as u32,
                    documents,
                });
            }
            Err(e) => log::warn!("HTTP stats failed, falling back to CLI: {}", e),
        }
    }

    let (stdout, stderr, ok) = lens::run_lens_command(&["stats", "--json"])?;
    if !ok {
        return Err(format!("Stats failed: {}", stderr));
    }
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Bad stats JSON: {}", e))?;
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let documents: Vec<DocumentInfo> = parsed["documents"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    Some(DocumentInfo {
                        source: d.get("source")?.as_str()?.into(),
                        chunks: d.get("chunks")?.as_u64()? as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(KnowledgeStats {
        total_chunks: parsed["total_chunks"].as_u64().unwrap_or(0) as u32,
        documents,
    })
}

/// Stop the lens server if it's running, run `body`, then restart the server
/// if it was running before. Wraps any qdrant-mutating subprocess so the
/// process-level POSIX file lock on Qdrant's storage doesn't conflict
/// between the long-running server and a one-shot CLI invocation.
async fn with_lens_paused<F, T>(lens: &LensManager, body: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let was_running = lens
        .status()
        .await
        .map(|s| s["running"].as_bool().unwrap_or(false))
        .unwrap_or(false);
    if was_running {
        if let Err(e) = lens.stop().await {
            log::warn!("Failed to stop lens server: {}", e);
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let result = body.await;
    if was_running {
        if let Err(e) = lens.start().await {
            log::warn!("Failed to restart lens server: {}", e);
        }
    }
    result
}

#[tauri::command]
async fn delete_document(
    source: String,
    lens: tauri::State<'_, LensManager>,
) -> Result<u32, String> {
    // Prefer HTTP path when the server is up (no flock conflict).
    let server_running = lens
        .status()
        .await
        .map(|s| s["running"].as_bool().unwrap_or(false))
        .unwrap_or(false);
    if server_running {
        let path = format!("/sources/{}", percent_encode_path(&source));
        match lens_http_delete(&path).await {
            Ok(v) => return Ok(v["deleted_chunks"].as_u64().unwrap_or(0) as u32),
            Err(e) => log::warn!("HTTP delete failed, falling back to CLI: {}", e),
        }
    }
    with_lens_paused(&lens, async {
        let (stdout, stderr, ok) = lens::run_lens_command(&["delete", "--json", &source])?;
        if !ok {
            return Err(format!("Delete failed: {}", stderr));
        }
        let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
            .map_err(|e| format!("Bad delete JSON: {}", e))?;
        Ok(parsed["deleted_chunks"].as_u64().unwrap_or(0) as u32)
    })
    .await
}

/// Drop every chunk from the knowledge base (destructive — for the
/// "Remove all" button in Settings → AI → Local Knowledge Base).
#[tauri::command]
async fn clear_knowledge(lens: tauri::State<'_, LensManager>) -> Result<u32, String> {
    let server_running = lens
        .status()
        .await
        .map(|s| s["running"].as_bool().unwrap_or(false))
        .unwrap_or(false);
    if server_running {
        match lens_http_delete("/sources").await {
            Ok(v) => return Ok(v["deleted_chunks"].as_u64().unwrap_or(0) as u32),
            Err(e) => log::warn!("HTTP clear failed, falling back to CLI: {}", e),
        }
    }
    with_lens_paused(&lens, async {
        let (stdout, stderr, ok) = lens::run_lens_command(&["clear", "--json", "--yes"])?;
        if !ok {
            return Err(format!("Clear failed: {}", stderr));
        }
        let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
            .map_err(|e| format!("Bad clear JSON: {}", e))?;
        Ok(parsed["deleted_chunks"].as_u64().unwrap_or(0) as u32)
    })
    .await
}

// ── Setup commands ─────────────────────────────────────────────────

#[tauri::command]
fn get_setup_status(setup: tauri::State<'_, SetupManager>) -> SetupStatus {
    setup.status()
}

#[tauri::command]
async fn run_setup(setup: tauri::State<'_, SetupManager>) -> Result<(), String> {
    setup.run_setup().await
}

#[tauri::command]
fn reset_setup(setup: tauri::State<'_, SetupManager>) -> Result<(), String> {
    setup.reset()
}

/// Cancel the currently running setup — flips a flag that download/install
/// loops check at yield points, and SIGKILLs the currently running child
/// subprocess if one is tracked. The UI button wiring lives in
/// js/knowledge-base.js.
#[tauri::command]
fn cancel_setup(setup: tauri::State<'_, SetupManager>) {
    setup.cancel();
}

// ── Auto-updater commands ──────────────────────────────────────────

#[derive(serde::Serialize)]
struct UpdateInfo {
    available: bool,
    current_version: String,
    new_version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {}", e))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            current_version,
            new_version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            current_version,
            new_version: None,
            notes: None,
            date: None,
        }),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {}", e))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {}", e))?
        .ok_or("No update available")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Update install failed: {}", e))?;
    app.restart();
}

// ── Main ───────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            if let Some(window) = _app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .manage(LensManager::new())
        .manage(SetupManager::new())
        .manage(IngestState::default())
        .invoke_handler(tauri::generate_handler![
            // Lens sidecar
            get_lens_status,
            start_lens,
            stop_lens,
            configure_lens,
            // GPU detection
            detect_gpu,
            detect_all_gpus,
            // First-run setup
            get_setup_status,
            run_setup,
            reset_setup,
            cancel_setup,
            // Knowledge base
            get_lens_config,
            ingest_documents,
            get_ingest_progress,
            get_knowledge_stats,
            delete_document,
            clear_knowledge,
            // Auto-updater
            check_for_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running getbased");
}
