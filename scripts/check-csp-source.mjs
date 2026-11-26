// Scans web source files for inline-style patterns forbidden by the strict CSP
// (`default-src 'self'` in `web/public/_headers`): JSX `style={`, `<style` tags,
// `setAttribute("style", ...)`, and `createElement("style")` / `createElementNS(..., "style")`.
//
// Usage: node scripts/check-csp-source.mjs [dir]
// Defaults to `<repo>/web/src`.
//
// Comment rule:
// - Lines starting with `//` are skipped.
// - Block comments opened on a line starting with `/*` are tracked until `*/`; text after `*/`
//   on the closing line is still checked. `*`-leading lines are skipped only inside an open block.
//
// Exclusions:
// - `*.test.[cm]?[jt]sx?` and `test-setup.ts`.
//
// Known limits:
// - A line inside a multi-line template literal or string that starts with `//` or `/*` is
//   skipped (fail-open).
// - A mid-line `/*` that opens a block is not tracked (fail-closed: later lines are still tested).
// - Trailing `//` comments on code lines are not stripped (fail-closed).
// - `/<style\b/i` is case-insensitive, so JSX `<Style>` components or TypeScript generics such as
//   `Array<Style>` are known false positives (fail-closed).
// - `createElement("style")` / `createElementNS(ns, "style")` only flags literal string arguments.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const CANDIDATE_RE = /\.[cm]?[jt]sx?$/;
const EXCLUDED_TEST_RE = /\.test\.[cm]?[jt]sx?$/;
const EXCLUDED_NAMES = new Set(["test-setup.ts"]);

const PATTERNS = [
  { label: "style={", regex: /\bstyle=\{/ },
  { label: "<style", regex: /<style\b/i },
  { label: 'setAttribute("style"', regex: /setAttribute\(\s*["'`]style["'`]/i },
  {
    label: 'createElement("style")',
    regex: /\bcreateElement\(\s*["'`]style["'`]|\bcreateElementNS\(\s*[^,)]+,\s*["'`]style["'`]/i,
  },
];

const targetDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dirname, "../web/src");

let stats;
try {
  stats = statSync(targetDir);
} catch {
  console.error(`check-csp-source: directory not found: ${targetDir}`);
  process.exit(2);
}

if (!stats.isDirectory()) {
  console.error(`check-csp-source: not a directory: ${targetDir}`);
  process.exit(2);
}

const entries = readdirSync(targetDir, { recursive: true });
const files = [];

for (const entry of entries) {
  if (typeof entry !== "string") continue;
  const name = basename(entry);
  if (!CANDIDATE_RE.test(name)) continue;
  if (EXCLUDED_TEST_RE.test(name) || EXCLUDED_NAMES.has(name)) continue;
  const fullPath = resolve(targetDir, entry);
  if (!statSync(fullPath).isFile()) continue;
  files.push(fullPath);
}

files.sort();

if (files.length === 0) {
  console.error(`check-csp-source: zero files scanned in ${targetDir}`);
  process.exit(2);
}

const findings = [];

for (const fullPath of files) {
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  let inBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    let textToCheck;

    if (inBlock) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) continue;
      inBlock = false;
      textToCheck = line.slice(closeIdx + 2);
    } else if (trimmed.startsWith("//")) {
      continue;
    } else if (trimmed.startsWith("/*")) {
      const closeIdx = trimmed.indexOf("*/", 2);
      if (closeIdx === -1) {
        inBlock = true;
        continue;
      }
      textToCheck = trimmed.slice(closeIdx + 2);
    } else {
      textToCheck = line;
    }

    for (const { label, regex } of PATTERNS) {
      if (regex.test(textToCheck)) {
        findings.push(`${relative(process.cwd(), fullPath)}:${i + 1}: ${label}: ${line.trim()}`);
      }
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(finding);
  }
  process.exit(1);
}

console.log(`check-csp-source: ${files.length} files scanned, no inline-style patterns`);
