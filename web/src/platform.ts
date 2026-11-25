type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

/** True on macOS, iOS and iPadOS, where shortcuts use the ⌘ key and its glyphs. */
export function isApplePlatform(): boolean {
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Label for a Cmd/Ctrl shortcut. `keys` uses the Apple glyphs after the modifier
 * (`"K"`, `"⇧I"`); other platforms get them spelled out (`"Ctrl+Shift+I"`).
 */
export function modShortcut(keys: string): string {
  if (isApplePlatform()) {
    return `⌘${keys}`;
  }
  return `Ctrl+${keys.replace("⇧", "Shift+")}`;
}

/** `aria-keyshortcuts` value for a Cmd/Ctrl + `key` shortcut on this platform. */
export function modKeyShortcut(key: string): string {
  return `${isApplePlatform() ? "Meta" : "Control"}+${key}`;
}
