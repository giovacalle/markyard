import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConflictMerge } from "./components/ConflictMerge";
import { Editor } from "./components/Editor";
import { RevisionDiff } from "./components/RevisionDiff";
import { mountSvgInShadow } from "./cspSafeSvg";
import {
  adoptUserSheet,
  compileCustomCss,
  customCssDisabledByQuery,
  extractCssBlocks,
  getCustomCssSheet,
  getCustomCssStatusText,
  resetCustomCssForTests,
  setCustomCss,
} from "./customCss";

afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("extractCssBlocks and compileCustomCss", () => {
  it("extracts only exact css fenced blocks in document order", () => {
    const md = [
      "# Styles",
      "",
      "```css",
      ".a { color: red; }",
      "```",
      "",
      "```css2",
      ".ignored-1 { color: green; }",
      "```",
      "",
      "```scss",
      ".ignored-2 { color: yellow; }",
      "```",
      "",
      "```CSS x",
      ".ignored-3 { color: pink; }",
      "```",
      "",
      "```CSS",
      ".ignored-4 { color: purple; }",
      "```",
      "",
      "~~~  css  ",
      ".b { color: blue; }",
      "~~~",
      "",
      "````markdown",
      "```css",
      ".nested-ignored { color: orange; }",
      "```",
      "````",
      "",
      "````css",
      "/* fence with 3 backticks inside stays in block */",
      "```",
      ".c { color: teal; }",
      "````",
    ].join("\n");

    expect(extractCssBlocks(md)).toEqual([
      ".a { color: red; }",
      ".b { color: blue; }",
      "/* fence with 3 backticks inside stays in block */\n```\n.c { color: teal; }",
    ]);
  });

  it("concatenates notes in localeCompare name order and blocks in document order", () => {
    const css = compileCustomCss([
      { name: "z.md", text: "```css\n.z { opacity: 0.5; }\n```" },
      {
        name: "a.md",
        text: "```css\n.a1 { color: red; }\n```\n\n```css\n.a2 { color: blue; }\n```",
      },
      { name: "m.md", text: "No css blocks here." },
    ]);

    expect(css).toBe(".a1 { color: red; }\n\n.a2 { color: blue; }\n\n.z { opacity: 0.5; }");
  });
});

describe("shared constructable sheet and shadow roots", () => {
  it("adopts the shared sheet last on document and all four shadow-root hosts and updates in place", async () => {
    setCustomCss(".x { color: red; }");
    const sheet = getCustomCssSheet();
    expect(sheet).not.toBeNull();
    expect(document.adoptedStyleSheets.at(-1)).toBe(sheet);

    const { unmount: unmountEditor } = render(<Editor initialText="# Hi" onChange={vi.fn()} />);
    const { unmount: unmountMerge } = render(
      <ConflictMerge mine={"a\n"} remote={"b\n"} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    const { unmount: unmountDiff } = render(<RevisionDiff current={"a\n"} revision={"b\n"} />);
    const svgHost = document.createElement("div");
    document.body.append(svgHost);
    mountSvgInShadow(svgHost, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "");

    try {
      const roots = await vi.waitFor(() => {
        const editorShadow = screen.getByTestId("editor-host").shadowRoot;
        const mergeShadow = screen.getByTestId("merge-host").shadowRoot;
        const diffShadow = screen.getByTestId("revision-diff-host").shadowRoot;
        const svgShadow = svgHost.shadowRoot;
        if (!editorShadow || !mergeShadow || !diffShadow || !svgShadow) {
          throw new Error("Shadow root not mounted yet");
        }
        return [editorShadow, mergeShadow, diffShadow, svgShadow] as const;
      });

      for (const root of roots) {
        expect(root.adoptedStyleSheets.at(-1)).toBe(sheet);
      }
      expect(sheet!.cssRules[0]?.cssText).toContain("red");

      setCustomCss(".y { color: blue; }");
      expect(getCustomCssSheet()).toBe(sheet);
      expect(document.adoptedStyleSheets.at(-1)).toBe(sheet);
      for (const root of roots) {
        expect(root.adoptedStyleSheets.at(-1)).toBe(sheet);
      }
      expect(sheet!.cssRules[0]?.cssText).toContain("blue");
    } finally {
      unmountEditor();
      unmountMerge();
      unmountDiff();
      svgHost.remove();
    }
  });

  it("lets unlayered user rules beat layered app rules without !important", () => {
    const appSheet = new CSSStyleSheet();
    appSheet.replaceSync("@layer components { .markdown-preview h1 { color: rgb(0, 0, 255); } }");
    document.adoptedStyleSheets = [appSheet];

    const container = document.createElement("div");
    container.className = "markdown-preview";
    const heading = document.createElement("h1");
    heading.textContent = "Title";
    container.append(heading);
    document.body.append(container);

    try {
      expect(getComputedStyle(heading).color).toBe("rgb(0, 0, 255)");
      setCustomCss(".markdown-preview h1 { color: rgb(255, 0, 0); }");
      expect(getComputedStyle(heading).color).toBe("rgb(255, 0, 0)");
    } finally {
      container.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== appSheet);
    }
  });

  it("stays unadopted and empty when disabled by ?nocss=1", () => {
    history.replaceState(null, "", "/?nocss=1");
    resetCustomCssForTests();

    expect(customCssDisabledByQuery()).toBe(true);
    setCustomCss(".x { color: red; }");

    const sheet = getCustomCssSheet();
    expect(sheet === null || sheet.cssRules.length === 0).toBe(true);
    expect(sheet === null || !document.adoptedStyleSheets.includes(sheet)).toBe(true);

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    adoptUserSheet(shadow);
    expect(shadow.adoptedStyleSheets).toHaveLength(0);
    expect(getCustomCssStatusText()).toBe("Disabled for this load by ?nocss=1");
  });
});

describe("test-setup custom CSS isolation", () => {
  it("applies custom CSS in the first test", () => {
    setCustomCss(".leak-check { color: red; }");
    const sheet = getCustomCssSheet()!;
    expect(sheet.cssRules.length).toBe(1);
    expect(document.adoptedStyleSheets).toContain(sheet);
  });

  it("starts with an empty, unadopted sheet in the next test", () => {
    const sheet = getCustomCssSheet()!;
    expect(sheet.cssRules.length).toBe(0);
    expect(document.adoptedStyleSheets).not.toContain(sheet);
  });
});
