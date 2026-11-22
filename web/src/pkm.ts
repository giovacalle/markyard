import { createContext, useContext } from "react";
import type { TemplateNote } from "./templates";
import type { VaultNoteRef } from "./vaultDocuments";

/** Vault-wide note actions shared by Preview, the editor and the info drawer. */
export interface PkmApi {
  notes: readonly VaultNoteRef[];
  currentFileId: string | null;
  vaultPinned: boolean;
  /** Opens a note (revealing it in the tree), then scrolls to `heading` when given. */
  openNote: (id: string, options?: { heading?: string }) => void;
  /** Creates `<stem>.md` in the open note's folder (the root when unknown) and opens it. */
  createNote: (stem: string) => void;
  /** The vault's `Templates/` notes with their text, for `/` completions. */
  loadTemplates: () => Promise<readonly TemplateNote[]>;
}

export const PkmContext = createContext<PkmApi | null>(null);

export function usePkm(): PkmApi | null {
  return useContext(PkmContext);
}
