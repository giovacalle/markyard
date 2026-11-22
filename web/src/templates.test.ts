import { describe, expect, it } from "vite-plus/test";
import {
  BUILTIN_SLASH_COMMANDS,
  dailyNoteContent,
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
    const result = expandTemplate("{{unknown}} x", { now: NOW, title: "T" });
    expect(result).toEqual({ text: "{{unknown}} x", cursor: 13 });
  });

  it("drops only the first {{cursor}}'s marker position and removes the rest", () => {
    const result = expandTemplate("a{{cursor}}b{{cursor}}c", { now: NOW, title: "T" });
    expect(result).toEqual({ text: "abc", cursor: 1 });
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
  it("expands Templates/Daily.md, or answers null without one", () => {
    const now = new Date(2026, 10, 21, 9, 5);
    const templates = [
      { id: "d", name: "daily.MD", text: "# {{date}}\r\n\r\n{{cursor}}- [ ] plan {{time}}\r\n" },
    ];
    expect(dailyNoteContent(templates, now, "2026-11-21")).toBe(
      "# 2026-11-21\r\n\r\n- [ ] plan 09:05\r\n",
    );
    expect(dailyNoteContent([{ id: "m", name: "Meeting.md", text: "x" }], now, "t")).toBeNull();
  });
});
