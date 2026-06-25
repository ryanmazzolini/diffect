fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "open_website_review",
                "position_website_review",
                "close_website_review",
                "report_website_pick",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
