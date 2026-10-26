// The desktop app starts and supervises the link sidecar (Node + Claude Code) and hands the page its port and
// token (desktop.rs). A phone can't run Claude Code, so the Android app starts nothing: the page pairs with a
// desktop's link over the network instead (app/src/remote.ts), and this shell only adds the QR scanner.

#[cfg(desktop)]
mod desktop;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(mobile)]
    tauri::Builder::default()
        .plugin(tauri_plugin_barcode_scanner::init())
        .run(tauri::generate_context!())
        .expect("error while running waifufy-code");
}
