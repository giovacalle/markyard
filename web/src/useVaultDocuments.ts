import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { readVaultDocuments, type VaultDocument } from "./vaultDocuments";

const REFRESH_DEBOUNCE_MS = 300;

/**
 * Every listed note with a local copy, re-read (debounced) whenever a note's text or a folder
 * listing changes in the query cache. `null` until the first read lands.
 */
export function useVaultDocuments(enabled = true): VaultDocument[] | null {
  const queryClient = useQueryClient();
  const [docs, setDocs] = useState<VaultDocument[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void readVaultDocuments(queryClient).then((next) => {
        if (active) {
          setDocs(next);
        }
      });
    };
    load();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const head = event.query.queryKey[0];
      if (event.type !== "updated" || (head !== "files" && head !== "folders")) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(load, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient, enabled]);
  return docs;
}
