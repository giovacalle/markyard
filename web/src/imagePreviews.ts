// Live image previews in the editor: an attachment image (`![alt](/api/files/<id>/blob)`) shows
// its Drive thumbnail under its line, and its long URL folds into a small image chip until the
// cursor or selection touches the image. Code blocks and external images are left alone.
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { attachmentThumbUrl } from "./attachmentRefs";

/** Longest edge of the preview, px: the info sidebar's size, so the browser cache is shared. */
const PREVIEW_PX = 800;

/** `/api/files/<id>/blob` (optionally in `<…>`) → the file id. */
export function attachmentIdOfUrl(url: string): string | undefined {
  const match = /^<?\/api\/files\/([^\s/?#)>"'\\]+)\/blob>?$/.exec(url.trim());
  if (match === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The folded `(/api/files/…/blob)`: a click puts the cursor there, which unfolds it. */
class LinkChip extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-image-link";
    chip.title = "Image link (click to edit)";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of [
      ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
      ["circle", { cx: "9", cy: "9", r: "2" }],
      ["path", { d: "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" }],
    ] as const) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
      svg.appendChild(shape);
    }
    chip.appendChild(svg);
    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** The thumbnail shown as a block under the image's line. */
class ImagePreview extends WidgetType {
  constructor(
    readonly id: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImagePreview): boolean {
    return other.id === this.id && other.alt === this.alt;
  }

  get estimatedHeight(): number {
    return 200;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-image-preview";
    const img = document.createElement("img");
    img.src = attachmentThumbUrl(this.id, PREVIEW_PX);
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => {
      box.classList.add("cm-image-preview-missing");
      box.replaceChildren(
        document.createTextNode(
          this.alt === "" ? "Image unavailable" : `${this.alt} (unavailable)`,
        ),
      );
      view.requestMeasure();
    });
    box.appendChild(img);
    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const CHIP = Decoration.replace({ widget: new LinkChip() });

function previewDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selection = state.selection.ranges;
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name !== "Image") {
        return;
      }
      const node = ref.node;
      const url = node.getChild("URL");
      const id = url === null ? undefined : attachmentIdOfUrl(state.sliceDoc(url.from, url.to));
      if (url === null || id === undefined) {
        return false;
      }
      const marks = node.getChildren("LinkMark");
      // Marks: `![`, `]`, `(`, …, `)`.
      const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
      const open = marks.find(
        (mark) => mark.to <= url.from && state.sliceDoc(mark.from, mark.to) === "(",
      );
      const editing = selection.some((range) => range.from <= node.to && range.to >= node.from);
      if (!editing) {
        ranges.push(CHIP.range(open?.from ?? url.from, node.to));
      }
      const line = state.doc.lineAt(node.to);
      ranges.push(
        Decoration.widget({ widget: new ImagePreview(id, alt), block: true, side: 1 }).range(
          line.to,
        ),
      );
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const previews = StateField.define<DecorationSet>({
  create: previewDecorations,
  update(value, tr) {
    return tr.docChanged ||
      tr.selection !== undefined ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? previewDecorations(tr.state)
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Attachment image previews under their lines, with their URLs folded while not edited. */
export const imagePreviews: Extension = [
  previews,
  EditorView.theme({
    ".cm-image-link": {
      display: "inline-flex",
      alignItems: "center",
      verticalAlign: "-0.15em",
      margin: "0 0.125rem",
      padding: "0.0625rem 0.3125rem",
      borderRadius: "0.3125rem",
      color: "var(--cm-muted, #737373)",
      backgroundColor: "var(--cm-code-bg, #f5f5f5)",
      cursor: "pointer",
    },
    ".cm-image-link svg": {
      width: "0.875rem",
      height: "0.875rem",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.75",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    ".cm-image-preview": {
      padding: "0.375rem 0 0.625rem",
    },
    ".cm-image-preview img": {
      display: "block",
      maxWidth: "100%",
      maxHeight: "20rem",
      borderRadius: "0.5rem",
      border: "1px solid var(--cm-popup-border, #e5e5e5)",
      backgroundColor: "var(--cm-code-bg, #f5f5f5)",
    },
    ".cm-image-preview-missing": {
      color: "var(--cm-muted, #737373)",
      fontSize: "0.8125rem",
      fontStyle: "italic",
    },
  }),
];
