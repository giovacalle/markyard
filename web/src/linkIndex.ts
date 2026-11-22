import { extractHeadings, type HeadingItem } from "./commandSearch";
import type { QueryClient } from "@tanstack/react-query";
import type { SyncQueue } from "./syncQueue";
import {
  readVaultDocuments,
  saveVaultDocument,
  type VaultDocument,
  vaultNotes,
} from "./vaultDocuments";
import {
  backlinkContexts,
  type BacklinkContext,
  noteStem,
  resolveWikilink,
  rewriteWikilinks,
  type VaultNote,
  type Wikilink,
} from "./wikilinks";

export interface Backlink {
  note: VaultDocument;
  contexts: BacklinkContext[];
}

function pointsAt(
  targetId: string,
  doc: VaultNote,
  notes: readonly VaultNote[],
): (link: Wikilink) => boolean {
  return (link) =>
    link.target.length > 0 && resolveWikilink(link.target, notes, doc.path)?.id === targetId;
}

/** Notes (other than the target itself) whose wikilinks resolve to `targetId`, with context lines. */
export function findBacklinks(
  targetId: string,
  docs: readonly VaultDocument[],
  notes: readonly VaultNote[],
): Backlink[] {
  const out: Backlink[] = [];
  for (const doc of docs) {
    if (doc.id === targetId || !doc.text.includes("[[")) {
      continue;
    }
    const contexts = backlinkContexts(doc.text, pointsAt(targetId, doc, notes));
    if (contexts.length > 0) {
      out.push({ note: doc, contexts });
    }
  }
  return out.sort((a, b) => noteStem(a.note.name).localeCompare(noteStem(b.note.name)));
}

/**
 * The edits that keep links pointing at a renamed note: `notesBefore` still holds its old name,
 * so links resolve as they did before. The renamed note itself is skipped (it is open).
 */
export function planLinkRewrites(
  renamedId: string,
  newName: string,
  docs: readonly VaultDocument[],
  notesBefore: readonly VaultNote[],
): { doc: VaultDocument; text: string }[] {
  const newStem = noteStem(newName);
  const out: { doc: VaultDocument; text: string }[] = [];
  for (const doc of docs) {
    if (doc.id === renamedId || !doc.text.includes("[[")) {
      continue;
    }
    const result = rewriteWikilinks(doc.text, pointsAt(renamedId, doc, notesBefore), newStem);
    if (result.count > 0) {
      out.push({ doc, text: result.text });
    }
  }
  return out;
}

/** The heading a `[[Note#Heading]]` link names (case-insensitive, first match), if present. */
export function findHeading(markdown: string, heading: string): HeadingItem | undefined {
  const wanted = heading.trim().toLowerCase();
  return extractHeadings(markdown).find((item) => item.text.trim().toLowerCase() === wanted);
}

/**
 * After `renamedId` was renamed from `oldName` (the tree cache already holds the new name),
 * rewrites every cached note's links to it and saves them through the sync queue. Answers how
 * many notes changed.
 */
export async function updateLinksAfterRename(
  queryClient: QueryClient,
  syncQueue: SyncQueue,
  renamedId: string,
  oldName: string,
  newName: string,
): Promise<number> {
  if (oldName === newName) {
    return 0;
  }
  const notesBefore = vaultNotes(queryClient).map((note) =>
    note.id === renamedId ? { ...note, name: oldName } : note,
  );
  const docs = await readVaultDocuments(queryClient);
  const edits = planLinkRewrites(renamedId, newName, docs, notesBefore);
  for (const { doc, text } of edits) {
    saveVaultDocument(syncQueue, doc, text);
  }
  return edits.length;
}
