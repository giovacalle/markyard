import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { TasksPanel } from "./components/TasksView";
import type { VaultDocument } from "./vaultDocuments";

const doc = (id: string, name: string, path: string[], text: string): VaultDocument => ({
  id,
  name,
  path,
  folderId: id,
  text,
  revision: `rev-${id}`,
});

const DOCS = [
  doc("w", "Plan.md", ["Work"], "# Plan\r\n- [ ] ship #release @2026-12-01\r\n- [x] draft\r\n"),
  doc("h", "Groceries.md", ["Home"], "* [ ] milk #shop\n```\n- [ ] not a task\n```\n"),
];

function renderPanel() {
  const onToggle = vi.fn<(doc: VaultDocument, text: string) => void>();
  const onOpenNote = vi.fn<(id: string) => void>();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TasksPanel docs={DOCS} vaultPinned={false} onToggle={onToggle} onOpenNote={onOpenNote} />
    </QueryClientProvider>,
  );
  return { onToggle, onOpenNote };
}

describe("TasksPanel", () => {
  it("groups open tasks by note and filters by status, search, folder and tag", () => {
    renderPanel();
    const groups = () =>
      screen.getAllByRole("group").map((g) =>
        within(g)
          .getAllByRole("checkbox")
          .map((c) => c.getAttribute("aria-label")),
      );
    expect(groups()).toEqual([["milk #shop"], ["ship #release @2026-12-01"]]);
    expect(screen.getByText("Pin vault offline to include every note.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Completed" }));
    expect(groups()).toEqual([["draft"]]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(groups()).toEqual([["milk #shop"], ["ship #release @2026-12-01", "draft"]]);

    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), {
      target: { value: "Work" },
    });
    expect(groups()).toEqual([["ship #release @2026-12-01", "draft"]]);
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "#shop" }));
    expect(screen.getByRole("button", { name: "#shop" })).toHaveAttribute("aria-pressed", "true");
    expect(groups()).toEqual([["milk #shop"]]);
    fireEvent.click(screen.getByRole("button", { name: "#shop" }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), {
      target: { value: "ship" },
    });
    expect(groups()).toEqual([["ship #release @2026-12-01"]]);
  });

  it("toggles the exact line byte for byte and opens notes from their header", () => {
    const { onToggle, onOpenNote } = renderPanel();
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "ship #release @2026-12-01" }));
    });
    expect(onToggle).toHaveBeenCalledWith(
      DOCS[0],
      "# Plan\r\n- [x] ship #release @2026-12-01\r\n- [x] draft\r\n",
    );
    fireEvent.click(screen.getByRole("button", { name: /Groceries/ }));
    expect(onOpenNote).toHaveBeenCalledWith("h");
  });
});
