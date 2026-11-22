import { describe, expect, it } from "vite-plus/test";
import { toggleTaskAt } from "./taskToggle";

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
