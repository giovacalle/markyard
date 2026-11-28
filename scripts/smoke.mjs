import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SECURITY_HEADERS } from "../host-node/static-host.mjs";
import { isMainEntry } from "./mock-api.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, "..");

const MOCK_API_SCRIPT = resolve(scriptDir, "mock-api.mjs");
const CSP_REPORT_PATH = "/__mock/csp-reports";
const STRONG_ETAG_PATTERN = /^"[A-Za-z0-9+/=_-]{1,200}"$/;
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** A GET whose path and headers reach the server unchanged (`fetch` normalizes both). */
function rawGet(baseUrl, path, headers = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method: "GET",
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolveReq({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", rejectReq);
    req.end();
  });
}

function pnpmBuild() {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn("pnpm", ["build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("error", rejectBuild);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveBuild();
      } else {
        rejectBuild(new Error(`pnpm build failed (code=${code}, signal=${signal ?? "none"})`));
      }
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((done) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      done();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, SHUTDOWN_TIMEOUT_MS);
    killTimer.unref?.();
    child.once("close", finish);
    child.kill("SIGTERM");
  });
}

function startMockApi({ distDir, fixtureFile } = {}) {
  const args = [MOCK_API_SCRIPT, "--port", "0"];
  if (distDir !== undefined) args.push("--dist", distDir);
  if (fixtureFile !== undefined) args.push("--fixture", fixtureFile);

  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void stopChild(child).finally(() => rejectStart(err));
    };

    const timeout = setTimeout(() => {
      const detail = stderr.trim();
      fail(
        new Error(
          `mock-api did not start within ${STARTUP_TIMEOUT_MS}ms${detail ? `: ${detail}` : ""}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (settled) return;
      const match = stdout.match(/mock-api listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        settled = true;
        clearTimeout(timeout);
        resolveStart({
          child,
          baseUrl: match[1],
          getStderr: () => stderr,
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => fail(err));

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const detail = stderr.trim();
      rejectStart(
        new Error(
          `mock-api exited before listening (code=${code}, signal=${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

export async function runMatrix(
  baseUrl,
  { out = process.stderr } = {},
) {
  let rootId;
  let markdownFileId;
  let initialBody;
  let initialEtag;

  const steps = [
    [
      "static",
      async () => {
        const res = await fetch(`${baseUrl}/`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        await res.text();
        let expectedCsp = null;
        for (const [name, value] of SECURITY_HEADERS) {
          assert.equal(res.headers.get(name), value, `header ${name} mismatch`);
          if (name === "content-security-policy") expectedCsp = value;
        }
        assert.equal(
          res.headers.get("content-security-policy-report-only"),
          `${expectedCsp}; report-uri ${CSP_REPORT_PATH}`,
        );
      },
    ],
    [
      "session",
      async () => {
        const res = await fetch(`${baseUrl}/api/session`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        const session = await res.json();
        assert.equal(typeof session.email, "string");
      },
    ],
    [
      "root",
      async () => {
        const res = await fetch(`${baseUrl}/api/root`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        const root = await res.json();
        assert.equal(typeof root.id, "string");
        assert.ok(root.id.length > 0, "root.id must be non-empty");
        rootId = root.id;
      },
    ],
    [
      "children",
      async () => {
        const res = await fetch(`${baseUrl}/api/folders/${encodeURIComponent(rootId)}/children`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        const { nodes } = await res.json();
        const markdownNode = Array.isArray(nodes)
          ? nodes.find((node) => node.kind === "markdown")
          : undefined;
        assert.ok(markdownNode, "expected at least one markdown file under root");
        markdownFileId = markdownNode.id;
      },
    ],
    [
      "content",
      async () => {
        const res = await fetch(`${baseUrl}/api/files/${encodeURIComponent(markdownFileId)}/content`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        const etag = res.headers.get("etag");
        assert.match(etag ?? "", STRONG_ETAG_PATTERN, `expected strong ETag, got ${etag}`);
        initialBody = await res.text();
        initialEtag = etag;
      },
    ],
    [
      "put",
      async () => {
        const fileUrl = `${baseUrl}/api/files/${encodeURIComponent(markdownFileId)}/content`;

        const noMatchRes = await fetch(fileUrl, {
          method: "PUT",
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
          body: "missing if-match",
        });
        assert.equal(noMatchRes.status, 428, `expected 428 without If-Match, got ${noMatchRes.status}`);
        await noMatchRes.text();

        const staleRes = await fetch(fileUrl, {
          method: "PUT",
          headers: {
            "If-Match": '"stale-0"',
            "Content-Type": "text/markdown; charset=utf-8",
          },
          body: "stale if-match",
        });
        assert.equal(staleRes.status, 412, `expected 412 for stale If-Match, got ${staleRes.status}`);
        await staleRes.text();

        const updatedBody = `${initialBody}\n<!-- smoke -->\n`;
        const saveRes = await fetch(fileUrl, {
          method: "PUT",
          headers: {
            "If-Match": initialEtag,
            "Content-Type": "text/markdown; charset=utf-8",
          },
          body: updatedBody,
        });
        assert.equal(saveRes.status, 204, `expected 204 for matching If-Match, got ${saveRes.status}`);
        await saveRes.text();

        const verifyRes = await fetch(fileUrl);
        assert.equal(verifyRes.status, 200, `expected 200 on post-save GET, got ${verifyRes.status}`);
        assert.equal(await verifyRes.text(), updatedBody);
      },
    ],
    [
      "changes",
      async () => {
        const tokenRes = await fetch(`${baseUrl}/api/changes/start-token`);
        assert.equal(tokenRes.status, 200, `expected 200 for start-token, got ${tokenRes.status}`);
        const { startPageToken } = await tokenRes.json();
        assert.equal(typeof startPageToken, "string");
        assert.ok(startPageToken.length > 0);

        const feedRes = await fetch(
          `${baseUrl}/api/changes?pageToken=${encodeURIComponent(startPageToken)}`,
        );
        assert.equal(feedRes.status, 200, `expected 200 for changes feed, got ${feedRes.status}`);
        await feedRes.json();

        const expiredRes = await fetch(`${baseUrl}/api/changes?pageToken=999999`);
        assert.equal(
          expiredRes.status,
          410,
          `expected 410 for unknown pageToken, got ${expiredRes.status}`,
        );
        await expiredRes.text();
      },
    ],
    [
      "traversal",
      async () => {
        // `%2e%2e` is a dot segment the URL parser removes; `%2f` survives parsing and must be refused.
        const dotRes = await rawGet(baseUrl, "/%2e%2e/package.json");
        assert.doesNotMatch(dotRes.body, /"name":\s*"markyard"/, "dot-segment traversal leaked a file");
        const rawRes = await rawGet(baseUrl, "/..%2fpackage.json");
        assert.equal(rawRes.status, 403, `expected 403 for path traversal, got ${rawRes.status}`);
      },
    ],
    [
      "reports",
      async () => {
        const res = await fetch(`${baseUrl}${CSP_REPORT_PATH}`);
        assert.equal(res.status, 200, `expected 200 for csp-reports, got ${res.status}`);
        assert.deepEqual(await res.json(), []);
      },
    ],
  ];

  await runSteps(steps, out);
}

async function runSteps(steps, out) {
  for (const [name, fn] of steps) {
    try {
      await fn();
      out.write(`ok ${name}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.write(`FAIL ${name}: ${message}\n`);
      throw new Error(`${name}: ${message}`, { cause: err });
    }
  }
}

function assertSecurityHeaders(headers) {
  const get = (name) => (headers instanceof Headers ? headers.get(name) : headers[name]);
  for (const [name, value] of SECURITY_HEADERS) {
    assert.equal(get(name), value, `header ${name} mismatch`);
  }
}

/**
 * The signed-out matrix for a real host (the Node host or its container): no fixture vault, so
 * it checks static parity and the BFF answers that need no Google account.
 */
export async function runHostMatrix(baseUrl, { out = process.stderr } = {}) {
  let indexEtag;
  let assetPath;

  const steps = [
    [
      "static",
      async () => {
        const res = await fetch(`${baseUrl}/`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.match(res.headers.get("content-type") ?? "", /^text\/html\b/);
        assertSecurityHeaders(res.headers);
        assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
        indexEtag = res.headers.get("etag");
        assert.ok(indexEtag, "index.html must carry an ETag");
        const html = await res.text();
        assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
        assert.ok(assetPath, "index.html must reference a hashed /assets/*.js file");
      },
    ],
    [
      "revalidate",
      async () => {
        const res = await fetch(`${baseUrl}/`, { headers: { "if-none-match": indexEtag } });
        assert.equal(res.status, 304, `expected 304, got ${res.status}`);
        assertSecurityHeaders(res.headers);
      },
    ],
    [
      "asset",
      async () => {
        const res = await fetch(`${baseUrl}${assetPath}`);
        assert.equal(res.status, 200, `expected 200 for ${assetPath}, got ${res.status}`);
        assert.match(res.headers.get("content-type") ?? "", /^text\/javascript\b/);
        assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
        assertSecurityHeaders(res.headers);
        await res.arrayBuffer();
      },
    ],
    [
      "spa",
      async () => {
        const nav = await rawGet(baseUrl, "/some/deep/route", { "sec-fetch-mode": "navigate" });
        assert.equal(nav.status, 200, `expected 200 for a navigation, got ${nav.status}`);
        assert.match(nav.headers["content-type"] ?? "", /^text\/html\b/);
        assertSecurityHeaders(nav.headers);
        const res = await fetch(`${baseUrl}/some/deep/route`);
        assert.equal(res.status, 404, `expected 404 for a non-navigation miss, got ${res.status}`);
        assert.deepEqual(await res.json(), { code: "not_found", message: "Not found" });
      },
    ],
    [
      "headers-file",
      async () => {
        const res = await fetch(`${baseUrl}/_headers`);
        assert.equal(res.status, 404, `expected _headers to be hidden, got ${res.status}`);
        await res.text();
      },
    ],
    [
      "health",
      async () => {
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assertSecurityHeaders(res.headers);
        assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
        await res.json();
      },
    ],
    [
      "session",
      async () => {
        const res = await fetch(`${baseUrl}/api/session`);
        assert.equal(res.status, 401, `expected 401 signed out, got ${res.status}`);
        await res.text();
      },
    ],
    [
      "login",
      async () => {
        const res = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
        assert.equal(res.status, 302, `expected 302, got ${res.status}`);
        const location = new URL(res.headers.get("location") ?? "");
        assert.equal(location.origin, "https://accounts.google.com");
        assert.equal(location.searchParams.get("code_challenge_method"), "S256");
        assert.match(location.searchParams.get("redirect_uri") ?? "", /\/api\/auth\/callback$/);
        assert.ok(
          res.headers.getSetCookie().some((c) => c.startsWith("__Host-")),
          "login must set a __Host- state cookie",
        );
      },
    ],
    [
      "csrf",
      async () => {
        const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
        assert.equal(res.status, 403, `expected 403 without Origin, got ${res.status}`);
        await res.text();
      },
    ],
    [
      "traversal",
      async () => {
        const dotRes = await rawGet(baseUrl, "/%2e%2e/package.json");
        assert.doesNotMatch(dotRes.body, /"name":\s*"markyard"/, "dot-segment traversal leaked a file");
        const rawRes = await rawGet(baseUrl, "/..%2fpackage.json");
        assert.equal(rawRes.status, 403, `expected 403 for path traversal, got ${rawRes.status}`);
      },
    ],
  ];

  await runSteps(steps, out);
}

export async function runSmoke({
  build = pnpmBuild,
  distDir,
  fixtureFile,
  out = process.stderr,
} = {}) {
  let baseUrl;
  let started = null;
  let failed = false;
  try {
    await build();
    started = await startMockApi({ distDir, fixtureFile });
    baseUrl = started.baseUrl;
    await runMatrix(baseUrl, { out });
    return { exitCode: 0, baseUrl };
  } catch (err) {
    failed = true;
    if (!baseUrl) {
      const message = err instanceof Error ? err.message : String(err);
      out.write(`FAIL smoke: ${message}\n`);
    }
    return { exitCode: 1, baseUrl };
  } finally {
    if (started) {
      await stopChild(started.child);
      if (failed) {
        const childStderr = started.getStderr().trim();
        if (childStderr) {
          out.write(`mock-api stderr:\n${childStderr}\n`);
        }
      }
    }
  }
}

/** `pnpm smoke` runs the mock matrix; `pnpm smoke --target <url>` checks a running host. */
export async function main(argv, out = process.stderr) {
  if (argv.length === 0) return (await runSmoke({ out })).exitCode;
  if (argv.length !== 2 || argv[0] !== "--target" || !/^https?:\/\/[^/]+$/.test(argv[1])) {
    out.write("usage: smoke.mjs [--target http://host:port]\n");
    return 2;
  }
  try {
    await runHostMatrix(argv[1], { out });
    return 0;
  } catch {
    return 1;
  }
}

if (isMainEntry(scriptPath)) {
  process.exitCode = await main(process.argv.slice(2));
}
