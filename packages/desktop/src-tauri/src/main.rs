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

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, Url, WebviewUrl,
    WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
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
                        let url = url.parse().expect("ready line carries a valid URL");
                        let _ = w.navigate(desktop_url(url));
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

fn desktop_url(mut url: Url) -> Url {
    url.query_pairs_mut()
        .append_pair("shell", "desktop")
        .append_pair("platform", std::env::consts::OS);
    url

fn is_reviewable_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && is_loopback(url)
}

const WEBSITE_REVIEW_LABEL: &str = "website-review";
const PICK_SCHEME: &str = "diffect-pick";
const PICK_TITLE_PREFIX: &str = "__DIFFECT_PICK__";
const WEBSITE_PICKER_SCRIPT: &str = r#"
(() => {
  if (window.__diffectWebsitePicker) return;
  window.__diffectWebsitePicker = true;

  const cssEscape = (value) => {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const selectorFor = (element) => {
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5; node = node.parentElement) {
      let part = node.localName;
      if (!part) break;
      if (node.classList.length) part += `.${Array.from(node.classList).slice(0, 2).map(cssEscape).join(".")}`;
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.localName === node.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);

  const style = document.createElement("style");
  style.textContent = `.__diffect-picker-hover { outline: 2px solid #7c3aed !important; outline-offset: 2px !important; }`;
  document.documentElement.appendChild(style);

  let pickCount = 0;
  const sendPick = (element) => {
    const rect = element.getBoundingClientRect();
    const payload = {
      kind: "element",
      pickId: ++pickCount,
      url: location.href,
      title: document.title,
      selector: selectorFor(element),
      text: cleanText(element.innerText || element.textContent),
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    };
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (invoke) {
      invoke("report_website_pick", { payload }).catch(() => {
        document.title = `__DIFFECT_PICK__${encodeURIComponent(JSON.stringify(payload))}`;
      });
    } else {
      document.title = `__DIFFECT_PICK__${encodeURIComponent(JSON.stringify(payload))}`;
    }
  };

  let hover = null;
  document.addEventListener("pointerover", (event) => {
    if (!(event.target instanceof Element)) return;
    if (hover) hover.classList.remove("__diffect-picker-hover");
    hover = event.target;
    hover.classList.add("__diffect-picker-hover");
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendPick(event.target);
  }, true);

  document.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
"#;

fn dispatch_website_pick_value(handle: &AppHandle, value: serde_json::Value) -> Result<(), String> {
    let Some(url) = value.get("url").and_then(|v| v.as_str()) else {
        return Err("website pick payload missing URL".into());
    };
    let url: Url = url.parse().map_err(|e| format!("invalid picked URL: {e}"))?;
    if !is_reviewable_url(&url) {
        return Err("ignored non-loopback website pick".into());
    }
    let json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    let Some(main) = handle.get_webview("main") else {
        return Err("main webview is not available".into());
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('diffect:website-pick', {{ detail: {json} }}));"
    );
    main.eval(script).map_err(|e| e.to_string())?;
    if let Some(window) = handle.get_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

fn dispatch_website_pick(handle: &AppHandle, payload: &str) {
    let decoded = Url::parse(&format!("http://diffect.local/?payload={payload}"))
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "payload")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_else(|| payload.to_string());
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&decoded) else {
        eprintln!("diffect-desktop: ignored malformed website pick payload");
        return;
    };
    if let Err(e) = dispatch_website_pick_value(handle, value) {
        eprintln!("diffect-desktop: ignored website pick: {e}");
    }
}

#[tauri::command]
fn report_website_pick(
    handle: AppHandle,
    webview: tauri::Webview,
    payload: serde_json::Value,
) -> Result<(), String> {
    if webview.label() != WEBSITE_REVIEW_LABEL {
        return Err("website picks may only come from the Website Review webview".into());
    }
    dispatch_website_pick_value(&handle, payload)
}

fn handle_review_navigation(handle: &AppHandle, target: &Url) -> bool {
    if target.scheme() == PICK_SCHEME {
        if let Some((_, payload)) = target.query_pairs().find(|(key, _)| key == "payload") {
            dispatch_website_pick(handle, payload.as_ref());
        }
        return false;
    }
    if is_reviewable_url(target) {
        return true;
    }
    let _ = handle.opener().open_url(target.as_str(), None::<&str>);
    false
}

fn review_size(width: f64, height: f64) -> Result<LogicalSize<f64>, String> {
    if width < 100.0 || height < 100.0 {
        return Err("Website Review needs at least a 100×100 viewport".into());
    }
    Ok(LogicalSize::new(width, height))
}

fn move_review_webview(
    handle: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = handle
        .get_webview(WEBSITE_REVIEW_LABEL)
        .ok_or("Website Review is not open")?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(review_size(width, height)?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_website_review(
    handle: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let url: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    if !is_reviewable_url(&url) {
        return Err("Website Review only opens http(s) loopback URLs".into());
    }

    if let Some(webview) = handle.get_webview(WEBSITE_REVIEW_LABEL) {
        move_review_webview(&handle, x, y, width, height)?;
        webview.navigate(url).map_err(|e| e.to_string())?;
        let _ = webview.show();
        let _ = webview.set_focus();
        return Ok(());
    }

    let window = handle
        .get_window("main")
        .ok_or("main window is not available")?;
    let nav_handle = handle.clone();
    let new_window_handle = handle.clone();
    let title_handle = handle.clone();
    let builder = WebviewBuilder::new(WEBSITE_REVIEW_LABEL, WebviewUrl::External(url))
        .on_navigation(move |target| handle_review_navigation(&nav_handle, target))
        .on_new_window(move |target, _| {
            handle_review_navigation(&new_window_handle, &target);
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(payload) = title.strip_prefix(PICK_TITLE_PREFIX) {
                dispatch_website_pick(&title_handle, payload);
            }
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && is_reviewable_url(payload.url())
            {
                let _ = webview.eval(WEBSITE_PICKER_SCRIPT);
            }
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            review_size(width, height)?,
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn position_website_review(
    handle: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    move_review_webview(&handle, x, y, width, height)
}

#[tauri::command]
fn close_website_review(handle: AppHandle) -> Result<(), String> {
    if let Some(webview) = handle.get_webview(WEBSITE_REVIEW_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn focus_window(handle: &AppHandle, requested: Option<Url>) {
    if let Some(w) = handle.get_webview_window("main") {
        if let Some(url) = requested {
            let _ = w.navigate(desktop_url(url));
        }
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn website_review_allows_only_loopback_http_urls() {
        assert!(is_reviewable_url(&"http://127.0.0.1:5173".parse().unwrap()));
        assert!(is_reviewable_url(
            &"https://localhost:3000".parse().unwrap()
        ));
        assert!(!is_reviewable_url(&"https://example.com".parse().unwrap()));
        assert!(!is_reviewable_url(
            &"file:///tmp/index.html".parse().unwrap()
        ));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_website_review,
            position_website_review,
            close_website_review,
            report_website_pick
        ])
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
            let url: Url = desktop_url(url.parse()?);
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
