import { describe, expect, it } from "vite-plus/test";
import { toggleTaskAt, toggleTaskIfUnchanged } from "./taskToggle";

describe("toggleTaskAt", () => {
  it("flips only the checkbox character of the list item starting at the offset", () => {
    const text = "- [ ] one\n- [x] two\n";
    expect(toggleTaskAt(text, 0)).toBe("- [x] one\n- [x] two\n");
    expect(toggleTaskAt(text, 10)).toBe("- [ ] one\n- [ ] two\n");
  });

  it("supports `*`, `+`, ordered markers, uppercase X and nested indentation", () => {
    expect(toggleTaskAt("* [ ] a", 0)).toBe("* [x] a");
    expect(toggleTaskAt("+ [X] a", 0)).toBe("+ [ ] a");
    expect(toggleTaskAt("12. [ ] a", 0)).toBe("12. [x] a");
    expect(toggleTaskAt("1) [x] a", 0)).toBe("1) [ ] a");
    const nested = "- [ ] parent\n  - [ ] child\n";
    expect(toggleTaskAt(nested, nested.indexOf("- [ ] child"))).toBe(
      "- [ ] parent\n  - [x] child\n",
    );
  });

  it("keeps CRLF, frontmatter, wikilinks and spacing byte-for-byte", () => {
    const text = "---\r\ntags: [a]\r\n---\r\n\r\n-   [ ]  see [[Other Note]]  \r\n";
    const offset = text.indexOf("-   [ ]");
    expect(toggleTaskAt(text, offset)).toBe(
      "---\r\ntags: [a]\r\n---\r\n\r\n-   [x]  see [[Other Note]]  \r\n",
    );
  });

  it("returns null when the offset is not at a task list item", () => {
    expect(toggleTaskAt("- plain item", 0)).toBeNull();
    expect(toggleTaskAt("text - [ ] x", 0)).toBeNull();
    expect(toggleTaskAt("- [ ] a", 99)).toBeNull();
    expect(toggleTaskAt("- [ ] a", -1)).toBeNull();
  });
});

describe("toggleTaskIfUnchanged", () => {
  it("flips the task when offset, text, and done state match", () => {
    const text = "- [ ] A\n- [ ] B\n- [x] C\n";
    expect(toggleTaskIfUnchanged(text, { offset: 8, text: "B", done: false })).toBe(
      "- [ ] A\n- [x] B\n- [x] C\n",
    );
    expect(toggleTaskIfUnchanged(text, { offset: 16, text: "C", done: true })).toBe(
      "- [ ] A\n- [ ] B\n- [ ] C\n",
    );
  });

  it("returns null when offset points at a different task", () => {
    const text = "- [ ] B\n- [ ] C\n";
    expect(toggleTaskIfUnchanged(text, { offset: 8, text: "B", done: false })).toBeNull();
  });

  it("returns null when text differs at the same offset", () => {
    const text = "- [ ] Updated B\n";
    expect(toggleTaskIfUnchanged(text, { offset: 0, text: "B", done: false })).toBeNull();
  });

  it("returns null when done state differs at the same offset", () => {
    const text = "- [x] B\n";
    expect(toggleTaskIfUnchanged(text, { offset: 0, text: "B", done: false })).toBeNull();
  });

  it("returns null when no task exists at the offset", () => {
    const text = "Plain paragraph\n- [ ] B\n";
    expect(toggleTaskIfUnchanged(text, { offset: 0, text: "B", done: false })).toBeNull();
    expect(toggleTaskIfUnchanged(text, { offset: 99, text: "B", done: false })).toBeNull();
  });

  it("returns null when the offset is inside a fenced code block", () => {
    const text = "```md\n- [ ] B\n```\n";
    const offset = text.indexOf("- [ ] B");
    expect(toggleTaskIfUnchanged(text, { offset, text: "B", done: false })).toBeNull();
  });

  it("matches a task on the first line after a leading BOM", () => {
    const text = "\uFEFF- [ ] first\n- [ ] second\n";
    expect(toggleTaskIfUnchanged(text, { offset: 1, text: "first", done: false })).toBe(
      "\uFEFF- [x] first\n- [ ] second\n",
    );
  });
});
