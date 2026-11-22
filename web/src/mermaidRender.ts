import mermaid from "mermaid";
import { mountSvgInShadow, withCspSafeInlineStyles } from "./cspSafeSvg";

let counter = 0;
const latestRender = new WeakMap<HTMLElement, number>();

/**
 * Renders a Mermaid diagram into `host`'s shadow root under the strict CSP. Only the latest call
 * per host mounts its result, so fast source or theme changes never interleave stale diagrams.
 * Rejects on invalid diagram syntax.
 */
export async function renderMermaidInto(
  host: HTMLElement,
  source: string,
  dark: boolean,
): Promise<void> {
  counter += 1;
  const id = `markyard-mermaid-${counter}`;
  latestRender.set(host, counter);
  const ticket = counter;

  const { value, css } = await withCspSafeInlineStyles(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: dark ? "dark" : "default",
    });
    return mermaid.render(id, source);
  });
  if (latestRender.get(host) === ticket) {
    mountSvgInShadow(host, value.svg, css);
  }
}
