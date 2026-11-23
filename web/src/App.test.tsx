import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { App } from "./App";
import { DEFAULT_SETTINGS, getSettings, SETTINGS_STORAGE_KEY, updateSettings } from "./settings";
import { writeExpandedFolders } from "./treeExpanded";

const server = setupServer(
  http.get("/api/root", () =>
    HttpResponse.json({
      id: "root-id",
      name: "Notes",
      kind: "folder",
      modifiedTime: "2026-11-01T10:00:00.000Z",
    }),
  ),
  http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  focusManager.setFocused(undefined);
});

afterAll(() => {
  server.close();
});

const ENDED_MESSAGE = "Your session has ended. Sign in again.";

function signedOut() {
  return HttpResponse.json({ code: "unauthenticated", message: "Not signed in" }, { status: 401 });
}

function sessionEnded() {
  return HttpResponse.json(
    { code: "unauthenticated", message: ENDED_MESSAGE, reason: "session_ended" },
    { status: 401 },
  );
}

function signedIn(email = "owner@example.com", extra: { name?: string } = {}) {
  return HttpResponse.json({ email, ...extra });
}

function serverError() {
  return HttpResponse.json({ code: "upstream_error", message: "Try again." }, { status: 502 });
}

function refocus() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

describe("App", () => {
  it("cold start with an ended session shows the sign-in screen with a message", async () => {
    server.use(http.get("/api/session", sessionEnded));
    render(<App />);

    const link = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(link).toHaveAttribute("href", "/api/auth/login");
    expect(screen.getByRole("alert")).toHaveTextContent(ENDED_MESSAGE);
  });

  it("while the session loads it shows a status message", async () => {
    server.use(http.get("/api/session", () => new Promise<never>(() => {})));
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });

  it("signed out shows the sign-in screen with a Google link", async () => {
    server.use(http.get("/api/session", signedOut));
    render(<App />);

    const link = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(link).toHaveAttribute("href", "/api/auth/login");
    expect(screen.queryByText(ENDED_MESSAGE)).not.toBeInTheDocument();
    expect(
      screen.getByText("Independent open-source project. Not affiliated with Google LLC."),
    ).toBeInTheDocument();
  });

  it("signed in shows the email and opens the account popover with theme and sign-out controls", async () => {
    server.use(http.get("/api/session", () => signedIn("owner@example.com")));
    render(<App />);

    const trigger = await screen.findByRole("button", {
      name: /Account: owner@example\.com/,
    });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows the display name above a smaller email and the cloud sync badge", async () => {
    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ email: "owner@example.com", name: "Alex Rivera", cloudSync: true }),
      ),
      http.get("/api/state", () =>
        HttpResponse.json({ enabled: true, state: null, updatedAt: null }),
      ),
      http.put("/api/state", () => HttpResponse.json({ enabled: true, state: {}, updatedAt: 1 })),
    );
    render(<App />);

    const trigger = await screen.findByRole("button", {
      name: "Account: Alex Rivera (owner@example.com)",
    });
    expect(within(trigger).getByText("Alex Rivera")).toBeInTheDocument();
    expect(within(trigger).getByText("owner@example.com")).toHaveClass("text-[11px]");
    expect(within(trigger).getByText("A")).toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(within(dialog).getByText("owner@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("Cloud sync active")).toBeInTheDocument();
  });

  it("without a display name shows the email alone and no cloud sync badge", async () => {
    server.use(http.get("/api/session", () => signedIn("owner@example.com", { name: "  " })));
    render(<App />);

    const trigger = await screen.findByRole("button", { name: "Account: owner@example.com" });
    expect(within(trigger).getByText("owner@example.com")).toHaveClass("text-xs");
    expect(within(trigger).getByText("O")).toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("owner@example.com")).toBeInTheDocument();
    expect(within(dialog).queryByText("Cloud sync active")).not.toBeInTheDocument();
  });

  it("switches between dark, light, and system themes from the account popover and persists", async () => {
    server.use(http.get("/api/session", () => signedIn()));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Account: owner@example\.com/ }));
    const darkOption = await screen.findByRole("radio", { name: "Dark" });
    fireEvent.click(darkOption);

    expect(darkOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("markyard-theme")).toBe("dark");

    const lightOption = screen.getByRole("radio", { name: "Light" });
    fireEvent.click(lightOption);

    expect(lightOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("markyard-theme")).toBe("light");
  });

  it("shows the root folder name in the sidebar header and collapses/reopens the sidebar", async () => {
    server.use(http.get("/api/session", () => signedIn()));
    render(<App />);

    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    expect(await screen.findByRole("heading", { level: 1, name: "Notes" })).toBeInTheDocument();
    expect(screen.queryByText("Markyard")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(sidebar).not.toHaveAttribute("hidden");
  });

  it("sign out posts to /api/auth/logout, clears expanded folders and settings, and returns to sign-in", async () => {
    let active = true;
    let logoutCalls = 0;
    server.use(
      http.get("/api/session", () => (active ? signedIn() : signedOut())),
      http.post("/api/auth/logout", () => {
        logoutCalls += 1;
        active = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    writeExpandedFolders("root-id", ["folder-1", "folder-2"]);
    writeExpandedFolders("other-root", ["folder-3"]);
    updateSettings({ dailyNotesFolder: "Journal", attachmentsFolder: "Media" });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Account: owner@example\.com/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(logoutCalls).toBe(1);
    expect(screen.queryByText(ENDED_MESSAGE)).not.toBeInTheDocument();
    expect(localStorage.getItem("markyard:tree-expanded:root-id")).toBeNull();
    expect(localStorage.getItem("markyard:tree-expanded:other-root")).toBeNull();
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("a failed sign out keeps the signed-in view and says so", async () => {
    server.use(
      http.get("/api/session", () => signedIn()),
      http.post("/api/auth/logout", () =>
        HttpResponse.json({ code: "forbidden", message: "No." }, { status: 403 }),
      ),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Account: owner@example\.com/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to sign out. Try again.");
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it("offers a Clear local data fallback when sign out fails offline", async () => {
    let online = true;
    server.use(
      http.get("/api/session", () => (online ? signedIn() : HttpResponse.error())),
      http.post("/api/auth/logout", () => HttpResponse.error()),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Account: owner@example\.com/ }));
    online = false;
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to sign out while offline.");
    fireEvent.click(within(alert).getByRole("button", { name: "Clear local data" }));

    expect(await screen.findByText("Unable to reach the server.")).toBeInTheDocument();
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
  });

  it("a 401 after being signed in returns to the sign-in screen with a message", async () => {
    server.use(http.get("/api/session", () => signedIn()));
    render(<App />);
    await screen.findByText("owner@example.com");

    server.use(http.get("/api/session", signedOut));
    refocus();

    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(ENDED_MESSAGE);
  });

  it("a failed background refetch keeps the signed-in view", async () => {
    let calls = 0;
    server.use(
      http.get("/api/session", () => {
        calls += 1;
        return calls === 1 ? signedIn() : serverError();
      }),
    );
    render(<App />);
    await screen.findByText("owner@example.com");

    refocus();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(calls).toBe(2);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Unable to reach the server.")).not.toBeInTheDocument();
  });

  it("a server error on first load shows a retry that recovers", async () => {
    let calls = 0;
    server.use(
      http.get("/api/session", () => {
        calls += 1;
        return calls === 1 ? serverError() : signedIn();
      }),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to reach the server.");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    const email = await screen.findByText("owner@example.com");
    // Focus does not fall to <body> when Retry unmounts (WCAG 2.4.3).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(email);
  });
});
