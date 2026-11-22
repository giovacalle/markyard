import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { copyAsRichText, noteBody } from "./richCopy";
import { markdownToHtml } from "./richHtml";

const NOTE = "---\ntags: [a]\n---\n# Title\n\n- [x] **done** <b>raw</b>\n";

describe("copy as rich text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the note body as HTML without frontmatter and without raw HTML", () => {
    const html = markdownToHtml(noteBody(NOTE));
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>done</strong>");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("tags");
    expect(html).not.toContain("<b>");
  });

  it("writes text/html and text/plain through ClipboardItem when available", async () => {
    const items: Record<string, Blob | Promise<Blob>>[] = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(data: Record<string, Blob | Promise<Blob>>) {
          items.push(data);
        }
      },
    );
    const clipboard = { write: vi.fn().mockResolvedValue(undefined), writeText: vi.fn() };

    await copyAsRichText(NOTE, clipboard);

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["text/html", "text/plain"]);
    expect(await (await items[0]?.["text/html"])?.text()).toContain("<h1>Title</h1>");
    expect(await (await items[0]?.["text/plain"])?.text()).toBe(
      "# Title\n\n- [x] **done** <b>raw</b>\n",
    );
  });

  it("falls back to writeText with the Markdown body without ClipboardItem", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

    await copyAsRichText(NOTE, clipboard);

    expect(clipboard.writeText).toHaveBeenCalledWith("# Title\n\n- [x] **done** <b>raw</b>\n");
  });
});
