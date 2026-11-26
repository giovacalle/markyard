import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, "..");

const DEFAULT_PORT = 4173;
const DEFAULT_DIST_DIR = resolve(repoRoot, "web/dist");
const DEFAULT_HEADERS_FILE = resolve(repoRoot, "web/public/_headers");
const DEFAULT_FIXTURE_FILE = resolve(scriptDir, "mock-api.fixture.json");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

/**
 * Parses Cloudflare `_headers` rules: a URL pattern line followed by indented `Name: value` lines.
 * @param {string} text
 * @returns {Array<{ pattern: string, headers: Array<[string, string]> }>}
 */
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (/^\s/.test(rawLine)) {
      if (!current) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (name.length > 0) current.headers.push([name, value]);
    } else {
      current = { pattern: trimmed, headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function patternMatches(pattern, pathname) {
  if (pattern === pathname) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // includes trailing "/"
    return pathname === pattern.slice(0, -2) || pathname.startsWith(prefix);
  }
  return false;
}

/**
 * Collects headers from every `_headers` rule matching `pathname`.
 * @param {Array<{ pattern: string, headers: Array<[string, string]> }>} rules
 * @param {string} pathname
 * @returns {Array<[string, string]>}
 */
export function headersFor(rules, pathname) {
  const matched = [];
  for (const rule of rules) {
    if (patternMatches(rule.pattern, pathname)) {
      matched.push(...rule.headers);
    }
  }
  return matched;
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function serveStatic(req, res, pathname, distDir, headerRules) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  if (decoded.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  const resolvedDist = realpathSync(resolve(distDir));
  const candidate = resolve(resolvedDist, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(resolvedDist, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let filePath = resolve(resolvedDist, "index.html");
  if (isRegularFile(candidate)) {
    const realCandidate = realpathSync(candidate);
    const realRel = relative(resolvedDist, realCandidate);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    filePath = realCandidate;
  }
  if (!isRegularFile(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const body = readFileSync(filePath);
  for (const [name, value] of headersFor(headerRules, pathname)) {
    res.setHeader(name, value);
  }
  res.setHeader("Content-Type", contentTypeFor(filePath));
  res.setHeader("Content-Length", String(body.byteLength));
  res.writeHead(200);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

const DEFAULT_SESSION = { email: "fixture@example.com", name: "Fixture User" };
const ALLOWED_SESSION_KEYS = new Set(["email", "name"]);
const INITIAL_TIME = "2026-01-01T00:00:00.000Z";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatEtag(id, rev) {
  return `"${id}-${rev}"`;
}

function toDriveNode(node) {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    modifiedTime: node.modifiedTime,
  };
}

/**
 * Validates and builds an in-memory fixture vault from JSON.
 * @param {unknown} json
 */
export function loadFixture(json) {
  if (!isPlainObject(json)) {
    throw new Error("Fixture must be a JSON object");
  }

  let session = { ...DEFAULT_SESSION };
  if (json.session !== undefined) {
    if (!isPlainObject(json.session)) {
      throw new Error("Fixture session must be an object");
    }
    for (const key of Object.keys(json.session)) {
      if (!ALLOWED_SESSION_KEYS.has(key)) {
        throw new Error(`Unsupported fixture session key: "${key}"`);
      }
    }
    if (typeof json.session.email !== "string" || json.session.email.trim().length === 0) {
      throw new Error("Fixture session.email must be a non-empty string");
    }
    if (json.session.name !== undefined && typeof json.session.name !== "string") {
      throw new Error("Fixture session.name must be a string");
    }
    session =
      json.session.name !== undefined
        ? { email: json.session.email, name: json.session.name }
        : { email: json.session.email };
  }

  if (!isPlainObject(json.files)) {
    throw new Error("Fixture files must be an object mapping paths to UTF-8 strings");
  }

  const rootId = "fixture-root";
  const nodes = new Map();
  const childrenByParent = new Map();
  const pathToId = new Map();

  const rootNode = {
    id: rootId,
    name: "Vault",
    kind: "folder",
    parentId: null,
    modifiedTime: INITIAL_TIME,
  };
  nodes.set(rootId, rootNode);
  childrenByParent.set(rootId, new Map());

  let nextNumericId = 1;
  const allocateId = () => `fixture-${nextNumericId++}`;

  for (const [rawPath, content] of Object.entries(json.files)) {
    if (typeof content !== "string") {
      throw new Error(`Fixture file "${rawPath}" content must be a string`);
    }
    if (rawPath.length === 0 || rawPath.startsWith("/") || rawPath.endsWith("/")) {
      throw new Error(`Invalid fixture file path: "${rawPath}"`);
    }
    const segments = rawPath.split("/");
    for (const seg of segments) {
      if (seg.length === 0 || seg === "." || seg === ".." || seg.includes("\0")) {
        throw new Error(`Invalid path segment "${seg}" in fixture path "${rawPath}"`);
      }
    }

    let parentId = rootId;
    let currentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      currentPath = currentPath.length === 0 ? seg : `${currentPath}/${seg}`;
      const existingId = pathToId.get(currentPath);
      if (existingId !== undefined) {
        const existing = nodes.get(existingId);
        if (existing.kind !== "folder") {
          throw new Error(`Fixture path conflict: "${currentPath}" is both a file and a folder`);
        }
        parentId = existingId;
      } else {
        const id = allocateId();
        const folder = {
          id,
          name: seg,
          kind: "folder",
          parentId,
          modifiedTime: INITIAL_TIME,
        };
        nodes.set(id, folder);
        childrenByParent.set(id, new Map());
        childrenByParent.get(parentId).set(seg, id);
        pathToId.set(currentPath, id);
        parentId = id;
      }
    }

    const fileName = segments[segments.length - 1];
    const fullPath = segments.join("/");
    if (pathToId.has(fullPath)) {
      throw new Error(`Fixture path conflict: "${fullPath}" already exists`);
    }
    const id = allocateId();
    const kind = fileName.toLowerCase().endsWith(".md") ? "markdown" : "other";
    const file = {
      id,
      name: fileName,
      kind,
      parentId,
      modifiedTime: INITIAL_TIME,
      content,
      rev: 1,
      etag: formatEtag(id, 1),
    };
    nodes.set(id, file);
    childrenByParent.get(parentId).set(fileName, id);
    pathToId.set(fullPath, id);
  }

  return {
    session,
    rootId,
    nodes,
    childrenByParent,
    changes: [],
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { code, message });
}

function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function compareNodes(a, b) {
  const aFolder = a.kind === "folder" ? 0 : 1;
  const bFolder = b.kind === "folder" ? 0 : 1;
  if (aFolder !== bFolder) return aFolder - bFolder;
  return a.name.localeCompare(b.name);
}

const ETAG_PATTERN = /^"[A-Za-z0-9+/=_-]{1,200}"$/;
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

function isStrongEtag(value) {
  return typeof value === "string" && ETAG_PATTERN.test(value);
}

function isPageToken(value) {
  return typeof value === "string" && PAGE_TOKEN_PATTERN.test(value);
}

function toIndexEntry(node) {
  return {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    modifiedTime: node.modifiedTime,
  };
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

async function handleApi(req, res, pathname, searchParams, vault) {
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/session") {
    sendJson(res, 200, vault.session);
    return;
  }

  if (method === "GET" && pathname === "/api/root") {
    sendJson(res, 200, toDriveNode(vault.nodes.get(vault.rootId)));
    return;
  }

  if (method === "GET" && pathname === "/api/changes/start-token") {
    sendJson(res, 200, { startPageToken: String(vault.changes.length + 1) });
    return;
  }

  if (method === "GET" && pathname === "/api/changes") {
    const pageToken = searchParams.get("pageToken");
    if (pageToken === null || !isPageToken(pageToken)) {
      sendError(res, 400, "invalid_request", "A valid pageToken is required.");
      return;
    }
    const maxToken = vault.changes.length + 1;
    const numeric = POSITIVE_INT_PATTERN.test(pageToken) ? Number(pageToken) : NaN;
    if (!Number.isSafeInteger(numeric) || numeric > maxToken) {
      sendError(res, 410, "token_expired", "The change token expired. Reload the folder tree.");
      return;
    }
    const changes = vault.changes.slice(numeric - 1);
    sendJson(res, 200, {
      nextPageToken: String(maxToken),
      hasMore: false,
      changes,
    });
    return;
  }

  if (method === "GET" && pathname === "/api/vault/index") {
    const folders = [];
    const files = [];
    const queue = [vault.rootId];
    while (queue.length > 0) {
      const parentId = queue.shift();
      const childIds = Array.from(vault.childrenByParent.get(parentId)?.values() ?? []);
      const children = childIds.map((cid) => vault.nodes.get(cid)).sort(compareNodes);
      for (const child of children) {
        if (child.kind === "folder") {
          folders.push(toIndexEntry(child));
          queue.push(child.id);
        } else if (child.kind === "markdown") {
          files.push(toIndexEntry(child));
        }
      }
    }
    sendJson(res, 200, { rootId: vault.rootId, folders, files, truncated: false });
    return;
  }

  const childrenMatch = pathname.match(/^\/api\/folders\/([^/]+)\/children$/);
  if (method === "GET" && childrenMatch) {
    const id = decodeSegment(childrenMatch[1]);
    const folder = id === null ? undefined : vault.nodes.get(id);
    if (!folder || folder.kind !== "folder") {
      sendError(res, 404, "not_found", "Not found");
      return;
    }
    const childIds = Array.from(vault.childrenByParent.get(folder.id)?.values() ?? []);
    const nodes = childIds.map((cid) => toDriveNode(vault.nodes.get(cid))).sort(compareNodes);
    sendJson(res, 200, { nodes });
    return;
  }

  const contentMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/);
  if (contentMatch && (method === "GET" || method === "PUT")) {
    const id = decodeSegment(contentMatch[1]);
    const file = id === null ? undefined : vault.nodes.get(id);

    if (method === "GET") {
      if (!file || file.kind !== "markdown") {
        sendError(res, 404, "not_found", "Not found");
        return;
      }
      const body = Buffer.from(file.content, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        ETag: file.etag,
        "Content-Length": String(body.byteLength),
      });
      res.end(body);
      return;
    }

    const rawIfMatch = req.headers["if-match"];
    const ifMatch = typeof rawIfMatch === "string" ? rawIfMatch.trim() : "";
    if (!isStrongEtag(ifMatch)) {
      sendError(res, 428, "precondition_required", "A revision tag is required to save.");
      return;
    }
    if (!file || file.kind !== "markdown") {
      sendError(res, 404, "not_found", "Not found");
      return;
    }
    if (ifMatch !== file.etag) {
      sendError(res, 412, "conflict", "The note changed on Drive since it was opened.");
      return;
    }

    const body = await readRequestBody(req);
    file.content = body.toString("utf8");
    file.rev += 1;
    file.etag = formatEtag(file.id, file.rev);
    file.modifiedTime = new Date().toISOString();
    vault.changes.push({
      fileId: file.id,
      removed: false,
      time: file.modifiedTime,
      node: toDriveNode(file),
      parentIds: [file.parentId],
    });
    res.writeHead(204, { ETag: file.etag });
    res.end();
    return;
  }

  sendError(res, 501, "not_implemented", "Not served by the mock-api fixture");
}

export function createMockServer({
  distDir = DEFAULT_DIST_DIR,
  headersFile = DEFAULT_HEADERS_FILE,
  fixture,
  log = () => {},
} = {}) {
  const headerRules = parseHeaders(readFileSync(headersFile, "utf8"));
  const vault = fixture ?? loadFixture({ files: {} });
  return createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const queryIndex = rawUrl.indexOf("?");
    const rawPathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    if (rawPathname === "/api" || rawPathname.startsWith("/api/")) {
      const method = req.method ?? "GET";
      res.on("finish", () => {
        log(`${method} ${rawPathname} -> ${res.statusCode}`);
      });
      const searchParams = new URLSearchParams(
        queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1),
      );
      void handleApi(req, res, rawPathname, searchParams, vault).catch(() => {
        if (!res.headersSent) {
          sendError(res, 500, "internal_error", "Mock API handler error");
        }
      });
      return;
    }
    serveStatic(req, res, rawPathname, distDir, headerRules);
  });
}

function parseCliArgs(argv) {
  let port = DEFAULT_PORT;
  let distDir = DEFAULT_DIST_DIR;
  let fixtureFile = DEFAULT_FIXTURE_FILE;

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const raw = takeValue(i, arg);
      i += 1;
      if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid --port value "${raw}" (expected an integer 0..65535)`);
      }
      const parsed = Number(raw);
      if (parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid --port value "${raw}" (expected an integer 0..65535)`);
      }
      port = parsed;
    } else if (arg === "--dist") {
      distDir = resolve(takeValue(i, arg));
      i += 1;
    } else if (arg === "--fixture") {
      fixtureFile = resolve(takeValue(i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { port, distDir, fixtureFile };
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`mock-api: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const indexPath = resolve(options.distDir, "index.html");
  if (!isRegularFile(indexPath)) {
    process.stderr.write(
      `mock-api: missing ${indexPath}. Run "pnpm build" before starting mock-api.\n`,
    );
    process.exit(1);
  }

  let fixture;
  try {
    const rawFixture = JSON.parse(readFileSync(options.fixtureFile, "utf8"));
    fixture = loadFixture(rawFixture);
  } catch (err) {
    process.stderr.write(
      `mock-api: failed to load fixture "${options.fixtureFile}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  let server;
  try {
    server = createMockServer({
      distDir: options.distDir,
      fixture,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    process.stderr.write(
      `mock-api: failed to initialize server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  server.on("error", (err) => {
    const code = err && typeof err === "object" && "code" in err ? err.code : "ERROR";
    process.stderr.write(
      `mock-api: could not listen on 127.0.0.1:${options.port} (${code}). Pass --port <n> to choose another port.\n`,
    );
    process.exit(1);
  });

  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : options.port;
    process.stdout.write(`mock-api listening on http://127.0.0.1:${actualPort}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath);
  } catch {
    return resolve(process.argv[1]) === scriptPath;
  }
}

if (isMainEntry()) {
  main();
}
