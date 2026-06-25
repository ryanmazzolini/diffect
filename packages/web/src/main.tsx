import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { getStoredTheme, setTheme } from "./theme.js";
import { getStoredDensity, setDensity } from "./density.js";
import "@git-diff-view/react/styles/diff-view.css";
import "./styles.css";

// Apply shell, theme, and density before first paint to avoid layout/colour flash.
if (new URLSearchParams(window.location.search).get("shell") === "desktop") {
  document.documentElement.dataset.shell = "desktop";
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
