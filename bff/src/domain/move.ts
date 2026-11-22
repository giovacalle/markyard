// The `PATCH /api/files/{id}` and `PATCH /api/folders/{id}` body when it moves the item:
// `{"parentId": "<id>", "name"?: "<string>"}`. A body without a string `parentId` is a plain
// rename and is decoded by the rename rules (`decodeRenameBody`, `decodeFolderNameBody`), so
// rename-only callers keep their exact behavior.

export type PatchBody =
  | { readonly kind: "rename" }
  | { readonly kind: "move"; readonly parentId: string; readonly name: string | undefined }
  | { readonly kind: "invalid" };

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const isCleanString = (u: unknown): u is string => typeof u === "string" && !LONE_SURROGATE.test(u);

export const decodePatchBody = (bytes: Uint8Array): PatchBody => {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { kind: "rename" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { kind: "rename" };
  const { parentId, name } = json as Record<string, unknown>;
  if (parentId === undefined || parentId === null) return { kind: "rename" };
  if (!isCleanString(parentId)) return { kind: "invalid" };
  if (name === undefined || name === null) return { kind: "move", parentId, name: undefined };
  return isCleanString(name) ? { kind: "move", parentId, name } : { kind: "invalid" };
};
