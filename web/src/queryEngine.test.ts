import { describe, expect, it } from "vite-plus/test";
import { executeQuery, parseQuery, parseWhere, resolveRelativeDate } from "./queryEngine";
import type { VaultDocument } from "./vaultDocuments";

const NOW = new Date(2026, 10, 27, 12, 0, 0); // 2026-11-27

function makeDoc(
  id: string,
  name: string,
  path: string[],
  text: string,
  modifiedTime?: string,
): VaultDocument {
  return {
    id,
    name,
    path,
    folderId: path.join("/") || "root",
    modifiedTime,
    text,
    revision: `rev-${id}`,
  };
}

const SAMPLE_DOCS: VaultDocument[] = [
  makeDoc(
    "p1",
    "Alpha.md",
    ["Projects"],
    [
      "---",
      "status: active",
      "priority: 1",
      "published: true",
      "owner: Alice",
      "tags:",
      "  - work",
      "  - Q4",
      "---",
      "",
      "# Alpha",
      "Kickoff notes #roadmap",
      "```md",
      "#ignored-in-code",
      "```",
      "Inline `#also-ignored` and real #launch.",
      "- [ ] Ship v1 #release @2026-11-30",
      "- [x] Write spec #docs @2026-11-20",
      "- [ ] Celebrate",
    ].join("\n"),
    "2026-11-27T10:00:00Z",
  ),
  makeDoc(
    "p2",
    "Beta.md",
    ["Projects", "Mobile"],
    [
      "---",
      "status: active",
      "priority: 10",
      "published: false",
      "owner: Bob",
      "tags: [work, mobile]",
      "---",
      "",
      "# Beta",
      "- [ ] Fix login crash #urgent @2026-11-25",
      "- [ ] Update icons @2026-12-10",
    ].join("\n"),
    "2026-11-26T09:00:00Z",
  ),
  makeDoc(
    "p3",
    "Archive.md",
    ["Projects"],
    [
      "---",
      "status: archived",
      "priority: 2",
      "tags: [work, archived]",
      "---",
      "",
      "# Old Project",
      "- [ ] Clean up bucket",
    ].join("\n"),
    "2026-10-01T08:00:00Z",
  ),
  makeDoc(
    "r1",
    "Inbox.md",
    [],
    ["# Inbox", "Remember to review #personal notes.", "- [ ] Buy milk #errands @2026-11-27"].join(
      "\n",
    ),
    "2026-11-25T15:30:00Z",
  ),
  makeDoc(
    "n1",
    "Meeting Notes.md",
    ["Work"],
    ["---", "status: draft", "attendees: [Alice, Carol]", "---", "", "# Sync"].join("\n"),
    undefined,
  ),
];

describe("parseQuery", () => {
  it("parses empty block with defaults", () => {
    const res = parseQuery("\n# just a comment\n");
    expect(res).toEqual({
      ok: true,
      query: {
        type: "notes",
        from: undefined,
        where: undefined,
        sort: undefined,
        limit: undefined,
        view: { kind: "list" },
      },
    });
  });

  it("parses case-insensitive keys, quoted from, sort, limit, and table view", () => {
    const res = parseQuery(
      [
        "TYPE: Notes",
        'FROM: "/Projects/Mobile/"',
        'WHERE: status = "active" AND priority <= 10',
        "SORT: priority DESC",
        "LIMIT: 5",
        "VIEW: table(title, status, priority, tags)",
      ].join("\n"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.query.type).toBe("notes");
    expect(res.query.from).toBe("Projects/Mobile");
    expect(res.query.sort).toEqual({ field: "priority", direction: "desc" });
    expect(res.query.limit).toBe(5);
    expect(res.query.view).toEqual({
      kind: "table",
      columns: [
        { field: "title", label: "title" },
        { field: "status", label: "status" },
        { field: "priority", label: "priority" },
        { field: "tags", label: "tags" },
      ],
    });
  });

  it("parses table column aliases with double quotes, single quotes, unquoted tokens, commas, and escapes", () => {
    const res = parseQuery(
      [
        'view: table(title as "Name, Full", status AS Status, tags as \'Note Labels\', modified As "Last Updated")',
      ].join("\n"),
    );
    expect(res).toEqual({
      ok: true,
      query: {
        type: "notes",
        from: undefined,
        where: undefined,
        sort: undefined,
        limit: undefined,
        view: {
          kind: "table",
          columns: [
            { field: "title", label: "Name, Full" },
            { field: "status", label: "Status" },
            { field: "tags", label: "Note Labels" },
            { field: "modified", label: "Last Updated" },
          ],
        },
      },
    });

    const escaped = parseQuery(
      `view: table(title as "Say \\"Hi\\" \\\\ (All)", owner as 'It\\'s \\\\ Team', status as 'Don''t Stop', priority)`,
    );
    expect(escaped.ok).toBe(true);
    if (!escaped.ok) return;
    expect(escaped.query.view).toEqual({
      kind: "table",
      columns: [
        { field: "title", label: 'Say "Hi" \\ (All)' },
        { field: "owner", label: "It's \\ Team" },
        { field: "status", label: "Don't Stop" },
        { field: "priority", label: "priority" },
      ],
    });
  });

  it("rejects malformed table column aliases with clear diagnostics", () => {
    expect(parseQuery('view: table(modified as "Updated)')).toMatchObject({
      ok: false,
      error: /unclosed quote/i,
    });
    expect(parseQuery("view: table(modified as 'Updated)")).toMatchObject({
      ok: false,
      error: /unclosed quote/i,
    });
    expect(parseQuery('view: table(modified as "Updated')).toMatchObject({
      ok: false,
      error: /unclosed quote/i,
    });
    expect(parseQuery("view: table(modified as)")).toMatchObject({
      ok: false,
      error: /missing alias/i,
    });
    expect(parseQuery("view: table(modified as, status)")).toMatchObject({
      ok: false,
      error: /missing alias/i,
    });
    expect(parseQuery('view: table(modified as "")')).toMatchObject({
      ok: false,
      error: /empty alias/i,
    });
    expect(parseQuery('view: table(modified as "   ")')).toMatchObject({
      ok: false,
      error: /empty alias/i,
    });
    expect(parseQuery("view: table(modified as '')")).toMatchObject({
      ok: false,
      error: /empty alias/i,
    });
    expect(parseQuery("view: table(123bad as Label)")).toMatchObject({
      ok: false,
      error: /Invalid table column/i,
    });
    expect(parseQuery('view: table("123bad" as Label)')).toMatchObject({
      ok: false,
      error: /Invalid table column/i,
    });
    expect(parseQuery("view: table(modified as Updated extra)")).toMatchObject({
      ok: false,
      error: /unexpected token/i,
    });
    expect(parseQuery('view: table(modified as "Updated" extra)')).toMatchObject({
      ok: false,
      error: /unexpected token/i,
    });
    expect(parseQuery("view: table(modified Updated)")).toMatchObject({
      ok: false,
      error: /unexpected token/i,
    });
    expect(parseQuery('view: table(modified "Updated")')).toMatchObject({
      ok: false,
      error: /expected "as"/i,
    });
    expect(parseQuery("view: table(, title)")).toMatchObject({
      ok: false,
      error: /empty column/i,
    });
    expect(parseQuery("view: table(title, , status)")).toMatchObject({
      ok: false,
      error: /empty column/i,
    });
    expect(parseQuery("view: table(title, status")).toMatchObject({
      ok: false,
      error: /missing closing/i,
    });
    expect(parseQuery("view: table(title) extra")).toMatchObject({
      ok: false,
      error: /unexpected trailing content/i,
    });
  });

  it("defaults tasks query view to tasks", () => {
    const res = parseQuery("type: tasks\nfrom: /\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.query.from).toBe("");
    expect(res.query.view).toEqual({ kind: "tasks" });
  });

  it("rejects unknown keys, duplicate keys, malformed lines, and invalid values", () => {
    expect(parseQuery("select: *")).toMatchObject({ ok: false, error: /Unknown key/i });
    expect(parseQuery("limit: 1\nlimit: 2")).toMatchObject({ ok: false, error: /Duplicate key/i });
    expect(parseQuery("not a yaml line")).toMatchObject({ ok: false, error: /Invalid line 1/i });
    expect(parseQuery("type: folders")).toMatchObject({ ok: false, error: /Invalid type/i });
    expect(parseQuery("limit: 0")).toMatchObject({ ok: false, error: /Invalid limit/i });
    expect(parseQuery("limit: -3")).toMatchObject({ ok: false, error: /Invalid limit/i });
    expect(parseQuery("limit: 2.5")).toMatchObject({ ok: false, error: /Invalid limit/i });
    expect(parseQuery("sort: title sideways")).toMatchObject({
      ok: false,
      error: /Invalid sort direction/i,
    });
    expect(parseQuery("view: kanban")).toMatchObject({ ok: false, error: /Invalid view/i });
    expect(parseQuery("view: table()")).toMatchObject({ ok: false, error: /at least one column/i });
    // Quoted field names keep working, with or without an alias.
    expect(parseQuery(`view: table("title", 'status' as State)`)).toMatchObject({
      ok: true,
      query: {
        view: {
          kind: "table",
          columns: [
            { field: "title", label: "title" },
            { field: "status", label: "State" },
          ],
        },
      },
    });
    // No arbitrary column cap.
    const many = Array.from({ length: 100 }, (_, n) => `c${n}`).join(", ");
    expect(parseQuery(`view: table(${many})`).ok).toBe(true);
    expect(parseQuery("view: table(title, )")).toMatchObject({
      ok: false,
      error: /empty column/i,
    });
    expect(parseQuery("type: notes\nview: tasks")).toMatchObject({
      ok: false,
      error: /requires "type: tasks"/i,
    });
    expect(parseQuery("from:")).toMatchObject({ ok: false, error: /Missing value for "from"/i });
  });
});

describe("parseWhere", () => {
  it("respects OR < AND < NOT < parentheses precedence", () => {
    const res = parseWhere("a OR b AND NOT c");
    expect(res).toEqual({
      ok: true,
      expr: {
        kind: "or",
        left: { kind: "truthy", field: "a" },
        right: {
          kind: "and",
          left: { kind: "truthy", field: "b" },
          right: { kind: "not", operand: { kind: "truthy", field: "c" } },
        },
      },
    });
  });

  it("rejects syntax errors, unterminated strings, and excessive nesting", () => {
    expect(parseWhere("")).toMatchObject({ ok: false });
    expect(parseWhere('status = "unclosed')).toMatchObject({
      ok: false,
      error: /Unterminated string/i,
    });
    expect(parseWhere("(status = active")).toMatchObject({ ok: false, error: /Missing closing/i });
    expect(parseWhere("status == active")).toMatchObject({ ok: false, error: /Use "="/i });
    expect(parseWhere("!done")).toMatchObject({ ok: false, error: /Use "NOT"/i });
    expect(parseWhere("status =")).toMatchObject({ ok: false, error: /Expected a value/i });
    expect(parseWhere("status = active extra")).toMatchObject({
      ok: false,
      error: /Unexpected token/i,
    });
    expect(parseWhere("AND")).toMatchObject({ ok: false, error: /Unexpected keyword/i });

    const deep = "(".repeat(40) + "done" + ")".repeat(40);
    expect(parseWhere(deep)).toMatchObject({ ok: false, error: /too deeply nested/i });
  });
});

describe("resolveRelativeDate", () => {
  it("computes days, weeks, and month-clamped offsets", () => {
    expect(resolveRelativeDate(NOW, 0, "d")).toBe("2026-11-27");
    expect(resolveRelativeDate(NOW, 7, "d")).toBe("2026-12-04");
    expect(resolveRelativeDate(NOW, -2, "w")).toBe("2026-11-13");
    expect(resolveRelativeDate(new Date(2026, 0, 31), 1, "m")).toBe("2026-02-28");
    expect(resolveRelativeDate(new Date(2024, 0, 31), 1, "m")).toBe("2024-02-29");
  });
});

describe("executeQuery (notes)", () => {
  it("filters by folder prefix and root-only from", () => {
    const projects = parseQuery("from: Projects");
    expect(projects.ok).toBe(true);
    if (!projects.ok) return;
    const projRes = executeQuery(projects.query, SAMPLE_DOCS, NOW);
    expect(projRes.rows.map((r) => r.title)).toEqual(["Alpha", "Beta", "Archive"]);

    const root = parseQuery('from: ""');
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    const rootRes = executeQuery(root.query, SAMPLE_DOCS, NOW);
    expect(rootRes.rows.map((r) => r.title)).toEqual(["Inbox"]);
  });

  it("matches #tag across frontmatter and body while ignoring fenced and inline code", () => {
    const q1 = parseQuery("where: #q4 AND #launch AND NOT #ignored-in-code");
    expect(q1.ok).toBe(true);
    if (!q1.ok) return;
    expect(executeQuery(q1.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual(["Alpha"]);

    const q2 = parseQuery("where: #also-ignored");
    expect(q2.ok).toBe(true);
    if (!q2.ok) return;
    expect(executeQuery(q2.query, SAMPLE_DOCS, NOW).rows).toEqual([]);
  });

  it("evaluates numeric, boolean, date, contains, truthy, and missing-field comparisons", () => {
    // Numeric comparison: priority <= 2 must include 1 and 2, NOT 10.
    const numQ = parseQuery("where: priority <= 2\nsort: priority asc");
    expect(numQ.ok).toBe(true);
    if (!numQ.ok) return;
    expect(executeQuery(numQ.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Alpha",
      "Archive",
    ]);

    // Boolean + bare truthy + NOT
    const boolQ = parseQuery("where: published = true");
    expect(boolQ.ok).toBe(true);
    if (!boolQ.ok) return;
    expect(executeQuery(boolQ.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual(["Alpha"]);

    const falsyQ = parseQuery("where: published");
    expect(falsyQ.ok).toBe(true);
    if (!falsyQ.ok) return;
    expect(executeQuery(falsyQ.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Alpha",
    ]);

    // Relative date normalized against ISO modifiedTime timestamp
    const modQ = parseQuery("where: modified >= today-1d");
    expect(modQ.ok).toBe(true);
    if (!modQ.ok) return;
    expect(executeQuery(modQ.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Alpha",
      "Beta",
    ]);

    // contains on string and array fields (case-insensitive)
    const containsTitle = parseQuery('where: title contains "meet"');
    expect(containsTitle.ok).toBe(true);
    if (!containsTitle.ok) return;
    expect(executeQuery(containsTitle.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Meeting Notes",
    ]);

    const containsArr = parseQuery('where: attendees contains "carol"');
    expect(containsArr.ok).toBe(true);
    if (!containsArr.ok) return;
    expect(executeQuery(containsArr.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Meeting Notes",
    ]);

    // Missing field with != against non-empty string matches notes lacking the property
    const neqQ = parseQuery('where: status != "archived"');
    expect(neqQ.ok).toBe(true);
    if (!neqQ.ok) return;
    expect(executeQuery(neqQ.query, SAMPLE_DOCS, NOW).rows.map((r) => r.title)).toEqual([
      "Alpha",
      "Beta",
      "Inbox",
      "Meeting Notes",
    ]);
  });

  it("sorts missing values last and respects limit while preserving totalMatched", () => {
    const q = parseQuery("sort: priority asc\nlimit: 2");
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const res = executeQuery(q.query, SAMPLE_DOCS, NOW);
    expect(res.totalMatched).toBe(5);
    expect(res.rows.map((r) => r.title)).toEqual(["Alpha", "Archive"]);

    const qAll = parseQuery("sort: priority desc");
    expect(qAll.ok).toBe(true);
    if (!qAll.ok) return;
    const allRes = executeQuery(qAll.query, SAMPLE_DOCS, NOW);
    // 10, 2, 1, then notes missing priority alphabetically (Inbox, Meeting Notes)
    expect(allRes.rows.map((r) => r.title)).toEqual([
      "Beta",
      "Archive",
      "Alpha",
      "Inbox",
      "Meeting Notes",
    ]);
  });
});

describe("executeQuery (tasks)", () => {
  it("filters tasks by done, due relative dates, task tags, and parent frontmatter fields", () => {
    const q = parseQuery(["type: tasks", "where: NOT done AND due <= today+7d"].join("\n"));
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const res = executeQuery(q.query, SAMPLE_DOCS, NOW);
    expect(res.type).toBe("tasks");
    if (res.type !== "tasks") return;
    // Default sort: due asc (2026-11-25, 2026-11-27, 2026-11-30)
    expect(res.rows.map((r) => r.text)).toEqual([
      "Fix login crash #urgent @2026-11-25",
      "Buy milk #errands @2026-11-27",
      "Ship v1 #release @2026-11-30",
    ]);
  });

  it("matches #tag against both task tags and parent note tags, and falls back to parent frontmatter", () => {
    const q = parseQuery('type: tasks\nwhere: (#urgent OR #roadmap) AND owner = "Alice"');
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const res = executeQuery(q.query, SAMPLE_DOCS, NOW);
    expect(res.type).toBe("tasks");
    if (res.type !== "tasks") return;
    // All 3 tasks in Alpha inherit parent tag #roadmap and owner: Alice; Beta has owner: Bob
    expect(res.rows.map((r) => r.title)).toEqual(["Alpha", "Alpha", "Alpha"]);
    // Default task sort puts tasks with due dates before tasks without due dates
    expect(res.rows.map((r) => r.due)).toEqual(["2026-11-20", "2026-11-30", undefined]);
  });

  it("supports count view with limit", () => {
    const q = parseQuery("type: tasks\nwhere: NOT done\nlimit: 3\nview: count");
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const res = executeQuery(q.query, SAMPLE_DOCS, NOW);
    expect(res.totalMatched).toBe(6);
    expect(res.rows).toHaveLength(3);
  });

  it("rejects out-of-range relative date offsets and keeps missing-field equality consistent", () => {
    const huge = parseQuery("where: due <= today+9999999999d");
    expect(huge.ok).toBe(false);

    const eqEmpty = parseQuery('where: status = ""');
    const neqEmpty = parseQuery('where: status != ""');
    expect(eqEmpty.ok && neqEmpty.ok).toBe(true);
    if (!eqEmpty.ok || !neqEmpty.ok) return;
    const eqRes = executeQuery(eqEmpty.query, SAMPLE_DOCS, NOW);
    const neqRes = executeQuery(neqEmpty.query, SAMPLE_DOCS, NOW);
    expect(eqRes.rows.length + neqRes.rows.length).toBe(SAMPLE_DOCS.length);
  });
});
