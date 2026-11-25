import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
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
  it("shows a thumbnail under each attachment image and folds its URL", () => {
    const { root } = mountEditor(
      'Intro\n\nSee ![Beach](/api/files/img-1/blob) and ![](/api/files/img-2/blob "t")\n',
    );
    expect(previews(root)).toEqual([
      ["/api/files/img-1/thumb?size=800", "Beach"],
      ["/api/files/img-2/thumb?size=800", ""],
    ]);
    const line = root.querySelectorAll(".cm-line")[2];
    expect(line.textContent).toBe("See ![Beach] and ![]");
    expect(line.querySelectorAll(".cm-image-link")).toHaveLength(2);
  });

  it("unfolds the URL while the cursor touches the image, keeping the preview", () => {
    const text = "Intro\n![Beach](/api/files/img-1/blob)\nAfter";
    const { view, root } = mountEditor(text);
    act(() => view.dispatch({ selection: EditorSelection.cursor(text.indexOf("Beach")) }));
    expect(root.querySelectorAll(".cm-line")[1].textContent).toBe(
      "![Beach](/api/files/img-1/blob)",
    );
    expect(previews(root)).toHaveLength(1);

    act(() => view.dispatch({ selection: EditorSelection.cursor(text.length) }));
    expect(root.querySelectorAll(".cm-line")[1].textContent).toBe("![Beach]");
  });

  it("follows edits", () => {
    const { view, root } = mountEditor("Intro\n");
    act(() => view.dispatch({ changes: { from: 6, insert: "![Map](/api/files/img-3/blob)" } }));
    expect(previews(root)).toEqual([["/api/files/img-3/thumb?size=800", "Map"]]);
    act(() => view.dispatch({ changes: { from: 6, to: view.state.doc.length } }));
    expect(previews(root)).toEqual([]);
  });

  it("leaves external images, code and front matter alone", () => {
    const { root } = mountEditor(
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
    expect(previews(root)).toEqual([["/api/files/img-6/thumb?size=800", "Real"]]);
  });

  it("names a preview that fails to load", () => {
    const { root } = mountEditor("Intro\n![Beach](/api/files/img-1/blob)\n");
    act(() => {
      root.querySelector(".cm-image-preview img")!.dispatchEvent(new Event("error"));
    });
    expect(root.querySelector(".cm-image-preview-missing")?.textContent).toBe(
      "Beach (unavailable)",
    );
  });
});
