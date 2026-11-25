import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isApplePlatform, modShortcut } from "./platform";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPlatform(platform: string) {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
}

describe("platform shortcut labels", () => {
  it("uses the ⌘ glyphs on Apple platforms", () => {
    stubPlatform("MacIntel");
    expect(isApplePlatform()).toBe(true);
    expect(modShortcut("K")).toBe("⌘K");
    expect(modShortcut("⇧I")).toBe("⌘⇧I");
    expect(modShortcut("\\")).toBe("⌘\\");
  });

  it("spells out Ctrl and Shift elsewhere", () => {
    stubPlatform("Win32");
    expect(isApplePlatform()).toBe(false);
    expect(modShortcut("K")).toBe("Ctrl+K");
    expect(modShortcut("⇧I")).toBe("Ctrl+Shift+I");
    expect(modShortcut("\\")).toBe("Ctrl+\\");
  });

  it("treats iPhone and iPad as Apple platforms", () => {
    stubPlatform("iPhone");
    expect(isApplePlatform()).toBe(true);
    stubPlatform("iPad");
    expect(isApplePlatform()).toBe(true);
  });
});
