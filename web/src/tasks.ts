import { maskInlineCode, noteStem, sourceLines, type VaultNote } from "./wikilinks";

export interface TaskItem {
  /** 1-based line number. */
  line: number;
  /** Offset of the list item's first character, as `toggleTaskAt` expects. */
  offset: number;
  /** The task's text after the checkbox, trimmed. */
  text: string;
  done: boolean;
  /** Lowercased `#tags`, in order of appearance. */
  tags: string[];
  /** The first `@YYYY-MM-DD` due date, if any. */
  due?: string;
}

const TASK_LINE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\])(?:[ \t]+(.*))?$/;
const TAG = /(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
// Like Obsidian, a tag needs at least one letter: `#30` is an issue number, not a tag.
const HAS_LETTER = /\p{L}/u;
const DUE = /(?:^|\s)@(\d{4}-\d{2}-\d{2})(?![\d-])/;

/** Every GFM task list item in `text` (`-`, `*`, `+` or numbered), outside fenced code blocks. */
export function parseTasks(text: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const line of sourceLines(text)) {
    if (line.inFence) {
      continue;
    }
    // A leading BOM sits before the first line's list marker.
    const bom = line.from === 0 && line.text.startsWith("\uFEFF") ? 1 : 0;
    const match = TASK_LINE.exec(line.text.slice(bom));
    if (match === null) {
      continue;
    }
    const body = (match[3] ?? "").trim();
    const masked = maskInlineCode(body);
    const tags: string[] = [];
    for (const tag of masked.matchAll(TAG)) {
      const name = tag[1].toLowerCase();
      if (HAS_LETTER.test(name) && !tags.includes(name)) {
        tags.push(name);
      }
    }
    tasks.push({
      line: line.number,
      offset: line.from + bom,
      text: body,
      done: match[2] !== " ",
      tags,
      due: DUE.exec(masked)?.[1],
    });
  }
  return tasks;
}

export interface NoteTasks extends VaultNote {
  tasks: TaskItem[];
}

export type TaskStatusFilter = "open" | "completed" | "all";

export interface TaskFilter {
  status: TaskStatusFilter;
  query?: string;
  /** Folder path joined with `/`; notes in it or below it match. `""` is the root only. */
  folder?: string;
  tag?: string;
}

/** Notes holding at least one task the filter accepts, each with only those tasks. */
export function filterTasks(notes: readonly NoteTasks[], filter: TaskFilter): NoteTasks[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const tag = filter.tag?.toLowerCase();
  const folder = filter.folder?.toLowerCase();
  const out: NoteTasks[] = [];
  for (const note of notes) {
    if (folder !== undefined) {
      const path = note.path.join("/").toLowerCase();
      const inFolder =
        folder === "" ? path === "" : path === folder || path.startsWith(`${folder}/`);
      if (!inFolder) {
        continue;
      }
    }
    const titleMatches = query.length > 0 && noteStem(note.name).toLowerCase().includes(query);
    const tasks = note.tasks.filter(
      (task) =>
        (filter.status === "all" || task.done === (filter.status === "completed")) &&
        (tag === undefined || task.tags.includes(tag)) &&
        (query.length === 0 || titleMatches || task.text.toLowerCase().includes(query)),
    );
    if (tasks.length > 0) {
      out.push({ ...note, tasks });
    }
  }
  return out;
}
