# Templates & Declarative Query Blocks

Markyard supports reusable Markdown templates with dynamic placeholders and live declarative ```` ```query ```` blocks that filter, sort, and summarize notes and tasks directly in Preview mode and inline inside Edit mode—all client-side, with zero custom scripting and full strict-CSP safety.

## Templates

Create plain `.md` files inside your vault's `Templates/` folder (configurable in **Settings → Vault → Templates folder**). Templates are ordinary Google Drive Markdown files, so they sync across devices and remain portable.

### Using templates

- **Slash menu (`/`)**: Type `/` at the start of a line or after whitespace in the editor to insert built-in blocks (`/today`, `/time`, `/task`, `/callout`, `/table`, `/code`, `/divider`) or any note from your `Templates/` folder.
- **Command palette (`Cmd+K`)**: Run **New note from template…** to pick a template, enter a title, and choose any destination folder (defaulting to the current folder or vault root) with all placeholders expanded automatically.
- **Daily notes (`Templates/Daily.md`)**: When a note named `Daily.md` exists in your `Templates/` folder, opening today's daily note uses it as the initial body for a newly created daily note (placing the editor caret at `{{cursor}}` when present).

### Template tokens

All placeholders are case-sensitive inside `{{ ... }}` (surrounding whitespace inside the braces is optional, e.g. `{{ date }}`). Dates and times use your device's local timezone.

| Token | Output / behavior |
| --- | --- |
| `{{date}}` | Today's date in ISO format (`YYYY-MM-DD`, e.g. `2026-11-27`) |
| `{{time}}` | Current local time (`HH:mm`, 24-hour, e.g. `14:05`) |
| `{{datetime}}` | Local date and time (`YYYY-MM-DD HH:mm`) |
| `{{weekday}}` | Full weekday name (e.g. `Friday`) |
| `{{week}}` | ISO 8601 week number (`YYYY-Www`, e.g. `2026-W48`) |
| `{{month}}` | ISO month (`YYYY-MM`, e.g. `2026-11`; use `{{date:MMMM}}` for the full month name) |
| `{{date+Nd}}`, `{{date-Nd}}` | Date offset by `N` days (`d`), weeks (`w`), months (`m`), or years (`y`) — e.g. `{{date+1d}}`, `{{date-1w}}`, `{{date+1m}}`, `{{date-1y}}` |
| `{{date:FORMAT}}` | Custom formatted date (also combinable with offsets: `{{date+7d:MMM D, YYYY}}`) |
| `{{title}}` | Current note's filename without `.md` |
| `{{folder}}` | Current note's folder path (empty string at vault root) |
| `{{fm.<key>}}` or `{{frontmatter.<key>}}` | Value of a YAML frontmatter property on the current note (lists join with `, `; missing keys expand to empty string) |
| `{{cursor}}` | Removed on expansion; places the editor caret at its first occurrence |

#### Date format tokens (`{{date:FORMAT}}`)

| Format token | Example | Meaning |
| --- | --- | --- |
| `YYYY` | `2026` | 4-digit year |
| `YY` | `26` | 2-digit year |
| `MMMM` | `November` | Full month name |
| `MMM` | `Nov` | Abbreviated month name |
| `MM` | `11` | 2-digit month (`01`–`12`) |
| `M` | `11` | Unpadded month (`1`–`12`) |
| `DD` | `27` | 2-digit day of month (`01`–`31`) |
| `D` | `27` | Unpadded day of month (`1`–`31`) |
| `dddd` | `Friday` | Full weekday name |
| `ddd` | `Fri` | Abbreviated weekday name |
| `HH` | `09` | 2-digit hour (`00`–`23`) |
| `mm` | `05` | 2-digit minute (`00`–`59`) |
| `WW` | `48` | 2-digit ISO week number (`01`–`53`) |

#### Example `Templates/Daily.md`

```markdown
---
date: {{date}}
week: {{week}}
tags: [daily]
---

# {{date:dddd, MMMM D, YYYY}}

## Focus
- [ ] {{cursor}}

## Due this week
```

---

## Declarative Query Blocks

Add a fenced ```` ```query ```` code block to any Markdown note to render live lists, tables, interactive task lists, or counts in Preview mode and inline inside Edit mode. Queries are purely declarative (no JavaScript evaluation) and run locally over your cached vault notes.

### Edit mode (Live Preview)

- **Cursor outside the block**: A closed top-level ```` ```query ```` block folds into its rendered result directly inside the editor, with an **Edit** button in the header to unfold it.
- **Cursor inside the block**: The YAML remains editable with syntax highlighting, and a **Live preview** renders right below the closing fence—updating as you type.
- **Unclosed fences**: While typing a new ```` ```query ```` block before adding the closing fence, it stays plain text.
- Note links and task checkboxes remain interactive inline (respecting Read-only mode and preserving unsaved edits in the current note).

### Block schema

Each line is a `key: value` pair (keys are case-insensitive; blank lines and `#` comment lines are ignored):

| Key | Optional | Default | Description |
| --- | --- | --- | --- |
| `type` | Yes | `notes` | What to query: `notes` or `tasks` |
| `from` | Yes | All folders | Folder prefix (e.g. `Projects` or `Projects/Mobile`). Use `""` or `/` for root-level notes only. |
| `where` | Yes | All items | Boolean filter expression (see below) |
| `sort` | Yes | `modified desc` (`notes`) or `due asc` (`tasks`) | `<field> [asc\|desc]`; missing values always sort last |
| `limit` | Yes | Unlimited | Positive integer capping the number of displayed results |
| `view` | Yes | `list` (`notes`) or `tasks` (`tasks`) | Output format: `list`, `table(col1, col2, ...)`, `tasks`, or `count` |

### `where` filter syntax

Expressions support operator precedence **`OR` < `AND` < `NOT` < `(...)`** (keywords are case-insensitive).

- **Tag check**: `#tag` matches case-insensitively against frontmatter tags and inline `#tags` in the note body (outside code fences and inline code). For `type: tasks`, `#tag` matches both task-level `#tags` and parent note tags.
- **Comparisons**: `<field> <op> <value>` with operators `=`, `!=`, `<`, `<=`, `>`, `>=`, and `contains` (case-insensitive substring match on strings, or case-insensitive element/substring match on lists like `tags`).
- **Bare truthy check**: `<field>` (or `NOT <field>`) checks whether a field is present and truthy (e.g. `where: NOT done`, `where: published`, `where: due`).
- **Literals**:
  - Strings: `"double quoted"`, `'single quoted'`, or unquoted words (`active`, `2026-11-27`)
  - Numbers: `1`, `2.5`, `-10` (ordering compares numerically when both sides are numbers)
  - Booleans: `true`, `false`
  - Relative dates: `today`, `today+Nd`, `today-Nd`, `today+Nw`, `today-Nw`, `today+Nm`, `today-Nm` (`d` = days, `w` = weeks, `m` = months)

### Available fields

#### Built-in fields for `type: notes`

- `title` — note filename without `.md`
- `name` — full filename (e.g. `Alpha.md`)
- `folder` — folder path (`""` at vault root)
- `path` — full path without `.md` (e.g. `Projects/Alpha`)
- `modified` — last modified timestamp (normalized to `YYYY-MM-DD` when compared with dates or relative dates)
- `tags` — combined frontmatter and inline body tags
- **Any YAML frontmatter property** — looked up case-insensitively (e.g. `status`, `priority`, `owner`)

#### Built-in fields for `type: tasks`

- `text` — task body text
- `done` — boolean (`true` for `[x]`, `false` for `[ ]`)
- `due` — `@YYYY-MM-DD` due date on the task (empty when unset)
- `line` — 1-based line number in the source note
- `tags` — task-level `#tags`
- **Parent note fields** — `title`, `name`, `folder`, `path`, `modified`, and any parent note YAML frontmatter property not shadowed by a task field

### Views

- **`list`**: Compact list of clickable note links with folder subtitles (or task items when `type: tasks`).
- **`table(col1, col2, ...)`**: Responsive table with the requested columns. A `title` column renders as clickable note links, `tags` renders as pills, and missing values display as `—`.
- **`tasks`** (requires `type: tasks`): Interactive checklist with optional `@YYYY-MM-DD` due badges and source note links. Checking or unchecking a task updates the view immediately and saves the change back to the source note through the sync queue (and records an undoable edit when toggling a task inside the active note in Edit mode). If the note changed since the results were drawn, the click writes nothing and the results refresh.
- **`count`**: Clean numeric summary card showing how many notes or tasks match the query.

### Examples

#### Active projects table

````markdown
```query
from: Projects
where: status = "active" AND NOT #archived
sort: priority asc
view: table(title, status, priority, tags, modified)
```
````

#### Open tasks due in the next 7 days

````markdown
```query
type: tasks
where: NOT done AND due <= today+7d
sort: due asc
view: tasks
```
````

#### Count of open urgent tasks

````markdown
```query
type: tasks
where: NOT done AND #urgent
view: count
```
````

### Local cache & offline vault behavior

Query blocks evaluate strictly against notes cached locally on your device (in memory, pending edits, or IndexedDB) so both Preview and Edit mode stay instant and never trigger background Google Drive downloads.

Each query block displays a compact footer showing both the number of results and how many vault notes are currently cached (for example, `3 results · 14 of 120 notes cached`). To include every note in your vault in query results—even notes you have not opened recently—enable **Offline vault** pinning in **Settings**.
