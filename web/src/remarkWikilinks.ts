interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const LINK = /\[\[([^[\]|#\r\n]*)(?:#([^[\]|\r\n]*))?(?:\|([^[\]\r\n]*))?\]\]/g;

/** Node types whose text is never a wikilink (code is parsed into its own nodes already). */
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html", "math", "inlineMath"]);

function wikilinkNode(target: string, heading: string, alias: string): MdNode {
  const label = alias || (target ? (heading ? `${target} › ${heading}` : target) : heading);
  return {
    type: "wikilink",
    data: {
      hName: "wikilink",
      hProperties: { target, heading, alias },
      hChildren: [{ type: "text", value: label }],
    },
  };
}

function split(text: MdNode): MdNode[] | null {
  const value = text.value ?? "";
  if (!value.includes("[[")) {
    return null;
  }
  const out: MdNode[] = [];
  let last = 0;
  LINK.lastIndex = 0;
  for (let match = LINK.exec(value); match !== null; match = LINK.exec(value)) {
    const target = match[1].trim();
    const heading = match[2]?.trim() ?? "";
    if (target.length === 0 && heading.length === 0) {
      continue;
    }
    if (match.index > last) {
      out.push({ type: "text", value: value.slice(last, match.index) });
    }
    out.push(wikilinkNode(target, heading, match[3]?.trim() ?? ""));
    last = match.index + match[0].length;
  }
  if (out.length === 0) {
    return null;
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

function walk(node: MdNode): void {
  const children = node.children;
  if (children === undefined || SKIP.has(node.type)) {
    return;
  }
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type === "text") {
      const parts = split(child);
      if (parts !== null) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    } else {
      walk(child);
    }
  }
}

/**
 * Turns `[[Target#Heading|Alias]]` in text into `wikilink` elements (rendered by Preview). Code
 * spans and fenced blocks are separate nodes, so links inside them stay literal.
 */
export function remarkWikilinks() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
