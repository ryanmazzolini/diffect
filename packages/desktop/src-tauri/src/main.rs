#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Diffect desktop shell: spawn a private diffectd on an ephemeral loopback
//! port, wait for its `DIFFECTD_READY <url>` line, and point the webview at
//! that origin. The web UI uses relative URLs throughout, so it needs no
//! changes; review state stays in the shared per-user store, where the CLI,
//! agents, and any manually run daemon see it too.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The spawned diffectd, killed on app exit.
struct Daemon(Mutex<Option<Child>>);

const READY_PREFIX: &str = "DIFFECTD_READY ";
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Dev layout: this crate lives at packages/desktop/src-tauri, so the built
/// daemon and web assets sit under the monorepo root three levels up. A
/// packaged build replaces this with a bundled sidecar + resource dir.
fn monorepo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|e| format!("could not resolve monorepo root: {e}"))
}

fn spawn_daemon() -> Result<(Child, String), String> {
    let root = monorepo_root()?;
    let daemon_js = root.join("packages/core/dist/daemon-bin.js");
    let web_root = root.join("packages/web/dist");
    for missing in [&daemon_js, &web_root].into_iter().filter(|p| !p.exists()) {
        return Err(format!(
            "not built: {} (run `mise run build` first)",
            missing.display()
        ));
    }

    // --no-workspace: the app serves registered workspaces only; it must not
    // register its own cwd as something to review.
    let mut child = Command::new("node")
        .arg(&daemon_js)
        .args(["--port", "0", "--no-workspace", "--web-root"])
        .arg(&web_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not spawn `node`: {e}"))?;

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

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // Escape hatch for UI development: point the window at an
            // existing origin (Vite dev server or a manual daemon) instead
            // of spawning one.
            let url = match std::env::var("DIFFECT_DESKTOP_URL") {
                Ok(u) if !u.is_empty() => u,
                _ => {
                    let (child, url) = spawn_daemon()?;
                    app.manage(Daemon(Mutex::new(Some(child))));
                    url
                }
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Diffect")
                .inner_size(1280.0, 860.0)
                .build()?;
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
