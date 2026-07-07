import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { getStoredTheme, setTheme } from "./theme.js";
import { getStoredDensity, setDensity } from "./density.js";
import "./styles.css";

// Apply shell, platform, theme, and density before first paint to avoid layout/colour flash.
const params = new URLSearchParams(window.location.search);
if (params.get("shell") === "desktop") {
  document.documentElement.dataset.shell = "desktop";
}
const platform = params.get("platform");
if (platform === "macos" || platform === "linux" || platform === "windows") {
  document.documentElement.dataset.platform = platform;
}
setTheme(getStoredTheme());
setDensity(getStoredDensity());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
