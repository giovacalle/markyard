// Helpers that let third-party SVG renderers (Mermaid) run under the strict CSP in
// `public/_headers`: inline `style` attributes and `<style>` elements are refused there, while
// CSSOM writes and constructable stylesheets (`adoptedStyleSheets`) are allowed.

import { adoptUserSheet } from "./customCss";

let running: Promise<unknown> = Promise.resolve();

function sheetFrom(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

/**
 * Runs `task` while `setAttribute("style", …)` is redirected to `element.style.cssText` and
 * `document.createElement("style")` returns an inert stand-in whose CSS is applied through
 * `document.adoptedStyleSheets` for the duration of the task. Calls are serialized because the
 * patches are global. Resolves with the task
 * result and the CSS captured from `<style>` writes, which the stand-ins do not serialize.
 */
export function withCspSafeInlineStyles<T>(
  task: () => Promise<T>,
): Promise<{ value: T; css: string }> {
  const run = running.then(() => runPatched(task));
  running = run.catch(() => undefined);
  return run;
}

async function runPatched<T>(task: () => Promise<T>): Promise<{ value: T; css: string }> {
  const originalSetAttribute = Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")!
    .value as (this: Element, name: string, value: string) => void;
  const added: CSSStyleSheet[] = [];

  Element.prototype.setAttribute = function setAttribute(this: Element, name, value) {
    if (name.toLowerCase() === "style" && "style" in this) {
      (this as HTMLElement).style.cssText = String(value);
      return;
    }
    originalSetAttribute.call(this, name, value);
  };
  document.createElement = function createElement(
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    if (tagName.toLowerCase() !== "style") {
      return Document.prototype.createElement.call(this, tagName, options);
    }
    const standIn = Document.prototype.createElement.call(this, "template");
    const sheet = new CSSStyleSheet();
    added.push(sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(standIn, "innerHTML", {
      configurable: true,
      get: () => Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"),
      set: (css: string) => {
        sheet.replaceSync(css);
      },
    });
    return standIn;
  } as typeof document.createElement;

  try {
    const value = await task();
    const css = added
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n");
    return { value, css };
  } finally {
    Element.prototype.setAttribute = originalSetAttribute;
    delete (document as { createElement?: unknown }).createElement;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => !added.includes(sheet),
    );
  }
}

const UNSAFE_HREF_SCHEME = /^(?:javascript|vbscript|data):/i;

function isUnsafeHref(value: string): boolean {
  // Strip ASCII whitespace and control chars before scheme matching (browsers ignore them).
  // oxlint-disable-next-line no-control-regex
  return UNSAFE_HREF_SCHEME.test(value.replace(/[\u0000-\u0020]+/g, ""));
}

/**
 * Mounts renderer SVG markup into `host`'s shadow root without inline style markup: `<style>`
 * contents and `css` become an adopted stylesheet, `style` attributes are re-applied through
 * CSSOM, and scripts, `<foreignObject>`, `on*` handlers, or unsafe `href`/`xlink:href` schemes
 * are dropped. Parsing happens in an inert document.
 */
export function mountSvgInShadow(host: HTMLElement, svg: string, css: string): void {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${svg}`, "text/html");
  const root = parsed.body.querySelector("svg");
  if (root === null) {
    throw new Error("Renderer output has no <svg> root.");
  }

  const styleText = [css];
  for (const element of Array.from(root.querySelectorAll("style, script, foreignObject"))) {
    if (element.localName === "style") {
      styleText.push(element.textContent ?? "");
    }
    element.remove();
  }

  const sourceElements = [root, ...Array.from(root.querySelectorAll("*"))];
  const inlineStyles = sourceElements.map((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href") && isUnsafeHref(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    const style = element.getAttribute("style");
    element.removeAttribute("style");
    return style;
  });

  const live = document.importNode(root, true);
  const liveElements = [live, ...Array.from(live.querySelectorAll("*"))];
  liveElements.forEach((element, index) => {
    const style = inlineStyles[index];
    if (style && "style" in element) {
      (element as SVGElement).style.cssText = style;
    }
  });

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [
    sheetFrom(":host { display: block; overflow-x: auto; } svg { max-width: 100%; height: auto; }"),
    sheetFrom(styleText.join("\n")),
  ];
  adoptUserSheet(shadow);
  shadow.replaceChildren(live);
}
