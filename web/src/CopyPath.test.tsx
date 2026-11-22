import { fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { App } from "./App";
import type { DriveNode } from "./api";

const server = setupServer();
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  server.resetHandlers();
  writeText.mockClear();
  Reflect.deleteProperty(navigator, "clipboard");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: DriveNode["kind"]): DriveNode {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function nestedDrive() {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "My Drive Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({
        nodes: [node("projects", "0Projects", "folder"), node("top", "top.md", "markdown")],
      }),
    ),
    http.get("/api/folders/projects/children", () =>
      HttpResponse.json({ nodes: [node("dn", "drive-notes", "folder")] }),
    ),
    http.get("/api/folders/dn/children", () =>
      HttpResponse.json({ nodes: [node("readme", "README.md", "markdown")] }),
    ),
  );
}

async function expandFolder(name: string) {
  const item = await screen.findByRole("treeitem", { name: new RegExp(name) });
  fireEvent.click(within(item).getByText(name));
}

describe("Copy path in the file tree", () => {
  it("copies a nested folder's path without the root folder's name and confirms it", async () => {
    nestedDrive();
    render(<App />);
    await expandFolder("0Projects");
    await screen.findByRole("treeitem", { name: /drive-notes/ });

    fireEvent.click(screen.getByRole("button", { name: "Actions for drive-notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("0Projects/drive-notes");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    // The confirmation is brief: the popover closes by itself.
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument(),
    );
  });

  it("copies a note's path from the right-click menu", async () => {
    nestedDrive();
    render(<App />);
    await expandFolder("0Projects");
    await expandFolder("drive-notes");
    const readme = await screen.findByRole("treeitem", { name: /README\.md/ });

    fireEvent.contextMenu(within(readme).getByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("0Projects/drive-notes/README.md");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("copies a top-level note as just its name", async () => {
    nestedDrive();
    render(<App />);
    await screen.findByRole("treeitem", { name: /top\.md/ });

    fireEvent.click(screen.getByRole("button", { name: "Actions for top.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("top.md");
  });
});
