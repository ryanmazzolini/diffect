fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_website_review",
            "position_website_review",
            "set_website_review_visible",
            "set_website_review_tool",
            "capture_website_area",
            "close_website_review",
            "report_website_pick",
            "import_browser_bookmarks",
        ]),
    ))
    .expect("failed to run tauri-build");
}
