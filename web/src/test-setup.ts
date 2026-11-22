import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vite-plus/test";
import { clearLocalCache } from "./localCache";
import { resetSettings } from "./settings";
import { resetViewPrefs } from "./viewPrefs";

// @ui-sdk/core calls getAnimations() unguarded when expanding/collapsing panels.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    writable: true,
    value: () => [],
  });
}

// jsdom ships `[popover] { display: none }` without implementing `showPopover()`, which
// hides open @ui-sdk popups/dialogs from Testing Library's accessibility queries.
if (!("showPopover" in HTMLElement.prototype)) {
  const style = document.createElement("style");
  style.textContent = "[popover]:not([hidden]) { display: block; }";
  document.head.appendChild(style);
}

// CodeMirror 6 measures text via Range layout APIs that jsdom does not implement.
if (!("getClientRects" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }),
  });
}
if (!("getBoundingClientRect" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }),
  });
}

// CodeMirror 6 falls back to document.execCommand when reading shadow-root selection without
// ShadowRoot.prototype.getSelection, which jsdom does not implement.
if (!("execCommand" in Document.prototype)) {
  Object.defineProperty(Document.prototype, "execCommand", {
    configurable: true,
    writable: true,
    value: () => false,
  });
}

afterEach(async () => {
  cleanup();
  localStorage.clear();
  resetViewPrefs();
  resetSettings();
  document.documentElement.classList.remove("dark");
  await clearLocalCache();
});
