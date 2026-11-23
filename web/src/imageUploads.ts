import { StateEffect, StateField, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  ApiError,
  AttachmentError,
  describeError,
  isRateLimited,
  isTooLarge,
  isUnauthenticated,
  type UploadedAttachment,
  validateAttachment,
} from "./api";

interface Placeholder {
  from: number;
  to: number;
  text: string;
}

const trackPlaceholder = StateEffect.define<{ id: number } & Placeholder>();
const forgetPlaceholder = StateEffect.define<number>();

/**
 * Upload placeholders by id, mapped through every change so their spans stay exact while the
 * user keeps typing. A placeholder whose span was deleted or edited is dropped.
 */
export const imagePlaceholders = StateField.define<ReadonlyMap<number, Placeholder>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<number, Placeholder> | null = null;
    if (tr.docChanged && value.size > 0) {
      next = new Map();
      for (const [id, span] of value) {
        const from = tr.changes.mapPos(span.from, 1);
        const to = tr.changes.mapPos(span.to, -1);
        if (to - from === span.text.length && tr.state.sliceDoc(from, to) === span.text) {
          next.set(id, { ...span, from, to });
        }
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(trackPlaceholder)) {
        next ??= new Map(value);
        const { id, ...span } = effect.value;
        next.set(id, span);
      } else if (effect.is(forgetPlaceholder)) {
        next ??= new Map(value);
        next.delete(effect.value);
      }
    }
    return next ?? value;
  },
});

const UPLOAD_PLACEHOLDER_PATTERN = /!\[Uploading [^\]]*…\]\(\)/;

/** Whether `text` currently contains an image upload placeholder (`![Uploading …]()`). */
export function hasUploadPlaceholder(text: string): boolean {
  return UPLOAD_PLACEHOLDER_PATTERN.test(text);
}

/** Escapes text for a Markdown image alt (`![…]`). */
function escapeAlt(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function stem(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return base.length > 0 ? base : "image";
}

export function fileLabel(file: File): string {
  return file.name.length > 0 ? file.name : "image";
}

/** Image files carried by a paste or drop, or none. */
export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) {
    return [];
  }
  const files = Array.from(data.files ?? []);
  if (files.length > 0) {
    return files.filter((file) => file.type.startsWith("image/"));
  }
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Whether a drag carries files (their types are hidden until drop). */
export function dragHasFiles(data: DataTransfer | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}

export function uploadErrorMessage(file: File, error: unknown): string {
  if (error instanceof AttachmentError) {
    return error.message;
  }
  const label = fileLabel(file);
  if (isTooLarge(error)) {
    return `“${label}” is larger than 10 MB and cannot be added.`;
  }
  if (isUnauthenticated(error)) {
    return `Unable to add “${label}”: your session has ended. Sign in again.`;
  }
  if (isRateLimited(error)) {
    return `Unable to add “${label}”: Google Drive is busy. Try again shortly.`;
  }
  if (error instanceof ApiError || error instanceof TypeError) {
    return `Unable to add “${label}”. Reason: ${describeError(error)}`;
  }
  return `Unable to add “${label}”. Try again.`;
}

let nextId = 1;

export interface UploadCallbacks {
  upload: (file: File) => Promise<UploadedAttachment>;
  onStart: () => void;
  onSettled: () => void;
  onError: (message: string) => void;
}

/**
 * Inserts one placeholder per image at `pos`, uploads each, and swaps the placeholder for the
 * Markdown image link (or removes it on failure). Invalid files are refused before any edit.
 */
export function insertImages(
  view: EditorView,
  files: readonly File[],
  pos: number,
  callbacks: UploadCallbacks,
): void {
  let at = pos;
  for (const file of files) {
    const invalid = validateAttachment(file);
    if (invalid !== null) {
      callbacks.onError(invalid.message);
      continue;
    }
    const id = nextId++;
    const text = `![Uploading ${escapeAlt(fileLabel(file))}…]()`;
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      effects: trackPlaceholder.of({ id, from: at, to: at + text.length, text }),
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    at += text.length;
    callbacks.onStart();
    callbacks.upload(file).then(
      (uploaded) => {
        const url = `/api/files/${encodeURIComponent(uploaded.id)}/blob`;
        replacePlaceholder(view, id, `![${escapeAlt(stem(uploaded.name))}](${url})`, true);
        callbacks.onSettled();
      },
      (error: unknown) => {
        replacePlaceholder(view, id, "", false);
        callbacks.onError(uploadErrorMessage(file, error));
        callbacks.onSettled();
      },
    );
  }
}

function replacePlaceholder(view: EditorView, id: number, insert: string, keepHistory: boolean) {
  const span = view.state.field(imagePlaceholders, false)?.get(id);
  if (span === undefined) {
    return;
  }
  view.dispatch({
    changes: { from: span.from, to: span.to, insert },
    effects: forgetPlaceholder.of(id),
    // A failed upload's placeholder must never come back through undo.
    annotations: keepHistory ? [] : [Transaction.addToHistory.of(false)],
  });
}
