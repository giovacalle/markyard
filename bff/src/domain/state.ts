// The per-account UI state the web app syncs across devices (`GET`/`PUT /api/state`). Pure
// rules: what a valid state is, how a stored row and a `PUT` body decode. No I/O here.

import { isValidId } from "./drive.ts";
import { folderNameProblem, rustTrim } from "./folders.ts";
import { isU64, parseJson } from "./session.ts";

/** The largest `PUT /api/state` body accepted, in bytes. */
export const MAX_STATE_BYTES = 16_384;
/** The most expanded folders one state may list. */
export const MAX_EXPANDED_FOLDERS = 500;

export type ThemePreference = "light" | "dark" | "system";
export type LayoutPreference = "default" | "borderless";
export type EditorMode = "preview" | "edit";

export interface UserState {
  readonly theme?: ThemePreference;
  readonly lastOpenFileId?: string | null;
  readonly expandedFolders?: ReadonlyArray<string>;
  readonly readOnly?: boolean;
  readonly focusMode?: boolean;
  readonly typewriterMode?: boolean;
  readonly infoDrawerOpen?: boolean;
  /** The account's chosen vault folder; `null` when none was chosen. */
  readonly rootFolderId?: string | null;
  /** The image attachments folder directly under the vault root. */
  readonly attachmentsFolder?: string;
  /** Whether the root attachments folder is shown in the tree and folder pickers. */
  readonly showAttachmentsFolder?: boolean;
  /** Where daily notes go: `""` is the vault root, otherwise a folder directly under it. */
  readonly dailyNotesFolder?: string;
  readonly templatesFolder?: string;
  /** The folder directly under the vault root whose notes provide custom CSS. */
  readonly stylesFolder?: string;
  /** Whether custom CSS from `stylesFolder` is applied. */
  readonly customCss?: boolean;
  /** Chrome framing preset: edge-to-edge (`default`) or inset card (`borderless`). */
  readonly layout?: LayoutPreference;
  readonly defaultMode?: EditorMode;
  readonly linkPreviewsEnabled?: boolean;
}

export interface StoredUserState {
  readonly state: UserState;
  /** The client clock (ms) of the write; a write never replaces a newer one. */
  readonly updatedAt: number;
}

type Json = Record<string, unknown>;

const isObject = (u: unknown): u is Json =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const THEMES: ReadonlyArray<unknown> = ["light", "dark", "system"];
const LAYOUTS: ReadonlyArray<unknown> = ["default", "borderless"];
const MODES: ReadonlyArray<unknown> = ["preview", "edit"];
const FLAGS = [
  "readOnly",
  "focusMode",
  "typewriterMode",
  "infoDrawerOpen",
  "showAttachmentsFolder",
  "linkPreviewsEnabled",
  "customCss",
] as const;
/** Folder-name settings; only `dailyNotesFolder` may be `""` (the vault root). */
const FOLDER_SETTINGS = [
  ["attachmentsFolder", false],
  ["dailyNotesFolder", true],
  ["templatesFolder", false],
  ["stylesFolder", false],
] as const;

const isDriveId = (u: unknown): u is string => typeof u === "string" && isValidId(u);

/** A folder-name setting trimmed, or `undefined` when it is not a valid folder name. */
const folderSetting = (u: unknown, allowEmpty: boolean): string | undefined => {
  if (typeof u !== "string") return undefined;
  const name = rustTrim(u);
  if (name === "" && allowEmpty) return name;
  return folderNameProblem(name) === undefined ? name : undefined;
};

/**
 * A valid state, or `undefined` when any known key has a wrong value. Unknown keys are dropped,
 * so a row written by a newer app version still decodes.
 */
export const decodeUserState = (value: unknown): UserState | undefined => {
  if (!isObject(value)) return undefined;
  const out: { -readonly [K in keyof UserState]: UserState[K] } = {};

  const theme = value["theme"];
  if (theme !== undefined) {
    if (!THEMES.includes(theme)) return undefined;
    out.theme = theme as ThemePreference;
  }

  const last = value["lastOpenFileId"];
  if (last !== undefined) {
    if (last !== null && !isDriveId(last)) return undefined;
    out.lastOpenFileId = last;
  }

  const folders = value["expandedFolders"];
  if (folders !== undefined) {
    if (!Array.isArray(folders) || !folders.every(isDriveId)) return undefined;
    const unique = [...new Set(folders)];
    if (unique.length > MAX_EXPANDED_FOLDERS) return undefined;
    out.expandedFolders = unique;
  }

  const root = value["rootFolderId"];
  if (root !== undefined) {
    if (root !== null && !isDriveId(root)) return undefined;
    out.rootFolderId = root;
  }

  for (const [key, allowEmpty] of FOLDER_SETTINGS) {
    const v = value[key];
    if (v === undefined) continue;
    const name = folderSetting(v, allowEmpty);
    if (name === undefined) return undefined;
    out[key] = name;
  }

  const layout = value["layout"];
  if (layout !== undefined) {
    if (!LAYOUTS.includes(layout)) return undefined;
    out.layout = layout as LayoutPreference;
  }

  const mode = value["defaultMode"];
  if (mode !== undefined) {
    if (!MODES.includes(mode)) return undefined;
    out.defaultMode = mode as EditorMode;
  }

  for (const flag of FLAGS) {
    const v = value[flag];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return undefined;
    out[flag] = v;
  }
  return out;
};

/** A `PUT /api/state` body: `{state, updatedAt}`, at most `MAX_STATE_BYTES`, or `undefined`. */
export const decodePutStateBody = (bytes: Uint8Array): StoredUserState | undefined => {
  if (bytes.byteLength > MAX_STATE_BYTES) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const json = parseJson(text);
  if (!isObject(json) || !isU64(json["updatedAt"])) return undefined;
  const state = decodeUserState(json["state"]);
  return state === undefined ? undefined : { state, updatedAt: json["updatedAt"] };
};
