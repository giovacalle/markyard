import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { App } from "./App";
import { formatLocalDate, todayNoteName } from "./commandSearch";
import { writeCachedFile } from "./localCache";
import { setViewPref } from "./viewPrefs";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-01T10:00:00.000Z";
const node = (id: string, name: string, kind: "markdown" | "folder" = "markdown") => ({
  id,
  name,
  kind,
  modifiedTime: MODIFIED,
});

const PLAN = "# Plan\n\n## Risks\n";
const ALPHA = "Intro\r\n- see [[plan|the plan]] here\r\n";

function serve(texts: Record<string, string>, withTemplates = false) {
  const puts: { id: string; body: string; ifMatch: string | null }[] = [];
  const created: { folderId: string; name: string; content?: string }[] = [];
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "t1" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/:id/children", ({ params }) =>
      HttpResponse.json({
        nodes:
          params.id === "root-id"
            ? [
                node("work-id", "Work", "folder"),
                ...(withTemplates ? [node("tpl-id", "templates", "folder")] : []),
                node("a-id", "alpha.md"),
              ]
            : params.id === "work-id"
              ? [node("doc-id", "plan.md")]
              : params.id === "tpl-id"
                ? [node("daily-id", "Daily.md")]
                : [],
      }),
    ),
    http.get(
      "/api/files/:id/content",
      ({ params }) =>
        new HttpResponse(texts[String(params.id)] ?? "", {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            ETag: `"etag-${String(params.id)}"`,
          },
        }),
    ),
    http.put("/api/files/:id/content", async ({ params, request }) => {
      puts.push({
        id: String(params.id),
        body: await request.text(),
        ifMatch: request.headers.get("If-Match"),
      });
      return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-next"' } });
    }),
    http.patch("/api/files/:id", async ({ params, request }) => {
      const body = (await request.json()) as { name: string };
      return HttpResponse.json(node(String(params.id), body.name));
    }),
    http.post("/api/folders/:id/files", async ({ params, request }) => {
      const body = (await request.json()) as { name: string; content: string };
      created.push({ folderId: String(params.id), name: body.name, content: body.content });
      return HttpResponse.json(node("new-id", body.name), {
        status: 201,
        headers: { ETag: '"etag-new"' },
      });
    }),
  );
  return { puts, created };
}

/** Expands `Work/` so the tree cache lists the open note and its folder. */
async function expandWork() {
  fireEvent.click(await screen.findByRole("treeitem", { name: /Work/ }));
  await screen.findByRole("treeitem", { name: /plan\.md/ });
}

describe("PKM in the app", () => {
  it("lists backlinks with their context line and opens the linking note", async () => {
    await writeCachedFile("a-id", ALPHA, '"etag-a-id"');
    setViewPref("infoDrawerOpen", true);
    history.replaceState(null, "", "/?file=doc-id");
    serve({ "doc-id": PLAN, "a-id": ALPHA });
    render(<App />);
    await expandWork();

    const section = await screen.findByRole("region", { name: "Backlinks" });
    const link = await within(section).findByRole("button", { name: /alpha/ });
    expect(link).toHaveTextContent("- see [[plan|the plan]] here");
    expect(within(section).getByText("Pin vault offline for full-vault backlinks.")).toBeVisible();
    fireEvent.click(link);
    await waitFor(() => expect(new URL(location.href).searchParams.get("file")).toBe("a-id"));
  });

  it("rewrites links to a renamed note and says how many notes changed", async () => {
    await writeCachedFile("a-id", ALPHA, '"etag-a-id"');
    history.replaceState(null, "", "/?file=doc-id");
    const { puts } = serve({ "doc-id": PLAN, "a-id": ALPHA });
    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await expandWork();

    fireEvent.click(await within(preview).findByRole("button", { name: "plan.md" }));
    const input = within(preview).getByLabelText("File name");
    fireEvent.change(input, { target: { value: "roadmap" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const notice = await screen.findByText("Updated links in 1 note");
    expect(notice.closest('[role="status"]')).not.toBeNull();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      id: "a-id",
      body: "Intro\r\n- see [[roadmap|the plan]] here\r\n",
      ifMatch: '"etag-a-id"',
    });
  });

  it("creates an unresolved link's note in the open note's folder", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    const { created } = serve({ "doc-id": "Next: [[Ideas]]" });
    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await expandWork();
    fireEvent.click(await within(preview).findByRole("button", { name: "Ideas" }));
    await waitFor(() =>
      expect(created).toEqual([{ folderId: "work-id", name: "Ideas.md", content: "" }]),
    );
  });

  it("opens the Tasks dashboard from the sidebar", async () => {
    await writeCachedFile("a-id", "- [ ] call #home\n", '"etag-a-id"');
    serve({});
    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    const tasks = await screen.findByRole("region", { name: "Tasks" });
    expect(await within(tasks).findByRole("checkbox", { name: "call #home" })).not.toBeChecked();
  });
});

describe("heading links", () => {
  it("scrolls to the heading a [[#Heading]] link names", async () => {
    const scrolled: string[] = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        scrolled.push(this.textContent ?? "");
      },
    });
    history.replaceState(null, "", "/?file=doc-id");
    serve({ "doc-id": "# Plan\n\nSee [[#Risks]]\n\n## Goals\n\n## Risks\n" });
    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await expandWork();
    fireEvent.click(await within(preview).findByRole("link", { name: "Risks" }));
    await waitFor(() => expect(scrolled).toContain("Risks"));
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });
});

describe("Today's note", () => {
  it("starts from the vault's Templates/Daily.md, even when the folder was never expanded", async () => {
    const { created } = serve(
      { "daily-id": "# {{title}}\n\n- [ ] plan {{date}}{{cursor}}\n" },
      true,
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const dialog = await screen.findByRole("dialog", { name: /command palette/i });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Today's note/ }));

    const name = todayNoteName();
    const date = formatLocalDate();
    await waitFor(() =>
      expect(created).toEqual([
        {
          folderId: "root-id",
          name,
          content: `# ${name.replace(/\.md$/, "")}\n\n- [ ] plan ${date}\n`,
        },
      ]),
    );
  });
});
