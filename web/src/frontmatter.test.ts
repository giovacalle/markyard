import { describe, expect, it } from "vite-plus/test";
import {
  addFrontmatterProperty,
  deleteFrontmatterProperty,
  ensureFrontmatter,
  extractFrontmatterTags,
  formatYamlScalar,
  joinFrontmatter,
  normalizeFrontmatterFence,
  parseFrontmatter,
  parseFrontmatterEditable,
  setFrontmatterProperty,
  setFrontmatterTags,
  splitFrontmatter,
} from "./frontmatter";

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

describe("parseFrontmatterEditable", () => {
  it("records exact spans, BOM/CRLF/fence metadata, and property kinds", () => {
    const text = [
      "\uFEFF---",
      "# top comment",
      'title: "Trip: Rome"',
      "draft: true",
      'flagText: "true"',
      "tags: [#travel, '2026']",
      "aliases:",
      "  - Roma",
      "  - Eternal City",
      "...",
      "",
      "# Body",
    ].join("\r\n");

    const fm = parseFrontmatterEditable(text);
    expect(fm).not.toBeNull();
    expect(fm?.bom).toBe(true);
    expect(fm?.eol).toBe("\r\n");
    expect(fm?.closingFence).toBe("...");
    expect(fm?.hasComments).toBe(true);
    expect(fm?.raw).toBe(text.slice(0, fm?.closeEnd));
    expect(text.slice(fm!.bodyStart)).toBe("# Body");

    expect(fm?.properties.map((p) => ({ key: p.key, kind: p.kind, style: p.style }))).toEqual([
      { key: "title", kind: "text", style: "scalar" },
      { key: "draft", kind: "boolean", style: "scalar" },
      { key: "flagText", kind: "text", style: "scalar" },
      { key: "tags", kind: "tags", style: "flow-list" },
      { key: "aliases", kind: "list", style: "block-list" },
    ]);
    expect(fm?.properties[1].booleanValue).toBe(true);
    expect(fm?.properties[2].value).toBe("true");
    expect(fm?.properties[3].listItems).toEqual(["travel", "2026"]);
    expect(fm?.properties[4].listItems).toEqual(["Roma", "Eternal City"]);
  });

  it("classifies complex YAML constructs safely without losing their full block span", () => {
    const text = [
      "---",
      "summary: |",
      "  line one",
      "  line two",
      "folded: >-",
      "  folded text",
      "author:",
      "  name: Ada",
      "  role: Architect",
      "items:",
      "  - name: Alpha",
      "    qty: 2",
      "inlineMap: { a: 1, b: 2 }",
      "nestedFlow: [[1, 2], [3, 4]]",
      "anchor: &def base",
      "alias: *def",
      "status: ready",
      "---",
      "",
      "Body",
    ].join("\n");

    const fm = parseFrontmatterEditable(text);
    expect(fm).not.toBeNull();
    const kinds = fm!.properties.map((p) => [p.key, p.kind]);
    expect(kinds).toEqual([
      ["summary", "complex"],
      ["folded", "complex"],
      ["author", "complex"],
      ["items", "complex"],
      ["inlineMap", "complex"],
      ["nestedFlow", "complex"],
      ["anchor", "complex"],
      ["alias", "complex"],
      ["status", "text"],
    ]);

    // Block span for nested map covers both indented child lines.
    const author = fm!.properties[2];
    expect(text.slice(author.blockStart, author.blockEnd)).toBe(
      "author:\n  name: Ada\n  role: Architect",
    );

    // Editing a complex property is a strict no-op; editing a sibling leaves complex YAML untouched.
    expect(setFrontmatterProperty(text, 2, "overwrite")).toBe(text);
    const updated = setFrontmatterProperty(text, 8, "published");
    expect(updated).toBe(text.replace("status: ready", "status: published"));
  });
});

describe("splitFrontmatter & joinFrontmatter", () => {
  it("always satisfies frontmatterRaw + body === text and computes accurate body line offsets", () => {
    const cases: Array<{
      name: string;
      text: string;
      expectedBody: string;
      expectedLines: number;
    }> = [
      {
        name: "no frontmatter",
        text: "# Hello\nworld",
        expectedBody: "# Hello\nworld",
        expectedLines: 0,
      },
      {
        name: "single newline after fence",
        text: "---\nstatus: ready\n---\n# Heading\n",
        expectedBody: "# Heading\n",
        expectedLines: 3,
      },
      {
        name: "blank separator line after fence",
        text: "---\nstatus: ready\n---\n\n# Heading\n",
        expectedBody: "# Heading\n",
        expectedLines: 4,
      },
      {
        name: "multiple blank lines keep extras in body",
        text: "---\nstatus: ready\n---\n\n\n# Heading\n",
        expectedBody: "\n# Heading\n",
        expectedLines: 4,
      },
      {
        name: "CRLF + BOM + ... fence",
        text: "\uFEFF---\r\na: 1\r\n...\r\n\r\nBody",
        expectedBody: "Body",
        expectedLines: 4,
      },
      {
        name: "frontmatter only without trailing newline",
        text: "---\na: 1\n---",
        expectedBody: "",
        expectedLines: 3,
      },
    ];

    for (const c of cases) {
      const split = splitFrontmatter(c.text);
      expect(split.frontmatterRaw + split.body, c.name).toBe(c.text);
      expect(split.body, c.name).toBe(c.expectedBody);
      expect(split.frontmatterLineCount, c.name).toBe(c.expectedLines);
      expect(joinFrontmatter(split.frontmatterRaw, split.body), c.name).toBe(c.text);
    }
  });

  it("inserts a line break in joinFrontmatter when body is added after a fence with no trailing EOL", () => {
    const split = splitFrontmatter("---\r\na: 1\r\n---");
    expect(joinFrontmatter(split.frontmatterRaw, "Hello")).toBe("---\r\na: 1\r\n---\r\nHello");
  });
});

describe("surgical frontmatter mutations", () => {
  it("ensureFrontmatter creates a block preserving BOM and CRLF and is idempotent", () => {
    expect(ensureFrontmatter("# Hello\n")).toBe("---\n---\n\n# Hello\n");
    expect(ensureFrontmatter("")).toBe("---\n---\n");
    expect(ensureFrontmatter("\uFEFF# Hello\r\nWorld\r\n")).toBe(
      "\uFEFF---\r\n---\r\n\r\n# Hello\r\nWorld\r\n",
    );
    const existing = "---\nstatus: ready\n---\n# Hello\n";
    expect(ensureFrontmatter(existing)).toBe(existing);
  });

  it("addFrontmatterProperty creates frontmatter when absent and safely quotes scalars", () => {
    let text = "# My Note\n";
    text = addFrontmatterProperty(text, "status", "ready");
    expect(text).toBe("---\nstatus: ready\n---\n\n# My Note\n");

    text = addFrontmatterProperty(text, "draft", false);
    text = addFrontmatterProperty(text, "title", "Note: part #1");
    text = addFrontmatterProperty(text, "literalBool", "true");
    text = addFrontmatterProperty(text, "tags", ["#alpha", "beta", "Alpha"]);
    expect(text).toBe(
      [
        "---",
        "status: ready",
        "draft: false",
        'title: "Note: part #1"',
        'literalBool: "true"',
        "tags: [alpha, beta]",
        "---",
        "",
        "# My Note\n",
      ].join("\n"),
    );
  });

  it("quotes YAML special values cleanly in formatYamlScalar", () => {
    expect(formatYamlScalar("ready")).toBe("ready");
    expect(formatYamlScalar("2026-11-23")).toBe("2026-11-23");
    expect(formatYamlScalar("a: b")).toBe('"a: b"');
    expect(formatYamlScalar("color #fff")).toBe('"color #fff"');
    expect(formatYamlScalar(" padded ")).toBe('" padded "');
    expect(formatYamlScalar("[array]")).toBe('"[array]"');
    expect(formatYamlScalar("- item")).toBe('"- item"');
    expect(formatYamlScalar("null")).toBe('"null"');
    expect(formatYamlScalar("a, b", { flow: true })).toBe('"a, b"');
  });

  it("setFrontmatterProperty updates scalars, booleans, inline comments, and block lists surgically", () => {
    const text = [
      "\uFEFF---",
      "# header comment",
      "status: ready  # keep inline",
      "empty: # keep empty comment",
      "draft: true",
      "aliases:",
      "    - One",
      "    - Two",
      "...",
      "",
      "# Body",
    ].join("\r\n");

    let next = setFrontmatterProperty(text, 0, "done");
    expect(next).toContain("status: done  # keep inline");

    next = setFrontmatterProperty(next, 1, "filled");
    expect(next).toContain("empty: filled # keep empty comment");

    next = setFrontmatterProperty(next, 1, "");
    expect(next).toContain("empty: # keep empty comment");

    next = setFrontmatterProperty(next, 2, false);
    expect(next).toContain("draft: false");

    // Block list preserves 4-space indentation and CRLF.
    next = setFrontmatterProperty(next, 3, ["Uno", "Due", "Tre: 3"]);
    expect(next).toBe(
      [
        "\uFEFF---",
        "# header comment",
        "status: done  # keep inline",
        "empty: # keep empty comment",
        "draft: false",
        "aliases:",
        "    - Uno",
        "    - Due",
        '    - "Tre: 3"',
        "...",
        "",
        "# Body",
      ].join("\r\n"),
    );
  });

  it("setFrontmatterTags preserves flow/block/scalar styles, deduplicates, and adds when missing", () => {
    // Flow list preserved
    const flow = "---\n# keep\ntags: [one, two]\n---\n\nBody";
    expect(setFrontmatterTags(flow, ["#One", "three", "THREE"])).toBe(
      "---\n# keep\ntags: [One, three]\n---\n\nBody",
    );

    // Block list preserved with indent
    const block = "---\ntags:\n  - alpha\n  - beta\n---\nBody";
    expect(setFrontmatterTags(block, ["alpha", "gamma"])).toBe(
      "---\ntags:\n  - alpha\n  - gamma\n---\nBody",
    );
    expect(setFrontmatterTags(block, [])).toBe("---\ntags: []\n---\nBody");

    // Plain scalar tags line: 1 tag stays scalar, multiple become flow list
    const scalar = "---\ntags: test\n---\nBody";
    expect(setFrontmatterTags(scalar, ["#prod"])).toBe("---\ntags: prod\n---\nBody");
    expect(setFrontmatterTags(scalar, ["test", "prod"])).toBe("---\ntags: [test, prod]\n---\nBody");

    // Note without frontmatter
    expect(setFrontmatterTags("# Note\n", [])).toBe("# Note\n");
    expect(setFrontmatterTags("# Note\n", ["#work", "Work", "ideas"])).toBe(
      "---\ntags: [work, ideas]\n---\n\n# Note\n",
    );
  });

  it("deleteFrontmatterProperty preserves sibling bytes and removes empty uncommented frontmatter", () => {
    const multi = "\uFEFF---\r\n# keep\r\na: 1\r\nb: 2\r\n...\r\n\r\n# Body";
    expect(deleteFrontmatterProperty(multi, 0)).toBe(
      "\uFEFF---\r\n# keep\r\nb: 2\r\n...\r\n\r\n# Body",
    );

    // Last property removed WITHOUT comments -> cleanly removes frontmatter + blank separator line
    expect(deleteFrontmatterProperty("---\nstatus: ready\n---\n\n# Body", 0)).toBe("# Body");
    expect(deleteFrontmatterProperty("\uFEFF---\r\nstatus: ready\r\n---\r\n\r\n# Body", 0)).toBe(
      "\uFEFF# Body",
    );
    expect(deleteFrontmatterProperty("---\nstatus: ready\n---", 0)).toBe("");

    // Last property removed WITH comments -> keeps comments intact
    expect(deleteFrontmatterProperty("---\n# keep me\nstatus: ready\n---\n\n# Body", 0)).toBe(
      "---\n# keep me\n---\n\n# Body",
    );
  });
});
