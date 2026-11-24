import { markSelfWrite } from "./selfWrites";

export interface Session {
  email: string;
  /** Google display name, when the account has one. */
  name?: string;
  /** `true` only when the BFF has its optional D1 database bound (`/api/state` works). */
  cloudSync?: boolean;
  /** `true` when this account has no vault folder yet: the app shows the folder picker. */
  needsVaultSetup?: boolean;
}

/** UI preferences synced across devices through `/api/state`. */
export interface CloudUserState {
  theme?: "light" | "dark" | "system";
  lastOpenFileId?: string | null;
  expandedFolders?: string[];
  readOnly?: boolean;
  focusMode?: boolean;
  typewriterMode?: boolean;
  infoDrawerOpen?: boolean;
  rootFolderId?: string | null;
  attachmentsFolder?: string;
  showAttachmentsFolder?: boolean;
  dailyNotesFolder?: string;
  templatesFolder?: string;
  defaultMode?: "preview" | "edit";
  linkPreviewsEnabled?: boolean;
}

export interface CloudStateResponse {
  enabled: boolean;
  state: CloudUserState | null;
  updatedAt: number | null;
}

export type NodeKind = "folder" | "markdown" | "other";

export interface DriveNode {
  id: string;
  name: string;
  kind: NodeKind;
  modifiedTime: string;
}

export interface SearchHit {
  node: DriveNode;
  path: string[];
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  time: string;
  node?: DriveNode;
  parentIds: string[];
}

export interface ChangesPage {
  nextPageToken: string;
  hasMore: boolean;
  changes: DriveChange[];
}

export interface VaultEntry {
  id: string;
  name: string;
  parentId: string;
  modifiedTime: string;
}

export interface VaultIndex {
  rootId: string;
  folders: VaultEntry[];
  files: VaultEntry[];
  truncated: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  /** Seconds the BFF asks to wait before trying again, from `Retry-After`. */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, reason?: string, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  reason?: string;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (response.ok) {
    return response;
  }
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Not a JSON error body: keep the defaults below.
  }
  const retryAfter = response.headers.get("Retry-After");
  throw new ApiError(
    response.status,
    body.code ?? "unknown",
    body.message ?? `Request failed: ${response.status}`,
    body.reason,
    retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined,
  );
}

export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const response = await request("/api/session", { signal });
  return (await response.json()) as Session;
}

export async function fetchCloudState(signal?: AbortSignal): Promise<CloudStateResponse> {
  const response = await request("/api/state", { signal });
  return (await response.json()) as CloudStateResponse;
}

/** Stores `state` unless the server holds a newer one; answers with the winning state. */
export async function putCloudState(
  state: CloudUserState,
  updatedAt: number,
): Promise<CloudStateResponse> {
  const response = await request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, updatedAt }),
  });
  return (await response.json()) as CloudStateResponse;
}

export async function fetchRoot(signal?: AbortSignal): Promise<DriveNode> {
  const response = await request("/api/root", { signal });
  return (await response.json()) as DriveNode;
}

/** A level of the user's Google Drive, for the vault folder picker. */
export interface DriveFoldersResponse {
  parent: { id: string; name: string };
  folders: DriveNode[];
}

/** Folders inside `parentId` anywhere in My Drive (its top level when omitted or `"root"`). */
export async function fetchDriveFolders(
  parentId?: string,
  signal?: AbortSignal,
): Promise<DriveFoldersResponse> {
  const query =
    parentId === undefined || parentId === "root"
      ? ""
      : `?parentId=${encodeURIComponent(parentId)}`;
  const response = await request(`/api/drive/folders${query}`, { signal });
  return (await response.json()) as DriveFoldersResponse;
}

/** Creates a folder anywhere in My Drive (its top level when `parentId` is omitted). */
export async function createDriveFolder(name: string, parentId?: string): Promise<DriveNode> {
  const response = await request("/api/drive/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      parentId === undefined || parentId === "root" ? { name } : { parentId, name },
    ),
  });
  return (await response.json()) as DriveNode;
}

/** Makes `folderId` this account's vault root; answers the new root. */
export async function setVaultRoot(folderId: string): Promise<DriveNode> {
  const response = await request("/api/vault/root", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderId }),
  });
  return ((await response.json()) as { root: DriveNode }).root;
}

export async function fetchChildren(id: string, signal?: AbortSignal): Promise<DriveNode[]> {
  const response = await request(`/api/folders/${encodeURIComponent(id)}/children`, { signal });
  return ((await response.json()) as { nodes: DriveNode[] }).nodes;
}

export async function searchDriveNotes(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const response = await request(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal });
  return ((await response.json()) as { results: SearchHit[] }).results;
}

/**
 * Reads a Drive revision tag from a response. A proxy that compresses the body may weaken a strong
 * tag to `W/"…"`; the BFF only accepts the strong form in `If-Match` (428 otherwise), and the quoted
 * value is still Drive's own tag, so the weak prefix is dropped.
 */
export function readRevision(response: Response): string {
  const raw = response.headers.get("ETag")?.trim() ?? "";
  return raw.startsWith("W/") ? raw.slice(2) : raw;
}

export class NotUtf8Error extends Error {
  constructor() {
    super("Not valid UTF-8");
    this.name = "NotUtf8Error";
  }
}

async function readUtf8(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new Uint8Array(buffer),
    );
  } catch {
    throw new NotUtf8Error();
  }
}

export async function fetchContent(
  id: string,
  signal?: AbortSignal,
): Promise<{ text: string; revision: string }> {
  const response = await request(`/api/files/${encodeURIComponent(id)}/content`, { signal });
  const text = await readUtf8(response);
  return { text, revision: readRevision(response) };
}

/** One stored Drive revision of a file, newest first in `fetchRevisions`. */
export interface Revision {
  id: string;
  modifiedTime: string;
  size?: number;
  author?: string;
  keepForever: boolean;
}

export async function fetchRevisions(fileId: string, signal?: AbortSignal): Promise<Revision[]> {
  const response = await request(`/api/files/${encodeURIComponent(fileId)}/revisions`, { signal });
  return ((await response.json()) as { revisions: Revision[] }).revisions;
}

/** The text of one Drive revision; throws `NotUtf8Error` when its bytes are not UTF-8. */
export async function fetchRevisionContent(
  fileId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await request(
    `/api/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`,
    { signal },
  );
  return readUtf8(response);
}

/** Image types `POST /api/attachments` accepts. */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** Upload cap of `POST /api/attachments`: 10 MiB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export type AttachmentErrorReason = "unsupported_type" | "too_large" | "offline";

/** An image refused on the client, before any request was made. */
export class AttachmentError extends Error {
  readonly reason: AttachmentErrorReason;

  constructor(reason: AttachmentErrorReason, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.reason = reason;
  }
}

function attachmentType(file: Blob): string {
  return file.type.split(";")[0].trim().toLowerCase();
}

/** Why `file` cannot be uploaded, or `null` when it can be. */
export function validateAttachment(file: Blob, filename?: string): AttachmentError | null {
  const label = filename ?? (file instanceof File && file.name.length > 0 ? file.name : "image");
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(attachmentType(file))) {
    return new AttachmentError(
      "unsupported_type",
      `“${label}” is not a supported image. Use PNG, JPEG, WebP or GIF.`,
    );
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return new AttachmentError("too_large", `“${label}” is larger than 10 MB and cannot be added.`);
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new AttachmentError("offline", "You are offline. Add images when you are back online.");
  }
  return null;
}

/** The BFF's attachments folder when no other is configured. */
export const DEFAULT_ATTACHMENTS_FOLDER = "_attachments";

/** `folder` when it names a non-default attachments folder, else `null` (the BFF default). */
function customAttachmentsFolder(folder: string | undefined): string | null {
  const trimmed = folder?.trim() ?? "";
  return trimmed.length > 0 && trimmed !== DEFAULT_ATTACHMENTS_FOLDER ? trimmed : null;
}

/** Uploads an image to the vault's attachments folder (`_attachments` unless `folder` says). */
export async function uploadAttachment(
  file: Blob | File,
  filename?: string,
  folder?: string,
): Promise<UploadedAttachment> {
  const invalid = validateAttachment(file, filename);
  if (invalid !== null) {
    throw invalid;
  }
  const name = filename ?? (file instanceof File ? file.name : "");
  const headers: Record<string, string> = { "Content-Type": attachmentType(file) };
  if (name.length > 0) {
    headers["X-Filename"] = encodeURIComponent(name);
  }
  const custom = customAttachmentsFolder(folder);
  if (custom !== null) {
    headers["X-Attachments-Folder"] = encodeURIComponent(custom);
  }
  const response = await request("/api/attachments", { method: "POST", headers, body: file });
  return (await response.json()) as UploadedAttachment;
}

/** An image in the vault's `_attachments` folder. */
export interface AttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime: string;
  /** Same-origin blob URL: `/api/files/<id>/blob`. */
  url: string;
}

export interface AttachmentsResponse {
  /** `null` until the first upload creates `_attachments`. */
  folderId: string | null;
  attachments: AttachmentItem[];
}

/** Lists the vault's uploaded attachments (in `_attachments` unless `folder` says). */
export async function fetchAttachments(
  signal?: AbortSignal,
  folder?: string,
): Promise<AttachmentsResponse> {
  const custom = customAttachmentsFolder(folder);
  const query = custom === null ? "" : `?folder=${encodeURIComponent(custom)}`;
  const response = await request(`/api/attachments${query}`, { signal });
  return (await response.json()) as AttachmentsResponse;
}

/** Metadata of an external page, proxied by the BFF; image URLs are same-origin. */
export interface LinkPreviewData {
  url: string;
  finalUrl: string;
  hostname: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  favicon?: string;
}

export async function fetchLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewData> {
  const response = await request(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal });
  return (await response.json()) as LinkPreviewData;
}

export async function saveContent(
  id: string,
  text: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await request(`/api/files/${encodeURIComponent(id)}/content`, {
    method: "PUT",
    headers: {
      "If-Match": revision,
      "Content-Type": "text/markdown; charset=utf-8",
    },
    body: new TextEncoder().encode(text),
    signal,
  });
  markSelfWrite(id);
  return readRevision(response);
}

/** Creates a Markdown file in a folder; answers the new node and its revision tag. */
export async function createFile(
  folderId: string,
  name: string,
  content = "",
): Promise<{ node: DriveNode; revision: string }> {
  const response = await request(`/api/folders/${encodeURIComponent(folderId)}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  });
  const node = (await response.json()) as DriveNode;
  markSelfWrite(node.id);
  return { node, revision: readRevision(response) };
}

/** Renames a Markdown file on Drive; answers the updated node and its refreshed revision tag. */
export async function renameFile(
  id: string,
  name: string,
): Promise<{ node: DriveNode; revision: string }> {
  const response = await request(`/api/files/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const node = (await response.json()) as DriveNode;
  markSelfWrite(id);
  return { node, revision: readRevision(response) };
}

/** Moves a Markdown file into another folder; answers the node and its refreshed revision tag. */
export async function moveFile(
  id: string,
  parentId: string,
): Promise<{ node: DriveNode; revision: string }> {
  const response = await request(`/api/files/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  const node = (await response.json()) as DriveNode;
  markSelfWrite(id);
  return { node, revision: readRevision(response) };
}

/** Moves a folder (with everything in it) into another folder; answers the folder node. */
export async function moveFolder(id: string, parentId: string): Promise<DriveNode> {
  const response = await request(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  markSelfWrite(id);
  return (await response.json()) as DriveNode;
}

/** Moves a file to Google Drive Trash. */
export async function deleteFile(id: string): Promise<void> {
  await request(`/api/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  markSelfWrite(id);
}

export async function fetchStartPageToken(signal?: AbortSignal): Promise<string> {
  const response = await request("/api/changes/start-token", { signal });
  return ((await response.json()) as { startPageToken: string }).startPageToken;
}

export async function fetchChanges(pageToken: string, signal?: AbortSignal): Promise<ChangesPage> {
  const response = await request(`/api/changes?pageToken=${encodeURIComponent(pageToken)}`, {
    signal,
  });
  return (await response.json()) as ChangesPage;
}

export async function fetchVaultIndex(signal?: AbortSignal): Promise<VaultIndex> {
  const response = await request("/api/vault/index", { signal });
  return (await response.json()) as VaultIndex;
}

/** Drive no longer accepts the stored changes page token. */
export function isTokenExpired(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 410 || error.code === "token_expired");
}

export function isInvalidMove(error: unknown): boolean {
  return error instanceof ApiError && error.code === "invalid_move";
}

/** Creates a subfolder inside a folder; answers the new folder node. */
export async function createFolder(parentId: string, name: string): Promise<DriveNode> {
  const response = await request(`/api/folders/${encodeURIComponent(parentId)}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const folder = (await response.json()) as DriveNode;
  markSelfWrite(folder.id);
  return folder;
}

/** Renames a folder on Drive; answers the updated folder node. */
export async function renameFolder(id: string, name: string): Promise<DriveNode> {
  const response = await request(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  markSelfWrite(id);
  return (await response.json()) as DriveNode;
}

/** Moves a folder (and all its contents) to Google Drive Trash. */
export async function deleteFolder(id: string): Promise<void> {
  await request(`/api/folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  markSelfWrite(id);
}

export function isNameExists(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === "name_exists");
}

export async function signOut(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** A session cookie came in and could not be used: revoked, expired or unreadable. */
export function isSessionEnded(error: unknown): boolean {
  return isUnauthenticated(error) && (error as ApiError).reason === "session_ended";
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 429 || error.code === "rate_limited");
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === "not_found");
}

export function isTooLarge(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 413 || error.code === "too_large");
}

/** The BFF refused an upload without a usable `If-Match` revision tag. */
export function isPreconditionRequired(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 428 || error.code === "precondition_required")
  );
}

/** A failure worth retrying on its own: network, timeout, rate limit, or a 5xx from the BFF/Drive. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  return (
    error instanceof ApiError &&
    (error.status === 408 || isRateLimited(error) || (error.status >= 500 && error.status <= 599))
  );
}

/** A short, specific technical reason for a failed request, for display next to friendly copy. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.code !== "unknown" ? ` ${error.code}` : "";
    const message =
      error.message.length > 0 && !error.message.startsWith("Request failed")
        ? ` — ${error.message}`
        : "";
    return `HTTP ${error.status}${code}${message}`;
  }
  if (error instanceof TypeError) {
    return "Network error — the request did not reach the server.";
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Unknown error";
}

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 412 || error.code === "conflict");
}
