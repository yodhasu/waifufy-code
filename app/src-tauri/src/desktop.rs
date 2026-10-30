use std::{
    collections::{hash_map::RandomState, VecDeque},
    fs::{self, File, OpenOptions},
    hash::{BuildHasher, Hasher},
    io::{self, BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalSize, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// How the page reaches the link sidecar: its port, and the token its WebSocket requires.
#[derive(Clone, Serialize)]
struct LinkInfo {
    port: u16,
    token: String,
}

/// Where the sidecar's pieces live: the Node runtime, the link package, and the bundled Claude Code (release only).
struct SidecarPaths {
    node: PathBuf,
    link: PathBuf,
    claude: Option<PathBuf>,
}

struct Link {
    info: LinkInfo,
    paths: SidecarPaths,
    child: Mutex<Option<Child>>,
    log: Arc<Mutex<SidecarLog>>,
    stopping: AtomicBool,
    #[cfg(windows)]
    job: Option<job::KillOnClose>,
}

/// How long the sidecar gets to close its Claude Code session after stdin closes, before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// Used only if the OS cannot hand out a free port.
const FALLBACK_PORT: u16 = 47901;
/// How often the watchdog checks whether the sidecar is still alive.
const WATCH_INTERVAL: Duration = Duration::from_millis(200);
/// The first restart is quick (a one-off crash), then each one waits twice as long, up to the max.
const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(5);
/// A sidecar that stayed up this long was healthy, so its next crash starts the backoff over.
const STABLE_UPTIME: Duration = Duration::from_secs(30);
/// More restarts than this within the window means it will not recover by itself: stop and tell the user.
const RESTART_LIMIT: usize = 8;
const RESTART_WINDOW: Duration = Duration::from_secs(120);
const LOG_FILE: &str = "sidecar.log";
/// Past this size the log moves to `sidecar.1.log` (replacing the previous one) and starts over.
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
/// The last lines of sidecar output, shortened, shown in the error dialog when the watchdog gives up.
const LOG_TAIL_LINES: usize = 6;
const LOG_TAIL_CHARS: usize = 160;
/// The Claude Code binary that `npm ci` puts in the staged link (see scripts/stage-sidecar.mjs).
#[cfg(not(debug_assertions))]
const CLAUDE_EXE: [&str; 4] = ["node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"];
/// WebView2 reads extra browser switches from this variable when it creates its environment.
const WEBVIEW2_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
/// And its data folder from this one, which wins over the folder the app asks for.
const WEBVIEW2_DATA_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";
/// A screen smaller than the window in tauri.conf.json gets the largest stage-shaped window that fills this much of
/// its work area, so the title bar stays on screen.
const SCREEN_FILL: f64 = 0.9;
const STAGE_ASPECT: f64 = 16.0 / 9.0;
const RETRY: &str = "Try again";
const OPEN_LOG: &str = "Open log folder";
const CLOSE: &str = "Close";

/// Dev builds run the checkout: `WAIFUFY_CODE_HOME`, else the repo this was built from, with Node from PATH.
/// Claude Code is left to the SDK's own lookup.
#[cfg(debug_assertions)]
fn sidecar_paths(_app: &AppHandle) -> tauri::Result<SidecarPaths> {
    let repo = std::env::var_os("WAIFUFY_CODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."));
    Ok(SidecarPaths { node: "node".into(), link: repo.join("link"), claude: None })
}

/// Release builds run what the installer put under `<resources>/sidecar`: `node/node.exe` and `link/`.
#[cfg(not(debug_assertions))]
fn sidecar_paths(app: &AppHandle) -> tauri::Result<SidecarPaths> {
    let root = without_verbatim_prefix(app.path().resource_dir()?).join("sidecar");
    let link = root.join("link");
    let claude = CLAUDE_EXE.iter().fold(link.clone(), |path, part| path.join(part));
    Ok(SidecarPaths { node: root.join("node").join("node.exe"), claude: claude.is_file().then_some(claude), link })
}

#[cfg(debug_assertions)]
fn sidecar_missing(e: &io::Error) -> String {
    format!(
        "Node.js or the link was not found ({e}). Dev mode runs link/ from this checkout (or WAIFUFY_CODE_HOME) \
         with your own Node from PATH, version 24 or newer."
    )
}

#[cfg(not(debug_assertions))]
fn sidecar_missing(e: &io::Error) -> String {
    format!("Part of Waifufy Code is missing ({e}). Reinstalling it should fix this.")
}

/// `resource_dir()` is canonicalized, so on Windows it starts with `\\?\`. Node resolves its ESM imports from
/// the script path, and plain drive paths are what it handles reliably.
#[cfg(not(debug_assertions))]
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => path,
    }
}

/// `WC_DATA_DIR` (tests), else `%APPDATA%\waifufy-code`, the folder link/src/settings.ts uses too.
fn data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("WC_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| app.path().data_dir().ok())
        .unwrap_or_default()
        .join("waifufy-code")
}

/// Whether phone access is on (link/src/remote.ts keeps it in remote.json). Then closing the window keeps the app,
/// and its link, running in the tray: a phone paired with this computer can always reach it.
fn phone_access_on(app: &AppHandle) -> bool {
    fs::read_to_string(data_dir(app).join("remote.json"))
        .map(|s| s.replace(' ', "").contains("\"enabled\":true"))
        .unwrap_or(false)
}

/// Brings the window back from the tray (or from behind other windows).
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The tray icon: a click brings the window back; its menu opens or quits.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Waifufy Code", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Waifufy Code")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(FALLBACK_PORT)
}

/// 128 random bits as hex. Each `RandomState` is seeded from the OS, so no extra crate is needed.
fn random_token() -> String {
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

/// `YYYY-MM-DD hh:mm:ssZ` for log lines, from the days-to-civil algorithm
/// (https://howardhinnant.github.io/date_algorithms.html#civil_from_days), so no date crate is needed.
fn utc_now() -> String {
    const SECS_PER_DAY: u64 = 86_400;
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, time) = ((secs / SECS_PER_DAY) as i64, secs % SECS_PER_DAY);
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z", time / 3600, time / 60 % 60, time % 60)
}

/// `logs/sidecar.log`: the sidecar's stdout and stderr, line by line, plus the shell's own notes about
/// starting, exiting and restarting it. A release build has no console, so this is the only place they show up.
/// The link also keeps its own `link.log` (link/src/server.ts) with the same lines once it runs; this one adds what
/// happens before that (a bad install, an import error, Node itself crashing) and why the shell restarted it.
struct SidecarLog {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    tail: VecDeque<String>,
}

impl SidecarLog {
    fn open(dir: &Path) -> Self {
        let _ = fs::create_dir_all(dir);
        let mut log = SidecarLog { path: dir.join(LOG_FILE), file: None, size: 0, tail: VecDeque::new() };
        log.reopen();
        log
    }

    fn reopen(&mut self) {
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.size = self.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.size >= LOG_ROTATE_BYTES {
            self.file = None;
            let _ = fs::rename(&self.path, self.path.with_extension("1.log"));
            self.reopen();
        }
        if let Some(file) = &mut self.file {
            if file.write_all(bytes).is_ok() {
                self.size += bytes.len() as u64;
            }
        }
    }

    fn sidecar_line(&mut self, line: &[u8]) {
        self.write(line);
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end();
        if !text.is_empty() {
            let text = match text.char_indices().nth(LOG_TAIL_CHARS) {
                Some((cut, _)) => format!("{}…", &text[..cut]),
                None => text.to_string(),
            };
            if self.tail.len() == LOG_TAIL_LINES {
                self.tail.pop_front();
            }
            self.tail.push_back(text);
        }
    }

    fn note(&mut self, text: &str) {
        self.write(format!("[{} shell] {text}\n", utc_now()).as_bytes());
    }
}

/// Copies one of the sidecar's output streams into the log until the process closes it.
fn pipe_to_log(stream: impl Read + Send + 'static, log: Arc<Mutex<SidecarLog>>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line), Ok(n) if n > 0) {
            if !line.ends_with(b"\n") {
                line.push(b'\n');
            }
            log.lock().unwrap().sidecar_line(&line);
            // `npm run dev` shows the link and Claude Code live in its terminal, as before the log existed.
            #[cfg(debug_assertions)]
            {
                let _ = io::stderr().write_all(&line);
            }
            line.clear();
        }
    });
}

impl Link {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn note(&self, text: &str) {
        self.log.lock().unwrap().note(text);
    }

    /// Starts `link/src/server.ts` with Node. Its stdin stays open while the app runs; closing it tells the
    /// sidecar to end its session and exit. Every other variable is inherited, so `WC_MOCK` and `WC_DATA_DIR`
    /// reach it when set.
    fn start(&self) -> io::Result<()> {
        let script = self.paths.link.join("src").join("server.ts");
        // Spawning from a missing link folder fails with "the directory name is invalid", which reads like a crash
        // and would be retried; a missing piece is an install problem, so it is reported as such right away.
        if let Some(path) = [&self.paths.node, &script].into_iter().find(|p| p.is_absolute() && !p.is_file()) {
            let e = io::Error::new(io::ErrorKind::NotFound, format!("{} is missing", path.display()));
            self.note(&format!("cannot start the sidecar: {e}"));
            return Err(e);
        }
        let mut cmd = Command::new(&self.paths.node);
        cmd.arg(&script)
            .current_dir(&self.paths.link)
            .env("WC_PORT", self.info.port.to_string())
            .env("WC_TOKEN", &self.info.token)
            // The DevTools setup is meant for this app's webview, not for anything Claude Code launches.
            .env_remove(WEBVIEW2_ARGS_ENV)
            .env_remove(WEBVIEW2_DATA_ENV)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(claude) = &self.paths.claude {
            // The bundled binary speaks the protocol of the SDK it shipped with, so it must not update itself.
            cmd.env("WC_CLAUDE", claude).env("DISABLE_AUTOUPDATER", "1");
        }
        #[cfg(all(windows, not(debug_assertions)))]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().inspect_err(|e| {
            self.note(&format!("cannot start {} {}: {e}", self.paths.node.display(), script.display()))
        })?;
        self.note(&format!("started the sidecar (pid {}) on port {}", child.id(), self.info.port));
        #[cfg(windows)]
        if let Some(job) = &self.job {
            if let Err(e) = job.adopt(&child) {
                self.note(&format!("the sidecar may outlive the app: {e}"));
            }
        }
        if let Some(out) = child.stdout.take() {
            pipe_to_log(out, self.log.clone());
        }
        if let Some(err) = child.stderr.take() {
            pipe_to_log(err, self.log.clone());
        }
        let mut slot = self.child.lock().unwrap();
        // Shutdown began while it was starting: let it go the same way stop() would have.
        if self.stopping() {
            drop(child.stdin.take());
        }
        *slot = Some(child);
        Ok(())
    }

    /// Blocks until the running sidecar exits and says how. None once the app is shutting down.
    fn wait(&self) -> Option<String> {
        loop {
            {
                let mut slot = self.child.lock().unwrap();
                if self.stopping() {
                    return None;
                }
                let ended = match slot.as_mut()?.try_wait() {
                    Ok(None) => None,
                    Ok(Some(status)) => Some(format!("exited ({status})")),
                    Err(e) => Some(format!("could not be watched: {e}")),
                };
                if ended.is_some() {
                    *slot = None;
                    return ended;
                }
            }
            thread::sleep(WATCH_INTERVAL);
        }
    }

    /// Sleeps in short steps so a shutdown is never held up. False if the app started shutting down.
    fn pause(&self, delay: Duration) -> bool {
        let until = Instant::now() + delay;
        while Instant::now() < until {
            if self.stopping() {
                return false;
            }
            thread::sleep(WATCH_INTERVAL.min(until - Instant::now()));
        }
        !self.stopping()
    }

    /// The watchdog stopped restarting: say why, with the sidecar's last words. True if the user asks to retry.
    fn ask_retry(&self, app: &AppHandle, reason: &str) -> bool {
        self.note(&format!("gave up: {reason}"));
        let (tail, dir) = {
            let log = self.log.lock().unwrap();
            (log.tail.iter().cloned().collect::<Vec<_>>().join("\n"), log.path.parent().map(Path::to_path_buf))
        };
        let last_words = if tail.is_empty() { String::new() } else { format!("\n\nLast output:\n{tail}") };
        loop {
            if self.stopping() {
                return false;
            }
            let answer = app
                .dialog()
                .message(format!("{reason}\n\nThe chat stays offline until the link runs again.{last_words}"))
                .title("Waifufy Code: the link to Claude Code is down")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::YesNoCancelCustom(RETRY.into(), OPEN_LOG.into(), CLOSE.into()))
                .blocking_show_with_result();
            match answer {
                MessageDialogResult::Custom(choice) if choice == RETRY => return true,
                MessageDialogResult::Custom(choice) if choice == OPEN_LOG => {
                    if let Some(dir) = &dir {
                        let _ = Command::new("explorer").arg(dir).spawn();
                    }
                }
                _ => return false,
            }
        }
    }

    /// Closes the sidecar's stdin so it can end its Claude Code session, then kills it if it takes too long.
    /// Setting `stopping` first keeps the watchdog from taking the exit for a crash.
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        drop(child.stdin.take());
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return self.note("the sidecar shut down");
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        self.note("the sidecar did not shut down in time and was killed");
    }
}

/// Keeps the sidecar running: starts it, and after an unexpected exit restarts it on the same port and token
/// (the page's WebSocket reconnects by itself), backing off between attempts. Gives up with a dialog after
/// RESTART_LIMIT restarts within RESTART_WINDOW, or at once if Node or the link is missing.
fn supervise(app: AppHandle) {
    let link = app.state::<Link>();
    let mut backoff = RESTART_BACKOFF_MIN;
    let mut restarts = VecDeque::<Instant>::new();
    loop {
        let started = Instant::now();
        let ended = match link.start() {
            Ok(()) => match link.wait() {
                Some(how) => how,
                None => return,
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !link.ask_retry(&app, &sidecar_missing(&e)) {
                    return;
                }
                restarts.clear();
                backoff = RESTART_BACKOFF_MIN;
                continue;
            }
            Err(e) => format!("could not start: {e}"),
        };
        if link.stopping() {
            return;
        }
        link.note(&format!("the sidecar {ended}"));
        if started.elapsed() >= STABLE_UPTIME {
            backoff = RESTART_BACKOFF_MIN;
        }
        let now = Instant::now();
        while restarts.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
            restarts.pop_front();
        }
        if restarts.len() >= RESTART_LIMIT {
            let reason = format!(
                "The link to Claude Code went down {RESTART_LIMIT} times within {} seconds, so it is no longer restarted. \
                 Last time it {ended}.",
                RESTART_WINDOW.as_secs()
            );
            if !link.ask_retry(&app, &reason) {
                return;
            }
            restarts.clear();
            backoff = RESTART_BACKOFF_MIN;
        } else {
            if !link.pause(backoff) {
                return;
            }
            backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
        }
        restarts.push_back(Instant::now());
        link.note("restarting the sidecar");
    }
}

/// `WC_CDP_PORT`: opens the WebView2 DevTools protocol so the E2E harness can drive the page. WebView2 takes
/// browser switches from both the environment variable and the window's `additionalBrowserArgs` option, and
/// depending on the runtime one may replace the other, so both get the same full list: the port plus the
/// switches from tauri.conf.json (the browser process then shows each switch once). Must run before the
/// webview environment is created.
///
/// WebView2 runs one browser process per data folder and refuses a second one with other switches
/// (0x8007139F), so a test instance on the default folder fails to start while the user's own Waifufy Code is
/// open. `webview-cdp-<port>` gives each debug port its own browser, under `WC_DATA_DIR` when the harness sets
/// one, so the tests' storage stays out of the user's profile. It goes through the environment because Tauri
/// 2.12 does not pass the window's `dataDirectory` option on to WebView2.
fn enable_cdp<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let Some(port) = std::env::var("WC_CDP_PORT").ok().filter(|p| p.parse::<u16>().is_ok()) else { return };
    let data = std::env::var_os("WC_DATA_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(&context.config().identifier)));
    if let Some(data) = data {
        std::env::set_var(WEBVIEW2_DATA_ENV, data.join(format!("webview-cdp-{port}")));
    }
    let Some(window) = context.config_mut().app.windows.first_mut() else { return };
    let args = match window.additional_browser_args.as_deref() {
        Some(configured) => format!("--remote-debugging-port={port} {configured}"),
        None => format!("--remote-debugging-port={port}"),
    };
    std::env::set_var(WEBVIEW2_ARGS_ENV, &args);
    window.additional_browser_args = Some(args);
}

/// The window starts hidden at the size in tauri.conf.json. On a smaller work area (a 1366x768 laptop, or 1080p at
/// 150%) a centered 1600x900 window would put its title bar above the screen, out of reach, so it shrinks first.
fn fit_to_screen(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else { return Ok(()) };
    let area = monitor.work_area().size;
    let (outer, inner) = (window.outer_size()?, window.inner_size()?);
    if outer.width <= area.width && outer.height <= area.height {
        return Ok(());
    }
    let frame_width = f64::from(outer.width.saturating_sub(inner.width));
    let frame_height = f64::from(outer.height.saturating_sub(inner.height));
    let max_width = f64::from(area.width) * SCREEN_FILL - frame_width;
    let max_height = f64::from(area.height) * SCREEN_FILL - frame_height;
    let width = max_width.min(max_height * STAGE_ASPECT);
    window.set_size(PhysicalSize::new(width.round() as u32, (width / STAGE_ASPECT).round() as u32))?;
    window.center()
}

/// A Windows job object that ends every process in it when its last handle closes, which happens when this
/// process exits by any route: a crash, a kill from Task Manager, or the installer closing the app to replace it.
/// The sidecar and the claude.exe it starts would otherwise outlive the shell and keep their files locked.
#[cfg(windows)]
mod job {
    use std::{ffi::c_void, io, mem, os::windows::io::AsRawHandle, process::Child, ptr};

    type Handle = *mut c_void;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    /// Lets processes the sidecar's children start break away silently, as libuv's own job does: a browser
    /// that Claude Code opens for login, or an editor from `!code .`, must outlive the app.
    const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x1000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, with JOBOBJECT_BASIC_LIMIT_INFORMATION and IO_COUNTERS inlined.
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    }

    /// Never closed: the OS closes it as this process ends, and that is the moment it exists for.
    pub struct KillOnClose(Handle);

    // A job handle is a kernel handle, usable from any thread.
    unsafe impl Send for KillOnClose {}
    unsafe impl Sync for KillOnClose {}

    impl KillOnClose {
        pub fn new() -> io::Result<Self> {
            let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let limits = ExtendedLimits {
                limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
                ..Default::default()
            };
            let info = (&limits as *const ExtendedLimits).cast();
            let length = mem::size_of::<ExtendedLimits>() as u32;
            if unsafe { SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, length) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(KillOnClose(job))
        }

        /// Takes in a freshly started child. What it starts later breaks away from this job; node's own job
        /// (libuv's, kill-on-close) still ends Claude Code and `!` commands when node ends, while a browser or
        /// editor they open survives the app.
        pub fn adopt(&self, child: &Child) -> io::Result<()> {
            match unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) } {
                0 => Err(io::Error::last_os_error()),
                _ => Ok(()),
            }
        }
    }
}

#[tauri::command]
fn link_info(link: tauri::State<Link>) -> LinkInfo {
    link.info.clone()
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let mut context = tauri::generate_context!();
    enable_cdp(&mut context);
    let app = tauri::Builder::default()
        // First, so a second launch hands over to this one before it starts anything of its own.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // With phone access on, the window's close button only hides it: the link keeps running for the phone.
            // Quit (the tray, or Exit on the title screen) ends it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if phone_access_on(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let mut log = SidecarLog::open(&data_dir(&handle).join("logs"));
            if let Err(e) = tray(app) {
                log.note(&format!("no tray icon: {e}"));
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = fit_to_screen(&window) {
                    log.note(&format!("could not fit the window to the screen: {e}"));
                }
                window.show()?;
            }
            #[cfg(windows)]
            let job = job::KillOnClose::new()
                .inspect_err(|e| log.note(&format!("no job object for the sidecar: {e}")))
                .ok();
            app.manage(Link {
                info: LinkInfo { port: free_port(), token: random_token() },
                paths: sidecar_paths(&handle)?,
                child: Mutex::new(None),
                log: Arc::new(Mutex::new(log)),
                stopping: AtomicBool::new(false),
                #[cfg(windows)]
                job,
            });
            thread::spawn(move || supervise(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![link_info, quit])
        .build(context)
        .expect("error while building waifufy-code");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<Link>().stop();
        }
    });
}
