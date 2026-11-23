import { describe, expect, it } from "vite-plus/test";
import { mountSvgInShadow, withCspSafeInlineStyles } from "./cspSafeSvg";

function currentSetAttribute(): unknown {
  return Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")?.value;
}

describe("withCspSafeInlineStyles", () => {
  it("routes style attributes and <style> elements to CSSOM while the task runs, then restores", async () => {
    const originalSetAttribute = currentSetAttribute();
    let css = "";

    const { value: result, css: captured } = await withCspSafeInlineStyles(async () => {
      const div = document.createElement("div");
      div.setAttribute("style", "color: red; margin: 2px");
      div.setAttribute("id", "kept");
      const style = document.createElement("style");
      style.innerHTML = "#kept { color: blue; }";
      css = document.adoptedStyleSheets.map((s) => s.cssRules[0]?.cssText ?? "").join("");
      return { div, style };
    });

    expect(result.div.style.color).toBe("red");
    expect(result.div.style.margin).toBe("2px");
    expect(result.div.id).toBe("kept");
    expect(result.style).not.toBeInstanceOf(HTMLStyleElement);
    expect(css).toContain("#kept");
    expect(captured).toContain("#kept");
    expect(document.adoptedStyleSheets).toHaveLength(0);
    expect(currentSetAttribute()).toBe(originalSetAttribute);
    expect(Object.hasOwn(document, "createElement")).toBe(false);
  });

  it("restores the patches when the task throws", async () => {
    const originalSetAttribute = currentSetAttribute();
    await expect(
      withCspSafeInlineStyles(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(currentSetAttribute()).toBe(originalSetAttribute);
    expect(Object.hasOwn(document, "createElement")).toBe(false);
  });
});

describe("mountSvgInShadow", () => {
  it("mounts the SVG in a shadow root with adopted styles and no inline style markup", () => {
    const host = document.createElement("div");
    const svg =
      '<svg id="m1" viewBox="0 0 10 10" style="max-width: 40px"><style>#m1 .node { fill: red; }</style>' +
      '<g class="node"><rect width="5" height="5" style="stroke: blue"></rect></g></svg>';

    mountSvgInShadow(host, svg, "#m1 { font-size: 16px; }");

    const shadow = host.shadowRoot!;
    expect(shadow.querySelector("style")).toBeNull();
    const mounted = shadow.querySelector("svg")!;
    expect(mounted.style.maxWidth).toBe("40px");
    expect(shadow.querySelector("rect")!.style.stroke).toBe("blue");
    const rules = shadow.adoptedStyleSheets.flatMap((s) =>
      Array.from(s.cssRules, (r) => r.cssText),
    );
    expect(rules.some((r) => r.includes("font-size: 16px"))).toBe(true);
    expect(rules.some((r) => r.includes("fill: red"))).toBe(true);

    mountSvgInShadow(host, '<svg id="m2"></svg>', "");
    expect(shadow.querySelectorAll("svg")).toHaveLength(1);
    expect(shadow.querySelector("svg")!.id).toBe("m2");
  });

  it("drops scripts and rejects output without an SVG root", () => {
    const host = document.createElement("div");
    mountSvgInShadow(host, '<svg><script>alert(1)</script><g onclick="x()"></g></svg>', "");
    expect(host.shadowRoot!.querySelector("script")).toBeNull();
    expect(host.shadowRoot!.querySelector("g")!.hasAttribute("onclick")).toBe(false);
    expect(() => mountSvgInShadow(host, "<p>nope</p>", "")).toThrow();
  });

  it("drops <foreignObject> and unsafe href/xlink:href schemes while preserving safe links", () => {
    const host = document.createElement("div");
    const svg =
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
      "<foreignObject><div>injected</div></foreignObject>" +
      '<a id="bad-js" href="javascript:alert(1)"></a>' +
      '<a id="bad-ws" href=" \t\nJaVaScRiPt:alert(1)"></a>' +
      '<a id="bad-data" xlink:href="data:text/html,boom"></a>' +
      '<a id="bad-vb" href="vbscript:msgbox(1)"></a>' +
      '<a id="safe-https" href="https://example.com"></a>' +
      '<use id="safe-hash" xlink:href="#shape"></use>' +
      "</svg>";

    mountSvgInShadow(host, svg, "");

    const shadow = host.shadowRoot!;
    expect(shadow.querySelector("foreignObject")).toBeNull();
    expect(shadow.querySelector("#bad-js")!.hasAttribute("href")).toBe(false);
    expect(shadow.querySelector("#bad-ws")!.hasAttribute("href")).toBe(false);
    expect(shadow.querySelector("#bad-data")!.hasAttribute("xlink:href")).toBe(false);
    expect(shadow.querySelector("#bad-vb")!.hasAttribute("href")).toBe(false);
    expect(shadow.querySelector("#safe-https")!.getAttribute("href")).toBe("https://example.com");
    expect(shadow.querySelector("#safe-hash")!.getAttribute("xlink:href")).toBe("#shape");
  });
});
