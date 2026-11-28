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

function rawGet(baseUrl, path) {
  const url = new URL(baseUrl);
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
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

if (isMainEntry(scriptPath)) {
  process.exitCode = (await runSmoke()).exitCode;
}
