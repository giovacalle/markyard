import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "markyard-theme";
const LIGHT_THEME_COLOR = "#ffffff";
const DARK_THEME_COLOR = "#0a0a0a";
const BORDERLESS_LIGHT_THEME_COLOR = "#f5f5f5";
const BORDERLESS_DARK_THEME_COLOR = "#171717";
const NARROW_QUERY = "(max-width: 47.99rem)";

function isNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_QUERY).matches
  );
}

const listeners = new Set<() => void>();

/** Called after every stored preference change (cloud state sync watches it). */
export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function getStoredTheme(): ThemePreference {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function setStoredTheme(preference: ThemePreference): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage may be blocked in restricted browsing contexts.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

/** Keeps `meta[name="theme-color"]` aligned with the active dark class, layout, and viewport. */
export function syncThemeColor(): void {
  if (typeof document === "undefined") {
    return;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    return;
  }
  const dark = document.documentElement.classList.contains("dark");
  const borderless =
    document.documentElement.dataset.layout === "borderless" && !isNarrowViewport();
  meta.content = borderless
    ? dark
      ? BORDERLESS_DARK_THEME_COLOR
      : BORDERLESS_LIGHT_THEME_COLOR
    : dark
      ? DARK_THEME_COLOR
      : LIGHT_THEME_COLOR;
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    syncThemeColor();
  }
  return resolved;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => applyTheme(getStoredTheme()));

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredTheme(next);
    setPreferenceState(next);
    setResolved(applyTheme(next));
  }, []);

  useEffect(() => {
    setResolved(applyTheme(preference));
    if (preference !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [preference]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(NARROW_QUERY);
    media.addEventListener?.("change", syncThemeColor);
    return () => media.removeEventListener?.("change", syncThemeColor);
  }, []);

  return { preference, resolved, setPreference };
}
