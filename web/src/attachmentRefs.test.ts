import { describe, expect, it } from "vite-plus/test";
import {
  attachmentIdsIn,
  attachmentUsage,
  extractAttachmentRefs,
  removeAttachmentRefs,
} from "./attachmentRefs";
import type { VaultDocument } from "./vaultDocuments";

describe("extractAttachmentRefs", () => {
  it("dedupes image references by file id, keeping the first alt and counting occurrences", () => {
    const text = [
      "![Shot](/api/files/img-1/blob)",
      'Inline ![](/api/files/img-2/blob "Title") and again ![Other](/api/files/img-1/blob).',
      "![Remote](https://example.com/x.png)",
      "[link](/api/files/img-3/blob)",
      "```",
      "![in code](/api/files/img-4/blob)",
      "```",
    ].join("\n");
    expect(extractAttachmentRefs(text)).toEqual([
      { id: "img-1", alt: "Shot", count: 2 },
      { id: "img-2", alt: "", count: 1 },
    ]);
  });

  it("answers no references for plain notes", () => {
    expect(extractAttachmentRefs("# Title\n\nNo images.")).toEqual([]);
  });
});

describe("removeAttachmentRefs", () => {
  it("drops a standalone image line and the blank line it leaves behind", () => {
    const text = "# Title\n\nBefore\n\n![Shot](/api/files/img-1/blob)\n\nAfter\n";
    expect(removeAttachmentRefs(text, "img-1")).toBe("# Title\n\nBefore\n\nAfter\n");
  });

  it("handles titles, inline images, CRLF and leaves other images and text untouched", () => {
    const text = [
      'See ![a](/api/files/img-1/blob "A title") here and ![b](/api/files/img-2/blob).',
      "",
      "![c](/api/files/img-1/blob 'single')",
      "",
      "End",
      "",
    ].join("\r\n");
    expect(removeAttachmentRefs(text, "img-1")).toBe(
      ["See here and ![b](/api/files/img-2/blob).", "", "End", ""].join("\r\n"),
    );
  });

  it("removes images at the start and end of the note and inside list items", () => {
    expect(removeAttachmentRefs("![x](/api/files/i/blob)\n\nBody", "i")).toBe("Body");
    expect(removeAttachmentRefs("Body\n\n![x](/api/files/i/blob)", "i")).toBe("Body");
    expect(removeAttachmentRefs("Body\n\n![x](/api/files/i/blob)\n", "i")).toBe("Body\n");
    expect(removeAttachmentRefs("- one\n- ![x](/api/files/i/blob)\n- two\n", "i")).toBe(
      "- one\n- two\n",
    );
    expect(removeAttachmentRefs("Tail ![x](/api/files/i/blob)\n", "i")).toBe("Tail\n");
  });

  it("does not touch code blocks, similar ids or plain links", () => {
    const text = [
      "```",
      "![x](/api/files/i/blob)",
      "```",
      "![y](/api/files/i2/blob)",
      "[link](/api/files/i/blob)",
      "",
    ].join("\n");
    expect(removeAttachmentRefs(text, "i")).toBe(text);
  });
});

describe("attachment usage", () => {
  const doc = (id: string, text: string): VaultDocument => ({
    id,
    name: `${id}.md`,
    path: [],
    folderId: "root",
    text,
    revision: "r",
  });

  it("finds every blob id a note references, image or link", () => {
    expect([...attachmentIdsIn("![a](/api/files/a/blob) [b](/api/files/b/blob) /x")]).toEqual([
      "a",
      "b",
    ]);
  });

  it("maps attachment ids to the cached notes that reference them", () => {
    const one = doc("n1", "![a](/api/files/a/blob)\n![a](/api/files/a/blob)");
    const two = doc("n2", "![a](/api/files/a/blob) ![b](/api/files/b/blob)");
    const usage = attachmentUsage([one, two, doc("n3", "nothing")]);
    expect(usage.get("a")).toEqual([one, two]);
    expect(usage.get("b")).toEqual([two]);
    expect(usage.get("c")).toBeUndefined();
  });
});
