import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  getViewPrefs,
  resetViewPrefs,
  setViewPref,
  toggleViewPref,
  useViewPrefs,
  VIEW_PREFS_STORAGE_KEY,
} from "./viewPrefs";

describe("view preferences", () => {
  it("defaults every mode to off", () => {
    expect(getViewPrefs()).toEqual({
      readOnly: false,
      focusMode: false,
      typewriterMode: false,
      infoDrawerOpen: false,
    });
  });

  it("persists read-only, focus and typewriter modes in localStorage but not the drawer", () => {
    toggleViewPref("readOnly");
    setViewPref("typewriterMode", true);
    toggleViewPref("infoDrawerOpen");
    expect(JSON.parse(localStorage.getItem(VIEW_PREFS_STORAGE_KEY) ?? "null")).toEqual({
      readOnly: true,
      focusMode: false,
      typewriterMode: true,
    });

    resetViewPrefs();
    expect(getViewPrefs()).toEqual({
      readOnly: true,
      focusMode: false,
      typewriterMode: true,
      infoDrawerOpen: false,
    });
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(VIEW_PREFS_STORAGE_KEY, "{not json");
    resetViewPrefs();
    expect(getViewPrefs().readOnly).toBe(false);
  });

  it("re-renders subscribers when a preference changes", () => {
    const { result } = renderHook(() => useViewPrefs());
    expect(result.current.focusMode).toBe(false);
    act(() => toggleViewPref("focusMode"));
    expect(result.current.focusMode).toBe(true);
  });
});
