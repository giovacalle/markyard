import { describe, expect, it } from "vite-plus/test";
import { findBacklinks, findHeading, planLinkRewrites } from "./linkIndex";
import type { VaultDocument } from "./vaultDocuments";

const doc = (id: string, name: string, path: string[], text: string): VaultDocument => ({
  id,
  name,
  path,
  folderId: path.join("/") || "root",
  text,
  revision: `rev-${id}`,
});

const DOCS = [
  doc("target", "Plan.md", ["Work"], "# Plan\nlinks to [[Plan]] itself\n"),
  doc("other-plan", "Plan.md", ["Home"], "home plan"),
  doc("a", "Alpha.md", [], "- see [[Work/Plan|the plan]]\n- [[Home/Plan]]\n"),
  doc("b", "Beta.md", ["Work"], "Intro\r\n  * [[plan#Risks]] matters\r\n"),
  doc("c", "Gamma.md", [], "`[[Work/Plan]]` only in code"),
];

describe("findBacklinks", () => {
  it("lists every other note linking to the target with the linking lines", () => {
    const links = findBacklinks("target", DOCS, DOCS);
    expect(links.map((l) => [l.note.id, l.contexts])).toEqual([
      ["a", [{ line: 1, text: "- see [[Work/Plan|the plan]]" }]],
      ["b", [{ line: 2, text: "* [[plan#Risks]] matters" }]],
    ]);
  });
});

describe("planLinkRewrites", () => {
  it("rewrites links resolving to the renamed note, byte for byte elsewhere", () => {
    const edits = planLinkRewrites("target", "Roadmap.md", DOCS, DOCS);
    expect(edits.map((e) => [e.doc.id, e.text])).toEqual([
      ["a", "- see [[Work/Roadmap|the plan]]\n- [[Home/Plan]]\n"],
      ["b", "Intro\r\n  * [[Roadmap#Risks]] matters\r\n"],
    ]);
  });
});

describe("findHeading", () => {
  it("finds a heading by text, ignoring case and code fences", () => {
    const text = "# Plan\n```\n## Risks\n```\n## risks \n### Next\n";
    expect(findHeading(text, "Risks")).toMatchObject({ line: 5, index: 1 });
    expect(findHeading(text, "missing")).toBeUndefined();
  });
});
