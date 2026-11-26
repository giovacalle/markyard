import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { Editor } from "./components/Editor";
import { detectTrigger } from "./editorCompletion";
import { type PkmApi, PkmContext } from "./pkm";

function mount(initialText: string, overrides: Partial<PkmApi> = {}) {
  const pkm: PkmApi = {
    notes: [
      { id: "a", name: "Alpha.md", path: [], folderId: "root" },
      { id: "p1", name: "Plan.md", path: ["Work"], folderId: "work" },
      { id: "p2", name: "Plan.md", path: ["Home"], folderId: "home" },
      { id: "cur", name: "Current.md", path: [], folderId: "root" },
    ],
    currentFileId: "cur",
    vaultPinned: false,
    openNote: vi.fn(),
    createNote: vi.fn(),
    loadTemplates: vi.fn(async () => [
      { id: "t", name: "Meeting.md", text: "## {{title}}\r\n{{cursor}}" },
    ]),
    ...overrides,
  };
  const onChange = vi.fn<(text: string) => void>();
  const { getByTestId } = render(
    <PkmContext.Provider value={pkm}>
      <Editor initialText={initialText} onChange={onChange} />
    </PkmContext.Provider>,
  );
  const shadow = getByTestId("editor-host").shadowRoot;
  const textbox = shadow?.querySelector<HTMLElement>('[role="textbox"]');
  const view = textbox ? EditorView.findFromDOM(textbox) : null;
  if (!shadow || !view) {
    throw new Error("EditorView not found");
  }
  const type = (text: string) => {
    act(() => {
      const at = view.state.selection.main.head;
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        userEvent: "input.type",
      });
    });
  };
  const press = (key: string) => {
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key });
    });
  };
  const listbox = () => shadow.querySelector<HTMLElement>('[role="listbox"]:not([hidden])');
  const options = () =>
    Array.from(listbox()?.querySelectorAll('[role="option"]') ?? []).map((o) => o.textContent);
  return { view, onChange, type, press, listbox, options, pkm };
}

describe("detectTrigger", () => {
  it("spots [[ and / triggers only where they belong", () => {
    expect(detectTrigger("see [[Al")).toEqual({ kind: "wikilink", from: 4, query: "Al" });
    expect(detectTrigger("see [[Al|x")).toBeNull();
    expect(detectTrigger("/ta")).toEqual({ kind: "slash", from: 0, query: "ta" });
    expect(detectTrigger("a /ta")).toEqual({ kind: "slash", from: 2, query: "ta" });
    expect(detectTrigger("a/b")).toBeNull();
  });
});

describe("Editor [[ completion", () => {
  it("lists matching notes with folder hints and inserts the link with closing brackets", () => {
    const { view, type, press, listbox, options, onChange } = mount("x\r\n");
    act(() => view.dispatch({ selection: { anchor: 1 } }));
    type(" [[pl");
    expect(listbox()?.getAttribute("aria-label")).toBe("Link to note");
    expect(options()).toEqual(["PlanHome", "PlanWork"]);
    expect(listbox()?.getAttribute("style") ?? "").not.toContain("<");
    press("ArrowDown");
    expect(listbox()?.querySelector('[aria-selected="true"]')?.textContent).toBe("PlanWork");
    press("Enter");
    expect(view.state.doc.toString()).toBe("x [[Work/Plan]]\n");
    expect(view.state.selection.main.head).toBe("x [[Work/Plan]]".length);
    expect(listbox()).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("x [[Work/Plan]]\r\n");
  });

  it("replaces auto-closed brackets, inserts a bare stem when unique, and closes on Escape", () => {
    const { view, type, press, listbox, options } = mount("[[]]");
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    type("al");
    expect(options()).toEqual(["Alpha"]);
    press("Tab");
    expect(view.state.doc.toString()).toBe("[[Alpha]]");

    type(" [[");
    expect(listbox()).not.toBeNull();
    press("Escape");
    expect(listbox()).toBeNull();
    type("c");
    expect(listbox()).toBeNull();
  });

  it("does not open inside inline code", () => {
    const { view, type, listbox } = mount("`code `");
    let parsed = false;
    act(() => {
      parsed = forceParsing(view, view.state.doc.length, 5_000);
    });
    expect(parsed).toBe(true);
    act(() => view.dispatch({ selection: { anchor: 6 } }));
    type("[[");
    expect(listbox()).toBeNull();
  });
});

describe("Editor / completion", () => {
  it("inserts built-in blocks at the line start", () => {
    const { type, press, options, view } = mount("");
    type("/ta");
    expect(options()).toEqual(["/taskTask item", "/tableTable"]);
    press("Enter");
    expect(view.state.doc.toString()).toBe("- [ ] ");
  });

  it("does not trigger in the middle of a word", () => {
    const { type, listbox } = mount("");
    type("and/or");
    expect(listbox()).toBeNull();
  });

  it("loads vault templates and expands their placeholders with the caret at {{cursor}}", async () => {
    const { type, press, options, view, pkm } = mount("");
    type("/meet");
    await act(async () => {
      await Promise.resolve();
    });
    expect(pkm.loadTemplates).toHaveBeenCalled();
    expect(options()).toEqual(["/MeetingTemplate"]);
    press("Enter");
    expect(view.state.doc.toString()).toBe("## Current\n");
    expect(view.state.selection.main.head).toBe("## Current\n".length);
  });
});
