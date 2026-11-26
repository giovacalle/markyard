import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SYNCED_SETTINGS_KEYS,
  applyLayout,
  getSettings,
  pickSyncedSettings,
  resetSettings,
  subscribeSettings,
  updateSettings,
  validateFolderSetting,
} from "./settings";
import { useTheme } from "./theme";

describe("settings store", () => {
  it("starts from the defaults", () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      attachmentsFolder: "_attachments",
      showAttachmentsFolder: true,
      dailyNotesFolder: "",
      templatesFolder: "Templates",
      stylesFolder: "_styles",
      customCss: true,
      layout: "default",
      defaultMode: "preview",
      linkPreviewsEnabled: true,
    });
  });

  it("persists updates in localStorage and reloads them", () => {
    updateSettings({ dailyNotesFolder: "Daily", defaultMode: "edit" });
    expect(getSettings()).toMatchObject({ dailyNotesFolder: "Daily", defaultMode: "edit" });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toMatchObject({
      dailyNotesFolder: "Daily",
      defaultMode: "edit",
    });

    // A fresh read (as after a reload) comes from storage.
    resetSettings({ keepStorage: true });
    expect(getSettings()).toMatchObject({ dailyNotesFolder: "Daily", defaultMode: "edit" });
  });

  it("ignores corrupt or invalid stored values", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        attachmentsFolder: "a/b",
        showAttachmentsFolder: "yes",
        defaultMode: "nope",
        linkPreviewsEnabled: 1,
      }),
    );
    resetSettings({ keepStorage: true });
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);

    localStorage.setItem(SETTINGS_STORAGE_KEY, "{not json");
    resetSettings({ keepStorage: true });
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("resetSettings drops storage and returns to the defaults", () => {
    updateSettings({ templatesFolder: "Snippets" });
    resetSettings();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("notifies listeners, flagging silent updates, and skips no-op updates", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSettings(listener);
    updateSettings({ linkPreviewsEnabled: false });
    updateSettings({ linkPreviewsEnabled: false });
    updateSettings({ defaultMode: "edit" }, { silent: true });
    unsubscribe();
    updateSettings({ defaultMode: "preview" });
    expect(listener.mock.calls).toEqual([[{ silent: false }], [{ silent: true }]]);
  });

  it("trims folder names on update", () => {
    updateSettings({ attachmentsFolder: "  Media  ", stylesFolder: "  theme  " });
    expect(getSettings().attachmentsFolder).toBe("Media");
    expect(getSettings().stylesFolder).toBe("theme");
  });

  it("persists and sanitizes stylesFolder and customCss across reloads", () => {
    updateSettings({ stylesFolder: "CustomTheme", customCss: false });
    expect(getSettings()).toMatchObject({ stylesFolder: "CustomTheme", customCss: false });

    resetSettings({ keepStorage: true });
    expect(getSettings()).toMatchObject({ stylesFolder: "CustomTheme", customCss: false });

    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ stylesFolder: "a/b", customCss: "nope" }),
    );
    resetSettings({ keepStorage: true });
    expect(getSettings()).toMatchObject({ stylesFolder: "_styles", customCss: true });
  });

  it("persists, sanitizes and applies layout on documentElement and theme-color", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#ffffff";
    document.head.appendChild(meta);
    try {
      updateSettings({ layout: "borderless" });
      expect(getSettings().layout).toBe("borderless");
      expect(document.documentElement.dataset.layout).toBe("borderless");
      expect(meta.content).toBe("#f5f5f5");

      document.documentElement.classList.add("dark");
      applyLayout("borderless");
      expect(meta.content).toBe("#171717");

      resetSettings({ keepStorage: true });
      expect(getSettings().layout).toBe("borderless");

      updateSettings({ layout: "default" });
      expect(document.documentElement.dataset.layout).toBeUndefined();
      expect(meta.content).toBe("#0a0a0a");

      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ layout: "floating" }));
      resetSettings({ keepStorage: true });
      expect(getSettings().layout).toBe("default");

      updateSettings({ layout: "borderless" });
      resetSettings();
      expect(document.documentElement.dataset.layout).toBeUndefined();
    } finally {
      meta.remove();
    }
  });

  it("keeps full-bleed theme-color on narrow viewports even when borderless is active", () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    let narrow = true;
    const narrowListeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 47.99rem)" ? narrow : false,
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: () => void) => {
          if (query === "(max-width: 47.99rem)") {
            narrowListeners.add(listener);
          }
        },
        removeEventListener: (_event: string, listener: () => void) => {
          if (query === "(max-width: 47.99rem)") {
            narrowListeners.delete(listener);
          }
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#ffffff";
    document.head.appendChild(meta);

    try {
      const { unmount } = renderHook(() => useTheme());
      updateSettings({ layout: "borderless" });
      expect(document.documentElement.dataset.layout).toBe("borderless");
      expect(meta.content).toBe("#ffffff");

      document.documentElement.classList.add("dark");
      applyLayout("borderless");
      expect(meta.content).toBe("#0a0a0a");

      // Crossing to a desktop viewport switches theme-color to the borderless canvas.
      narrow = false;
      for (const listener of narrowListeners) {
        listener();
      }
      expect(meta.content).toBe("#171717");

      document.documentElement.classList.remove("dark");
      applyLayout("borderless");
      expect(meta.content).toBe("#f5f5f5");

      // Crossing back to a narrow viewport restores the full-bleed light color.
      narrow = true;
      for (const listener of narrowListeners) {
        listener();
      }
      expect(meta.content).toBe("#ffffff");

      unmount();
    } finally {
      meta.remove();
      if (originalMatchMedia) {
        Object.defineProperty(window, "matchMedia", originalMatchMedia);
      }
    }
  });

  it("picks only the cloud-synced settings keys", () => {
    expect(SYNCED_SETTINGS_KEYS).toEqual([
      "attachmentsFolder",
      "showAttachmentsFolder",
      "dailyNotesFolder",
      "templatesFolder",
      "stylesFolder",
      "customCss",
      "layout",
      "defaultMode",
      "linkPreviewsEnabled",
    ]);
    const full = pickSyncedSettings(DEFAULT_SETTINGS);
    expect(full).toEqual({
      attachmentsFolder: "_attachments",
      showAttachmentsFolder: true,
      dailyNotesFolder: "",
      templatesFolder: "Templates",
      stylesFolder: "_styles",
      customCss: true,
      layout: "default",
      defaultMode: "preview",
      linkPreviewsEnabled: true,
    });

    const partial = pickSyncedSettings({
      stylesFolder: "theme",
      customCss: false,
      templatesFolder: "Tpl",
    });
    expect(partial).toEqual({ stylesFolder: "theme", customCss: false, templatesFolder: "Tpl" });
  });
});

describe("validateFolderSetting", () => {
  it("accepts ordinary folder names", () => {
    expect(validateFolderSetting("_attachments")).toBeNull();
    expect(validateFolderSetting("Daily notes")).toBeNull();
    expect(validateFolderSetting("Café ☕")).toBeNull();
  });

  it("rejects slashes, dot names and empties", () => {
    expect(validateFolderSetting("a/b")).toMatch(/\//);
    expect(validateFolderSetting("..")).not.toBeNull();
    expect(validateFolderSetting(".")).not.toBeNull();
    expect(validateFolderSetting("")).not.toBeNull();
    expect(validateFolderSetting("   ")).not.toBeNull();
  });

  it("allows an empty name only when asked", () => {
    expect(validateFolderSetting("", { allowEmpty: true })).toBeNull();
    expect(validateFolderSetting("  ", { allowEmpty: true })).toBeNull();
  });

  it("rejects names longer than 255 UTF-8 bytes", () => {
    expect(validateFolderSetting("a".repeat(255))).toBeNull();
    expect(validateFolderSetting("a".repeat(256))).not.toBeNull();
    // "é" is 2 bytes in UTF-8.
    expect(validateFolderSetting("é".repeat(128))).not.toBeNull();
  });
});
