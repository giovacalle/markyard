import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { type ReactNode, useId, useMemo, useState } from "react";
import { usePkm } from "../pkm";
import { useSyncQueue } from "../syncQueue";
import { filterTasks, type NoteTasks, parseTasks, type TaskStatusFilter } from "../tasks";
import { toggleTaskAt } from "../taskToggle";
import { useVaultDocuments } from "../useVaultDocuments";
import { saveVaultDocument, type VaultDocument } from "../vaultDocuments";
import { noteStem } from "../wikilinks";
import { CheckIcon, ChevronsUpDownIcon } from "./icons";
import { InlineMarkdown } from "./InlineMarkdown";

const STATUS_OPTIONS: { value: TaskStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
];

/** Folder Select value for notes at the root (no real folder path starts with `/`). */
const ROOT_ONLY = "/";

interface IndexedNote extends NoteTasks {
  doc: VaultDocument;
}

/** Every folder path holding a note with tasks, ancestors included, sorted. */
function folderPaths(notes: readonly NoteTasks[]): string[] {
  const out = new Set<string>();
  for (const note of notes) {
    for (let depth = 1; depth <= note.path.length; depth += 1) {
      out.add(note.path.slice(0, depth).join("/"));
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The Tasks dashboard over a given set of notes: filters, grouped list, live check-off. */
export function TasksPanel({
  docs,
  vaultPinned,
  onToggle,
  onOpenNote,
  header,
}: {
  docs: readonly VaultDocument[] | null;
  vaultPinned: boolean;
  /** Saves `text`, the note's content with one checkbox flipped. */
  onToggle: (doc: VaultDocument, text: string) => void;
  onOpenNote: (id: string) => void;
  header?: ReactNode;
}) {
  const taskIdPrefix = useId();
  const [status, setStatus] = useState<TaskStatusFilter>("open");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  // Toggled text shows at once, before the vault re-read catches up.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string>>(new Map());

  const indexed = useMemo((): IndexedNote[] => {
    if (docs === null) {
      return [];
    }
    const out: IndexedNote[] = [];
    for (const original of docs) {
      const override = overrides.get(original.id);
      const doc = override === undefined ? original : { ...original, text: override };
      const tasks = parseTasks(doc.text);
      if (tasks.length > 0) {
        out.push({ id: doc.id, name: doc.name, path: doc.path, tasks, doc });
      }
    }
    return out.sort(
      (a, b) =>
        noteStem(a.name).localeCompare(noteStem(b.name)) ||
        a.path.join("/").localeCompare(b.path.join("/")),
    );
  }, [docs, overrides]);

  const folders = useMemo(() => folderPaths(indexed), [indexed]);
  const folderItems = useMemo(
    () => [
      { value: "", label: "All folders" },
      { value: ROOT_ONLY, label: "Root only" },
      ...folders.map((path) => ({ value: path, label: path.split("/").join(" / ") })),
    ],
    [folders],
  );
  const tags = useMemo(() => {
    const all = new Set<string>();
    for (const note of indexed) {
      for (const task of note.tasks) {
        for (const name of task.tags) {
          all.add(name);
        }
      }
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [indexed]);

  const docsById = useMemo(() => new Map(indexed.map((note) => [note.id, note.doc])), [indexed]);
  const visible = filterTasks(indexed, {
    status,
    query,
    folder: folder ?? undefined,
    tag: tag ?? undefined,
  });

  const toggle = (noteId: string, offset: number) => {
    const doc = docsById.get(noteId);
    const next = doc === undefined ? null : toggleTaskAt(doc.text, offset);
    if (doc === undefined || next === null) {
      return;
    }
    setOverrides((prev) => new Map(prev).set(noteId, next));
    onToggle(doc, next);
  };

  const controlClass =
    "rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";

  return (
    <section data-region="tasks" aria-label="Tasks" className="flex min-h-0 flex-1 flex-col">
      <header
        data-slot="panel-header"
        className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 sm:px-6 dark:border-neutral-800"
      >
        {header}
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Tasks</h2>
        <SegmentedControl
          aria-label="Status"
          value={status}
          onValueChange={(next) => {
            if (next !== null) {
              setStatus(next);
            }
          }}
          className="ml-auto flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700"
        >
          {STATUS_OPTIONS.map((option) => (
            <SegmentedControlItem
              key={option.value}
              value={option.value}
              className="rounded px-2 py-0.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 data-checked:bg-neutral-900 data-checked:text-white data-checked:hover:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:data-checked:bg-neutral-100 dark:data-checked:text-neutral-900 dark:data-checked:hover:bg-neutral-100"
            >
              {option.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 sm:px-6 dark:border-neutral-800">
        <input
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`${controlClass} min-w-0 flex-1`}
        />
        <Select
          items={folderItems}
          value={folder === null ? "" : folder === "" ? ROOT_ONLY : folder}
          onValueChange={(next) => {
            const value = next ?? "";
            setFolder(value === "" ? null : value === ROOT_ONLY ? "" : value);
          }}
        >
          <SelectTrigger
            aria-label="Folder"
            className={`${controlClass} inline-flex items-center justify-between gap-2 data-open:border-neutral-400 dark:data-open:border-neutral-500`}
          >
            <SelectValue className="truncate" />
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
          </SelectTrigger>
          <SelectContent
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-50 max-h-64 min-w-(--anchor-width) overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {folderItems.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className="flex cursor-default items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-700 outline-none select-none data-highlighted:bg-neutral-100 data-highlighted:text-neutral-950 data-selected:text-neutral-950 dark:text-neutral-200 dark:data-highlighted:bg-neutral-800 dark:data-highlighted:text-neutral-50 dark:data-selected:text-neutral-50"
              >
                <span className="truncate">{item.label}</span>
                <SelectItemIndicator className="shrink-0 text-blue-600 dark:text-blue-400">
                  <CheckIcon className="size-3.5" />
                </SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tags.length > 0 && (
          <ToggleGroup
            aria-label="Tags"
            value={tag === null ? [] : [tag]}
            onValueChange={(next) => setTag(next[0] ?? null)}
            className="flex w-full flex-wrap gap-1"
          >
            {tags.map((name) => (
              <Toggle
                key={name}
                value={name}
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-blue-600 data-pressed:border-blue-600 data-pressed:bg-blue-600 data-pressed:text-white data-pressed:hover:border-blue-600 dark:border-neutral-700 dark:text-neutral-400 dark:data-pressed:border-blue-600 dark:data-pressed:text-white"
              >
                #{name}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
        {docs === null ? (
          <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">
            Scanning notes…
          </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No tasks match.</p>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {visible.map((note) => (
              <div role="group" aria-label={noteStem(note.name)} key={note.id}>
                <button
                  type="button"
                  onClick={() => onOpenNote(note.id)}
                  className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                    {noteStem(note.name)}
                  </span>
                  {note.path.length > 0 && (
                    <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {note.path.join(" / ")}
                    </span>
                  )}
                </button>
                <ul className="mt-1 space-y-0.5">
                  {note.tasks.map((task) => (
                    <li key={task.offset} className="flex items-start gap-2 px-1 py-0.5">
                      <Checkbox
                        aria-labelledby={`${taskIdPrefix}-${note.id}-${task.offset}`}
                        checked={task.done}
                        onCheckedChange={() => toggle(note.id, task.offset)}
                        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-neutral-300 bg-white text-white transition-colors hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 data-checked:border-blue-600 data-checked:bg-blue-600 dark:border-neutral-600 dark:bg-neutral-900 dark:hover:border-neutral-500 dark:data-checked:border-blue-500 dark:data-checked:bg-blue-500"
                      >
                        <CheckboxIndicator className="flex items-center justify-center">
                          <CheckIcon className="size-3" strokeWidth={2.5} />
                        </CheckboxIndicator>
                      </Checkbox>
                      <span
                        id={`${taskIdPrefix}-${note.id}-${task.offset}`}
                        className={`inline-markdown min-w-0 flex-1 break-words text-sm ${
                          task.done
                            ? "text-neutral-400 line-through dark:text-neutral-500"
                            : "text-neutral-800 dark:text-neutral-200"
                        }`}
                      >
                        <InlineMarkdown text={task.text} sourceId={note.id} />
                      </span>
                      {task.due !== undefined && (
                        <span className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                          {task.due}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {!vaultPinned && (
          <p className="mx-auto mt-6 max-w-3xl text-xs text-neutral-400 dark:text-neutral-500">
            Pin vault offline to include every note.
          </p>
        )}
      </div>
    </section>
  );
}

/** The Tasks workspace over every locally cached note; check-offs save through the sync queue. */
export function TasksView({ header }: { header?: ReactNode }) {
  const pkm = usePkm();
  const syncQueue = useSyncQueue();
  const docs = useVaultDocuments();
  return (
    <TasksPanel
      docs={docs}
      vaultPinned={pkm?.vaultPinned ?? false}
      header={header}
      onToggle={(doc, text) => saveVaultDocument(syncQueue, doc, text)}
      onOpenNote={(id) => pkm?.openNote(id)}
    />
  );
}
