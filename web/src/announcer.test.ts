import { screen } from "@testing-library/react";
import { announce } from "@ui-sdk/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("ui-sdk live announcer test setup", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const el of document.querySelectorAll("[data-ui-sdk-announcer]")) {
      el.remove();
    }
  });

  it("hides the announcer region from unscoped role and text queries while keeping it in the DOM", () => {
    vi.useFakeTimers();
    announce("hello");
    vi.advanceTimersByTime(100);

    const region = document.querySelector('[data-ui-sdk-announcer=""]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("hello");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("hello")).toBeNull();
  });
});
