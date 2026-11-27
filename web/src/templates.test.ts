import { describe, expect, it } from "vite-plus/test";
import { parseFrontmatter } from "./frontmatter";
import {
  BUILTIN_SLASH_COMMANDS,
  dailyNoteContent,
  dailyNoteTemplate,
  expandTemplate,
  isTemplatesFolder,
  slashCommands,
} from "./templates";

const NOW = new Date(2026, 10, 21, 9, 5);

describe("expandTemplate", () => {
  it("fills date, time and title, and places the cursor at {{cursor}}", () => {
    const result = expandTemplate("# {{title}}\n{{date}} {{ time }}\n\n- {{cursor}}\n", {
      now: NOW,
      title: "Daily",
    });
    expect(result.text).toBe("# Daily\n2026-11-21 09:05\n\n- \n");
    expect(result.cursor).toBe(result.text.indexOf("- ") + 2);
  });

  it("puts the cursor at the end without a {{cursor}} and keeps unknown placeholders", () => {
    const result = expandTemplate("{{unknown}} {{datefoo}} {{date:}} {{fm.}} x", {
      now: NOW,
      title: "T",
    });
    expect(result).toEqual({
      text: "{{unknown}} {{datefoo}} {{date:}} {{fm.}} x",
      cursor: "{{unknown}} {{datefoo}} {{date:}} {{fm.}} x".length,
    });
  });

  it("drops only the first {{cursor}}'s marker position and removes the rest", () => {
    const result = expandTemplate("a{{cursor}}b{{cursor}}c", { now: NOW, title: "T" });
    expect(result).toEqual({ text: "abc", cursor: 1 });
  });

  it("expands relative date offsets across days, weeks, months, years without mutating now", () => {
    const base = new Date(2026, 0, 31, 14, 30);
    const snapshot = base.getTime();
    const res = expandTemplate(
      [
        "{{date+1d}}",
        "{{date-1d}}",
        "{{date+2w}}",
        "{{date-1W}}",
        "{{date+1m}}",
        "{{date-1M}}",
        "{{date+1y}}",
        "{{date-2Y}}",
        "{{date+0d}}",
      ].join("|"),
      { now: base, title: "T" },
    );
    expect(res.text).toBe(
      [
        "2026-02-01",
        "2026-01-30",
        "2026-02-14",
        "2026-01-24",
        "2026-02-28",
        "2025-12-31",
        "2027-01-31",
        "2024-01-31",
        "2026-01-31",
      ].join("|"),
    );
    expect(base.getTime()).toBe(snapshot);
  });

  it("clamps month-end and leap-day dates cleanly", () => {
    const leapJan31 = new Date(2024, 0, 31, 8, 0);
    expect(expandTemplate("{{date+1m}}", { now: leapJan31, title: "T" }).text).toBe("2024-02-29");

    const mar31 = new Date(2026, 2, 31, 8, 0);
    expect(expandTemplate("{{date-1m}}", { now: mar31, title: "T" }).text).toBe("2026-02-28");

    const leapDay = new Date(2024, 1, 29, 8, 0);
    expect(
      expandTemplate("{{date+1y}}|{{date+4y}}|{{date-1y}}", { now: leapDay, title: "T" }).text,
    ).toBe("2025-02-28|2028-02-29|2023-02-28");
  });

  it("formats custom date patterns with longest-match-first deterministic English tokens", () => {
    // 2026-05-04 09:05 is a Monday in May (tests 'May' containing 'M' and 'Monday' containing 'M').
    const mayMonday = new Date(2026, 4, 4, 9, 5);
    expect(
      expandTemplate("{{date:YYYY-YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH:mm|WW}}", {
        now: mayMonday,
        title: "T",
      }).text,
    ).toBe("2026-26|May|May|05|5|04|4|Monday|Mon|09:05|19");

    // Combined offset + custom format and December containing 'D'.
    expect(
      expandTemplate("{{ date+7m:dddd, MMMM D, YYYY }}", { now: mayMonday, title: "T" }).text,
    ).toBe("Friday, December 4, 2026");

    expect(expandTemplate("{{date-1d:ddd MMM D}}", { now: mayMonday, title: "T" }).text).toBe(
      "Sun May 3",
    );
  });

  it("expands convenience tokens (datetime, weekday, month, folder)", () => {
    expect(
      expandTemplate("{{datetime}}|{{weekday}}|{{month}}|{{folder}}", {
        now: NOW,
        title: "Spec",
        folder: "Projects/2026",
      }).text,
    ).toBe("2026-11-21 09:05|Saturday|2026-11|Projects/2026");

    expect(expandTemplate("[{{folder}}]", { now: NOW, title: "Root" }).text).toBe("[]");
  });

  it("computes ISO week and ISO week-year across year boundaries", () => {
    const cases: [Date, string, string][] = [
      [new Date(2025, 11, 28), "2025-W52", "52"], // Sun
      [new Date(2025, 11, 29), "2026-W01", "01"], // Mon -> ISO year 2026
      [new Date(2025, 11, 31), "2026-W01", "01"], // Wed -> ISO year 2026
      [new Date(2026, 0, 1), "2026-W01", "01"], // Thu
      [new Date(2023, 0, 1), "2022-W52", "52"], // Sun -> ISO year 2022
      [new Date(2020, 11, 31), "2020-W53", "53"], // Thu -> 53-week year
      [new Date(2021, 0, 1), "2020-W53", "53"], // Fri -> still 2020-W53
      [new Date(2021, 0, 4), "2021-W01", "01"], // Mon -> 2021-W01
    ];
    for (const [date, expectedWeek, expectedWW] of cases) {
      expect(expandTemplate("{{week}}|{{date:WW}}", { now: date, title: "T" }).text).toBe(
        `${expectedWeek}|${expectedWW}`,
      );
    }
  });

  it("resolves frontmatter lookups case-insensitively for scalars, lists, raw text, and missing keys", () => {
    const rawNote = [
      "---",
      "Author: Ada Lovelace",
      "project-code: MK-27",
      "tags: [alpha, beta]",
      "reviewers:",
      "  - Grace",
      "  - Alan",
      "---",
      "# Body",
    ].join("\n");
    const parsed = parseFrontmatter(rawNote);

    const tpl =
      "{{fm.author}}|{{frontmatter.AUTHOR}}|{{fm.project-code}}|{{fm.tags}}|{{frontmatter.Reviewers}}|{{fm.missing}}";
    expect(expandTemplate(tpl, { now: NOW, title: "T", frontmatter: parsed }).text).toBe(
      "Ada Lovelace|Ada Lovelace|MK-27|alpha, beta|Grace, Alan|",
    );
    expect(expandTemplate(tpl, { now: NOW, title: "T", frontmatter: rawNote }).text).toBe(
      "Ada Lovelace|Ada Lovelace|MK-27|alpha, beta|Grace, Alan|",
    );
    expect(
      expandTemplate("{{fm.author}}|{{frontmatter.tags}}", { now: NOW, title: "T" }).text,
    ).toBe("|");
  });
});

describe("slash commands", () => {
  it("expands every built-in block", () => {
    const expand = (id: string) => {
      const command = BUILTIN_SLASH_COMMANDS.find((c) => c.id === id);
      if (command === undefined) throw new Error(id);
      return expandTemplate(command.template, { now: NOW, title: "T" });
    };
    expect(expand("today").text).toBe("2026-11-21");
    expect(expand("time").text).toBe("09:05");
    expect(expand("task").text).toBe("- [ ] ");
    expect(expand("callout").text).toBe("> [!NOTE]\n> ");
    expect(expand("table").text).toContain("| --- | --- |");
    expect(expand("code")).toEqual({ text: "```\n\n```", cursor: 4 });
    expect(expand("divider").text).toBe("---\n");
  });

  it("lists templates after built-ins and filters by prefix then substring", () => {
    const all = slashCommands([{ id: "t1", name: "Meeting.md", text: "## {{title}}" }], "");
    expect(all.at(-1)).toMatchObject({
      id: "template:t1",
      label: "Meeting",
      template: "## {{title}}",
    });
    expect(slashCommands([], "ta").map((c) => c.id)).toEqual(["task", "table"]);
    expect(
      slashCommands([{ id: "t1", name: "Meeting.md", text: "" }], "eet").map((c) => c.id),
    ).toEqual(["template:t1"]);
  });

  it("recognises a Templates folder case-insensitively at the root", () => {
    expect(isTemplatesFolder(["templates"])).toBe(true);
    expect(isTemplatesFolder(["Templates"])).toBe(true);
    expect(isTemplatesFolder(["Notes", "Templates"])).toBe(false);
    expect(isTemplatesFolder([])).toBe(false);
  });
});

describe("dailyNoteContent", () => {
  it("expands Templates/Daily.md with optional folder, or answers null without one", () => {
    const now = new Date(2026, 10, 21, 9, 5);
    const templates = [
      {
        id: "d",
        name: "daily.MD",
        text: "# {{date}} ({{folder}})\r\n\r\n{{cursor}}- [ ] plan {{time}}\r\n",
      },
    ];
    expect(dailyNoteContent(templates, now, "2026-11-21")).toBe(
      "# 2026-11-21 ()\r\n\r\n- [ ] plan 09:05\r\n",
    );
    expect(dailyNoteContent(templates, now, "2026-11-21", "Daily")).toBe(
      "# 2026-11-21 (Daily)\r\n\r\n- [ ] plan 09:05\r\n",
    );
    expect(dailyNoteTemplate(templates, now, "2026-11-21", "Daily")).toEqual({
      text: "# 2026-11-21 (Daily)\r\n\r\n- [ ] plan 09:05\r\n",
      cursor: "# 2026-11-21 (Daily)\r\n\r\n".length,
    });
    expect(dailyNoteContent([{ id: "m", name: "Meeting.md", text: "x" }], now, "t")).toBeNull();
  });

  it("handles huge date offsets and unclosed braces safely in linear time", () => {
    const now = new Date(2026, 10, 21, 9, 5);
    expect(expandTemplate("{{date+999999999999999d}}", { now, title: "t" }).text).toBe(
      "{{date+999999999999999d}}",
    );
    const unclosed = `{{${" ".repeat(4000)}unclosed`;
    expect(expandTemplate(unclosed, { now, title: "t" }).text).toBe(unclosed);
  });
});
