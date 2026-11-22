import { parseFrontmatter } from "./frontmatter";

export interface DocumentStats {
  words: number;
  /** Code points of the body (frontmatter excluded), without line breaks. */
  characters: number;
  /** Lines of the whole note, as the editor numbers them. */
  lines: number;
  tasks: { done: number; total: number };
  /** Estimated at 200 words per minute, rounded up; 0 for an empty note. */
  readingMinutes: number;
}

const WORDS_PER_MINUTE = 200;
const LINE_BREAK = /\r\n|\r|\n/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const TASK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]|$)/;
const TASK_BOXES = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\]/gm;
const WORDLIKE = /[\p{L}\p{N}]/u;

export function documentStats(text: string): DocumentStats {
  const frontmatter = parseFrontmatter(text);
  const body = (frontmatter === null ? text : text.slice(frontmatter.end)).replace(/^\uFEFF/, "");

  const words = body
    .replace(TASK_BOXES, "$1")
    .split(/\s+/)
    .filter((token) => WORDLIKE.test(token)).length;
  const characters = Array.from(body.replace(/\r\n|\r|\n/g, "")).length;
  const lines = text.length === 0 ? 0 : text.split(LINE_BREAK).length;

  const tasks = { done: 0, total: 0 };
  let fence: string | null = null;
  for (const line of body.split(LINE_BREAK)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const task = fence === null ? TASK.exec(line) : null;
    if (task) {
      tasks.total += 1;
      if (task[1] !== " ") {
        tasks.done += 1;
      }
    }
  }

  return {
    words,
    characters,
    lines,
    tasks,
    readingMinutes: Math.ceil(words / WORDS_PER_MINUTE),
  };
}
