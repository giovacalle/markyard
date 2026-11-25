import { describe, expect, it } from "vite-plus/test";
import {
  addAttachmentTags,
  collectKnownTags,
  isValidAttachmentTag,
  MAX_ATTACHMENT_TAGS,
  matchAttachmentTags,
  matchesAttachmentSearch,
  normalizeAttachmentTag,
  removeAttachmentTag,
} from "./attachmentTags";
import type { VaultDocument } from "./vaultDocuments";

describe("attachmentTags helpers", () => {
  it("normalizes idempotently and deduplicates tags case-insensitively while preserving casing", () => {
    expect(normalizeAttachmentTag("  ##Y2K   aesthetic  ")).toBe("Y2K aesthetic");
    expect(normalizeAttachmentTag("# #foo")).toBe("foo");
    expect(normalizeAttachmentTag(normalizeAttachmentTag("# #foo"))).toBe("foo");

    const added = addAttachmentTags(["Cybercore"], ["#Y2K aesthetic", "cybercore", "  "]);
    expect(added).toEqual({
      ok: true,
      tags: ["Cybercore", "Y2K aesthetic"],
      changed: true,
    });

    const unchanged = addAttachmentTags(["Cybercore"], ["#CYBERCORE"]);
    expect(unchanged).toEqual({
      ok: true,
      tags: ["Cybercore"],
      changed: false,
    });
  });

  it("enforces Drive appProperties limits, multibyte 124-byte cap, and format/control char rules", () => {
    const thirty = Array.from({ length: MAX_ATTACHMENT_TAGS }, (_, i) => `t${i}`);
    const overflow = addAttachmentTags(thirty, ["extra"]);
    expect(overflow.ok).toBe(false);

    // Exact 124 UTF-8 bytes: "tag_" (4) + 15*"%C3%A9" (90) + 15*"é" (30) = 124
    const exact124 = "é".repeat(15);
    expect(isValidAttachmentTag(exact124)).toBe(true);
    expect(addAttachmentTags([], [exact124]).ok).toBe(true);

    const over124 = "é".repeat(16);
    expect(isValidAttachmentTag(over124)).toBe(false);
    expect(addAttachmentTags([], [over124]).ok).toBe(false);

    expect(isValidAttachmentTag("bad\ntag")).toBe(false);
    expect(isValidAttachmentTag("zero\u200Bwidth")).toBe(false);
    expect(isValidAttachmentTag("bidi\u202Eoverride")).toBe(false);
    expect(addAttachmentTags([], ["bad\ntag"]).ok).toBe(false);
    expect(addAttachmentTags([], ["zero\u200Bwidth"]).ok).toBe(false);
  });

  it("removes tags case-insensitively", () => {
    expect(removeAttachmentTag(["Cybercore", "Wabi-sabi"], "cybercore")).toEqual(["Wabi-sabi"]);
  });

  it("matches attachment tags by exact > prefix > substring", () => {
    const tags = ["neo-brutalism", "cybercore", "cyber", "cyberpunk"];
    expect(matchAttachmentTags(tags, "#cyber")).toEqual(["cyber", "cybercore", "cyberpunk"]);
    expect(matchAttachmentTags(tags, "tag:brut")).toEqual(["neo-brutalism"]);
    expect(matchAttachmentTags(undefined, "cyber")).toEqual([]);
  });

  it("filters attachments by filename or tag, including # and tag: prefixes", () => {
    const img = { name: "hero.png", tags: ["Y2K aesthetic", "Cybercore"] };
    const plain = { name: "cyber-shot.png" };

    expect(matchesAttachmentSearch(img, "")).toBe(true);
    expect(matchesAttachmentSearch(img, "hero")).toBe(true);
    expect(matchesAttachmentSearch(img, "y2k")).toBe(true);
    expect(matchesAttachmentSearch(img, "#cyber")).toBe(true);
    expect(matchesAttachmentSearch(plain, "#cyber")).toBe(false);
    expect(matchesAttachmentSearch(plain, "cyber")).toBe(true);
    expect(matchesAttachmentSearch(img, "tag:")).toBe(true);
    expect(matchesAttachmentSearch(plain, "tag:")).toBe(false);
  });

  it("collects deduplicated known tags from attachments and note frontmatter", () => {
    const docs: VaultDocument[] = [
      {
        id: "n1",
        name: "Moodboard.md",
        path: [],
        folderId: "root",
        revision: "r1",
        text: "---\ntags: [Design, cybercore]\n---\nBody",
      },
    ];
    expect(collectKnownTags([{ tags: ["Cybercore", "Wabi-sabi"] }], docs)).toEqual([
      "Cybercore",
      "Design",
      "Wabi-sabi",
    ]);
  });
});
