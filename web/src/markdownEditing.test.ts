import { moveLineDown, moveLineUp } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  continueListItem,
  cycleHeading,
  indentListItem,
  insertWikilink,
  outdentListItem,
  smartPaste,
  toggleTask,
  tsvToMarkdownTable,
} from "./markdownEditing";

/** Builds a state from `doc`, where `^` marks the cursor and `«...»` marks a selection. */
function stateOf(marked: string): EditorState {
  const anchor = marked.includes("«") ? marked.indexOf("«") : marked.indexOf("^");
  const doc = marked.replace(/[\^«»]/g, "");
  const head = marked.includes("«") ? marked.indexOf("»") - 1 : anchor;
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length);
  return state;
}

function run(
  command: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean,
  marked: string,
): { handled: boolean; text: string; cursor: number } {
  let state = stateOf(marked);
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  return { handled, text: state.doc.toString(), cursor: state.selection.main.head };
}

describe("outliner commands", () => {
  it("moves the current line up and down (bound to Alt+ArrowUp/Down)", () => {
    expect(run(moveLineUp, "a\nb^\nc").text).toBe("b\na\nc");
    expect(run(moveLineDown, "a^\nb\nc").text).toBe("b\na\nc");
  });

  it("indents and outdents list items by two spaces, leaving other lines to the default Tab", () => {
    expect(run(indentListItem, "- a\n- b^").text).toBe("- a\n  - b");
    expect(run(indentListItem, "1. a\n2. b^").text).toBe("1. a\n  2. b");
    expect(run(indentListItem, "- [ ] a^").text).toBe("  - [ ] a");
    expect(run(indentListItem, "«- a\n- b»").text).toBe("  - a\n  - b");
    expect(run(outdentListItem, "- a\n  - b^").text).toBe("- a\n- b");
    expect(run(outdentListItem, "- a\n * b^").text).toBe("- a\n* b");
    expect(run(outdentListItem, "- a^").handled).toBe(true);
    expect(run(indentListItem, "plain^").handled).toBe(false);
    expect(run(outdentListItem, "plain^").handled).toBe(false);
  });

  it("continues bullets, numbers, and checkboxes with an empty checkbox on Enter", () => {
    expect(run(continueListItem, "- [x] done^")).toMatchObject({
      text: "- [x] done\n- [ ] ",
      cursor: "- [x] done\n- [ ] ".length,
    });
    expect(run(continueListItem, "- [ ] item^").text).toBe("- [ ] item\n- [ ] ");
    expect(run(continueListItem, "  * nested^").text).toBe("  * nested\n  * ");
    expect(run(continueListItem, "9. nine^").text).toBe("9. nine\n10. ");
    expect(run(continueListItem, "- spl^it").text).toBe("- spl\n- it");
  });

  it("removes an empty bullet or checkbox marker on Enter instead of continuing", () => {
    expect(run(continueListItem, "- a\n- ^")).toMatchObject({ text: "- a\n", cursor: 4 });
    expect(run(continueListItem, "- [ ] a\n- [ ] ^").text).toBe("- [ ] a\n");
    expect(run(continueListItem, "  - ^").text).toBe("");
  });

  it("does not handle Enter outside list items or inside fenced code", () => {
    expect(run(continueListItem, "plain^").handled).toBe(false);
    expect(run(continueListItem, "```\n- not a list^\n```").handled).toBe(false);
  });
});

describe("smart paste", () => {
  const paste = (marked: string, clip: string) => {
    const spec = smartPaste(stateOf(marked), clip);
    if (!spec) {
      return null;
    }
    return stateOf(marked).update(spec).state.doc.toString();
  };

  it("wraps a non-URL selection as a Markdown link when pasting an http(s) URL", () => {
    expect(paste("see «docs» here", "https://example.com/a?b=1")).toBe(
      "see [docs](https://example.com/a?b=1) here",
    );
    expect(paste("see «docs» here", "  http://example.com  ")).toBe(
      "see [docs](http://example.com) here",
    );
  });

  it("leaves URL paste alone without a selection, onto a URL, or for non-http schemes", () => {
    expect(paste("see ^ here", "https://example.com")).toBeNull();
    expect(paste("«https://old.example»", "https://example.com")).toBeNull();
    expect(paste("«docs»", "javascript:alert(1)")).toBeNull();
    expect(paste("«docs»", "https://example.com and more")).toBeNull();
  });

  it("converts pasted spreadsheet TSV into a GFM table", () => {
    expect(paste("^", "Name\tQty\nApple\t3\nPear|x\t\r\n")).toBe(
      "| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Pear\\|x |  |",
    );
    expect(tsvToMarkdownTable("one\ttwo")).toBeNull();
    expect(tsvToMarkdownTable("a\nb")).toBeNull();
  });
});

describe("accessory bar commands", () => {
  it("toggles a task box, turning plain lines and bullets into tasks without touching other bytes", () => {
    expect(run(toggleTask, "- [ ] a^\nb").text).toBe("- [x] a\nb");
    expect(run(toggleTask, "  * [X] a^").text).toBe("  * [ ] a");
    expect(run(toggleTask, "1. item^").text).toBe("1. [ ] item");
    expect(run(toggleTask, "- item^").text).toBe("- [ ] item");
    expect(run(toggleTask, "plain^").text).toBe("- [ ] plain");
    expect(run(toggleTask, "plain^").cursor).toBe("- [ ] plain".length);
    expect(run(toggleTask, "«a\nb»").text).toBe("- [ ] a\n- [ ] b");
  });

  it("cycles the heading level of the current line: none, #, ##, ###, none", () => {
    expect(run(cycleHeading, "Title^").text).toBe("# Title");
    expect(run(cycleHeading, "# Title^").text).toBe("## Title");
    expect(run(cycleHeading, "## Title^").text).toBe("### Title");
    expect(run(cycleHeading, "### Title^").text).toBe("Title");
    expect(run(cycleHeading, "###### Deep^").text).toBe("Deep");
  });

  it("starts a wikilink at the cursor or wraps the selection", () => {
    const empty = run(insertWikilink, "see ^");
    expect(empty.text).toBe("see [[]]");
    expect(empty.cursor).toBe(6);
    expect(run(insertWikilink, "see «Plan»").text).toBe("see [[Plan]]");
  });
});
