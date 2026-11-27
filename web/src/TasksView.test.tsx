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
  it("groups open tasks by note and filters by status, search, folder and tag", async () => {
    renderPanel();
    const groups = () =>
      screen
        .getAllByRole("group")
        .filter((g) => g.getAttribute("aria-label") !== "Tags")
        .map((g) =>
          within(g)
            .getAllByRole("checkbox")
            .map((c) => document.getElementById(c.getAttribute("aria-labelledby")!)?.textContent),
        );
    expect(groups()).toEqual([["milk #shop"], ["ship #release @2026-12-01"]]);
    expect(screen.getByText("Pin vault offline to include every note.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Completed" }));
    expect(groups()).toEqual([["draft"]]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(groups()).toEqual([["milk #shop"], ["ship #release @2026-12-01", "draft"]]);

    const folderTrigger = screen.getByRole("combobox", { name: "Folder" });
    expect(folderTrigger.tagName).toBe("BUTTON");
    fireEvent.click(folderTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Work" }));
    expect(groups()).toEqual([["ship #release @2026-12-01", "draft"]]);
    fireEvent.click(folderTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "All folders" }));

    fireEvent.click(screen.getByRole("button", { name: "#shop" }));
    expect(screen.getByRole("button", { name: "#shop" })).toHaveAttribute("aria-pressed", "true");
    expect(groups()).toEqual([["milk #shop"]]);
    fireEvent.click(screen.getByRole("button", { name: "#shop" }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), {
      target: { value: "ship" },
    });
    expect(groups()).toEqual([["ship #release @2026-12-01"]]);
  });

  it("filters by tag with a keyboard-navigable toggle group", () => {
    renderPanel();
    const tagGroup = screen.getByRole("group", { name: "Tags" });
    const shop = within(tagGroup).getByRole("button", { name: "#shop" });
    const release = within(tagGroup).getByRole("button", { name: "#release" });
    expect(shop).toHaveAttribute("data-slot", "toggle");

    fireEvent.click(shop);
    expect(shop).toHaveAttribute("aria-pressed", "true");
    expect(shop).toHaveAttribute("data-pressed");
    expect(screen.queryByRole("checkbox", { name: "ship #release @2026-12-01" })).toBeNull();

    fireEvent.click(release);
    expect(release).toHaveAttribute("aria-pressed", "true");
    expect(shop).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("checkbox", { name: "milk #shop" })).toBeNull();

    fireEvent.click(release);
    expect(release).toHaveAttribute("aria-pressed", "false");
    expect(shop).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("checkbox", { name: "milk #shop" })).toBeInTheDocument();

    const [first, second] = within(tagGroup).getAllByRole("button");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-pressed", "false");
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

  it("renders inline markdown in task text with a plain-text checkbox name", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TasksPanel
          docs={[doc("m", "Todo.md", [], "- [ ] **Close** the `account`\n")]}
          vaultPinned={false}
          onToggle={vi.fn()}
          onOpenNote={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Close the account" });
    const item = checkbox.closest("li")!;
    expect(item.querySelector("strong")).toHaveTextContent("Close");
    expect(item.querySelector("code")).toHaveTextContent("account");
    expect(item.textContent).not.toMatch(/[*`]/);
  });

  it("supports keyboard arrows on the status segmented control and filters root-only notes", async () => {
    const docsWithRoot = [...DOCS, doc("r", "Inbox.md", [], "- [ ] root task\n")];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TasksPanel
          docs={docsWithRoot}
          vaultPinned={false}
          onToggle={() => {}}
          onOpenNote={() => {}}
        />
      </QueryClientProvider>,
    );

    const openRadio = screen.getByRole("radio", { name: "Open" });
    openRadio.focus();
    fireEvent.keyDown(openRadio, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Completed" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("checkbox", { name: "draft" })).toBeChecked();

    const completedRadio = screen.getByRole("radio", { name: "Completed" });
    fireEvent.keyDown(completedRadio, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");

    const folderTrigger = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.click(folderTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Root only" }));
    expect(screen.getByRole("checkbox", { name: "root task" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "milk #shop" })).toBeNull();
  });
});
