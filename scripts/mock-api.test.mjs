import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer as createRawServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createMockServer, headersFor, loadFixture, parseHeaders } from "./mock-api.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const realHeadersFile = resolve(repoRoot, "web/public/_headers");
const mockApiScript = resolve(testDir, "mock-api.mjs");
const defaultFixtureFile = resolve(testDir, "mock-api.fixture.json");
const rootPackageJson = resolve(repoRoot, "package.json");

function expectedCspFromHeadersFile() {
  const raw = readFileSync(realHeadersFile, "utf8");
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("Content-Security-Policy:"));
  assert.ok(line, "Content-Security-Policy line must exist in web/public/_headers");
  return line.slice("Content-Security-Policy:".length).trim();
}

function makeTempDist() {
  const parent = mkdtempSync(join(tmpdir(), "markyard-mock-api-"));
  const dir = join(parent, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(parent, "secret.txt"), "TOP_SECRET_OUTSIDE_DIST");
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>ok</body></html>");
  writeFileSync(join(dir, "assets/app.js"), "console.log('app');");
  writeFileSync(join(dir, "assets/app.css"), "body { color: black; }");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Markyard"}');
  writeFileSync(join(dir, "icon.svg"), "<svg></svg>");
  writeFileSync(join(dir, "icon.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dir, "font.woff2"), Buffer.from([0, 1, 2, 3]));
  return { parent, dir };
}

async function startServer(options) {
  const server = createMockServer(options);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

describe("parseHeaders and headersFor", () => {
  it("parses Cloudflare _headers rules with splats and exact paths", () => {
    const rules = parseHeaders(`
# comment
/*
  Content-Security-Policy: default-src 'self'
  X-Content-Type-Options: nosniff

/assets/*
  Cache-Control: public, max-age=31536000

/exact
  X-Exact: yes
`);
    assert.deepEqual(headersFor(rules, "/"), [
      ["Content-Security-Policy", "default-src 'self'"],
      ["X-Content-Type-Options", "nosniff"],
    ]);
    assert.deepEqual(headersFor(rules, "/assets/app.js"), [
      ["Content-Security-Policy", "default-src 'self'"],
      ["X-Content-Type-Options", "nosniff"],
      ["Cache-Control", "public, max-age=31536000"],
    ]);
    assert.deepEqual(headersFor(rules, "/exact"), [
      ["Content-Security-Policy", "default-src 'self'"],
      ["X-Content-Type-Options", "nosniff"],
      ["X-Exact", "yes"],
    ]);
  });
});

describe("static serving and CSP headers", () => {
  const { parent, dir: distDir } = makeTempDist();
  let running;

  after(async () => {
    if (running) await running.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves index.html with the CSP from web/public/_headers on / and SPA fallback", async () => {
    running = await startServer({ distDir, headersFile: realHeadersFile });
    const expectedCsp = expectedCspFromHeadersFile();

    for (const path of ["/", "/some/deep/route"]) {
      const res = await fetch(`${running.baseUrl}${path}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-security-policy"), expectedCsp);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-type") ?? "", /^text\/html\b/);
      assert.equal(await res.text(), "<!doctype html><html><body>ok</body></html>");
    }

    const headRes = await fetch(`${running.baseUrl}/`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("content-security-policy"), expectedCsp);
    assert.equal(await headRes.text(), "");
  });

  it("serves static assets with correct content-type and CSP headers", async () => {
    const expectedCsp = expectedCspFromHeadersFile();
    const cases = [
      ["/assets/app.js", /^text\/javascript\b/],
      ["/assets/app.css", /^text\/css\b/],
      ["/manifest.webmanifest", /^application\/manifest\+json\b/],
      ["/icon.svg", /^image\/svg\+xml\b/],
      ["/icon.png", /^image\/png\b/],
      ["/font.woff2", /^font\/woff2\b/],
    ];
    for (const [path, expectedType] of cases) {
      const res = await fetch(`${running.baseUrl}${path}`);
      assert.equal(res.status, 200, `expected 200 for ${path}`);
      assert.match(res.headers.get("content-type") ?? "", expectedType, `content-type for ${path}`);
      assert.equal(res.headers.get("content-security-policy"), expectedCsp);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
  });

  it("refuses path-traversal requests outside distDir", async () => {
    const address = running.server.address();
    const rawRes = await new Promise((resolveReq, rejectReq) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/%2e%2e/secret.txt",
          method: "GET",
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolveReq({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", rejectReq);
      req.end();
    });
    assert.equal(rawRes.status, 403);
    assert.doesNotMatch(rawRes.body, /TOP_SECRET_OUTSIDE_DIST/);

    const fetchRes = await fetch(`${running.baseUrl}/%2e%2e/secret.txt`);
    assert.doesNotMatch(await fetchRes.text(), /TOP_SECRET_OUTSIDE_DIST/);
  });
});

describe("loadFixture validation", () => {
  it("rejects cloudSync, needsVaultSetup, and unknown session keys", () => {
    assert.throws(
      () => loadFixture({ session: { email: "a@b.c", cloudSync: true }, files: {} }),
      /cloudSync/,
    );
    assert.throws(
      () => loadFixture({ session: { email: "a@b.c", needsVaultSetup: true }, files: {} }),
      /needsVaultSetup/,
    );
    assert.throws(
      () => loadFixture({ session: { email: "a@b.c", extra: 1 }, files: {} }),
      /extra/,
    );
  });

  it("rejects empty, dot, and dot-dot path segments and file/folder collisions", () => {
    for (const badPath of ["", "/a.md", "a//b.md", "./a.md", "a/../b.md", "a/.", "a/"]) {
      assert.throws(() => loadFixture({ files: { [badPath]: "x" } }), /path/i, badPath);
    }
    assert.throws(
      () => loadFixture({ files: { notes: "x", "notes/a.md": "y" } }),
      /conflict|folder|file/i,
    );
  });
});

describe("session, root, and folder children endpoints", () => {
  const { parent, dir: distDir } = makeTempDist();
  const fixture = loadFixture({
    session: { email: "alice@example.com", name: "Alice" },
    files: {
      "Zebra.md": "# Zebra",
      "Alpha.md": "# Alpha",
      "notes/readme.txt": "plain text",
      "_styles/look.md": "```css\n:root { --markyard-accent: #b45309; }\n```\n",
    },
  });
  let running;

  after(async () => {
    if (running) await running.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("returns session JSON without static _headers CSP", async () => {
    running = await startServer({ distDir, headersFile: realHeadersFile, fixture });
    const res = await fetch(`${running.baseUrl}/api/session`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), null);
    assert.deepEqual(await res.json(), { email: "alice@example.com", name: "Alice" });
  });

  it("returns root folder node and sorted children with folders first", async () => {
    const rootRes = await fetch(`${running.baseUrl}/api/root`);
    assert.equal(rootRes.status, 200);
    const root = await rootRes.json();
    assert.equal(root.id, "fixture-root");
    assert.equal(root.kind, "folder");
    assert.equal(typeof root.modifiedTime, "string");

    const childrenRes = await fetch(`${running.baseUrl}/api/folders/${root.id}/children`);
    assert.equal(childrenRes.status, 200);
    const { nodes } = await childrenRes.json();
    assert.deepEqual(
      nodes.map((n) => [n.name, n.kind]),
      [
        ["_styles", "folder"],
        ["notes", "folder"],
        ["Alpha.md", "markdown"],
        ["Zebra.md", "markdown"],
      ],
    );

    const stylesFolder = nodes.find((n) => n.name === "_styles");
    const stylesRes = await fetch(`${running.baseUrl}/api/folders/${stylesFolder.id}/children`);
    assert.equal(stylesRes.status, 200);
    const stylesChildren = (await stylesRes.json()).nodes;
    assert.deepEqual(
      stylesChildren.map((n) => [n.name, n.kind]),
      [["look.md", "markdown"]],
    );

    const notesFolder = nodes.find((n) => n.name === "notes");
    const notesRes = await fetch(`${running.baseUrl}/api/folders/${notesFolder.id}/children`);
    assert.equal(notesRes.status, 200);
    const notesChildren = (await notesRes.json()).nodes;
    assert.deepEqual(
      notesChildren.map((n) => [n.name, n.kind]),
      [["readme.txt", "other"]],
    );
  });

  it("returns 404 not_found for unknown or non-folder ids", async () => {
    const unknownRes = await fetch(`${running.baseUrl}/api/folders/does-not-exist/children`);
    assert.equal(unknownRes.status, 404);
    assert.deepEqual(await unknownRes.json(), { code: "not_found", message: "Not found" });

    const rootChildren = (
      await (await fetch(`${running.baseUrl}/api/folders/fixture-root/children`)).json()
    ).nodes;
    const file = rootChildren.find((n) => n.kind === "markdown");
    const fileAsFolderRes = await fetch(`${running.baseUrl}/api/folders/${file.id}/children`);
    assert.equal(fileAsFolderRes.status, 404);
    assert.deepEqual(await fileAsFolderRes.json(), { code: "not_found", message: "Not found" });
  });
});

describe("file content GET and PUT with ETag and If-Match", () => {
  const { parent, dir: distDir } = makeTempDist();
  const fixture = loadFixture({
    files: {
      "Welcome.md": "# Welcome\n\nInitial body.\n",
      "notes/raw.txt": "not markdown",
    },
  });
  let running;
  let welcomeId;
  let rawTxtId;
  let notesFolderId;

  after(async () => {
    if (running) await running.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("GET returns UTF-8 content and strong quoted ETag, and 404 for unknown/non-markdown", async () => {
    running = await startServer({ distDir, headersFile: realHeadersFile, fixture });
    const rootNodes = (
      await (await fetch(`${running.baseUrl}/api/folders/fixture-root/children`)).json()
    ).nodes;
    welcomeId = rootNodes.find((n) => n.name === "Welcome.md").id;
    notesFolderId = rootNodes.find((n) => n.name === "notes").id;
    const notesNodes = (
      await (await fetch(`${running.baseUrl}/api/folders/${notesFolderId}/children`)).json()
    ).nodes;
    rawTxtId = notesNodes.find((n) => n.name === "raw.txt").id;

    const res = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[A-Za-z0-9+/=_-]{1,200}"$/);
    assert.equal(etag, `"${welcomeId}-1"`);
    assert.equal(await res.text(), "# Welcome\n\nInitial body.\n");

    for (const badId of ["missing-id", notesFolderId, rawTxtId]) {
      const badRes = await fetch(`${running.baseUrl}/api/files/${badId}/content`);
      assert.equal(badRes.status, 404, `expected 404 for ${badId}`);
      assert.deepEqual(await badRes.json(), { code: "not_found", message: "Not found" });
    }
  });

  it("PUT saves with matching If-Match, rejects stale with 412, rejects missing/weak with 428", async () => {
    const initial = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`);
    const etag1 = initial.headers.get("etag");
    assert.ok(etag1);

    // Missing If-Match -> 428
    const missingRes = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: "should not save",
    });
    assert.equal(missingRes.status, 428);
    assert.deepEqual(await missingRes.json(), {
      code: "precondition_required",
      message: "A revision tag is required to save.",
    });

    // Weak If-Match -> 428
    const weakRes = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`, {
      method: "PUT",
      headers: {
        "If-Match": `W/${etag1}`,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: "should not save",
    });
    assert.equal(weakRes.status, 428);
    assert.deepEqual(await weakRes.json(), {
      code: "precondition_required",
      message: "A revision tag is required to save.",
    });

    // Matching strong If-Match -> 204 with new ETag
    const putRes = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`, {
      method: "PUT",
      headers: {
        "If-Match": etag1,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: "# Welcome\n\nUpdated body — café.\n",
    });
    assert.equal(putRes.status, 204);
    const etag2 = putRes.headers.get("etag");
    assert.match(etag2 ?? "", /^"[A-Za-z0-9+/=_-]{1,200}"$/);
    assert.equal(etag2, `"${welcomeId}-2"`);
    assert.notEqual(etag2, etag1);

    // Subsequent GET sees new body and new ETag
    const afterPut = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`);
    assert.equal(afterPut.status, 200);
    assert.equal(afterPut.headers.get("etag"), etag2);
    assert.equal(await afterPut.text(), "# Welcome\n\nUpdated body — café.\n");

    // Stale If-Match -> 412 and body unchanged
    const staleRes = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`, {
      method: "PUT",
      headers: {
        "If-Match": etag1,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: "stale overwrite",
    });
    assert.equal(staleRes.status, 412);
    assert.deepEqual(await staleRes.json(), {
      code: "conflict",
      message: "The note changed on Drive since it was opened.",
    });

    const stillUpdated = await fetch(`${running.baseUrl}/api/files/${welcomeId}/content`);
    assert.equal(await stillUpdated.text(), "# Welcome\n\nUpdated body — café.\n");
    assert.equal(stillUpdated.headers.get("etag"), etag2);
  });
});

describe("changes feed and vault index", () => {
  const { parent, dir: distDir } = makeTempDist();
  const fixture = loadFixture({
    files: {
      "Welcome.md": "# Welcome\n",
      "_styles/look.md": "```css\n:root { --markyard-accent: #b45309; }\n```\n",
      "notes/sub/deep.md": "# Deep\n",
      "notes/attachment.txt": "ignored by vault index",
    },
  });
  let running;

  after(async () => {
    if (running) await running.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("records PUT updates in the changes feed and validates pageToken shapes", async () => {
    running = await startServer({ distDir, headersFile: realHeadersFile, fixture });

    const tokenRes = await fetch(`${running.baseUrl}/api/changes/start-token`);
    assert.equal(tokenRes.status, 200);
    const { startPageToken } = await tokenRes.json();
    assert.equal(typeof startPageToken, "string");
    assert.ok(startPageToken.length > 0);

    const indexRes = await fetch(`${running.baseUrl}/api/vault/index`);
    assert.equal(indexRes.status, 200);
    const index = await indexRes.json();
    const look = index.files.find((f) => f.name === "look.md");
    assert.ok(look);

    const getRes = await fetch(`${running.baseUrl}/api/files/${look.id}/content`);
    const etag = getRes.headers.get("etag");
    const putRes = await fetch(`${running.baseUrl}/api/files/${look.id}/content`, {
      method: "PUT",
      headers: {
        "If-Match": etag,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: "```css\n:root { --markyard-accent: #15803d; }\n```\n",
    });
    assert.equal(putRes.status, 204);

    const changesRes = await fetch(
      `${running.baseUrl}/api/changes?pageToken=${encodeURIComponent(startPageToken)}`,
    );
    assert.equal(changesRes.status, 200);
    const page = await changesRes.json();
    assert.equal(page.hasMore, false);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].fileId, look.id);
    assert.equal(page.changes[0].removed, false);
    assert.equal(typeof page.changes[0].time, "string");
    assert.equal(page.changes[0].node.id, look.id);
    assert.equal(page.changes[0].node.name, "look.md");
    assert.equal(page.changes[0].node.kind, "markdown");
    assert.deepEqual(page.changes[0].parentIds, [look.parentId]);

    const secondRes = await fetch(
      `${running.baseUrl}/api/changes?pageToken=${encodeURIComponent(page.nextPageToken)}`,
    );
    assert.equal(secondRes.status, 200);
    const secondPage = await secondRes.json();
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(secondPage.changes, []);
    assert.equal(secondPage.nextPageToken, page.nextPageToken);

    // Missing or ill-shaped pageToken -> 400 invalid_request
    for (const query of ["", "?pageToken=", "?pageToken=bad%20token!"]) {
      const badRes = await fetch(`${running.baseUrl}/api/changes${query}`);
      assert.equal(badRes.status, 400, `expected 400 for query ${query}`);
      assert.deepEqual(await badRes.json(), {
        code: "invalid_request",
        message: "A valid pageToken is required.",
      });
    }

    // Well-shaped unknown or beyond-log pageToken -> 410 token_expired
    for (const expiredToken of ["notanumber", "0", "999"]) {
      const expiredRes = await fetch(
        `${running.baseUrl}/api/changes?pageToken=${encodeURIComponent(expiredToken)}`,
      );
      assert.equal(expiredRes.status, 410, `expected 410 for token ${expiredToken}`);
      const errBody = await expiredRes.json();
      assert.equal(errBody.code, "token_expired");
    }
  });

  it("returns every non-root folder and markdown file in /api/vault/index and omits other files", async () => {
    const res = await fetch(`${running.baseUrl}/api/vault/index`);
    assert.equal(res.status, 200);
    const index = await res.json();
    assert.equal(index.rootId, "fixture-root");
    assert.equal(index.truncated, false);

    const folderByName = new Map(index.folders.map((f) => [f.name, f]));
    assert.deepEqual(Array.from(folderByName.keys()).sort(), ["_styles", "notes", "sub"]);
    assert.equal(folderByName.get("_styles").parentId, "fixture-root");
    assert.equal(folderByName.get("notes").parentId, "fixture-root");
    assert.equal(folderByName.get("sub").parentId, folderByName.get("notes").id);

    const fileByName = new Map(index.files.map((f) => [f.name, f]));
    assert.deepEqual(Array.from(fileByName.keys()).sort(), ["Welcome.md", "deep.md", "look.md"]);
    assert.equal(fileByName.get("Welcome.md").parentId, "fixture-root");
    assert.equal(fileByName.get("look.md").parentId, folderByName.get("_styles").id);
    assert.equal(fileByName.get("deep.md").parentId, folderByName.get("sub").id);
  });
});

function runCliToExit(args, cwd = tmpdir()) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [mockApiScript, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function startCli(args, cwd = tmpdir()) {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [mockApiScript, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const killChild = () =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        child.once("close", () => done());
        child.kill("SIGTERM");
      });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (!settled && newline !== -1) {
        settled = true;
        const firstLine = stdout.slice(0, newline);
        resolveStart({
          child,
          firstLine,
          getStdout: () => stdout,
          getStderr: () => stderr,
          stop: killChild,
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        rejectStart(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        rejectStart(new Error(`mock-api exited early with code ${code}: ${stderr}`));
      }
    });
  });
}

describe("default fixture, 501 routes, CLI, and package.json", () => {
  const { parent, dir: distDir } = makeTempDist();
  const emptyDist = join(parent, "empty-dist");
  mkdirSync(emptyDist, { recursive: true });

  after(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("commits a valid default fixture with _styles/look.md CSS and a root note", () => {
    const raw = JSON.parse(readFileSync(defaultFixtureFile, "utf8"));
    const vault = loadFixture(raw);
    const nodes = Array.from(vault.nodes.values());
    const stylesFolder = nodes.find((n) => n.kind === "folder" && n.name === "_styles");
    assert.ok(stylesFolder, "default fixture must contain _styles folder");
    const look = nodes.find((n) => n.parentId === stylesFolder.id && n.name === "look.md");
    assert.ok(look && look.kind === "markdown", "default fixture must contain _styles/look.md");
    assert.match(look.content, /```css[\s\S]*--markyard-[\s\S]*```/);
    const rootNotes = nodes.filter((n) => n.parentId === vault.rootId && n.kind === "markdown");
    assert.ok(rootNotes.length >= 1, "default fixture must contain at least one root note");
  });

  it("answers 501 not_implemented for unmocked /api/* routes", async () => {
    const running = await startServer({ distDir, headersFile: realHeadersFile });
    try {
      for (const [method, path] of [
        ["GET", "/api/search?q=hello"],
        ["GET", "/api/attachments"],
        ["GET", "/api/state"],
        ["POST", "/api/auth/logout"],
      ]) {
        const res = await fetch(`${running.baseUrl}${path}`, { method });
        assert.equal(res.status, 501, `${method} ${path} should be 501`);
        assert.deepEqual(await res.json(), {
          code: "not_implemented",
          message: "Not served by the mock-api fixture",
        });
      }
    } finally {
      await running.close();
    }
  });

  it("CLI serves default fixture from any cwd, logs listening line on stdout and API calls on stderr", async () => {
    const cli = await startCli(["--dist", distDir, "--port", "0"]);
    try {
      const match = cli.firstLine.match(/^mock-api listening on (http:\/\/127\.0\.0\.1:(\d+))$/);
      assert.ok(match, `unexpected listening line: ${cli.firstLine}`);
      const baseUrl = match[1];

      const pageRes = await fetch(`${baseUrl}/`);
      assert.equal(pageRes.status, 200);
      assert.equal(pageRes.headers.get("content-security-policy"), expectedCspFromHeadersFile());

      const sessionRes = await fetch(`${baseUrl}/api/session`);
      assert.equal(sessionRes.status, 200);
      const session = await sessionRes.json();
      assert.equal(typeof session.email, "string");
    } finally {
      await cli.stop();
    }

    assert.equal(cli.getStdout(), `${cli.firstLine}\n`);
    assert.match(cli.getStderr(), /GET \/api\/session -> 200/);
  });

  it("CLI loads custom --fixture JSON and replaces the default vault", async () => {
    const customFixturePath = join(parent, "custom.json");
    writeFileSync(
      customFixturePath,
      JSON.stringify({
        session: { email: "seeded@example.com", name: "Seeded" },
        files: { "Seeded.md": "# Seeded note\n" },
      }),
    );

    const cli = await startCli(["--dist", distDir, "--port", "0", "--fixture", customFixturePath]);
    try {
      const baseUrl = cli.firstLine.replace("mock-api listening on ", "");
      const session = await (await fetch(`${baseUrl}/api/session`)).json();
      assert.deepEqual(session, { email: "seeded@example.com", name: "Seeded" });

      const index = await (await fetch(`${baseUrl}/api/vault/index`)).json();
      assert.deepEqual(
        index.files.map((f) => f.name),
        ["Seeded.md"],
      );
    } finally {
      await cli.stop();
    }
  });

  it("CLI rejects unknown --headers option", async () => {
    const result = await runCliToExit(["--dist", distDir, "--port", "0", "--headers", realHeadersFile]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option: --headers/);
  });

  it("CLI exits 1 mentioning pnpm build when dist/index.html is missing", async () => {
    const result = await runCliToExit(["--dist", emptyDist, "--port", "0"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pnpm build/);
  });

  it("CLI exits 1 when fixture JSON is invalid", async () => {
    const badFixturePath = join(parent, "bad.json");
    writeFileSync(
      badFixturePath,
      JSON.stringify({
        session: { email: "bad@example.com", cloudSync: true },
        files: {},
      }),
    );
    const result = await runCliToExit(["--dist", distDir, "--port", "0", "--fixture", badFixturePath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cloudSync/);
  });

  it("CLI exits 1 mentioning --port when the requested port is already in use", async () => {
    const blocker = createRawServer();
    await new Promise((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
    const { port } = blocker.address();
    try {
      const result = await runCliToExit(["--dist", distDir, "--port", String(port)]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--port/);
    } finally {
      await new Promise((done) => blocker.close(done));
    }
  });

  it("registers preview:mock and test:scripts in root package.json", () => {
    const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8"));
    assert.equal(pkg.scripts["preview:mock"], "node scripts/mock-api.mjs");
    assert.match(pkg.scripts["test:scripts"], /(^| )scripts\/mock-api\.test\.mjs( |$)/);
  });
});
