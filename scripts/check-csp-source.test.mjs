import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const scriptPath = resolve(import.meta.dirname, "check-csp-source.mjs");
const tmpRoot = mkdtempSync(join(tmpdir(), "csp-src-"));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runChecker(args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

function makeFixtureDir(name) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const BAD_SOURCE = [
  '<div style={{ color: "red" }} />',
  'const s = "<style>a{}</style>";',
  'el.setAttribute("style", "x");',
  "el.setAttribute('style', 'x');",
  'document.createElement("style");',
  'document.createElementNS("http://www.w3.org/2000/svg", "style");',
  "const n = 2",
  '  * 3; document.createElement("style");',
  "/*",
  '*/ el.setAttribute("style", "y");',
  'el.setAttribute("style", "z"); // ok?',
].join("\n");

describe("check-csp-source", () => {
  it("T1: exits 0 on clean code, CSSOM usage, and comment mentions", () => {
    const dir = makeFixtureDir("t1-clean");
    writeFileSync(
      join(dir, "ok.ts"),
      [
        'el.style.setProperty("color", "red");',
        "document.adoptedStyleSheets = [sheet];",
        'if (el.localName === "style") {}',
        'document.createElement("div", { className: "style" });',
        '// comment mentioning <style> and setAttribute("style", x)',
        '/* single-line block mentioning <style> and setAttribute("style", x) */',
        "/**",
        " * JSDoc mentioning <style>,",
        ' * setAttribute("style", x), and',
        ' * document.createElement("style").',
        " */",
      ].join("\n"),
    );

    const res = runChecker([dir]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\b[1-9]\d* files? scanned\b/);
  });

  it("T2: exits 1 and reports file:line for every planted inline-style pattern", () => {
    const dir = makeFixtureDir("t2-bad");
    writeFileSync(join(dir, "bad.tsx"), BAD_SOURCE);

    const res = runChecker([dir]);
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);

    for (const line of [1, 2, 3, 4, 5, 6, 8, 10, 11]) {
      assert.match(
        res.stderr,
        new RegExp(`bad\\.tsx:${line}:`),
        `expected bad.tsx:${line}: in stderr:\n${res.stderr}`,
      );
    }
    for (const cleanLine of [7, 9]) {
      assert.doesNotMatch(
        res.stderr,
        new RegExp(`bad\\.tsx:${cleanLine}:`),
        `did not expect bad.tsx:${cleanLine}: in stderr:\n${res.stderr}`,
      );
    }
  });

  it("T3: ignores excluded test files when at least one non-excluded file is clean", () => {
    const dir = makeFixtureDir("t3-excluded");
    writeFileSync(join(dir, "x.test.tsx"), BAD_SOURCE);
    writeFileSync(join(dir, "test-setup.ts"), BAD_SOURCE);
    writeFileSync(join(dir, "clean.ts"), "export const ok = true;\n");

    const res = runChecker([dir]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\b1 files? scanned\b/);
  });

  it("T4: exits 0 on the default web/src directory with no arguments", () => {
    const res = runChecker();
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\b[1-9]\d* files? scanned\b/);
  });

  it("T5: exits 2 when the target directory does not exist", () => {
    const res = runChecker([join(tmpRoot, "does-not-exist")]);
    assert.equal(res.status, 2, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.notEqual(res.stderr.trim(), "");
  });

  it("T6: exits 2 when only excluded files exist so zero files are scanned", () => {
    const dir = makeFixtureDir("t6-only-excluded");
    writeFileSync(join(dir, "x.test.tsx"), BAD_SOURCE);
    writeFileSync(join(dir, "test-setup.ts"), BAD_SOURCE);

    const res = runChecker([dir]);
    assert.equal(res.status, 2, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.notEqual(res.stderr.trim(), "");
  });
});
