import { formatLocalDate } from "./commandSearch";
import { noteStem } from "./wikilinks";

export interface TemplateContext {
  now: Date;
  /** The current note's stem, for `{{title}}`. */
  title: string;
}

const PLACEHOLDER = /\{\{\s*(date|time|title|cursor)\s*\}\}/g;

function formatLocalTime(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * Fills `{{date}}` (YYYY-MM-DD), `{{time}}` (HH:MM) and `{{title}}`; `{{cursor}}` is removed and
 * its first position answered as `cursor` (the end of the text without one).
 */
export function expandTemplate(
  template: string,
  context: TemplateContext,
): { text: string; cursor: number } {
  let cursor: number | undefined;
  let text = "";
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    text += template.slice(last, match.index);
    last = match.index + match[0].length;
    switch (match[1]) {
      case "date":
        text += formatLocalDate(context.now);
        break;
      case "time":
        text += formatLocalTime(context.now);
        break;
      case "title":
        text += context.title;
        break;
      default:
        cursor ??= text.length;
    }
  }
  text += template.slice(last);
  return { text, cursor: cursor ?? text.length };
}

export interface SlashCommand {
  id: string;
  label: string;
  detail: string;
  template: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "today", label: "today", detail: "Today's date", template: "{{date}}" },
  { id: "time", label: "time", detail: "Current time", template: "{{time}}" },
  { id: "task", label: "task", detail: "Task item", template: "- [ ] " },
  { id: "callout", label: "callout", detail: "Note callout", template: "> [!NOTE]\n> " },
  {
    id: "table",
    label: "table",
    detail: "Table",
    template: "| {{cursor}}Column | Column |\n| --- | --- |\n|  |  |\n",
  },
  { id: "code", label: "code", detail: "Code block", template: "```\n{{cursor}}\n```" },
  { id: "divider", label: "divider", detail: "Divider", template: "---\n" },
];

export interface TemplateNote {
  id: string;
  name: string;
  text: string;
}

/** Built-in blocks, then templates, that start with `query` (then contain it), case-insensitive. */
export function slashCommands(templates: readonly TemplateNote[], query: string): SlashCommand[] {
  const all: SlashCommand[] = [
    ...BUILTIN_SLASH_COMMANDS,
    ...templates.map((template) => ({
      id: `template:${template.id}`,
      label: noteStem(template.name),
      detail: "Template",
      template: template.text,
    })),
  ];
  const q = query.toLowerCase();
  if (q.length === 0) {
    return all;
  }
  const starts = all.filter((c) => c.label.toLowerCase().startsWith(q));
  const contains = all.filter(
    (c) => !c.label.toLowerCase().startsWith(q) && c.label.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}

/**
 * Whether a folder path (names below the root) is the vault's root templates folder, named
 * `folderName` (`Templates` by default), case-insensitively.
 */
export function isTemplatesFolder(path: readonly string[], folderName = "Templates"): boolean {
  const name = folderName.trim() || "Templates";
  return path.length === 1 && path[0].toLowerCase() === name.toLowerCase();
}

/**
 * The initial body of today's note from a vault `Templates/Daily.md`, or null when there is none.
 * `{{cursor}}` is dropped (the note opens with the caret at its end).
 */
export function dailyNoteContent(
  templates: readonly TemplateNote[],
  now: Date,
  title: string,
): string | null {
  const daily = templates.find((template) => template.name.toLowerCase() === "daily.md");
  return daily === undefined ? null : expandTemplate(daily.text, { now, title }).text;
}
