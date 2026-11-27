import { yaml } from "@codemirror/lang-yaml";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/**
 * Reuse the already-bundled YAML language so `yaml`, `yml`, and Markyard `query`
 * fenced blocks highlight synchronously without an extra dynamic import.
 */
const YAML_LANGUAGE = LanguageDescription.of({
  name: "YAML",
  alias: ["yml", "query"],
  extensions: ["yaml", "yml"],
  support: yaml(),
});

/**
 * CodeMirror 6 language descriptions for fenced code blocks. Every language other
 * than YAML is loaded lazily on first use via dynamic `import()` from
 * `@codemirror/language-data`.
 */
export const CODE_LANGUAGES: readonly LanguageDescription[] = [
  YAML_LANGUAGE,
  ...languages.filter((desc) => desc.name !== "YAML"),
];

/**
 * Common fence info shorthands whose short forms live only in `extensions` (not
 * `alias`) inside `@codemirror/language-data`.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  console: "shell",
  docker: "dockerfile",
  golang: "go",
  jsonc: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  shellscript: "shell",
};

/**
 * Plain-text fence labels that must not fuzzy-match unrelated grammars (for example,
 * `"text"` and `"plaintext"` contain `"tex"`, which would otherwise match LaTeX).
 */
const PLAIN_TEXT_INFO = new Set(["none", "plain", "plaintext", "text", "txt"]);

/**
 * Resolves a Markdown fenced code info string (such as `"ts"`, `"python"`, or
 * `"query"`) to its `LanguageDescription`, or `null` when plain text or unknown.
 */
export function matchCodeLanguage(info: string): LanguageDescription | null {
  const token = /^\S+/.exec(info.trim())?.[0];
  if (!token) {
    return null;
  }
  const lower = token.toLowerCase();
  if (PLAIN_TEXT_INFO.has(lower)) {
    return null;
  }
  const normalized = LANGUAGE_ALIASES[lower] ?? lower;
  return LanguageDescription.matchLanguageName(CODE_LANGUAGES, normalized, true);
}
