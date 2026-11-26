import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { renderAfterCustomCss } from "./customCss";
import "./index.css";
import { applyLayout, getSettings } from "./settings";
import { applyTheme, getStoredTheme } from "./theme";

applyLayout(getSettings().layout);
applyTheme(getStoredTheme());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

renderAfterCustomCss(() => {
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
