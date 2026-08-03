#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Diffect desktop shell: reuse or spawn the clean Review daemon on its
//! canonical loopback origin and point one Tauri window at that origin.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};
use tauri_plugin_opener::OpenerExt;

struct Daemon(Arc<Mutex<Option<Child>>>);

const BASE_URL: &str = "http://127.0.0.1:7421";
const READY_PREFIX: &str = "DIFFECTD_READY ";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const MAX_RAPID_RESPAWNS: u32 = 3;

#[derive(Clone)]
struct DaemonLaunch {
    program: PathBuf,
    script: Option<PathBuf>,
    web_root: PathBuf,
}

fn monorepo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|error| format!("could not resolve monorepo root: {error}"))
}

fn resolve_daemon(handle: &AppHandle) -> Result<DaemonLaunch, String> {
    let sidecar = std::env::current_exe()
        .ok()
        .and_then(|executable| {
            Some(
                executable
                    .parent()?
                    .join(format!("diffectd{}", std::env::consts::EXE_SUFFIX)),
            )
        })
        .filter(|path| path.exists());
    if let Some(sidecar) = sidecar {
        let resources = handle
            .path()
            .resource_dir()
            .map_err(|error| format!("no resource dir: {error}"))?;
        let web_root = [resources.join("web"), resources.join("web/dist")]
            .into_iter()
            .find(|path| path.join("index.html").exists())
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
    for missing in [&daemon_js, &web_root]
        .into_iter()
        .filter(|path| !path.exists())
    {
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
    let mut command = Command::new(&launch.program);
    if let Some(script) = &launch.script {
        command.arg(script);
    }
    let mut child = command
        .args([
            "--port",
            "7421",
            "--no-workspace",
            "--exit-on-stdin-close",
            "--web-root",
        ])
        .arg(&launch.web_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not spawn {}: {error}", launch.program.display()))?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut sender = Some(sender);
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(url) = line.strip_prefix(READY_PREFIX) {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(url.trim().to_string());
                    continue;
                }
            }
            println!("{line}");
        }
    });

    match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(url) => Ok((child, url)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "diffectd did not become ready on 127.0.0.1:7421: {error}"
            ))
        }
    }
}

fn review_daemon_running() -> bool {
    let address: SocketAddr = "127.0.0.1:7421".parse().expect("static socket address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:7421\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"model\":\"review\"")
}

fn canonical_port_in_use() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:7421".parse().expect("static socket address"),
        Duration::from_millis(150),
    )
    .is_ok()
}

fn show_error(handle: &AppHandle, message: &str) {
    eprintln!("diffect-desktop: {message}");
    if let Some(window) = handle.get_webview_window("main") {
        let html = format!(
            "<body style=\"font-family:system-ui;background:#1e293b;color:#e2e8f0;\
             display:grid;place-items:center;height:100vh;margin:0\">\
             <div style=\"max-width:32rem\"><h1>Diffect hit a problem</h1>\
             <p>{message}</p><p>Quit and relaunch to try again.</p></div></body>"
        );
        let _ = window.eval(&format!(
            "document.open(); document.write({}); document.close();",
            serde_json::to_string(&html).unwrap_or_default()
        ));
    }
}

fn watch_daemon(handle: AppHandle, launch: DaemonLaunch, daemon: Arc<Mutex<Option<Child>>>) {
    thread::spawn(move || {
        let mut rapid = 0_u32;
        let mut last_spawn = Instant::now();
        loop {
            thread::sleep(Duration::from_secs(1));
            {
                let mut guard = daemon.lock().unwrap();
                let Some(child) = guard.as_mut() else { return };
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
            last_spawn = Instant::now();
            match spawn_daemon(&launch) {
                Ok((child, url)) => {
                    *daemon.lock().unwrap() = Some(child);
                    if let Some(window) = handle.get_webview_window("main") {
                        let target = window
                            .url()
                            .ok()
                            .map(|current| canonical_review_url(&current))
                            .unwrap_or_else(|| {
                                let ready = url.parse().expect("ready line carries a valid URL");
                                desktop_url(ready)
                            });
                        let _ = window.navigate(target);
                    }
                }
                Err(error) => {
                    show_error(&handle, &format!("could not restart diffectd: {error}"));
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
        Some(url::Host::Domain(domain)) => domain == "localhost",
        None => false,
    }
}

fn requested_loopback_url(args: &[String]) -> Option<Url> {
    args.iter()
        .skip(1)
        .filter_map(|argument| argument.parse::<Url>().ok())
        .find(is_loopback)
}

fn canonical_review_url(requested: &Url) -> Url {
    let mut canonical: Url = BASE_URL.parse().expect("canonical Review URL");
    canonical.set_path(requested.path());
    canonical.set_query(requested.query());
    canonical.set_fragment(requested.fragment());
    canonical
}

fn desktop_url(mut url: Url) -> Url {
    url.query_pairs_mut()
        .append_pair("shell", "desktop")
        .append_pair("platform", std::env::consts::OS);
    url
}

fn focus_window(handle: &AppHandle, requested: Option<Url>) {
    if let Some(window) = handle.get_webview_window("main") {
        if let Some(url) = requested {
            let _ = window.navigate(desktop_url(canonical_review_url(&url)));
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_window(app, requested_loopback_url(&argv));
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let argv: Vec<String> = std::env::args().collect();
            let requested = requested_loopback_url(&argv);
            let development_url = requested
                .is_none()
                .then(|| {
                    std::env::var("DIFFECT_DESKTOP_URL")
                        .ok()
                        .filter(|url| !url.is_empty())
                })
                .flatten();
            let url: Url = if let Some(development_url) = development_url {
                development_url.parse()?
            } else {
                let base = if review_daemon_running() {
                    BASE_URL.to_string()
                } else if canonical_port_in_use() {
                    return Err("127.0.0.1:7421 is occupied by another process".into());
                } else {
                    let launch = resolve_daemon(app.handle())?;
                    let (child, url) = spawn_daemon(&launch)?;
                    let daemon = Arc::new(Mutex::new(Some(child)));
                    app.manage(Daemon(daemon.clone()));
                    watch_daemon(app.handle().clone(), launch, daemon);
                    url
                };
                match requested {
                    Some(requested) => canonical_review_url(&requested),
                    None => base.parse()?,
                }
            };
            let url = desktop_url(url);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_links_keep_the_route_but_use_the_canonical_origin() {
        let requested: Url =
            "http://127.0.0.1:59999/reviews/rvw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?from=pi"
                .parse()
                .unwrap();
        assert_eq!(
            canonical_review_url(&requested).as_str(),
            "http://127.0.0.1:7421/reviews/rvw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?from=pi"
        );
    }
}
