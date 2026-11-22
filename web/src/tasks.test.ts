import { describe, expect, it } from "vite-plus/test";
import { filterTasks, parseTasks, type NoteTasks } from "./tasks";
import { toggleTaskAt } from "./taskToggle";

describe("parseTasks", () => {
  it("finds - and * tasks with tags and due dates, skipping fences and inline code", () => {
    const text = [
      "# Plan",
      "- [ ] write spec #work @2026-12-01",
      "  * [x] review `#notatag` #Q4/launch",
      "+ [ ] plus works too",
      "```",
      "- [ ] inside fence",
      "```",
      "- not a task",
      "1. [X] numbered done",
    ].join("\r\n");
    const tasks = parseTasks(text);
    expect(
      tasks.map(({ line, text: t, done, tags, due }) => ({ line, t, done, tags, due })),
    ).toEqual([
      {
        line: 2,
        t: "write spec #work @2026-12-01",
        done: false,
        tags: ["work"],
        due: "2026-12-01",
      },
      {
        line: 3,
        t: "review `#notatag` #Q4/launch",
        done: true,
        tags: ["q4/launch"],
        due: undefined,
      },
      { line: 4, t: "plus works too", done: false, tags: [], due: undefined },
      { line: 9, t: "numbered done", done: true, tags: [], due: undefined },
    ]);
  });

  it("ignores numeric-only #tags such as issue numbers, like Obsidian", () => {
    const [task] = parseTasks(
      "- [ ] fix #30 and #123 by #2026, see #1/2 #___ for #work #v2 #2026-goals #q4/launch\n",
    );
    expect(task.tags).toEqual(["work", "v2", "2026-goals", "q4/launch"]);
  });

  it("gives offsets toggleTaskAt flips byte-exactly, even after a BOM", () => {
    const text = "\uFEFF- [ ] first\r\n\t- [x] second\r\n";
    const [first, second] = parseTasks(text);
    expect(toggleTaskAt(text, first.offset)).toBe("\uFEFF- [x] first\r\n\t- [x] second\r\n");
    expect(toggleTaskAt(text, second.offset)).toBe("\uFEFF- [ ] first\r\n\t- [ ] second\r\n");
  });
});

describe("filterTasks", () => {
  const notes: NoteTasks[] = [
    {
      id: "a",
      name: "Alpha.md",
      path: ["Work"],
      tasks: parseTasks("- [ ] ship #release\n- [x] plan #release\n"),
    },
    { id: "b", name: "Beta.md", path: [], tasks: parseTasks("- [ ] buy milk #home\n") },
  ];

  it("filters by status, query, folder and tag, dropping empty notes", () => {
    const ids = (groups: NoteTasks[]) => groups.map((g) => [g.id, g.tasks.map((t) => t.text)]);
    expect(ids(filterTasks(notes, { status: "open" }))).toEqual([
      ["a", ["ship #release"]],
      ["b", ["buy milk #home"]],
    ]);
    expect(ids(filterTasks(notes, { status: "completed" }))).toEqual([["a", ["plan #release"]]]);
    expect(ids(filterTasks(notes, { status: "all", query: "MILK" }))).toEqual([
      ["b", ["buy milk #home"]],
    ]);
    expect(ids(filterTasks(notes, { status: "all", folder: "Work" }))).toEqual([
      ["a", ["ship #release", "plan #release"]],
    ]);
    expect(ids(filterTasks(notes, { status: "all", tag: "home" }))).toEqual([
      ["b", ["buy milk #home"]],
    ]);
  });

  it("matches the query against the note title too", () => {
    expect(filterTasks(notes, { status: "all", query: "beta" }).map((g) => g.id)).toEqual(["b"]);
  });
});
