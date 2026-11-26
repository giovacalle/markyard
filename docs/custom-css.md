# Custom CSS

Markyard lets you restyle the app using plain Markdown notes in your vault—without loosening its strict Content Security Policy.

## How it works

1. Create a folder named `_styles` at the root of your vault (configurable in **Settings → Appearance → Styles folder**).
2. Add one or more `.md` notes inside `_styles` containing fenced `css` code blocks (either triple backticks ```` ```css ```` or triple tildes `~~~css`).
3. Save the note. Markyard extracts every `css` fenced block and applies it immediately—no reload needed.

- **Load order**: notes in the styles folder are sorted alphabetically by filename (`localeCompare`), and blocks within each note are applied in document order. To disable a style note without deleting it, move it out of the styles folder.
- **Live updates**: saving a style note in Markyard or receiving a Drive sync change updates the active stylesheet in place.
- **No flash on reload**: the compiled CSS is cached in IndexedDB on the device and applied before first paint at boot.
- **Per-device settings**: the **Styles folder** path and the **Custom CSS** switch are per-device settings and are not synced via Cloud State. The `_styles` notes themselves live in Google Drive and sync with your vault like any other note.
- **Errors**: there is no CSS validator; browsers ignore invalid rules. **Settings → Appearance** displays a status line listing which style notes are currently loaded (or why custom CSS is off).

## Stable styling surface

Tailwind utility classes are an internal implementation detail and may change in any release. Build your styles on the documented CSS custom properties, `data-region` hooks, and `.dark` theme class below.

### CSS custom properties (`--markyard-*`)

Markyard leaves every `--markyard-*` variable unset by default so each region keeps its own default value. Setting a variable on `:root` (or `:root.dark`) overrides every region that reads it.

| Variable | Applies to | Default fallback |
| --- | --- | --- |
| `--markyard-font-ui` | App UI chrome (`html`) | System UI sans stack (`--default-font-family`) |
| `--markyard-font-text` | Preview body (`.markdown-preview`) and Editor body | System sans stack |
| `--markyard-font-mono` | Preview `code` / `pre` and Editor inline/fenced code | System monospace stack (`--default-mono-font-family`) |
| `--markyard-text-size` | Preview body and Editor body | `1rem` (Preview), `0.9375rem` (Editor) |
| `--markyard-line-height` | Preview body and Editor body | `1.625` (Preview), `1.7` (Editor) |
| `--markyard-text-width` | Note column max width (loaded and loading states) | `48rem` |
| `--markyard-accent` | Preview links, Preview `.wikilink`, and Editor links | Blue accent (`blue-600` / `blue-400` links, `blue-700` / `blue-300` wikilinks, `--cm-link` in Editor) |

### CodeMirror variables (`--cm-*`)

The CodeMirror editor shadow root reads these variables from `:root` and `:root.dark`:

- `--cm-bg`, `--cm-fg`, `--cm-heading`, `--cm-muted`, `--cm-caret`, `--cm-selection`
- `--cm-code-bg`, `--cm-code-fg`, `--cm-link`, `--cm-quote`, `--cm-active-line`
- `--cm-popup-bg`, `--cm-popup-border`
- `--cm-yaml-key`, `--cm-yaml-string`, `--cm-yaml-atom`, `--cm-yaml-comment`, `--cm-yaml-fence`

### Dark mode

Dark mode toggles the `.dark` class on `<html>`. Scope dark-only overrides with `:root.dark { … }` or `.dark [data-region="…"] { … }`.

### Region hooks (`data-region`)

| Selector | Region |
| --- | --- |
| `[data-region="sidebar"]` | Left file tree and workspace navigation sidebar |
| `[data-region="note-header"]` | Note title bar and toolbar actions |
| `[data-region="preview"]` | Note column while viewing a note in Preview mode |
| `[data-region="editor"]` | Note column while editing a note in Edit mode |
| `[data-region="info-drawer"]` | Right-hand Document info panel (Outline, Backlinks, Attachments, Stats) |
| `[data-region="tasks"]` | Global Tasks workspace panel |
| `[data-region="attachments"]` | Global Attachments workspace panel |
| `[data-region="palette"]` | Command palette dialog (`Cmd+K`) |
| `[data-region="settings"]` | Settings dialog |

`[data-region="preview"]` and `[data-region="editor"]` are the note column; it contains `[data-region="note-header"]` (the title bar) and the note body, so rules targeting those regions also reach the title bar—use `[data-region="preview"] .markdown-preview …` to style only the rendered note.

`[data-region="info-drawer"]` (the Document info panel) sits beside the note column, outside `[data-region="preview"]` and `[data-region="editor"]`, so rules on those regions do not reach it; target `[data-region="info-drawer"]` directly.

## Cascade & known limits

Markyard applies your CSS via a single shared unlayered constructable stylesheet (`document.adoptedStyleSheets`), placed after the app's layered CSS. In the main document, unlayered user CSS beats Markyard's layered `@layer` rules at any specificity without `!important`; however, inside the CodeMirror shadow roots (Editor, Conflict Merge, Revision Diff) Markyard's theme styles live in unlayered style-mod sheets scoped by a generated class, so a plain `.cm-content { … }` selector loses to them. KaTeX math styles have the same unlayered specificity limit.

For CodeMirror overrides, the supported route is setting `--markyard-*` or `--cm-*` custom properties on `:root` / `:root.dark`, or writing a selector of equal or higher specificity.

## CSP limits

Markyard preserves its strict `default-src 'self'` Content Security Policy and never creates `<style>` tags or inline style attributes. Because styles are applied through `CSSStyleSheet.prototype.replaceSync()` under this CSP:

- `@import` rules are ignored by the browser.
- `url()` only loads same-origin resources; remote fonts and external images are blocked. Use system or locally installed fonts in `font-family`.

## Recovery

If custom CSS hides controls or breaks the layout:

- **One-load bypass**: open Markyard with `?nocss=1` in the URL (for example, `https://notes.example.com/?nocss=1`). Custom CSS stays disabled for that entire page load so you can edit or move your style notes.
- **Persistent toggle**: open **Settings → Appearance** and turn off **Custom CSS**.

## Examples

### 1. Editorial reading typography and wider note column

````markdown
```css
:root {
  --markyard-font-text: Georgia, "Iowan Old Style", serif;
  --markyard-text-size: 1.0625rem;
  --markyard-line-height: 1.8;
  --markyard-text-width: 56rem;
  --markyard-accent: #b45309;
}

:root.dark {
  --markyard-accent: #f59e0b;
}
```
````

### 2. Warm paper palette for Preview, Editor, and Sidebar

````markdown
```css
:root {
  --cm-fg: #2c241b;
  --cm-heading: #1c1610;
  --cm-code-bg: #efe9dc;
}

[data-region="preview"],
[data-region="editor"] {
  background-color: #faf6ee;
}

[data-region="sidebar"] {
  background-color: #f3ede0;
}

.dark [data-region="preview"],
.dark [data-region="editor"] {
  background-color: #181512;
}

.dark [data-region="sidebar"] {
  background-color: #12100e;
}
```
````

### 3. Accent headings in Preview and a tinted Document info panel

Inside `.markdown-preview`, Markdown `#`, `##`, and `###` headings render as `h3`, `h4`, and `h5` (with deeper headings capped at `h6`) so they sit below the app and note title headings.

````markdown
```css
[data-region="preview"] .markdown-preview h3 {
  border-bottom: 1px solid #d4d4d4;
  padding-bottom: 0.25rem;
}

.dark [data-region="preview"] .markdown-preview h3 {
  border-bottom-color: #404040;
}

[data-region="info-drawer"] {
  background-color: #f5f3ff;
}

.dark [data-region="info-drawer"] {
  background-color: #1e1b2e;
}
```
````
