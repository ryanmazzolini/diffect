#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Diffect desktop shell: spawn a private diffectd on an ephemeral loopback
//! port, wait for its `DIFFECTD_READY <url>` line, and point the webview at
//! that origin. The web UI uses relative URLs throughout, so it needs no
//! changes; review state stays in the shared per-user store, where the CLI,
//! agents, and any manually run daemon see it too.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};
use tauri_plugin_opener::OpenerExt;

/// The spawned diffectd. Emptied on shutdown, which also stands the crash
/// watcher down; the daemon's `--exit-on-stdin-close` pipe is the backstop
/// that reaps it even when this process dies without running cleanup.
struct Daemon(Arc<Mutex<Option<Child>>>);

const READY_PREFIX: &str = "DIFFECTD_READY ";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// Crashes after at least this much uptime earn a fresh respawn allowance.
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const MAX_RAPID_RESPAWNS: u32 = 3;

/// How to start diffectd: either the bundled SEA sidecar (packaged app) or
/// the monorepo's built daemon via the system `node` (dev).
#[derive(Clone)]
struct DaemonLaunch {
    program: PathBuf,
    /// `daemon-bin.js` for the dev path; the sidecar needs no script arg.
    script: Option<PathBuf>,
    web_root: PathBuf,
}

/// Dev layout: this crate lives at packages/desktop/src-tauri, so the built
/// daemon and web assets sit under the monorepo root three levels up.
fn monorepo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|e| format!("could not resolve monorepo root: {e}"))
}

/// Prefer the packaged layout (a `diffectd` sidecar beside this executable,
/// web assets in the resource dir); fall back to the dev monorepo.
fn resolve_daemon(handle: &AppHandle) -> Result<DaemonLaunch, String> {
    let sidecar = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(format!("diffectd{}", std::env::consts::EXE_SUFFIX))))
        .filter(|p| p.exists());
    if let Some(sidecar) = sidecar {
        let res = handle
            .path()
            .resource_dir()
            .map_err(|e| format!("no resource dir: {e}"))?;
        let web_root = [res.join("web"), res.join("web/dist")]
            .into_iter()
            .find(|p| p.join("index.html").exists())
            .ok_or("bundled web assets not found in resource dir")?;
        return Ok(DaemonLaunch { program: sidecar, script: None, web_root });
    }
    let root = monorepo_root()?;
    let daemon_js = root.join("packages/core/dist/daemon-bin.js");
    let web_root = root.join("packages/web/dist");
    for missing in [&daemon_js, &web_root].into_iter().filter(|p| !p.exists()) {
        return Err(format!(
            "not built: {} (run `mise run build` first)",
            missing.display()
        ));
    }
    Ok(DaemonLaunch { program: "node".into(), script: Some(daemon_js), web_root })
}

fn spawn_daemon(launch: &DaemonLaunch) -> Result<(Child, String), String> {
    // --no-workspace: the app serves registered workspaces only; it must not
    // register its own cwd as something to review. The piped stdin is held
    // open for the daemon's whole life; the OS closes it when this process
    // dies — however it dies — and the daemon exits on that EOF.
    let mut cmd = Command::new(&launch.program);
    if let Some(script) = &launch.script {
        cmd.arg(script);
    }
    let mut child = cmd
        .args(["--port", "0", "--no-workspace", "--exit-on-stdin-close", "--web-root"])
        .arg(&launch.web_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not spawn {}: {e}", launch.program.display()))?;

    // One thread owns the child's stdout for the daemon's whole life: it
    // hands the ready URL back over a channel, then keeps draining (and
    // forwarding) output so the pipe never fills and blocks the daemon.
    let stdout = child.stdout.take().expect("stdout was piped");
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut tx = Some(tx);
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(url) = line.strip_prefix(READY_PREFIX) {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(url.trim().to_string());
                    continue;
                }
            }
            println!("{line}");
        }
        // Dropping an unused sender closes the channel, failing the wait
        // below as soon as the daemon dies before becoming ready.
    });

    match rx.recv_timeout(READY_TIMEOUT) {
        Ok(url) => Ok((child, url)),
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("diffectd did not become ready: {e}"))
        }
    }
}

/// Replace the window contents with a terminal error state. There is no IPC
/// bridge to retry from, so the message tells the user to relaunch.
fn show_error(handle: &AppHandle, message: &str) {
    eprintln!("diffect-desktop: {message}");
    if let Some(w) = handle.get_webview_window("main") {
        let html = format!(
            "<body style=\"font-family:system-ui;background:#1e293b;color:#e2e8f0;\
             display:grid;place-items:center;height:100vh;margin:0\">\
             <div style=\"max-width:32rem\"><h1>Diffect hit a problem</h1>\
             <p>{message}</p><p>Quit and relaunch to try again.</p></div></body>"
        );
        let _ = w.eval(&format!(
            "document.open(); document.write({}); document.close();",
            serde_json::to_string(&html).unwrap_or_default()
        ));
    }
}

/// Respawn the daemon if it dies underneath the window; give up (with a
/// visible error) when it crashloops.
fn watch_daemon(handle: AppHandle, launch: DaemonLaunch, daemon: Arc<Mutex<Option<Child>>>) {
    thread::spawn(move || {
        let mut rapid = 0u32;
        let mut last_spawn = Instant::now();
        loop {
            thread::sleep(Duration::from_secs(1));
            {
                let mut guard = daemon.lock().unwrap();
                let Some(child) = guard.as_mut() else { return }; // shutting down
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    continue;
                }
                *guard = None;
            }
            rapid = if last_spawn.elapsed() > CRASH_WINDOW { 1 } else { rapid + 1 };
            if rapid > MAX_RAPID_RESPAWNS {
                show_error(&handle, "diffectd keeps crashing; check the terminal output.");
                return;
            }
            eprintln!("diffectd exited unexpectedly; respawning ({rapid}/{MAX_RAPID_RESPAWNS})");
            last_spawn = Instant::now();
            match spawn_daemon(&launch) {
                Ok((child, url)) => {
                    *daemon.lock().unwrap() = Some(child);
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.navigate(url.parse().expect("ready line carries a valid URL"));
                    }
                }
                Err(e) => {
                    show_error(&handle, &format!("could not restart diffectd: {e}"));
                    return;
                }
            }
        }
    });
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d == "localhost",
        None => false,
    }
}

fn requested_loopback_url(args: &[String]) -> Option<Url> {
    args.iter()
        .skip(1)
        .filter_map(|arg| arg.parse::<Url>().ok())
        .find(is_loopback)
}

fn focus_window(handle: &AppHandle, requested: Option<Url>) {
    if let Some(w) = handle.get_webview_window("main") {
        if let Some(url) = requested {
            let _ = w.navigate(url);
        }
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch focuses the existing window instead of racing
            // a second daemon into the same store. If pi passed a loopback URL,
            // navigate the app there instead of opening a browser.
            focus_window(app, requested_loopback_url(&argv));
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Escape hatch for UI development: point the window at an
            // existing origin (Vite dev server or a manual daemon) instead
            // of spawning one.
            let argv: Vec<String> = std::env::args().collect();
            let url = match requested_loopback_url(&argv) {
                Some(url) => url.to_string(),
                None => match std::env::var("DIFFECT_DESKTOP_URL") {
                    Ok(u) if !u.is_empty() => u,
                    _ => {
                        let launch = resolve_daemon(app.handle())?;
                        let (child, url) = spawn_daemon(&launch)?;
                        let daemon = Arc::new(Mutex::new(Some(child)));
                        app.manage(Daemon(daemon.clone()));
                        watch_daemon(app.handle().clone(), launch, daemon);
                        url
                    }
                },
            };
            let mut url: Url = url.parse()?;
            url.query_pairs_mut().append_pair("shell", "desktop");
            // The app's own origins stay in the webview: any loopback port
            // (respawns get new ones) plus whatever origin the window was
            // started on. Everything else — links in comments, markdown —
            // opens in the system browser.
            let app_origin = url.origin();
            let handle = app.handle().clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Diffect")
                .inner_size(1280.0, 860.0)
                .disable_drag_drop_handler()
                .on_navigation(move |target| {
                    if is_loopback(target) || target.origin() == app_origin {
                        return true;
                    }
                    let _ = handle.opener().open_url(target.as_str(), None::<&str>);
                    false
                });
            #[cfg(target_os = "macos")]
            let builder = builder
                .hidden_title(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .traffic_light_position(LogicalPosition::new(14.0, 14.0));
            builder.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Diffect");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(daemon) = handle.try_state::<Daemon>() {
                if let Some(mut child) = daemon.0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
