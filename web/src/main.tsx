import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootCustomCss } from "./customCss";
import "./index.css";
import { applyTheme, getStoredTheme } from "./theme";

applyTheme(getStoredTheme());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

void bootCustomCss().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      // Service worker registration is best-effort.
    });
  });
}
