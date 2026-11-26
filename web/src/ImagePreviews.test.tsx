import { syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { Editor } from "./components/Editor";
import { attachmentIdOfUrl } from "./imagePreviews";

function mountEditor(initialText: string) {
  const result = render(<Editor initialText={initialText} onChange={vi.fn()} />);
  const root = result.getByTestId("editor-host").shadowRoot!;
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('[role="textbox"]')!)!;
  return { view, root };
}

const previews = (root: ShadowRoot) =>
  Array.from(root.querySelectorAll<HTMLImageElement>(".cm-image-preview img")).map((img) => [
    img.getAttribute("src"),
    img.alt,
  ]);

describe("attachmentIdOfUrl", () => {
  it("reads blob URLs only", () => {
    expect(attachmentIdOfUrl("/api/files/img-1/blob")).toBe("img-1");
    expect(attachmentIdOfUrl("</api/files/a%2Fb/blob>")).toBe("a/b");
    expect(attachmentIdOfUrl("https://example.com/a.png")).toBeUndefined();
    expect(attachmentIdOfUrl("/api/files/img-1/blob?x=1")).toBeUndefined();
  });
});

describe("editor image previews", () => {
  it("shows a thumbnail under each attachment image and folds its URL", async () => {
    const { root } = mountEditor(
      'Intro\n\nSee ![Beach](/api/files/img-1/blob) and ![](/api/files/img-2/blob "t")\n',
    );
    await waitFor(
      () => {
        expect(previews(root)).toEqual([
          ["/api/files/img-1/thumb?size=800", "Beach"],
          ["/api/files/img-2/thumb?size=800", ""],
        ]);
      },
      { timeout: 2500 },
    );
    const line = root.querySelectorAll(".cm-line")[2];
    expect(line.textContent).toBe("See ![Beach] and ![]");
    expect(line.querySelectorAll(".cm-image-link")).toHaveLength(2);
  });

  it("unfolds the URL while the cursor touches the image, keeping the preview", async () => {
    const text = "Intro\n![Beach](/api/files/img-1/blob)\nAfter";
    const { view, root } = mountEditor(text);
    await waitFor(() => expect(previews(root)).toHaveLength(1), { timeout: 2500 });

    act(() => view.dispatch({ selection: EditorSelection.cursor(text.indexOf("Beach")) }));
    expect(root.querySelectorAll(".cm-line")[1].textContent).toBe(
      "![Beach](/api/files/img-1/blob)",
    );
    expect(previews(root)).toHaveLength(1);

    act(() => view.dispatch({ selection: EditorSelection.cursor(text.length) }));
    expect(root.querySelectorAll(".cm-line")[1].textContent).toBe("![Beach]");
  });

  it("follows edits", async () => {
    const { view, root } = mountEditor("Intro\n");
    act(() => view.dispatch({ changes: { from: 6, insert: "![Map](/api/files/img-3/blob)" } }));
    await waitFor(
      () => {
        expect(previews(root)).toEqual([["/api/files/img-3/thumb?size=800", "Map"]]);
      },
      { timeout: 2500 },
    );
    act(() => view.dispatch({ changes: { from: 6, to: view.state.doc.length } }));
    await waitFor(() => expect(previews(root)).toEqual([]), { timeout: 2500 });
  });

  it("leaves external images, code and front matter alone", async () => {
    const { view, root } = mountEditor(
      [
        "---",
        "cover: ![x](/api/files/img-9/blob)",
        "---",
        "![Logo](https://example.com/logo.png)",
        "`![a](/api/files/img-4/blob)`",
        "```",
        "![b](/api/files/img-5/blob)",
        "```",
        "![Real](/api/files/img-6/blob)",
      ].join("\n"),
    );
    await waitFor(
      () => {
        expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
        expect(previews(root)).toEqual([["/api/files/img-6/thumb?size=800", "Real"]]);
      },
      { timeout: 2500 },
    );
  });

  it("names a preview that fails to load", async () => {
    const { root } = mountEditor("Intro\n![Beach](/api/files/img-1/blob)\n");
    const img = await waitFor(
      () => {
        const el = root.querySelector(".cm-image-preview img");
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 2500 },
    );
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(root.querySelector(".cm-image-preview-missing")?.textContent).toBe(
      "Beach (unavailable)",
    );
  });

  it("defers slow initial parsing past CodeMirror's 20ms slice and renders previews when background parsing finishes", async () => {
    // Varied Markdown inside CodeMirror's initial jsdom viewport (~900 chars) with an attachment
    // image at the end so multiple Lezer parser steps are needed to reach it.
    const filler = Array.from(
      { length: 10 },
      (_, i) => `- item ${i} with **bold**, *em*, \`code\` and [link](https://example.com/${i})`,
    ).join("\n");
    const doc = `${filler}\n\n![Tail](/api/files/img-tail/blob)\n`;

    let fakeNow = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      fakeNow += 25;
      return fakeNow;
    });
    const start = fakeNow;
    let mounted: ReturnType<typeof mountEditor>;
    try {
      mounted = mountEditor(doc);
    } finally {
      nowSpy.mockRestore();
    }
    const elapsedDuringMount = fakeNow - start;

    // CodeMirror's own LanguageState.init uses a 20ms slice; neither Editor mount nor
    // imagePreviews should force extra synchronous parsing beyond that slice.
    expect(elapsedDuringMount).toBeLessThan(150);
    expect(syntaxTreeAvailable(mounted.view.state, doc.length)).toBe(false);

    // Once background parsing completes, imagePreviews updates its decorations automatically.
    await waitFor(
      () => {
        expect(previews(mounted.root)).toEqual([["/api/files/img-tail/thumb?size=800", "Tail"]]);
      },
      { timeout: 2500 },
    );
  });
});
