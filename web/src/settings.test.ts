import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  getSettings,
  resetSettings,
  subscribeSettings,
  updateSettings,
  validateFolderSetting,
} from "./settings";

describe("settings store", () => {
  it("starts from the defaults", () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      attachmentsFolder: "_attachments",
      dailyNotesFolder: "",
      templatesFolder: "Templates",
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
      JSON.stringify({ attachmentsFolder: "a/b", defaultMode: "nope", linkPreviewsEnabled: 1 }),
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
    updateSettings({ attachmentsFolder: "  Media  " });
    expect(getSettings().attachmentsFolder).toBe("Media");
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
