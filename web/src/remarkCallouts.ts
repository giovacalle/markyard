export const CALLOUT_LABELS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;

export type CalloutType = keyof typeof CALLOUT_LABELS;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const MARKER = /^\[!([a-z]+)\][ \t]*([^\n]*)\n?/i;

function isCalloutType(value: string): value is CalloutType {
  return Object.hasOwn(CALLOUT_LABELS, value);
}

function toCallout(blockquote: MdNode): void {
  const paragraph = blockquote.children?.[0];
  const text = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
  const match = text?.type === "text" ? MARKER.exec(text.value ?? "") : null;
  const type = match?.[1].toLowerCase();
  if (!paragraph?.children || !text || !match || type === undefined || !isCalloutType(type)) {
    return;
  }

  text.value = (text.value ?? "").slice(match[0].length);
  if (text.value.length === 0) {
    paragraph.children.shift();
  }
  if (paragraph.children.length === 0) {
    blockquote.children?.shift();
  }
  blockquote.data = {
    ...blockquote.data,
    hName: "div",
    hProperties: {
      className: ["callout", `callout-${type}`],
      dataCallout: type,
      dataCalloutTitle: match[2].trim() || CALLOUT_LABELS[type],
    },
  };
}

function visit(node: MdNode): void {
  for (const child of node.children ?? []) {
    if (child.type === "blockquote") {
      toCallout(child);
    }
    visit(child);
  }
}

/** Turns GitHub/Obsidian alert blockquotes (`> [!NOTE] Title`) into callout containers. */
export function remarkCallouts() {
  return (tree: MdNode) => visit(tree);
}
