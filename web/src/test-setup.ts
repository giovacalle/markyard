import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vite-plus/test";
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

// @ui-sdk/core picks a popup presentation ("auto": popover or sheet) via matchMedia, which jsdom
// lacks. Tests see a wide screen unless they stub it.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom ships `[popover] { display: none }` without implementing `showPopover()`, which
// hides open @ui-sdk popups/dialogs from Testing Library's accessibility queries.
if (!("showPopover" in HTMLElement.prototype)) {
  const style = document.createElement("style");
  style.textContent = "[popover]:not([hidden]) { display: block; }";
  document.head.appendChild(style);
}

// @ui-sdk/core appends persistent live-region elements (`data-ui-sdk-announcer`) to document.body.
// Hiding them via CSS + defaultIgnore keeps them in the DOM for explicit assertions without
// colliding with unscoped `*ByRole("status"|"alert")` and `*ByText(...)` queries.
{
  const style = document.createElement("style");
  style.textContent = "[data-ui-sdk-announcer] { display: none; }";
  document.head.appendChild(style);
}
configure({ defaultIgnore: "script, style, [data-ui-sdk-announcer]" });

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

// @ui-sdk/core menus call scrollIntoView() unguarded on the highlighted item; jsdom lacks it.
// Installed before each test because some suites delete their own stub when they finish.
beforeEach(() => {
  if (!("scrollIntoView" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  resetViewPrefs();
  resetSettings();
  document.documentElement.classList.remove("dark");
  await clearLocalCache();
});
