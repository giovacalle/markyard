import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Preview } from "./components/Preview";

const lazyModules = vi.hoisted(() => ({ math: 0, mermaid: 0 }));
const renderMermaidInto = vi.hoisted(() =>
  vi.fn(async (host: HTMLElement, source: string) => {
    host.setAttribute("data-rendered", source);
  }),
);

vi.mock("./mermaidRender", () => {
  lazyModules.mermaid += 1;
  return { renderMermaidInto };
});

vi.mock("./mathPlugins", async (importOriginal) => {
  lazyModules.math += 1;
  return importOriginal();
});

afterEach(() => {
  renderMermaidInto.mockClear();
  vi.restoreAllMocks();
});

describe("Preview lazy modules", () => {
  // Runs first: proves notes without diagrams or math never import the heavy chunks.
  it("does not load Mermaid or KaTeX for notes without diagrams or math", async () => {
    render(
      <Preview text={"# Plain\n\nNo diagrams, `$code$` only.\n\n```js\nlet a = '$x$';\n```\n"} />,
    );
    expect(await screen.findByRole("heading", { name: "Plain" })).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(lazyModules).toEqual({ math: 0, mermaid: 0 });
  });

  it("lazy-loads KaTeX for inline and block math", async () => {
    const { container } = render(
      <Preview text={"Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$\n"} />,
    );
    await waitFor(() => expect(container.querySelectorAll(".katex").length).toBe(2));
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(lazyModules.math).toBe(1);
  });

  it("lazy-renders Mermaid fences through the CSP-safe renderer", async () => {
    render(<Preview text={"```mermaid\ngraph TD\n  A-->B\n```\n"} />);
    const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
    await waitFor(() => expect(diagram).toHaveAttribute("data-rendered", "graph TD\n  A-->B"));
    expect(renderMermaidInto).toHaveBeenCalledWith(diagram, "graph TD\n  A-->B", false);
    expect(lazyModules.mermaid).toBe(1);
  });

  it("falls back to the diagram source when Mermaid fails to render", async () => {
    renderMermaidInto.mockRejectedValueOnce(new Error("Parse error on line 1"));
    render(<Preview text={"```mermaid\nnot a diagram\n```\n"} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to render this diagram");
    expect(screen.getByText("not a diagram")).toBeInTheDocument();
  });
});

describe("Preview task checkboxes", () => {
  const text = [
    "---",
    "todo: |",
    "  - [ ] not a task in frontmatter",
    "---",
    "",
    "- [ ] first",
    "  - [x] nested done",
    "1. [ ] ordered",
    "",
    "```md",
    "- [ ] not a task in code",
    "```",
    "",
  ].join("\r\n");

  it("toggles the exact source checkbox and leaves every other byte untouched", () => {
    const onToggleTask = vi.fn();
    render(<Preview text={text} onToggleTask={onToggleTask} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);

    fireEvent.click(screen.getByRole("checkbox", { name: "nested done" }));
    expect(onToggleTask).toHaveBeenLastCalledWith(
      text.replace("  - [x] nested done", "  - [ ] nested done"),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "ordered" }));
    expect(onToggleTask).toHaveBeenLastCalledWith(text.replace("1. [ ] ordered", "1. [x] ordered"));
    expect(onToggleTask).toHaveBeenCalledTimes(2);
  });

  it("accounts for a leading BOM, which the Markdown parser drops from source offsets", () => {
    const onToggleTask = vi.fn();
    render(<Preview text={"\uFEFF- [ ] a\n- [ ] b"} onToggleTask={onToggleTask} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "b" }));
    expect(onToggleTask).toHaveBeenCalledWith("\uFEFF- [ ] a\n- [x] b");
  });

  it("stops click propagation so the surrounding click-to-edit does not fire", () => {
    const onContainerClick = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onContainerClick}>
        <Preview text={"- [ ] task"} onToggleTask={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "task" }));
    expect(onContainerClick).not.toHaveBeenCalled();
  });

  it("keeps checkboxes disabled without a toggle handler", () => {
    render(<Preview text={"- [ ] task"} />);
    expect(screen.getByRole("checkbox", { name: "task" })).toBeDisabled();
  });
});

describe("Preview callouts", () => {
  it.each([
    ["NOTE", "Note"],
    ["tip", "Tip"],
    ["Important", "Important"],
    ["WARNING", "Warning"],
    ["caution", "Caution"],
  ])("renders > [!%s] as an accessible %s callout", (marker, label) => {
    const { container } = render(<Preview text={`> [!${marker}]\n> Body text`} />);
    const callout = screen.getByRole("note", { name: label });
    expect(callout).toHaveClass(`callout-${label.toLowerCase()}`);
    expect(within(callout).getByText("Body text")).toBeInTheDocument();
    expect(callout).not.toHaveTextContent(`[!${marker}]`);
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("uses a custom title from the first line", () => {
    render(<Preview text={"> [!WARNING] Mind the gap\n> Details here"} />);
    const callout = screen.getByRole("note", { name: "Mind the gap" });
    expect(callout).toHaveClass("callout-warning");
    expect(within(callout).getByText("Details here")).toBeInTheDocument();
  });

  it("leaves plain blockquotes and unknown markers unchanged", () => {
    const { container } = render(<Preview text={"> just a quote\n\n> [!FOO] odd"} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(container.querySelectorAll("blockquote")).toHaveLength(2);
    expect(screen.getByText("[!FOO] odd")).toBeInTheDocument();
  });
});

describe("Preview code blocks", () => {
  it("shows the language, highlights tokens with classes and copies the raw code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onContainerClick = vi.fn();
    const { container } = render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onContainerClick}>
        <Preview text={"```ts\nconst x = 42;\nconsole.log(x);\n```\n"} />
      </div>,
    );
    const figure = screen.getByRole("figure", { name: "ts code" });
    expect(within(figure).getByText("ts")).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector("pre code .hljs-keyword")).toHaveTextContent("const"),
    );
    expect(container.querySelector("[style]")).toBeNull();

    fireEvent.click(within(figure).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const x = 42;\nconsole.log(x);");
    expect(await within(figure).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(onContainerClick).not.toHaveBeenCalled();
  });

  it("offers Copy on fences without a language", () => {
    render(<Preview text={"```\nplain\n```\n"} />);
    const figure = screen.getByRole("figure", { name: "Code" });
    expect(within(figure).getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});

describe("Preview images", () => {
  it("renders attachment blobs as responsive, lazy images", () => {
    render(<Preview text={"![Screen shot](/api/files/img-1/blob)\n"} />);
    const img = screen.getByRole("img", { name: "Screen shot" });
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "/api/files/img-1/blob");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img.className).toContain("max-w-full");
    expect(img).not.toHaveAttribute("style");
  });

  it("falls back to the alt text when an image cannot load (e.g. offline)", () => {
    render(<Preview text={"![Diagram](/api/files/img-2/blob)\n"} />);
    fireEvent.error(screen.getByRole("img", { name: "Diagram" }));
    const fallback = screen.getByRole("img", { name: "Diagram" });
    expect(fallback.tagName).toBe("SPAN");
    expect(fallback).toHaveTextContent("Image unavailable: Diagram");
  });

  it("never loads unsafe or cross-origin image URLs", () => {
    const { container } = render(
      <Preview
        text={[
          "![a](javascript:alert(1))",
          "![b](data:text/html,<script>alert(1)</script>)",
          "![c](https://evil.example/x.png)",
          "![d](//evil.example/y.png)",
          "![Uploading shot.png…]()",
        ].join("\n\n")}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "c" })).toHaveTextContent("Image blocked: c");
    expect(screen.getByRole("img", { name: "Uploading shot.png…" })).toHaveTextContent(
      "Uploading shot.png…",
    );
  });
});
