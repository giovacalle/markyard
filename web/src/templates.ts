import { formatLocalDate } from "./commandSearch";
import { type Frontmatter, parseFrontmatter } from "./frontmatter";
import { noteStem } from "./wikilinks";

export interface TemplateContext {
  now: Date;
  /** The current note's stem, for `{{title}}`. */
  title: string;
  /** Folder path below the vault root joined by `/` (or `""` at root), for `{{folder}}`. */
  folder?: string;
  /**
   * Parsed frontmatter (or raw note text parsed via `parseFrontmatter`), for `{{fm.<key>}}` and
   * `{{frontmatter.<key>}}`.
   */
  frontmatter?: Frontmatter | string | null;
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const MAX_DATE_OFFSET = 100_000;
const DATE_EXPR = /^date(?:([+-])(\d+)([dwmyDWMY]))?(?::(.+))?$/;
const FRONTMATTER_EXPR = /^(?:fm|frontmatter)\.(.+)$/;
const FORMAT_TOKEN = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|WW/g;

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalTime(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function addDateOffset(now: Date, signedAmount: number, unit: "d" | "w" | "m" | "y"): Date {
  if (unit === "d" || unit === "w") {
    const days = unit === "w" ? signedAmount * 7 : signedAmount;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + days,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    );
  }
  const monthDelta = unit === "y" ? signedAmount * 12 : signedAmount;
  const totalMonths = now.getFullYear() * 12 + now.getMonth() + monthDelta;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const maxDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const targetDay = Math.min(now.getDate(), maxDay);
  return new Date(
    targetYear,
    targetMonth,
    targetDay,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
}

/** ISO 8601 week-year and week number (1..53) for `date`'s local calendar day. */
function isoWeekInfo(date: Date): { year: number; week: number } {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const year = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

function formatDatePattern(date: Date, pattern: string): string {
  return pattern.replace(FORMAT_TOKEN, (token) => {
    switch (token) {
      case "YYYY":
        return String(date.getFullYear()).padStart(4, "0");
      case "YY":
        return pad2(Math.abs(date.getFullYear()) % 100);
      case "MMMM":
        return MONTHS_LONG[date.getMonth()];
      case "MMM":
        return MONTHS_SHORT[date.getMonth()];
      case "MM":
        return pad2(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return pad2(date.getDate());
      case "D":
        return String(date.getDate());
      case "dddd":
        return WEEKDAYS_LONG[date.getDay()];
      case "ddd":
        return WEEKDAYS_SHORT[date.getDay()];
      case "HH":
        return pad2(date.getHours());
      case "mm":
        return pad2(date.getMinutes());
      case "WW":
        return pad2(isoWeekInfo(date).week);
      default:
        return token;
    }
  });
}

function lookupFrontmatter(frontmatter: Frontmatter | null, key: string): string {
  if (frontmatter === null) {
    return "";
  }
  const needle = key.trim().toLowerCase();
  const prop = frontmatter.properties.find((entry) => entry.key.toLowerCase() === needle);
  if (prop === undefined) {
    return "";
  }
  return Array.isArray(prop.value) ? prop.value.join(", ") : prop.value;
}

/**
 * Expands known template placeholders (`{{date}}`, `{{date+Nd}}`, `{{date:FORMAT}}`, `{{time}}`,
 * `{{datetime}}`, `{{weekday}}`, `{{week}}`, `{{month}}`, `{{title}}`, `{{folder}}`,
 * `{{fm.<key>}}` / `{{frontmatter.<key>}}`). `{{cursor}}` is removed and its first position is
 * returned as `cursor` (or the end of the text when omitted). Unknown placeholders stay untouched.
 */
export function expandTemplate(
  template: string,
  context: TemplateContext,
): { text: string; cursor: number } {
  let cursor: number | undefined;
  let parsedFrontmatter: Frontmatter | null | undefined;
  const getFrontmatter = (): Frontmatter | null => {
    if (parsedFrontmatter !== undefined) {
      return parsedFrontmatter;
    }
    if (typeof context.frontmatter === "string") {
      parsedFrontmatter = parseFrontmatter(context.frontmatter);
    } else {
      parsedFrontmatter = context.frontmatter ?? null;
    }
    return parsedFrontmatter;
  };

  let text = "";
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const expr = match[1].trim();
    if (expr.length === 0) {
      continue;
    }
    let replacement: string | null = null;
    let isCursor = false;

    if (expr === "cursor") {
      isCursor = true;
    } else if (expr === "time") {
      replacement = formatLocalTime(context.now);
    } else if (expr === "datetime") {
      replacement = `${formatLocalDate(context.now)} ${formatLocalTime(context.now)}`;
    } else if (expr === "weekday") {
      replacement = WEEKDAYS_LONG[context.now.getDay()];
    } else if (expr === "week") {
      const info = isoWeekInfo(context.now);
      replacement = `${String(info.year).padStart(4, "0")}-W${pad2(info.week)}`;
    } else if (expr === "month") {
      replacement = `${String(context.now.getFullYear()).padStart(4, "0")}-${pad2(context.now.getMonth() + 1)}`;
    } else if (expr === "title") {
      replacement = context.title;
    } else if (expr === "folder") {
      replacement = context.folder ?? "";
    } else {
      const dateMatch = DATE_EXPR.exec(expr);
      if (dateMatch !== null) {
        const [, sign, rawAmount, rawUnit, format] = dateMatch;
        let targetDate: Date | null = context.now;
        if (sign !== undefined && rawAmount !== undefined && rawUnit !== undefined) {
          const amount = Number(rawAmount);
          if (!Number.isSafeInteger(amount) || amount > MAX_DATE_OFFSET) {
            targetDate = null;
          } else {
            const candidate = addDateOffset(
              context.now,
              (sign === "-" ? -1 : 1) * amount,
              rawUnit.toLowerCase() as "d" | "w" | "m" | "y",
            );
            targetDate = Number.isNaN(candidate.getTime()) ? null : candidate;
          }
        }
        if (targetDate !== null) {
          replacement =
            format !== undefined
              ? formatDatePattern(targetDate, format)
              : formatLocalDate(targetDate);
        }
      } else {
        const fmMatch = FRONTMATTER_EXPR.exec(expr);
        if (fmMatch !== null) {
          replacement = lookupFrontmatter(getFrontmatter(), fmMatch[1]);
        }
      }
    }

    if (!isCursor && replacement === null) {
      continue;
    }

    text += template.slice(last, match.index);
    last = match.index + match[0].length;
    if (isCursor) {
      cursor ??= text.length;
    } else if (replacement !== null) {
      text += replacement;
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
 * Expands a vault `Templates/Daily.md` for today's note (returning both `text` and `cursor`),
 * or `null` when there is none.
 */
export function dailyNoteTemplate(
  templates: readonly TemplateNote[],
  now: Date,
  title: string,
  folder = "",
): { text: string; cursor: number } | null {
  const daily = templates.find((template) => template.name.toLowerCase() === "daily.md");
  return daily === undefined ? null : expandTemplate(daily.text, { now, title, folder });
}

/**
 * The initial body of today's note from a vault `Templates/Daily.md`, or null when there is none.
 */
export function dailyNoteContent(
  templates: readonly TemplateNote[],
  now: Date,
  title: string,
  folder = "",
): string | null {
  return dailyNoteTemplate(templates, now, title, folder)?.text ?? null;
}
