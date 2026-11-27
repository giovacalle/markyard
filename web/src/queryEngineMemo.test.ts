import { describe, expect, it, vi } from "vite-plus/test";
import { parseFrontmatter } from "./frontmatter";
import { executeQuery, parseQuery } from "./queryEngine";
import { parseTasks } from "./tasks";
import type { VaultDocument } from "./vaultDocuments";

vi.mock("./frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./frontmatter")>();
  return { ...actual, parseFrontmatter: vi.fn(actual.parseFrontmatter) };
});

vi.mock("./tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tasks")>();
  return { ...actual, parseTasks: vi.fn(actual.parseTasks) };
});

const parseFrontmatterMock = vi.mocked(parseFrontmatter);
const parseTasksMock = vi.mocked(parseTasks);

const NOW = new Date(2026, 10, 27, 12, 0, 0);

function freshDocs(): VaultDocument[] {
  return [
    {
      id: "doc-1",
      name: "Alpha.md",
      path: ["Projects"],
      folderId: "Projects",
      modifiedTime: "2026-11-27T10:00:00Z",
      text: "---\nstatus: active\n---\n\n- [ ] Ship v1 @2026-11-30\n",
      revision: "rev-1",
    },
    {
      id: "doc-2",
      name: "Beta.md",
      path: ["Projects"],
      folderId: "Projects",
      modifiedTime: "2026-11-26T09:00:00Z",
      text: "---\nstatus: active\n---\n\n- [ ] Fix crash @2026-11-25\n",
      revision: "rev-2",
    },
    {
      id: "doc-3",
      name: "Gamma.md",
      path: [],
      folderId: "root",
      modifiedTime: "2026-11-25T08:00:00Z",
      text: "---\nstatus: draft\n---\n\n- [x] Archive logs\n",
      revision: "rev-3",
    },
  ];
}

describe("executeQuery per-document memoization", () => {
  it("does not re-parse frontmatter or tasks on a second executeQuery over the same documents", () => {
    const docs = freshDocs();
    const parsed = parseQuery("type: tasks\nwhere: NOT done");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    parseFrontmatterMock.mockClear();
    parseTasksMock.mockClear();

    const first = executeQuery(parsed.query, docs, NOW);
    const second = executeQuery(parsed.query, docs, NOW);

    expect(first.type).toBe("tasks");
    expect(second.type).toBe("tasks");
    if (first.type !== "tasks" || second.type !== "tasks") return;

    expect(first.rows.map((row) => row.text)).toEqual([
      "Fix crash @2026-11-25",
      "Ship v1 @2026-11-30",
    ]);
    expect(second.rows.map((row) => row.text)).toEqual([
      "Fix crash @2026-11-25",
      "Ship v1 @2026-11-30",
    ]);
    expect(parseFrontmatterMock).toHaveBeenCalledTimes(3);
    expect(parseTasksMock).toHaveBeenCalledTimes(3);
  });

  it("re-parses only the replaced document when one VaultDocument object changes", () => {
    const docs = freshDocs();
    const parsed = parseQuery('type: tasks\nwhere: status = "active" AND NOT done');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    parseFrontmatterMock.mockClear();
    parseTasksMock.mockClear();

    const initial = executeQuery(parsed.query, docs, NOW);
    expect(initial.type).toBe("tasks");
    if (initial.type !== "tasks") return;
    expect(initial.rows.map((row) => row.text)).toEqual([
      "Fix crash @2026-11-25",
      "Ship v1 @2026-11-30",
    ]);
    expect(parseFrontmatterMock).toHaveBeenCalledTimes(3);
    expect(parseTasksMock).toHaveBeenCalledTimes(3);

    parseFrontmatterMock.mockClear();
    parseTasksMock.mockClear();

    const updatedDocs: VaultDocument[] = [
      docs[0],
      {
        ...docs[1],
        text: "---\nstatus: active\n---\n\n- [x] Fix crash @2026-11-25\n- [ ] Write changelog @2026-11-28\n",
      },
      docs[2],
    ];

    const next = executeQuery(parsed.query, updatedDocs, NOW);
    expect(next.type).toBe("tasks");
    if (next.type !== "tasks") return;
    expect(next.rows.map((row) => row.text)).toEqual([
      "Write changelog @2026-11-28",
      "Ship v1 @2026-11-30",
    ]);
    expect(parseFrontmatterMock).toHaveBeenCalledTimes(1);
    expect(parseTasksMock).toHaveBeenCalledTimes(1);
  });

  it("reuses prepared frontmatter across notes queries and subsequent tasks queries", () => {
    const docs = freshDocs();
    const notesQuery = parseQuery('type: notes\nwhere: status = "active"');
    const tasksQuery = parseQuery("type: tasks");
    expect(notesQuery.ok && tasksQuery.ok).toBe(true);
    if (!notesQuery.ok || !tasksQuery.ok) return;

    parseFrontmatterMock.mockClear();
    parseTasksMock.mockClear();

    const notesFirst = executeQuery(notesQuery.query, docs, NOW);
    const notesSecond = executeQuery(notesQuery.query, docs, NOW);
    expect(notesFirst.rows.map((row) => row.title)).toEqual(["Alpha", "Beta"]);
    expect(notesSecond.rows.map((row) => row.title)).toEqual(["Alpha", "Beta"]);
    expect(parseFrontmatterMock).toHaveBeenCalledTimes(3);
    expect(parseTasksMock).toHaveBeenCalledTimes(0);

    const tasksFirst = executeQuery(tasksQuery.query, docs, NOW);
    expect(tasksFirst.rows).toHaveLength(3);
    expect(parseFrontmatterMock).toHaveBeenCalledTimes(3);
    expect(parseTasksMock).toHaveBeenCalledTimes(3);
  });
});
