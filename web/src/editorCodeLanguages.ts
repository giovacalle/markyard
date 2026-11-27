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
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["console", "shell"],
  ["docker", "dockerfile"],
  ["golang", "go"],
  ["jsonc", "json"],
  ["md", "markdown"],
  ["py", "python"],
  ["rs", "rust"],
  ["shellscript", "shell"],
]);

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
  const normalized = LANGUAGE_ALIASES.get(lower) ?? lower;
  return LanguageDescription.matchLanguageName(CODE_LANGUAGES, normalized, false);
}
