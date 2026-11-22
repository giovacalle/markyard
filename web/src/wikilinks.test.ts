import { describe, expect, it } from "vite-plus/test";
import {
  backlinkContexts,
  noteStem,
  parseWikilinks,
  resolveWikilink,
  rewriteWikilinks,
  type VaultNote,
} from "./wikilinks";

const NOTES: VaultNote[] = [
  { id: "a", name: "Alpha.md", path: [] },
  { id: "b", name: "Beta.md", path: ["Projects"] },
  { id: "b2", name: "beta.md", path: ["Archive", "Old"] },
  { id: "c", name: "Gamma.MD", path: ["Projects", "Deep"] },
];

describe("parseWikilinks", () => {
  it("parses targets, headings, aliases and folder paths with their offsets", () => {
    const text =
      "See [[Alpha]], [[Beta|the beta]], [[Gamma#Intro]] and [[Projects/Beta#Plan|plan]].";
    const links = parseWikilinks(text);
    expect(links.map(({ target, heading, alias }) => ({ target, heading, alias }))).toEqual([
      { target: "Alpha", heading: undefined, alias: undefined },
      { target: "Beta", heading: undefined, alias: "the beta" },
      { target: "Gamma", heading: "Intro", alias: undefined },
      { target: "Projects/Beta", heading: "Plan", alias: "plan" },
    ]);
    for (const link of links) {
      expect(text.slice(link.from, link.to)).toBe(link.raw);
      expect(text.slice(link.targetFrom, link.targetTo)).toBe(link.target);
    }
  });

  it("ignores links inside fenced code blocks and inline code spans", () => {
    const text = [
      "[[Alpha]] `[[Nope]]` ``a [[Nope]] b``",
      "```",
      "[[InFence]]",
      "```",
      "~~~~md",
      "[[Tilde]]",
      "~~~~",
      "after [[Beta]]",
    ].join("\r\n");
    expect(parseWikilinks(text).map((l) => l.target)).toEqual(["Alpha", "Beta"]);
  });

  it("skips empty and multi-line brackets", () => {
    expect(parseWikilinks("[[]] [[ ]] [[a\nb]]")).toEqual([]);
  });
});

describe("resolveWikilink", () => {
  it("matches the stem case-insensitively and prefers the shortest path", () => {
    expect(resolveWikilink("alpha", NOTES)?.id).toBe("a");
    expect(resolveWikilink("BETA", NOTES)?.id).toBe("b");
    expect(resolveWikilink("gamma.md", NOTES)?.id).toBe("c");
  });

  it("disambiguates with a folder path suffix", () => {
    expect(resolveWikilink("Old/Beta", NOTES)?.id).toBe("b2");
    expect(resolveWikilink("archive/old/beta", NOTES)?.id).toBe("b2");
    expect(resolveWikilink("Deep/Gamma", NOTES)?.id).toBe("c");
    expect(resolveWikilink("Elsewhere/Gamma", NOTES)).toBeNull();
  });

  it("prefers a note in the linking note's own folder", () => {
    expect(resolveWikilink("beta", NOTES, ["Archive", "Old"])?.id).toBe("b2");
  });

  it("answers null for unknown targets", () => {
    expect(resolveWikilink("Missing", NOTES)).toBeNull();
    expect(noteStem("Gamma.MD")).toBe("Gamma");
  });
});

describe("rewriteWikilinks", () => {
  it("renames only the target bytes, keeping folders, headings, aliases and line endings", () => {
    const text = "- [[Beta]]\r\n- [[projects/beta#Plan|alias]]\r\n- `[[Beta]]`\r\n- [[Alpha]]\r\n";
    const result = rewriteWikilinks(
      text,
      (link) => resolveWikilink(link.target, NOTES)?.id === "b",
      "Delta",
    );
    expect(result.count).toBe(2);
    expect(result.text).toBe(
      "- [[Delta]]\r\n- [[projects/Delta#Plan|alias]]\r\n- `[[Beta]]`\r\n- [[Alpha]]\r\n",
    );
  });

  it("keeps an explicit .md suffix and leaves text alone when nothing matches", () => {
    expect(rewriteWikilinks("[[Beta.md]]", () => true, "Delta").text).toBe("[[Delta.md]]");
    const untouched = rewriteWikilinks("[[Alpha]]", () => false, "Delta");
    expect(untouched).toEqual({ text: "[[Alpha]]", count: 0 });
  });
});

describe("backlinkContexts", () => {
  it("returns the trimmed line around every matching link", () => {
    const text = "# Title\n\n  - todo with [[Beta]] here\nnothing\n[[Alpha]] and [[beta|b]]\n";
    const contexts = backlinkContexts(text, (link) => link.target.toLowerCase() === "beta");
    expect(contexts).toEqual([
      { line: 3, text: "- todo with [[Beta]] here" },
      { line: 5, text: "[[Alpha]] and [[beta|b]]" },
    ]);
  });
});
