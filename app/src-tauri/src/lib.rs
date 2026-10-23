use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};

/// How the page reaches the link sidecar: its port, and the token its WebSocket requires.
#[derive(Clone, Serialize)]
struct LinkInfo {
    port: u16,
    token: String,
}

struct Link {
    info: LinkInfo,
    child: Mutex<Option<Child>>,
}

/// How long the sidecar gets to close its Claude Code session after stdin closes, before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// The repo root: `WAIFUFY_CODE_HOME`, else the checkout this was built from.
fn repo() -> PathBuf {
    std::env::var_os("WAIFUFY_CODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."))
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(47901)
}

/// 128 random bits as hex. Each `RandomState` is seeded from the OS, so no extra crate is needed.
fn random_token() -> String {
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

/// Starts `link/src/server.ts` with Node. Its stdin stays open while the app runs; closing it tells the
/// sidecar to end its session and exit.
fn spawn_link(info: &LinkInfo) -> std::io::Result<Child> {
    let link = repo().join("link");
    let mut cmd = Command::new("node");
    cmd.arg(link.join("src").join("server.ts"))
        .current_dir(&link)
        .env("WC_PORT", info.port.to_string())
        .env("WC_TOKEN", &info.token)
        .stdin(Stdio::piped());
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

fn stop_link(link: &Link) {
    let Some(mut child) = link.child.lock().unwrap().take() else { return };
    drop(child.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

#[tauri::command]
fn link_info(link: tauri::State<Link>) -> LinkInfo {
    link.info.clone()
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let info = LinkInfo { port: free_port(), token: random_token() };
    let child = spawn_link(&info)
        .map_err(|e| eprintln!("waifufy-code: cannot start the link sidecar (is Node on PATH?): {e}"))
        .ok();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Link { info, child: Mutex::new(child) })
        .invoke_handler(tauri::generate_handler![link_info, quit])
        .build(tauri::generate_context!())
        .expect("error while building waifufy-code");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_link(&app.state::<Link>());
        }
    });
}
