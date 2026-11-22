import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { Preview } from "./components/Preview";
import { type PkmApi, PkmContext } from "./pkm";

function renderPreview(text: string) {
  const pkm: PkmApi = {
    notes: [
      { id: "alpha", name: "Alpha.md", path: [], folderId: "root" },
      { id: "plan-work", name: "Plan.md", path: ["Work"], folderId: "work" },
      { id: "plan-home", name: "Plan.md", path: ["Home"], folderId: "home" },
      { id: "cur", name: "Current.md", path: ["Home"], folderId: "home" },
    ],
    currentFileId: "cur",
    vaultPinned: false,
    openNote: vi.fn(),
    createNote: vi.fn(),
    loadTemplates: vi.fn(async () => []),
  };
  render(
    <PkmContext.Provider value={pkm}>
      <Preview text={text} />
    </PkmContext.Provider>,
  );
  return pkm;
}

describe("Preview wikilinks", () => {
  it("renders resolved links that open the note at the heading", () => {
    const pkm = renderPreview("See [[alpha#Goals|the plan]] and [[Plan]] and [[Work/Plan]].");
    const alias = screen.getByRole("link", { name: "the plan" });
    expect(alias).toHaveClass("wikilink");
    fireEvent.click(alias);
    expect(pkm.openNote).toHaveBeenCalledWith("alpha", { heading: "Goals" });

    // Same folder wins for an ambiguous stem; a folder path picks the other one.
    fireEvent.click(screen.getByRole("link", { name: "Plan" }));
    expect(pkm.openNote).toHaveBeenLastCalledWith("plan-home", { heading: undefined });
    fireEvent.click(screen.getByRole("link", { name: "Work/Plan" }));
    expect(pkm.openNote).toHaveBeenLastCalledWith("plan-work", { heading: undefined });
  });

  it("renders unresolved links as create buttons", () => {
    const pkm = renderPreview("- todo [[Ideas/New idea]]");
    const button = screen.getByRole("button", { name: "Ideas/New idea" });
    expect(button).toHaveClass("wikilink-unresolved");
    fireEvent.click(button);
    expect(pkm.createNote).toHaveBeenCalledWith("New idea");
  });

  it("keeps links in code literal and same-note heading links working", () => {
    const pkm = renderPreview("`[[Alpha]]`\n\n```\n[[Alpha]]\n```\n\nJump to [[#Risks]]");
    expect(screen.getAllByText("[[Alpha]]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Risks" }));
    expect(pkm.openNote).toHaveBeenCalledWith("cur", { heading: "Risks" });
  });
});
