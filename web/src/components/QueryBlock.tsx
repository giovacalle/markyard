import { QueryClientContext } from "@tanstack/react-query";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { type ReactNode, useContext, useMemo, useState } from "react";
import { type PkmApi, usePkm } from "../pkm";
import {
  executeQuery,
  type FieldValue,
  type NoteQueryRow,
  parseQuery,
  type QueryResult,
  type TaskQueryRow,
} from "../queryEngine";
import { type SyncQueue, SyncQueueContext } from "../syncQueue";
import { toggleTaskAt } from "../taskToggle";
import { useVaultDocuments } from "../useVaultDocuments";
import { saveVaultDocument, type VaultDocument } from "../vaultDocuments";
import { CheckIcon } from "./icons";

const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T/;

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
    const match = ISO_TIMESTAMP_RE.exec(value);
    if (match !== null) {
      return match[1];
    }
  }
  return String(value);
}

function formatFooter(result: QueryResult, cachedCount: number, totalKnownNotes: number): string {
  const shown = result.rows.length;
  const resultLabel =
    result.totalMatched > shown
      ? `${shown} of ${result.totalMatched} results`
      : `${shown} ${shown === 1 ? "result" : "results"}`;
  const cacheLabel =
    totalKnownNotes > cachedCount
      ? `${cachedCount} of ${totalKnownNotes} notes cached`
      : `${cachedCount} ${cachedCount === 1 ? "cached note" : "cached notes"}`;
  return `${resultLabel} · ${cacheLabel}`;
}

function QueryBlockContent({
  source,
  docs,
  pkm,
  syncQueue,
}: {
  source: string;
  docs: readonly VaultDocument[] | null;
  pkm: PkmApi | null;
  syncQueue: SyncQueue | null;
}) {
  const parsed = useMemo(() => parseQuery(source), [source]);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, TextOverride>>(new Map());

  const effectiveDocs = useMemo((): VaultDocument[] | null => {
    if (docs === null) {
      return null;
    }
    return docs.map((doc) => {
      const override = overrides.get(doc.id);
      if (override !== undefined && override.baseText === doc.text) {
        return { ...doc, text: override.text };
      }
      return doc;
    });
  }, [docs, overrides]);

  const docsById = useMemo(() => new Map((docs ?? []).map((doc) => [doc.id, doc])), [docs]);
  const effectiveById = useMemo(
    () => new Map((effectiveDocs ?? []).map((doc) => [doc.id, doc])),
    [effectiveDocs],
  );

  const result = useMemo((): QueryResult | null => {
    if (!parsed.ok || effectiveDocs === null) {
      return null;
    }
    return executeQuery(parsed.query, effectiveDocs);
  }, [parsed, effectiveDocs]);

  if (!parsed.ok) {
    return (
      <div role="alert" className="query-block-error">
        <p className="query-block-error-message">{parsed.error}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (result === null || effectiveDocs === null) {
    return (
      <section className="query-block" data-slot="query-block" aria-label="Query results">
        <p role="status" className="query-block-empty">
          Running query…
        </p>
      </section>
    );
  }

  const toggleTask = (noteId: string, offset: number) => {
    const original = docsById.get(noteId);
    const current = effectiveById.get(noteId);
    if (original === undefined || current === undefined) {
      return;
    }
    const next = toggleTaskAt(current.text, offset);
    if (next === null) {
      return;
    }
    setOverrides((prev) => new Map(prev).set(noteId, { baseText: original.text, text: next }));
    if (syncQueue !== null) {
      saveVaultDocument(syncQueue, current, next);
    }
  };

  const totalKnownNotes = pkm?.notes.length ?? effectiveDocs.length;
  const footer = formatFooter(result, effectiveDocs.length, totalKnownNotes);

  return (
    <section className="query-block" data-slot="query-block" aria-label="Query results">
      {result.view.kind === "count" ? (
        <div className="query-block-count">
          <span className="query-block-count-value">{result.rows.length}</span>
          <span className="query-block-count-label">
            {result.type === "notes"
              ? result.rows.length === 1
                ? "matching note"
                : "matching notes"
              : result.rows.length === 1
                ? "matching task"
                : "matching tasks"}
          </span>
        </div>
      ) : result.rows.length === 0 ? (
        <p className="query-block-empty">No matching {result.type}.</p>
      ) : result.view.kind === "table" ? (
        <div className="query-block-table-wrap">
          <table className="query-block-table">
            <thead>
              <tr>
                {result.view.columns.map((col) => (
                  <th key={col} scope="col">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.kind === "task" ? `${row.id}:${row.offset}` : row.id}>
                  {result.view.kind === "table" &&
                    result.view.columns.map((col) => (
                      <td key={col}>{renderCellValue(row, col, pkm)}</td>
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
                aria-label={row.text}
                checked={row.done}
                disabled={syncQueue === null}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={() => toggleTask(row.id, row.offset)}
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

function VaultQueryBlock({
  source,
  pkm,
  syncQueue,
}: {
  source: string;
  pkm: PkmApi | null;
  syncQueue: SyncQueue | null;
}) {
  const docs = useVaultDocuments();
  return <QueryBlockContent source={source} docs={docs} pkm={pkm} syncQueue={syncQueue} />;
}

/** Renders a declarative ` ```query ` fenced code block live against locally cached notes. */
export function QueryBlock({ source }: { source: string }) {
  const queryClient = useContext(QueryClientContext);
  const pkm = usePkm();
  const syncQueue = useContext(SyncQueueContext);

  if (!queryClient) {
    return <QueryBlockContent source={source} docs={[]} pkm={pkm} syncQueue={syncQueue} />;
  }
  return <VaultQueryBlock source={source} pkm={pkm} syncQueue={syncQueue} />;
}
