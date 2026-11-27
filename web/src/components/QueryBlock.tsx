import { QueryClientContext } from "@tanstack/react-query";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type PkmApi, usePkm } from "../pkm";
import {
  executeQuery,
  type FieldValue,
  type NoteQueryRow,
  parseQuery,
  type QueryResult,
  type TaskQueryRow,
} from "../queryEngine";
import { formatModifiedDate, formatQueryCountLabel, formatQueryFooter } from "../queryFormat";
import { type SyncQueue, SyncQueueContext } from "../syncQueue";
import { toggleTaskIfUnchanged } from "../taskToggle";
import { useVaultDocuments } from "../useVaultDocuments";
import { freshNoteText, saveVaultDocument, type VaultDocument } from "../vaultDocuments";
import { CheckIcon } from "./icons";

interface TextOverride {
  baseText: string;
  text: string;
}

function NoteLink({
  id,
  title,
  pkm,
  className = "wikilink",
}: {
  id: string;
  title: string;
  pkm: PkmApi | null;
  className?: string;
}) {
  if (pkm === null) {
    return <span className={className}>{title}</span>;
  }
  return (
    <a
      href={`/?file=${encodeURIComponent(id)}`}
      className={className}
      data-note-id={id}
      onClick={(event) => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        pkm.openNote(id);
      }}
    >
      {title}
    </a>
  );
}

function renderCellValue(
  row: NoteQueryRow | TaskQueryRow,
  column: string,
  pkm: PkmApi | null,
): ReactNode {
  const lower = column.toLowerCase();
  if (lower === "title") {
    return <NoteLink id={row.id} title={row.title} pkm={pkm} />;
  }
  const value: FieldValue = row.getField(column);
  if (value === undefined || value === "") {
    return <span className="query-block-muted">—</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="query-block-muted">—</span>;
    }
    if (lower === "tags") {
      return (
        <span className="query-block-tags">
          {value.map((tag) => (
            <span key={tag} className="query-block-tag">
              #{tag}
            </span>
          ))}
        </span>
      );
    }
    return value.join(", ");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string" && lower === "modified") {
    return formatModifiedDate(value);
  }
  return String(value);
}

function QueryBlockContent({
  source,
  docs,
  pkm,
  syncQueue,
  currentNoteText,
  getCurrentNoteText,
  live = false,
  onToggleTask,
  onContentChange,
}: {
  source: string;
  docs: readonly VaultDocument[] | null;
  pkm: PkmApi | null;
  syncQueue: SyncQueue | null;
  currentNoteText?: string;
  getCurrentNoteText?: () => string | undefined;
  live?: boolean;
  onToggleTask?: (nextText: string) => void;
  onContentChange?: () => void;
}) {
  const queryClient = useContext(QueryClientContext);
  const parsed = useMemo(() => parseQuery(source), [source]);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, TextOverride>>(new Map());

  const effectiveDocs = useMemo((): VaultDocument[] | null => {
    if (docs === null) {
      return null;
    }
    const currentFileId = pkm?.currentFileId ?? null;
    return docs.map((doc) => {
      const baseText =
        currentFileId !== null && doc.id === currentFileId && currentNoteText !== undefined
          ? currentNoteText
          : doc.text;
      const override = overrides.get(doc.id);
      const text =
        override !== undefined && override.baseText === baseText ? override.text : baseText;
      return text === doc.text ? doc : { ...doc, text };
    });
  }, [docs, overrides, pkm?.currentFileId, currentNoteText]);

  const docsById = useMemo(() => new Map((docs ?? []).map((doc) => [doc.id, doc])), [docs]);

  // Evict display overrides once their source text moves on, so cycling back to an earlier
  // note text (e.g. toggle off -> toggle on from a sibling query block) cannot resurrect them.
  useEffect(() => {
    if (docs === null) {
      return;
    }
    const currentFileId = pkm?.currentFileId ?? null;
    setOverrides((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Map(prev);
      for (const [id, override] of prev) {
        const doc = docsById.get(id);
        const baseText =
          doc === undefined
            ? undefined
            : currentFileId !== null && id === currentFileId && currentNoteText !== undefined
              ? currentNoteText
              : doc.text;
        if (baseText !== override.baseText) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [docs, docsById, pkm?.currentFileId, currentNoteText]);

  const result = useMemo((): QueryResult | null => {
    if (!parsed.ok || effectiveDocs === null) {
      return null;
    }
    return executeQuery(parsed.query, effectiveDocs);
  }, [parsed, effectiveDocs]);

  useEffect(() => {
    onContentChange?.();
  }, [onContentChange, parsed, result, effectiveDocs]);

  const regionLabel = live ? "Query live preview" : "Query results";

  if (!parsed.ok) {
    return (
      <div role={live ? "status" : "alert"} className="query-block-error">
        <p className="query-block-error-message">{parsed.error}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (result === null || effectiveDocs === null) {
    return (
      <section className="query-block" data-slot="query-block" aria-label={regionLabel}>
        <p role="status" className="query-block-empty">
          Running query…
        </p>
      </section>
    );
  }

  const canToggleTasks = onToggleTask !== undefined && syncQueue !== null;

  const toggleTask = (row: TaskQueryRow) => {
    if (!canToggleTasks) {
      return;
    }
    const original = docsById.get(row.id);
    if (original === undefined) {
      return;
    }
    const isCurrent = row.id === pkm?.currentFileId;
    const baseText = isCurrent && currentNoteText !== undefined ? currentNoteText : original.text;
    const liveCurrent = isCurrent ? (getCurrentNoteText?.() ?? currentNoteText) : undefined;
    const fresh =
      isCurrent && liveCurrent !== undefined ? liveCurrent : freshNoteText(queryClient, original);
    const next = toggleTaskIfUnchanged(fresh, row);
    if (next === null) {
      setOverrides((prev) => new Map(prev).set(row.id, { baseText, text: fresh }));
      return;
    }
    setOverrides((prev) => new Map(prev).set(row.id, { baseText, text: next }));
    if (isCurrent) {
      onToggleTask(next);
    } else {
      saveVaultDocument(syncQueue, original, next);
    }
  };

  const totalKnownNotes = pkm?.notes.length ?? effectiveDocs.length;
  const footer = formatQueryFooter(result, effectiveDocs.length, totalKnownNotes);

  return (
    <section className="query-block" data-slot="query-block" aria-label={regionLabel}>
      {result.view.kind === "count" ? (
        <div className="query-block-count">
          <span className="query-block-count-value">{result.totalMatched}</span>
          <span className="query-block-count-label">
            {formatQueryCountLabel(result.type, result.totalMatched)}
          </span>
        </div>
      ) : result.rows.length === 0 ? (
        <p className="query-block-empty">No matching {result.type}.</p>
      ) : result.view.kind === "table" ? (
        <div className="query-block-table-wrap">
          <table className="query-block-table">
            <thead>
              <tr>
                {result.view.columns.map((col, index) => (
                  <th key={`${col}:${index}`} scope="col">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.kind === "task" ? `${row.id}:${row.offset}` : row.id}>
                  {result.view.kind === "table" &&
                    result.view.columns.map((col, index) => (
                      <td key={`${col}:${index}`}>{renderCellValue(row, col, pkm)}</td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : result.view.kind === "tasks" && result.type === "tasks" ? (
        <ul className="query-block-tasks">
          {result.rows.map((row) => (
            <li key={`${row.id}:${row.offset}`} className="query-block-task-item">
              <Checkbox
                aria-label={row.text || "Task item"}
                checked={row.done}
                disabled={!canToggleTasks}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={() => toggleTask(row)}
                className="query-block-checkbox"
              >
                <CheckboxIndicator className="query-block-checkbox-indicator">
                  <CheckIcon className="size-3" strokeWidth={2.5} />
                </CheckboxIndicator>
              </Checkbox>
              <span
                className={
                  row.done ? "query-block-task-text query-block-task-done" : "query-block-task-text"
                }
              >
                {row.text}
              </span>
              {row.due !== undefined && <span className="query-block-due">@{row.due}</span>}
              <NoteLink
                id={row.id}
                title={row.title}
                pkm={pkm}
                className="wikilink query-block-source-link"
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="query-block-list">
          {result.type === "notes"
            ? result.rows.map((row) => (
                <li key={row.id} className="query-block-list-item">
                  <NoteLink id={row.id} title={row.title} pkm={pkm} />
                  {row.folder.length > 0 && (
                    <span className="query-block-folder">{row.folder}</span>
                  )}
                </li>
              ))
            : result.rows.map((row) => (
                <li key={`${row.id}:${row.offset}`} className="query-block-list-item">
                  <span
                    className={
                      row.done
                        ? "query-block-task-text query-block-task-done"
                        : "query-block-task-text"
                    }
                  >
                    {row.text}
                  </span>
                  <NoteLink
                    id={row.id}
                    title={row.title}
                    pkm={pkm}
                    className="wikilink query-block-source-link"
                  />
                </li>
              ))}
        </ul>
      )}
      <p className="query-block-meta">{footer}</p>
    </section>
  );
}

const SharedVaultDocsContext = createContext<readonly VaultDocument[] | null | undefined>(
  undefined,
);

function VaultDocsSubscription({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const docs = useVaultDocuments(enabled);
  return <SharedVaultDocsContext.Provider value={docs}>{children}</SharedVaultDocsContext.Provider>;
}

/**
 * Shares a single `useVaultDocuments()` scan across every `QueryBlock` rendered inside a note
 * so multi-query dashboards do not multiply IndexedDB scans.
 */
export function QueryVaultDocumentsProvider({
  enabled = true,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) {
    return <SharedVaultDocsContext.Provider value={[]}>{children}</SharedVaultDocsContext.Provider>;
  }
  return <VaultDocsSubscription enabled={enabled}>{children}</VaultDocsSubscription>;
}

function VaultQueryBlock({
  source,
  pkm,
  syncQueue,
  currentNoteText,
  getCurrentNoteText,
  live,
  onToggleTask,
  onContentChange,
}: {
  source: string;
  pkm: PkmApi | null;
  syncQueue: SyncQueue | null;
  currentNoteText?: string;
  getCurrentNoteText?: () => string | undefined;
  live?: boolean;
  onToggleTask?: (nextText: string) => void;
  onContentChange?: () => void;
}) {
  const docs = useVaultDocuments();
  return (
    <QueryBlockContent
      source={source}
      docs={docs}
      pkm={pkm}
      syncQueue={syncQueue}
      currentNoteText={currentNoteText}
      getCurrentNoteText={getCurrentNoteText}
      live={live}
      onToggleTask={onToggleTask}
      onContentChange={onContentChange}
    />
  );
}

/** Renders a declarative ` ```query ` fenced code block live against locally cached notes. */
export function QueryBlock({
  source,
  currentNoteText,
  getCurrentNoteText,
  live,
  onToggleTask,
  onContentChange,
}: {
  source: string;
  currentNoteText?: string;
  getCurrentNoteText?: () => string | undefined;
  live?: boolean;
  onToggleTask?: (nextText: string) => void;
  onContentChange?: () => void;
}) {
  const queryClient = useContext(QueryClientContext);
  const sharedDocs = useContext(SharedVaultDocsContext);
  const pkm = usePkm();
  const syncQueue = useContext(SyncQueueContext);

  if (sharedDocs !== undefined) {
    return (
      <QueryBlockContent
        source={source}
        docs={sharedDocs}
        pkm={pkm}
        syncQueue={syncQueue}
        currentNoteText={currentNoteText}
        getCurrentNoteText={getCurrentNoteText}
        live={live}
        onToggleTask={onToggleTask}
        onContentChange={onContentChange}
      />
    );
  }
  if (!queryClient) {
    return (
      <QueryBlockContent
        source={source}
        docs={[]}
        pkm={pkm}
        syncQueue={syncQueue}
        currentNoteText={currentNoteText}
        getCurrentNoteText={getCurrentNoteText}
        live={live}
        onToggleTask={onToggleTask}
        onContentChange={onContentChange}
      />
    );
  }
  return (
    <VaultQueryBlock
      source={source}
      pkm={pkm}
      syncQueue={syncQueue}
      currentNoteText={currentNoteText}
      getCurrentNoteText={getCurrentNoteText}
      live={live}
      onToggleTask={onToggleTask}
      onContentChange={onContentChange}
    />
  );
}
