import { describe, expect, it } from "vite-plus/test";
import { documentStats } from "./documentStats";

describe("documentStats", () => {
  it("counts words, characters and lines of the body, ignoring frontmatter and Markdown markers", () => {
    const text = "---\ntitle: Ignored words here\n---\n# Hello world\n\n- [ ] buy [[Milk Bar]]\n";
    const stats = documentStats(text);
    expect(stats.words).toBe(5);
    expect(stats.characters).toBe("# Hello world- [ ] buy [[Milk Bar]]".length);
    expect(stats.lines).toBe(7);
  });

  it("does not count task boxes as words", () => {
    expect(documentStats("- [x] done\n- [ ] open item").words).toBe(3);
  });

  it("counts done and total tasks outside fenced code, across list markers and CRLF", () => {
    const text =
      "- [x] a\r\n  * [ ] b\r\n1. [X] c\r\n```\r\n- [ ] not a task\r\n```\r\n- [] nope\r\n";
    expect(documentStats(text).tasks).toEqual({ done: 2, total: 3 });
  });

  it("estimates reading time at 200 words per minute, rounding up, and 0 for an empty note", () => {
    expect(documentStats("").readingMinutes).toBe(0);
    expect(documentStats("").lines).toBe(0);
    expect(documentStats("word ".repeat(200)).readingMinutes).toBe(1);
    expect(documentStats("word ".repeat(201)).readingMinutes).toBe(2);
  });

  it("counts characters by code point and skips a leading BOM", () => {
    expect(documentStats("\uFEFFé😀").characters).toBe(2);
  });
});
