import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const scriptPath = resolve(import.meta.dirname, "check-test-timeouts.mjs");
const tmpRoot = mkdtempSync(join(tmpdir(), "test-timeouts-"));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runChecker(args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

function fixture(name, files) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    writeFileSync(join(dir, file), lines.join("\n"));
  }
  return dir;
}

describe("check-test-timeouts", () => {
  it("T1: exits 0 on tests without explicit timeouts, and on comment mentions", () => {
    const dir = fixture("t1-clean", {
      "ok.test.tsx": [
        "await vi.waitFor(() => expect(x).toBe(1));",
        'await screen.findByRole("tree", { name: "Notes" });',
        "setTimeout(resolve, 200);",
        "const t = options.timeout;",
        "// a comment mentioning { timeout: 3000 }",
        "/*",
        " * a block mentioning { timeout: 3000 }",
        " */",
      ],
    });

    const res = runChecker([dir]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\b1 test files scanned\b/);
  });

  it("T2: exits 1 with file:line for every planted timeout, including a shared options object", () => {
    const dir = fixture("t2-bad", {
      "bad.test.tsx": [
        "const WAIT = { timeout: 3000 };",
        "await vi.waitFor(() => expect(x).toBe(1), WAIT);",
        'await screen.findByText("Saved", {}, { timeout: DELAY + 1_500 });',
        "await waitFor(() => expect(x).toBe(1), { timeout });",
        'await waitFor(fn, { "timeout": 10 });',
      ],
    });

    const res = runChecker([dir]);
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    for (const line of [1, 3, 4, 5]) {
      assert.match(res.stderr, new RegExp(`bad\\.test\\.tsx:${line}:`), res.stderr);
    }
    assert.doesNotMatch(res.stderr, /bad\.test\.tsx:2:/, res.stderr);
  });

  it("T3: accepts a timeout with a reasoned marker directly above it", () => {
    const dir = fixture("t3-allowed", {
      "allowed.test.ts": [
        "// test-timeout-allowed: waits out the real 1 s debounce",
        "const WAIT = { timeout: 3000 };",
      ],
    });

    const res = runChecker([dir]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\(1 allowlisted\)/);
  });

  it("T4: rejects a marker without a reason, and a marker with no timeout below", () => {
    const dir = fixture("t4-bad-markers", {
      "markers.test.ts": [
        "// test-timeout-allowed:",
        "const A = { timeout: 1 };",
        "// test-timeout-allowed: stale reason",
        "const b = 2;",
        "// test-timeout-allowed: trailing stale reason",
      ],
    });

    const res = runChecker([dir]);
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /markers\.test\.ts:1: .*without a reason/);
    assert.match(res.stderr, /markers\.test\.ts:2: explicit test timeout/);
    assert.match(res.stderr, /markers\.test\.ts:3: .*no timeout below/);
    assert.match(res.stderr, /markers\.test\.ts:5: .*no timeout below/);
  });

  it("T5: ignores non-test files", () => {
    const dir = fixture("t5-non-test", {
      "prod.ts": ["const WAIT = { timeout: 3000 };"],
      "clean.test.ts": ["export {};"],
    });

    const res = runChecker([dir]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });

  it("T6: exits 0 on the default web/src directory with no arguments", () => {
    const res = runChecker();
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\b[1-9]\d* test files scanned\b/);
  });

  it("T7: exits 2 on a missing directory or one with zero test files", () => {
    assert.equal(runChecker([join(tmpRoot, "does-not-exist")]).status, 2);
    const dir = fixture("t7-empty", { "prod.ts": ["export {};"] });
    assert.equal(runChecker([dir]).status, 2);
  });
});
