import { foldedRanges, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Editor, type EditorHandle } from "./components/Editor";
import { getViewPrefs, setViewPref } from "./viewPrefs";

function mountEditor(initialText: string, extra?: Partial<Parameters<typeof Editor>[0]>) {
  const onChange = vi.fn<(text: string) => void>();
  const { getByTestId, unmount } = render(
    <Editor initialText={initialText} onChange={onChange} {...extra} />,
  );
  const textbox =
    getByTestId("editor-host").shadowRoot?.querySelector<HTMLElement>('[role="textbox"]');
  const view = textbox ? EditorView.findFromDOM(textbox) : null;
  if (!view) {
    throw new Error("EditorView not found in the shadow root");
  }
  return { view, onChange, unmount };
}

function dimmedLines(view: EditorView): string[] {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line.cm-dimmed")).map(
    (line) => line.textContent ?? "",
  );
}

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
}

function installVisualViewport(): FakeVisualViewport {
  const viewport = new FakeVisualViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
});

function paste(view: EditorView, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
}

describe("Editor", () => {
  it("parses YAML frontmatter as YAML (not Setext H2) and leaves it unfolded on open", async () => {
    const text = "---\r\nstatus: ready\r\ntags: test\r\n---\r\n# Body\r\n";
    const { view, onChange } = mountEditor(text);

    await waitFor(() => expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true), {
      timeout: 2500,
    });

    const folds: { from: number; to: number }[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      folds.push({ from, to });
    });
    expect(folds).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();

    const nodeNames: string[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        nodeNames.push(node.name);
      },
    });
    expect(nodeNames).toContain("Frontmatter");
    expect(nodeNames).toContain("Key");
    expect(nodeNames).not.toContain("SetextHeading2");
  });

  it("renders aboveEditor between the formatting toolbar and the editor host", () => {
    mountEditor("# Body", {
      aboveEditor: <div data-testid="properties-slot">Properties slot</div>,
    });
    const toolbar = screen.getByRole("toolbar", { name: "Markdown formatting" });
    const slot = screen.getByTestId("properties-slot");
    const host = screen.getByTestId("editor-host");

    expect(toolbar.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("syncs buffer text without emitting onChange via editorRef.syncText", () => {
    const ref = createRef<EditorHandle>();
    const { view, onChange } = mountEditor("Body", { editorRef: ref });
    act(() => {
      ref.current?.syncText("---\nstatus: ready\n---\n\nBody", 12);
    });
    expect(view.state.doc.toString()).toBe("---\nstatus: ready\n---\n\nBody");
    expect(view.state.selection.main.head).toBe(12);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("wraps the selection as a link when a URL is pasted and keeps CRLF in the saved text", () => {
    const { view, onChange } = mountEditor("see docs\r\n");
    act(() => {
      view.dispatch({ selection: { anchor: 4, head: 8 } });
    });
    paste(view, "https://example.com");
    expect(onChange).toHaveBeenLastCalledWith("see [docs](https://example.com)\r\n");
  });

  it("pastes spreadsheet rows as a GFM table", () => {
    const { view, onChange } = mountEditor("");
    paste(view, "a\tb\n1\t2");
    expect(view.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("Editor focus and typewriter modes", () => {
  it("dims every line outside the paragraph holding the cursor while Focus Mode is on", () => {
    setViewPref("focusMode", true);
    const { view } = mountEditor("one\n\ntwo a\ntwo b\n\nthree");
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });
    });
    expect(dimmedLines(view)).toEqual(["one", "", "", "three"]);

    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    expect(dimmedLines(view)).toEqual(["one", "", "two a", "two b", ""]);
  });

  it("toggles Focus Mode from the toolbar and persists it", () => {
    const { view } = mountEditor("a\n\nb");
    const button = screen.getByRole("button", { name: "Focus mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("data-slot", "toggle");
    expect(dimmedLines(view)).toEqual([]);

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("data-pressed");
    expect(getViewPrefs().focusMode).toBe(true);
    expect(dimmedLines(view).length).toBeGreaterThan(0);

    fireEvent.click(button);
    expect(dimmedLines(view)).toEqual([]);
    expect(getViewPrefs().focusMode).toBe(false);
  });

  it("scrolls the cursor line to the center on every edit while Typewriter Mode is on", () => {
    const { view } = mountEditor("a\nb");
    const typing = () => view.state.update({ changes: { from: 0, insert: "x" } });
    expect(typing().effects).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Typewriter mode" }));
    expect(getViewPrefs().typewriterMode).toBe(true);
    expect(typing().effects).toHaveLength(1);
    expect(view.dom).toHaveClass("cm-typewriter");
    // Pointer selections never jump the page under the mouse.
    expect(
      view.state.update({ selection: { anchor: 1 }, userEvent: "select.pointer" }).effects,
    ).toHaveLength(0);
  });
});

describe("mobile formatting accessory bar", () => {
  it("stays hidden on desktop and anchors above the on-screen keyboard when it opens", () => {
    const viewport = installVisualViewport();
    mountEditor("");
    expect(screen.queryByRole("toolbar", { name: "Formatting accessory bar" })).toBeNull();

    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.offsetTop = 20;
      viewport.dispatchEvent(new Event("resize"));
    });
    const bar = screen.getByRole("toolbar", { name: "Formatting accessory bar" });
    expect(bar.style.bottom).toBe("280px");
    expect(screen.getByTestId("accessory-bar-spacer").style.height).not.toBe("");

    act(() => {
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(bar.style.bottom).toBe("300px");
  });

  it("removes its visualViewport listeners on unmount", () => {
    const viewport = installVisualViewport();
    const remove = vi.spyOn(viewport, "removeEventListener");
    const { unmount } = mountEditor("");
    unmount();
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(["resize", "scroll"]);
  });

  it("runs one-tap formatting without taking focus from the editor", () => {
    const viewport = installVisualViewport();
    const { view, onChange } = mountEditor("item");
    act(() => {
      viewport.height = 300;
      viewport.dispatchEvent(new Event("resize"));
      view.dispatch({ selection: { anchor: 4 } });
    });
    const bar = screen.getByRole("toolbar", { name: "Formatting accessory bar" });
    const tap = (name: string) => {
      const button = within(bar).getByRole("button", { name });
      expect(fireEvent.pointerDown(button)).toBe(false);
      expect(fireEvent.mouseDown(button)).toBe(false);
      fireEvent.click(button);
    };

    tap("Toggle task");
    expect(view.state.doc.toString()).toBe("- [ ] item");
    tap("Indent");
    expect(view.state.doc.toString()).toBe("  - [ ] item");
    tap("Outdent");
    expect(view.state.doc.toString()).toBe("- [ ] item");
    tap("Heading");
    expect(view.state.doc.toString()).toBe("# - [ ] item");
    tap("Undo");
    expect(view.state.doc.toString()).toBe("- [ ] item");
    tap("Redo");
    expect(view.state.doc.toString()).toBe("# - [ ] item");
    tap("Undo");
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    tap("Wikilink");
    expect(view.state.doc.toString()).toBe("- [ ] item[[]]");
    tap("Bold");
    expect(view.state.doc.toString()).toBe("- [ ] item[[**bold**]]");
    tap("Link");
    expect(view.state.doc.toString()).toContain("[bold](https://)");
    expect(onChange).toHaveBeenCalled();

    const blur = vi.spyOn(view.contentDOM, "blur");
    tap("Dismiss keyboard");
    expect(blur).toHaveBeenCalled();
  });

  it("is a ui-sdk Toolbar: one tab stop, and the arrow keys move between its buttons", () => {
    const viewport = installVisualViewport();
    mountEditor("item");
    act(() => {
      viewport.height = 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    const bar = screen.getByRole("toolbar", { name: "Formatting accessory bar" });
    expect(bar).toHaveAttribute("data-slot", "toolbar");
    const buttons = within(bar).getAllByRole("button");
    for (const button of buttons) {
      expect(button).toHaveAttribute("data-slot", "toolbar-button");
    }
    // Roving focus: only one button is in the tab order.
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);

    act(() => buttons[0].focus());
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(buttons[1], { key: "ArrowLeft" });
    expect(buttons[0]).toHaveFocus();
  });
});
