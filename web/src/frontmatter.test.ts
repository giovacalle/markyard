import { describe, expect, it } from "vite-plus/test";
import { extractFrontmatterTags, normalizeFrontmatterFence, parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("reads scalar, inline-list, and block-list properties and locates the raw block", () => {
    const text =
      "\uFEFF---\r\ntitle: \"Trip: Rome\"\r\ntags: [travel, '2026']\r\naliases:\r\n  - Roma\r\n  - Eternal City\r\ndraft: true\r\n---\r\n# Body\r\n";
    const fm = parseFrontmatter(text);
    expect(fm?.properties).toEqual([
      { key: "title", value: "Trip: Rome" },
      { key: "tags", value: ["travel", "2026"] },
      { key: "aliases", value: ["Roma", "Eternal City"] },
      { key: "draft", value: "true" },
    ]);
    expect(text.slice(0, fm?.end)).toBe(
      "\uFEFF---\r\ntitle: \"Trip: Rome\"\r\ntags: [travel, '2026']\r\naliases:\r\n  - Roma\r\n  - Eternal City\r\ndraft: true\r\n---",
    );
    expect(fm?.endLine).toBe(8);
  });

  it("splits a plain tags string into tags and accepts `...` as the closing fence", () => {
    expect(parseFrontmatter("---\ntags: a, b #c\n...\n")?.properties).toEqual([
      { key: "tags", value: ["a", "b", "c"] },
    ]);
  });

  it("strips leading `#` from tag values across inline bracket lists and block lists", () => {
    const inline = '---\ntags: [#alpha, "#beta", gamma]\n---\n';
    expect(parseFrontmatter(inline)?.properties).toEqual([
      { key: "tags", value: ["alpha", "beta", "gamma"] },
    ]);

    const block = "---\ntags:\n  - #work\n  - '#project'\n  - personal\n  - #\n---\n";
    expect(parseFrontmatter(block)?.properties).toEqual([
      { key: "tags", value: ["work", "project", "personal"] },
    ]);
    expect(extractFrontmatterTags("---\ntags:\n  - #Work\nkeywords: [work, #ops]\n---\n")).toEqual([
      "Work",
      "ops",
    ]);
  });

  it("normalizes a `...` closing fence to `---` without shifting any body offsets", () => {
    const raw = "\uFEFF---\r\ntitle: Hi\r\n...  \r\n- [ ] task\r\n";
    const normalized = normalizeFrontmatterFence(raw);
    expect(normalized).toBe("\uFEFF---\r\ntitle: Hi\r\n---  \r\n- [ ] task\r\n");
    expect(normalized.length).toBe(raw.length);
    expect(normalized.indexOf("- [ ] task")).toBe(raw.indexOf("- [ ] task"));

    const already = "---\ntitle: Hi\n---\n# Body\n";
    expect(normalizeFrontmatterFence(already)).toBe(already);
  });

  it("returns null without an opening and closing fence at the top of the note", () => {
    expect(parseFrontmatter("# Title\n---\na: b\n---\n")).toBeNull();
    expect(parseFrontmatter("---\na: b\n")).toBeNull();
    expect(parseFrontmatter("")).toBeNull();
  });
});
