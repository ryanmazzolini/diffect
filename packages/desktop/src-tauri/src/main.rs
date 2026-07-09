#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Diffect desktop shell: spawn a private diffectd on an ephemeral loopback
//! port, wait for its `DIFFECTD_READY <url>` line, and point the webview at
//! that origin. The web UI uses relative URLs throughout, so it needs no
//! changes; review state stays in the shared per-user store, where the CLI,
//! agents, and any manually run daemon see it too.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, Url, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

/// The spawned diffectd. Emptied on shutdown, which also stands the crash
/// watcher down; the daemon's `--exit-on-stdin-close` pipe is the backstop
/// that reaps it even when this process dies without running cleanup.
struct Daemon(Arc<Mutex<Option<Child>>>);

struct WebsiteAllowedDomains(Arc<Mutex<Vec<String>>>);

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
        .and_then(|exe| {
            Some(
                exe.parent()?
                    .join(format!("diffectd{}", std::env::consts::EXE_SUFFIX)),
            )
        })
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
        return Ok(DaemonLaunch {
            program: sidecar,
            script: None,
            web_root,
        });
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
    Ok(DaemonLaunch {
        program: "node".into(),
        script: Some(daemon_js),
        web_root,
    })
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
        .args([
            "--port",
            "0",
            "--no-workspace",
            "--exit-on-stdin-close",
            "--web-root",
        ])
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
            rapid = if last_spawn.elapsed() > CRASH_WINDOW {
                1
            } else {
                rapid + 1
            };
            if rapid > MAX_RAPID_RESPAWNS {
                show_error(
                    &handle,
                    "diffectd keeps crashing; check the terminal output.",
                );
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
}

fn normalize_allowed_domains(domains: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for domain in domains {
        let domain = domain.trim().trim_start_matches('.').to_lowercase();
        if domain.is_empty() || out.contains(&domain) {
            continue;
        }
        out.push(domain);
    }
    out
}

fn is_allowed_domain_url(url: &Url, allowed_domains: &[String]) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_lowercase) else {
        return false;
    };
    allowed_domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn is_reviewable_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && is_loopback(url)
}

fn is_allowed_review_url(url: &Url, allowed_domains: &[String]) -> bool {
    is_reviewable_url(url) || is_allowed_domain_url(url, allowed_domains)
}

#[derive(serde::Serialize)]
struct BrowserBookmarkCandidate {
    url: String,
    title: String,
}

#[derive(serde::Serialize)]
struct BrowserBookmarkSource {
    browser: String,
    profile: String,
    bookmarks: Vec<BrowserBookmarkCandidate>,
}

struct ChromiumBrowser {
    name: &'static str,
    roots: &'static [&'static str],
}

const CHROMIUM_BROWSERS: &[ChromiumBrowser] = &[
    ChromiumBrowser {
        name: "Google Chrome",
        roots: &[
            "Library/Application Support/Google/Chrome",
            ".config/google-chrome",
            ".config/google-chrome-beta",
            ".config/google-chrome-unstable",
        ],
    },
    ChromiumBrowser {
        name: "Chrome Canary",
        roots: &["Library/Application Support/Google/Chrome Canary"],
    },
    ChromiumBrowser {
        name: "Chromium",
        roots: &["Library/Application Support/Chromium", ".config/chromium"],
    },
    ChromiumBrowser {
        name: "Brave",
        roots: &[
            "Library/Application Support/BraveSoftware/Brave-Browser",
            ".config/BraveSoftware/Brave-Browser",
        ],
    },
    ChromiumBrowser {
        name: "Microsoft Edge",
        roots: &[
            "Library/Application Support/Microsoft Edge",
            ".config/microsoft-edge",
        ],
    },
    ChromiumBrowser {
        name: "Vivaldi",
        roots: &["Library/Application Support/Vivaldi", ".config/vivaldi"],
    },
    ChromiumBrowser {
        name: "Arc",
        roots: &["Library/Application Support/Arc/User Data"],
    },
];

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn valid_bookmark_url(value: &str, allowed_domains: &[String]) -> Option<String> {
    let url = value.parse::<Url>().ok()?;
    is_allowed_review_url(&url, allowed_domains).then(|| value.to_string())
}

fn bookmark_title(value: Option<&str>, url: &str) -> String {
    value
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| url.to_string())
}

fn collect_chromium_bookmarks(
    value: &serde_json::Value,
    allowed_domains: &[String],
    out: &mut Vec<BrowserBookmarkCandidate>,
) {
    if let Some(url) = value
        .get("url")
        .and_then(|v| v.as_str())
        .and_then(|url| valid_bookmark_url(url, allowed_domains))
    {
        out.push(BrowserBookmarkCandidate {
            title: bookmark_title(value.get("name").and_then(|v| v.as_str()), &url),
            url,
        });
    }
    if let Some(children) = value.get("children").and_then(|v| v.as_array()) {
        for child in children {
            collect_chromium_bookmarks(child, allowed_domains, out);
        }
    }
    if let Some(roots) = value.get("roots").and_then(|v| v.as_object()) {
        for child in roots.values() {
            collect_chromium_bookmarks(child, allowed_domains, out);
        }
    }
}

fn chromium_profile_bookmark_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let direct = root.join("Bookmarks");
    if direct.is_file() {
        paths.push(direct);
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path().join("Bookmarks");
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    paths
}

fn profile_name(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("Default")
        .to_string()
}

fn import_chromium_bookmarks(
    home: &Path,
    allowed_domains: &[String],
    sources: &mut Vec<BrowserBookmarkSource>,
) {
    for browser in CHROMIUM_BROWSERS {
        for relative_root in browser.roots {
            let root = home.join(relative_root);
            if !root.is_dir() {
                continue;
            }
            for path in chromium_profile_bookmark_paths(&root) {
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let mut bookmarks = Vec::new();
                collect_chromium_bookmarks(&json, allowed_domains, &mut bookmarks);
                if bookmarks.is_empty() {
                    continue;
                }
                sources.push(BrowserBookmarkSource {
                    browser: browser.name.to_string(),
                    profile: profile_name(&path),
                    bookmarks,
                });
            }
        }
    }
}

fn import_firefox_profile(
    path: &Path,
    allowed_domains: &[String],
) -> Result<Vec<BrowserBookmarkCandidate>, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("diffect-firefox-places-{stamp}.sqlite"));
    fs::copy(path, &temp).map_err(|e| e.to_string())?;
    let result = (|| {
        let conn = rusqlite::Connection::open(&temp).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(b.title, ''), p.url
                 FROM moz_bookmarks b
                 JOIN moz_places p ON b.fk = p.id
                 WHERE b.type = 1 AND p.url IS NOT NULL
                 ORDER BY b.dateAdded DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let title: String = row.get(0)?;
                let url: String = row.get(1)?;
                Ok((title, url))
            })
            .map_err(|e| e.to_string())?;
        let mut bookmarks = Vec::new();
        for row in rows.flatten() {
            let (title, raw_url) = row;
            if let Some(url) = valid_bookmark_url(&raw_url, allowed_domains) {
                bookmarks.push(BrowserBookmarkCandidate {
                    title: bookmark_title(Some(&title), &url),
                    url,
                });
            }
        }
        Ok::<_, String>(bookmarks)
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn import_firefox_bookmarks(
    home: &Path,
    allowed_domains: &[String],
    sources: &mut Vec<BrowserBookmarkSource>,
) {
    for relative_root in [
        "Library/Application Support/Firefox/Profiles",
        ".mozilla/firefox",
    ] {
        let root = home.join(relative_root);
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path().join("places.sqlite");
            if !path.is_file() {
                continue;
            }
            let Ok(bookmarks) = import_firefox_profile(&path, allowed_domains) else {
                continue;
            };
            if bookmarks.is_empty() {
                continue;
            }
            sources.push(BrowserBookmarkSource {
                browser: "Firefox".to_string(),
                profile: profile_name(&path),
                bookmarks,
            });
        }
    }
}

#[tauri::command]
fn import_browser_bookmarks(
    allowed_domains: Vec<String>,
) -> Result<Vec<BrowserBookmarkSource>, String> {
    let Some(home) = home_dir() else {
        return Ok(Vec::new());
    };
    let allowed_domains = normalize_allowed_domains(allowed_domains);
    let mut sources = Vec::new();
    import_chromium_bookmarks(&home, &allowed_domains, &mut sources);
    import_firefox_bookmarks(&home, &allowed_domains, &mut sources);
    Ok(sources)
}

const WEBSITE_REVIEW_LABEL: &str = "website-review";
const PICK_SCHEME: &str = "diffect-pick";
const PICK_TITLE_PREFIX: &str = "__DIFFECT_PICK__";
const WEBSITE_PICKER_SCRIPT: &str = r#"
(() => {
  if (window.__diffectWebsitePicker) return;
  window.__diffectWebsitePicker = true;

  const UI = "__diffect-website-ui";
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
  const isChrome = (target) => target instanceof Element && Boolean(target.closest(`.${UI}`));

  const style = document.createElement("style");
  style.textContent = `
    .__diffect-picker-hover { outline: 2px solid #7c3aed !important; outline-offset: 2px !important; }
    :root[data-diffect-website-tool="area"] body { cursor: crosshair !important; }
    :root[data-diffect-website-tool="pick"] body { cursor: crosshair !important; }
    .${UI}, .${UI} * { box-sizing: border-box !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
    .__diffect-website-bubble { all: initial; position: fixed !important; z-index: 2147483647 !important; width: 360px !important; padding: 10px !important; border: 1px solid #34353b !important; border-radius: 10px !important; background: #16171b !important; color: #e7e8ea !important; box-shadow: 0 16px 48px rgba(0,0,0,.55) !important; }
    .__diffect-website-head { display: flex !important; align-items: center !important; justify-content: space-between !important; gap: 8px !important; margin-bottom: 8px !important; color: #e7e8ea !important; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
    .__diffect-website-close { border: 0 !important; background: transparent !important; color: #8c8e95 !important; cursor: pointer !important; font-size: 16px !important; line-height: 1 !important; }
    .__diffect-website-textarea { width: 100% !important; min-height: 92px !important; resize: vertical !important; border: 1px solid #34353b !important; border-radius: 8px !important; background: #0e0f12 !important; color: #e7e8ea !important; padding: 8px !important; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
    .__diffect-website-actions { display: flex !important; align-items: center !important; justify-content: flex-end !important; gap: 8px !important; margin-top: 8px !important; }
    .__diffect-website-button { border: 1px solid #34353b !important; border-radius: 6px !important; background: #25262c !important; color: #e7e8ea !important; cursor: pointer !important; padding: 5px 10px !important; font-size: 12px !important; }
    .__diffect-website-button.primary { background: #5e6ad2 !important; border-color: #5e6ad2 !important; color: white !important; }
    .__diffect-website-marker { all: initial; position: fixed !important; z-index: 2147483646 !important; display: grid !important; place-items: center !important; width: 26px !important; height: 26px !important; transform: translate(-50%, -50%) !important; border: 2px solid white !important; border-radius: 999px !important; background: #5e6ad2 !important; color: white !important; box-shadow: 0 8px 24px rgba(0,0,0,.5) !important; cursor: pointer !important; font: 800 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
    .__diffect-website-area-box { all: initial; position: fixed !important; z-index: 2147483645 !important; border: 2px solid #5e6ad2 !important; background: rgba(94,106,210,.18) !important; pointer-events: none !important; }
    .__diffect-website-saved { color: #e7e8ea !important; white-space: pre-wrap !important; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
  `;
  document.documentElement.appendChild(style);

  let tool = "browse";
  let hover = null;
  let bubble = null;
  let markerCount = 0;
  let drag = null;

  const clearHover = () => {
    if (hover) hover.classList.remove("__diffect-picker-hover");
    hover = null;
  };
  const closeBubble = () => {
    if (bubble) bubble.remove();
    bubble = null;
  };
  const clearDrag = () => {
    if (drag && drag.box) drag.box.remove();
    drag = null;
  };
  window.__diffectSetWebsiteTool = (next) => {
    tool = next === "area" || next === "pick" ? next : "browse";
    document.documentElement.dataset.diffectWebsiteTool = tool;
    clearHover();
    clearDrag();
    closeBubble();
  };
  window.__diffectSetWebsiteTool("browse");

  const boundsFor = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  };
  const payloadForElement = (element) => ({
    kind: "element",
    url: location.href,
    title: document.title,
    selector: selectorFor(element),
    text: cleanText(element.innerText || element.textContent),
    bounds: boundsFor(element),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    }
  });
  const payloadForArea = (bounds) => ({
    kind: "area",
    url: location.href,
    title: document.title,
    selector: "Area selection",
    text: "",
    bounds,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    }
  });
  const bubblePosition = (bounds) => {
    const width = 360;
    const height = 190;
    const right = bounds.x + bounds.width + 12;
    const left = right + width > window.innerWidth - 12 ? bounds.x - width - 12 : right;
    return {
      left: Math.min(Math.max(12, left), Math.max(12, window.innerWidth - width - 12)),
      top: Math.min(Math.max(12, bounds.y), Math.max(12, window.innerHeight - height - 12))
    };
  };
  const send = (payload) => {
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (invoke) {
      invoke("report_website_pick", { payload }).catch(() => {
        document.title = `__DIFFECT_PICK__${encodeURIComponent(JSON.stringify(payload))}`;
      });
    } else {
      document.title = `__DIFFECT_PICK__${encodeURIComponent(JSON.stringify(payload))}`;
    }
  };
  const withScreenshot = async (payload) => {
    if (payload.kind !== "area") return payload;
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (!invoke) return payload;
    try {
      const bytes = await invoke("capture_website_area", {
        x: payload.bounds.x,
        y: payload.bounds.y,
        width: payload.bounds.width,
        height: payload.bounds.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      });
      return { ...payload, screenshot: { name: "website-area.png", mime: "image/png", bytes } };
    } catch (error) {
      return { ...payload, screenshotError: String(error) };
    }
  };
  const showSavedBubble = (payload, body) => {
    closeBubble();
    const pos = bubblePosition(payload.bounds);
    bubble = document.createElement("div");
    bubble.className = `${UI} __diffect-website-bubble`;
    bubble.style.left = `${pos.left}px`;
    bubble.style.top = `${pos.top}px`;
    bubble.innerHTML = `
      <div class="__diffect-website-head"><span>Saved comment</span><button class="${UI} __diffect-website-close" type="button" aria-label="Close">×</button></div>
      <div class="__diffect-website-saved"></div>
    `;
    bubble.querySelector(".__diffect-website-saved").textContent = body;
    bubble.querySelector(".__diffect-website-close").addEventListener("click", closeBubble);
    document.documentElement.appendChild(bubble);
  };
  const addMarker = (payload, body) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `${UI} __diffect-website-marker`;
    marker.textContent = String(++markerCount);
    marker.style.left = `${payload.bounds.x + Math.min(payload.bounds.width, 16)}px`;
    marker.style.top = `${payload.bounds.y + Math.min(payload.bounds.height, 16)}px`;
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showSavedBubble(payload, body);
    });
    document.documentElement.appendChild(marker);
  };
  const openComposer = (payload) => {
    closeBubble();
    const pos = bubblePosition(payload.bounds);
    bubble = document.createElement("div");
    bubble.className = `${UI} __diffect-website-bubble`;
    bubble.style.left = `${pos.left}px`;
    bubble.style.top = `${pos.top}px`;
    bubble.innerHTML = `
      <div class="__diffect-website-head"><span>${payload.kind === "area" ? "Comment on area" : "Comment on selection"}</span><button class="${UI} __diffect-website-close" type="button" aria-label="Close">×</button></div>
      <textarea class="${UI} __diffect-website-textarea" placeholder="Leave feedback…"></textarea>
      <div class="__diffect-website-actions">
        <button class="${UI} __diffect-website-button" type="button" data-cancel>Cancel</button>
        <button class="${UI} __diffect-website-button primary" type="button" data-submit>Comment</button>
      </div>
    `;
    const textarea = bubble.querySelector("textarea");
    bubble.querySelector(".__diffect-website-close").addEventListener("click", closeBubble);
    bubble.querySelector("[data-cancel]").addEventListener("click", closeBubble);
    bubble.querySelector("[data-submit]").addEventListener("click", async () => {
      const body = textarea.value.trim();
      if (!body) return;
      const button = bubble.querySelector("[data-submit]");
      button.textContent = "Saving…";
      button.disabled = true;
      const comment = await withScreenshot({ ...payload, body });
      send(comment);
      addMarker(payload, body);
      closeBubble();
    });
    document.documentElement.appendChild(bubble);
    setTimeout(() => textarea.focus(), 0);
  };
  const updateDrag = (event) => {
    if (!drag) return;
    const x = Math.min(drag.startX, event.clientX);
    const y = Math.min(drag.startY, event.clientY);
    const width = Math.abs(event.clientX - drag.startX);
    const height = Math.abs(event.clientY - drag.startY);
    drag.bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    Object.assign(drag.box.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`
    });
  };
  const startArea = (event) => {
    closeBubble();
    clearHover();
    const box = document.createElement("div");
    box.className = `${UI} __diffect-website-area-box`;
    document.documentElement.appendChild(box);
    drag = { startX: event.clientX, startY: event.clientY, box, bounds: { x: event.clientX, y: event.clientY, width: 0, height: 0 } };
    updateDrag(event);
  };
  const finishArea = (event) => {
    if (!drag) return;
    updateDrag(event);
    const bounds = drag.bounds;
    clearDrag();
    if (bounds.width < 8 || bounds.height < 8) return;
    openComposer(payloadForArea(bounds));
  };

  document.addEventListener("pointerover", (event) => {
    if (tool !== "pick" || isChrome(event.target) || !(event.target instanceof Element)) return;
    if (hover) hover.classList.remove("__diffect-picker-hover");
    hover = event.target;
    hover.classList.add("__diffect-picker-hover");
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (tool === "browse" || isChrome(event.target)) return;
    if (!(event.target instanceof Element) || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (tool === "area") startArea(event);
    else openComposer(payloadForElement(event.target));
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    updateDrag(event);
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (!drag) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishArea(event);
  }, true);

  document.addEventListener("click", (event) => {
    if (tool === "browse" || isChrome(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
"#;

fn dispatch_website_pick_value(handle: &AppHandle, value: serde_json::Value) -> Result<(), String> {
    let Some(url) = value.get("url").and_then(|v| v.as_str()) else {
        return Err("website pick payload missing URL".into());
    };
    let url: Url = url
        .parse()
        .map_err(|e| format!("invalid picked URL: {e}"))?;
    let allowed_domains = handle
        .state::<WebsiteAllowedDomains>()
        .0
        .lock()
        .map(|domains| domains.clone())
        .unwrap_or_default();
    if !is_allowed_review_url(&url, &allowed_domains) {
        return Err("ignored pick outside loopback or allow-listed domains".into());
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
    let allowed_domains = handle
        .state::<WebsiteAllowedDomains>()
        .0
        .lock()
        .map(|domains| domains.clone())
        .unwrap_or_default();
    if is_allowed_review_url(target, &allowed_domains) {
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
    allowed_domains: Vec<String>,
) -> Result<(), String> {
    let url: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let allowed_domains = normalize_allowed_domains(allowed_domains);
    if !is_allowed_review_url(&url, &allowed_domains) {
        return Err("Website Review only opens loopback URLs or allow-listed domains".into());
    }
    if let Ok(mut domains) = handle.state::<WebsiteAllowedDomains>().0.lock() {
        *domains = allowed_domains;
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
    let load_handle = handle.clone();
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
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let allowed_domains = load_handle
                .state::<WebsiteAllowedDomains>()
                .0
                .lock()
                .map(|domains| domains.clone())
                .unwrap_or_default();
            if is_allowed_review_url(payload.url(), &allowed_domains) {
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
fn set_website_review_visible(handle: AppHandle, visible: bool) -> Result<(), String> {
    let webview = handle
        .get_webview(WEBSITE_REVIEW_LABEL)
        .ok_or("Website Review is not open")?;
    if visible {
        webview.show()
    } else {
        webview.hide()
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_website_review_tool(handle: AppHandle, tool: String) -> Result<(), String> {
    if !matches!(tool.as_str(), "browse" | "pick" | "area") {
        return Err("unknown Website Review tool".into());
    }
    let webview = handle
        .get_webview(WEBSITE_REVIEW_LABEL)
        .ok_or("Website Review is not open")?;
    let tool = serde_json::to_string(&tool).map_err(|e| e.to_string())?;
    webview
        .eval(format!("window.__diffectSetWebsiteTool?.({tool});"))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn capture_website_area(
    handle: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
) -> Result<Vec<u8>, String> {
    if width < 2.0 || height < 2.0 || viewport_width <= 0.0 || viewport_height <= 0.0 {
        return Err("capture area is too small".into());
    }
    let webview = handle
        .get_webview(WEBSITE_REVIEW_LABEL)
        .ok_or("Website Review is not open")?;
    let window = handle
        .get_window("main")
        .ok_or("main window is not available")?;
    let window_pos = window.outer_position().map_err(|e| e.to_string())?;
    let webview_pos = webview.position().map_err(|e| e.to_string())?;
    let webview_size = webview.size().map_err(|e| e.to_string())?;
    let scale_x = webview_size.width as f64 / viewport_width;
    let scale_y = webview_size.height as f64 / viewport_height;
    let sx = window_pos.x + webview_pos.x + (x * scale_x).round() as i32;
    let sy = window_pos.y + webview_pos.y + (y * scale_y).round() as i32;
    let sw = (width * scale_x).round().max(2.0) as i32;
    let sh = (height * scale_y).round().max(2.0) as i32;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("diffect-website-area-{stamp}.png"));
    let status = Command::new("screencapture")
        .args(["-x", "-R", &format!("{sx},{sy},{sw},{sh}")])
        .arg(&path)
        .status()
        .map_err(|e| format!("could not run screencapture: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(&path);
        return Err("screencapture failed".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&path);
    Ok(bytes)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn capture_website_area(
    _handle: AppHandle,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _viewport_width: f64,
    _viewport_height: f64,
) -> Result<Vec<u8>, String> {
    Err("area screenshot capture is only implemented on macOS in this tracer".into())
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
        let allowed = vec!["odeko.com".to_string()];
        assert!(!is_reviewable_url(&"https://example.com".parse().unwrap()));
        assert!(is_allowed_review_url(
            &"https://app.odeko.com".parse().unwrap(),
            &allowed
        ));
        assert!(!is_allowed_review_url(
            &"https://example.com".parse().unwrap(),
            &allowed
        ));
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
            set_website_review_visible,
            set_website_review_tool,
            capture_website_area,
            close_website_review,
            report_website_pick,
            import_browser_bookmarks
        ])
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch focuses the existing window instead of racing
            // a second daemon into the same store. If pi passed a loopback URL,
            // navigate the app there instead of opening a browser.
            focus_window(app, requested_loopback_url(&argv));
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(WebsiteAllowedDomains(Arc::new(Mutex::new(Vec::new()))))
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
