// Fails on explicit `timeout` options in web test files. A raised `waitFor` / `vi.waitFor` /
// `find*` timeout hides a timing dependency instead of fixing it (see `CODING_STANDARDS.md`):
// the fix is fake timers or awaiting the state the assertion needs.
//
// Usage: node scripts/check-test-timeouts.mjs [dir]
// Defaults to `<repo>/web/src`. Scans `*.test.[cm]?[jt]sx?` files only.
//
// What is flagged: any `timeout` object key in a test file, whatever its value (`timeout: 3000`,
// `timeout: DELAY + 500`, shorthand `{ timeout }`, quoted `"timeout":`). Flagging the key itself,
// not the call, also catches an options object shared through a constant
// (`const WAIT = { timeout: 3000 }; vi.waitFor(fn, WAIT)`): the constant's definition is reported.
//
// Allowlist: a line is accepted when the line directly above it is a comment of the form
// `// test-timeout-allowed: <reason>`. The reason is required. A marker not followed by a
// flagged line is itself reported, so stale markers do not pile up.
//
// Comment rule (same as check-csp-source.mjs): lines starting with `//` are skipped; block
// comments opened on a line starting with `/*` are skipped until `*/`.
//
// Known limits:
// - Computed keys (`{ [key]: 3000 }`) and options built at runtime are not caught (fail-open).
// - A positional timeout such as `it(name, fn, 5000)` is out of scope.
// - Any `timeout` key is flagged, including ones unrelated to `waitFor` / `find*` (fail-closed).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
const TIMEOUT_KEY_RE = /(?<![\w$.])timeout\s*[:,}]|["'`]timeout["'`]\s*:/;
const MARKER_RE = /^\/\/\s*test-timeout-allowed:(.*)$/;

const targetDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dirname, "../web/src");

let stats;
try {
  stats = statSync(targetDir);
} catch {
  console.error(`check-test-timeouts: directory not found: ${targetDir}`);
  process.exit(2);
}

if (!stats.isDirectory()) {
  console.error(`check-test-timeouts: not a directory: ${targetDir}`);
  process.exit(2);
}

const files = [];
for (const entry of readdirSync(targetDir, { recursive: true })) {
  if (typeof entry !== "string" || !TEST_FILE_RE.test(basename(entry))) continue;
  const fullPath = resolve(targetDir, entry);
  if (statSync(fullPath).isFile()) files.push(fullPath);
}
files.sort();

if (files.length === 0) {
  console.error(`check-test-timeouts: zero test files scanned in ${targetDir}`);
  process.exit(2);
}

const findings = [];
let allowed = 0;

for (const fullPath of files) {
  const where = (i) => `${relative(process.cwd(), fullPath)}:${i + 1}`;
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  let inBlock = false;
  // Index of the marker on the previous line, or -1.
  let pendingMarker = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const markerAbove = pendingMarker;
    pendingMarker = -1;
    let textToCheck;

    if (inBlock) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) continue;
      inBlock = false;
      textToCheck = line.slice(closeIdx + 2);
    } else if (trimmed.startsWith("//")) {
      const marker = MARKER_RE.exec(trimmed);
      if (marker) {
        if (marker[1].trim() === "") {
          findings.push(`${where(i)}: test-timeout-allowed marker without a reason`);
        } else {
          pendingMarker = i;
        }
      }
      if (markerAbove !== -1) {
        findings.push(`${where(markerAbove)}: test-timeout-allowed marker with no timeout below`);
      }
      continue;
    } else if (trimmed.startsWith("/*")) {
      const closeIdx = trimmed.indexOf("*/", 2);
      if (closeIdx === -1) inBlock = true;
      textToCheck = closeIdx === -1 ? "" : trimmed.slice(closeIdx + 2);
    } else {
      textToCheck = line;
    }

    if (TIMEOUT_KEY_RE.test(textToCheck)) {
      if (markerAbove !== -1) {
        allowed += 1;
      } else {
        findings.push(`${where(i)}: explicit test timeout: ${trimmed}`);
      }
    } else if (markerAbove !== -1) {
      findings.push(`${where(markerAbove)}: test-timeout-allowed marker with no timeout below`);
    }
  }

  if (pendingMarker !== -1) {
    findings.push(`${where(pendingMarker)}: test-timeout-allowed marker with no timeout below`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(
    "check-test-timeouts: fix the timing dependency in the test (fake timers, await the state it needs);" +
      " allowlist only with `// test-timeout-allowed: <reason>` on the line above",
  );
  process.exit(1);
}

console.log(
  `check-test-timeouts: ${files.length} test files scanned, no unlisted timeouts (${allowed} allowlisted)`,
);
