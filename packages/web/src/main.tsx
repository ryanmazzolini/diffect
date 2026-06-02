import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { getStoredTheme, setTheme } from "./theme.js";
import "./styles.css";

// Apply the stored theme before first paint to avoid a flash of the wrong theme.
setTheme(getStoredTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
