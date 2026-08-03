import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
if (params.get("shell") === "desktop") {
  document.documentElement.dataset.shell = "desktop";
}
const platform = params.get("platform");
if (platform === "macos" || platform === "linux" || platform === "windows") {
  document.documentElement.dataset.platform = platform;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
