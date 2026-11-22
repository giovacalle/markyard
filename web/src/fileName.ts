const MAX_NAME_BYTES = 255;
const UTF8_ENCODER = new TextEncoder();

export type NormalizedFileName = { ok: true; name: string } | { ok: false; error: string };

/** Trims, validates, and appends `.md` when missing. */
export function normalizeFileName(raw: string): NormalizedFileName {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter a file name." };
  }
  if (trimmed.includes("/")) {
    return { ok: false, error: 'A file name cannot contain "/".' };
  }
  const hasExt = trimmed.toLowerCase().endsWith(".md");
  const stem = hasExt ? trimmed.slice(0, -3).trim() : trimmed;
  if (stem.length === 0) {
    return { ok: false, error: "Enter a file name." };
  }
  const name = hasExt ? trimmed : `${trimmed}.md`;
  if (UTF8_ENCODER.encode(name).byteLength > MAX_NAME_BYTES) {
    return { ok: false, error: "A file name can be at most 255 bytes long." };
  }
  return { ok: true, name };
}

/** Trims and validates a folder name. */
export function normalizeFolderName(raw: string): NormalizedFileName {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter a folder name." };
  }
  if (trimmed === "." || trimmed === "..") {
    return { ok: false, error: "Choose a different folder name." };
  }
  if (trimmed.includes("/")) {
    return { ok: false, error: 'A folder name cannot contain "/".' };
  }
  if (UTF8_ENCODER.encode(trimmed).byteLength > MAX_NAME_BYTES) {
    return { ok: false, error: "A folder name can be at most 255 bytes long." };
  }
  return { ok: true, name: trimmed };
}

/** Strips a trailing `.md` extension (case-insensitive) for inline editing. */
export function stripMarkdownExtension(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** Picks an available default name (`Untitled.md`, `Untitled 2.md`, …) for instant note creation. */
export function pickUntitledName(existingNames: Iterable<string>, startIndex = 1): string {
  const taken = new Set<string>();
  for (const name of existingNames) {
    taken.add(name.toLowerCase());
  }
  for (let n = Math.max(1, startIndex); n < 10_000; n += 1) {
    const candidate = n === 1 ? "Untitled.md" : `Untitled ${n}.md`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `Untitled ${Date.now()}.md`;
}
