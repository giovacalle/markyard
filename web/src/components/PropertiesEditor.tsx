import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  addFrontmatterProperty,
  deleteFrontmatterProperty,
  isTagKey,
  setFrontmatterProperty,
  type EditableFrontmatter,
  type EditableFrontmatterProperty,
} from "../frontmatter";
import { ChevronIcon, CloseIcon, CodeIcon, PlusIcon } from "./icons";

function stopEscape(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function parseAddValue(key: string, rawValue: string): string | boolean | string[] {
  if (isTagKey(key)) {
    return rawValue
      .split(/[\s,]+/)
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter((tag) => tag !== "");
  }
  const trimmed = rawValue.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed;
}

function validatePropertyKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Enter a property name.";
  }
  if (/[:\r\n]/.test(trimmed) || trimmed.startsWith("#")) {
    return "Property name cannot contain “:” or start with “#”.";
  }
  return null;
}

function TagsValueEditor({
  tags,
  vaultTags,
  onChangeTags,
}: {
  tags: readonly string[];
  vaultTags: readonly string[];
  onChangeTags: (nextTags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const existingLower = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);

  const suggestions = useMemo(() => {
    const needle = draft.trim().replace(/^#/, "").toLowerCase();
    return vaultTags
      .filter(
        (tag) =>
          !existingLower.has(tag.toLowerCase()) &&
          (needle.length === 0 || tag.toLowerCase().includes(needle)),
      )
      .slice(0, 6);
  }, [vaultTags, existingLower, draft]);

  const commitTag = (raw: string) => {
    const cleaned = raw.replace(/^#/, "").trim();
    if (cleaned.length === 0) {
      setDraft("");
      return;
    }
    onChangeTags([...tags, cleaned]);
    setDraft("");
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
          >
            <span>#{tag}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() =>
                onChangeTags(tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()))
              }
              className="inline-flex size-3.5 items-center justify-center rounded-full text-blue-600/80 transition-colors hover:bg-blue-200/80 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-blue-300/80 dark:hover:bg-blue-900 dark:hover:text-blue-100"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          aria-label="Add tag"
          placeholder="+ tag…"
          value={draft}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            const value = event.target.value;
            if (value.endsWith(",")) {
              commitTag(value.slice(0, -1));
            } else {
              setDraft(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              event.stopPropagation();
              commitTag(draft);
            } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
              event.preventDefault();
              onChangeTags(tags.slice(0, -1));
            } else if (event.key === "Escape") {
              stopEscape(event);
              setDraft("");
              inputRef.current?.blur();
            }
          }}
          className="w-20 min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-800 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-200 dark:placeholder:text-neutral-500"
        />
      </div>
      {focused && suggestions.length > 0 && (
        <div role="listbox" aria-label="Tag suggestions" className="flex flex-wrap gap-1 pt-0.5">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitTag(tag)}
              className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/60 dark:hover:text-blue-300"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ListValueEditor({
  propKey,
  items,
  onChangeItems,
}: {
  propKey: string;
  items: readonly string[];
  onChangeItems: (nextItems: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commitItem = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      setDraft("");
      return;
    }
    onChangeItems([...items, trimmed]);
    setDraft("");
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((item, idx) => (
        <span
          key={`${item}-${idx}`}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-200/70 px-2 py-0.5 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
        >
          <span>{item}</span>
          <button
            type="button"
            aria-label={`Remove ${item} from ${propKey}`}
            onClick={() => onChangeItems(items.filter((_, itemIdx) => itemIdx !== idx))}
            className="inline-flex size-3.5 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-300 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        aria-label={`Add item to ${propKey}`}
        placeholder="+ item…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commitItem(draft);
          } else if (event.key === "Backspace" && draft === "" && items.length > 0) {
            event.preventDefault();
            onChangeItems(items.slice(0, -1));
          } else if (event.key === "Escape") {
            stopEscape(event);
            setDraft("");
            inputRef.current?.blur();
          }
        }}
        className="w-20 min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-800 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-200 dark:placeholder:text-neutral-500"
      />
    </div>
  );
}

function TextValueEditor({
  propKey,
  value,
  onCommit,
}: {
  propKey: string;
  value: string;
  onCommit: (nextValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    cancelledRef.current = false;
    setDraft(value);
    setEditing(true);
  };

  const commit = () => {
    if (cancelledRef.current) {
      return;
    }
    setEditing(false);
    if (draft !== value) {
      onCommit(draft);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        aria-label={`Edit ${propKey}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
          } else if (event.key === "Escape") {
            stopEscape(event);
            cancelledRef.current = true;
            setEditing(false);
            setDraft(value);
          }
        }}
        className="w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-xs text-neutral-900 focus:outline-none dark:border-blue-500 dark:bg-neutral-950 dark:text-neutral-100"
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={`Edit ${propKey}`}
      title="Click to edit"
      onClick={startEdit}
      className="w-full rounded px-1 py-0.5 text-left break-words text-neutral-800 transition-colors hover:bg-neutral-200/60 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      {value.length > 0 ? (
        value
      ) : (
        <span className="italic text-neutral-400 dark:text-neutral-500">Empty</span>
      )}
    </button>
  );
}

function AddPropertyForm({
  onAdd,
  onCancel,
}: {
  onAdd: (key: string, value: string | boolean | string[]) => void;
  onCancel: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    keyRef.current?.focus();
  }, []);

  const submit = () => {
    const validation = validatePropertyKey(keyDraft);
    if (validation !== null) {
      setError(validation);
      keyRef.current?.focus();
      return;
    }
    const cleanKey = keyDraft.trim();
    onAdd(cleanKey, parseAddValue(cleanKey, valueDraft));
  };

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={keyRef}
          type="text"
          aria-label="Property key"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          placeholder="key"
          value={keyDraft}
          onChange={(event) => {
            setKeyDraft(event.target.value);
            if (error !== null) {
              setError(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const validation = validatePropertyKey(keyDraft);
              if (validation !== null) {
                setError(validation);
              } else {
                valueRef.current?.focus();
              }
            } else if (event.key === "Escape") {
              stopEscape(event);
              onCancel();
            }
          }}
          className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <input
          ref={valueRef}
          type="text"
          aria-label="Property value"
          placeholder="value"
          value={valueDraft}
          onChange={(event) => setValueDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              submit();
            } else if (event.key === "Escape") {
              stopEscape(event);
              onCancel();
            }
          }}
          className="min-w-28 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Add
        </button>
        <button
          type="button"
          aria-label="Cancel adding property"
          onClick={onCancel}
          className="inline-flex size-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function collapsedScalars(properties: readonly EditableFrontmatterProperty[]): string[] {
  const summary: string[] = [];
  for (const prop of properties) {
    if (prop.kind === "tags") {
      continue;
    }
    if (prop.kind === "complex") {
      summary.push(`${prop.key}: …`);
    } else if (prop.kind === "boolean") {
      summary.push(`${prop.key}: ${String(prop.booleanValue === true)}`);
    } else if (prop.kind === "list") {
      const items = prop.listItems ?? [];
      summary.push(`${prop.key}: ${items.join(", ")}`);
    } else if (typeof prop.value === "string" && prop.value.length > 0) {
      summary.push(`${prop.key}: ${prop.value}`);
    }
    if (summary.length >= 2) {
      break;
    }
  }
  return summary;
}

/**
 * Inline editable YAML frontmatter panel rendered below the Editor formatting toolbar.
 * Supports Visual property editing (tags, booleans, lists, scalars, non-destructive complex YAML)
 * and a local toggle to Raw YAML mode in CodeMirror.
 */
export function PropertiesEditor({
  text,
  frontmatter,
  rawMode,
  vaultTags = [],
  onChange,
  onToggleRawMode,
}: {
  /** Full note Markdown text (including frontmatter). */
  text: string;
  /** Span-parsed frontmatter of `text`, or `null` when the note has none. */
  frontmatter: EditableFrontmatter | null;
  /** Whether CodeMirror currently shows the raw YAML header inline. */
  rawMode: boolean;
  /** Optional tag suggestions from locally cached notes in the vault. */
  vaultTags?: readonly string[];
  /** Receives the full updated note text after a surgical frontmatter edit. */
  onChange: (nextText: string) => void;
  /** Switches between Visual property editor and Raw YAML mode. */
  onToggleRawMode: (nextRaw: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);

  if (rawMode) {
    return (
      <div
        data-properties-editor=""
        className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/60"
      >
        <span className="font-medium text-neutral-600 dark:text-neutral-300">YAML frontmatter</span>
        <button
          type="button"
          onClick={() => onToggleRawMode(false)}
          className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-300 transition-colors hover:bg-blue-200/70 focus-visible:outline-2 focus-visible:outline-blue-600 dark:bg-blue-950/70 dark:text-blue-300 dark:ring-blue-800 dark:hover:bg-blue-900/70"
        >
          Visual
        </button>
      </div>
    );
  }

  if (frontmatter === null) {
    return (
      <div data-properties-editor="">
        {adding ? (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
            <p className="mb-1 font-medium text-neutral-600 dark:text-neutral-300">Add property</p>
            <AddPropertyForm
              onAdd={(key, value) => {
                setAdding(false);
                setExpanded(true);
                onChange(addFrontmatterProperty(text, key, value));
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-200"
          >
            <PlusIcon className="size-3" />
            <span>Add property</span>
          </button>
        )}
      </div>
    );
  }

  const tagPreview = frontmatter.properties
    .filter((prop) => prop.kind === "tags")
    .flatMap((prop) => (Array.isArray(prop.value) ? prop.value : [prop.value]))
    .filter((tag) => tag.length > 0);
  const scalarPreview = collapsedScalars(frontmatter.properties);

  return (
    <div
      data-properties-editor=""
      role="group"
      aria-label="Properties"
      className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-0.5 text-left text-neutral-500 transition-colors hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ChevronIcon
            className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="font-medium">Properties</span>
          {!expanded && (
            <>
              {tagPreview.map((tag, index) => (
                <span
                  key={`${tag}-${index}`}
                  className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                >
                  #{tag}
                </span>
              ))}
              {scalarPreview.map((entry, index) => (
                <span
                  key={`${entry}-${index}`}
                  className="max-w-48 truncate text-neutral-500 dark:text-neutral-400"
                >
                  {entry}
                </span>
              ))}
            </>
          )}
        </button>
        <button
          type="button"
          aria-label="Edit raw YAML"
          title="Edit raw YAML"
          onClick={() => onToggleRawMode(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <CodeIcon className="size-3.5" />
          <span>YAML</span>
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-neutral-200/80 pt-2 pb-1 dark:border-neutral-800">
          {frontmatter.properties.length > 0 && (
            <div className="space-y-1.5">
              {frontmatter.properties.map((prop, index) => (
                <div
                  key={`${prop.key}-${prop.blockStart}`}
                  className="grid grid-cols-[minmax(5rem,max-content)_1fr_auto] items-start gap-x-3 gap-y-1"
                >
                  <span className="truncate py-0.5 font-medium text-neutral-500 dark:text-neutral-400">
                    {prop.key}
                  </span>
                  <div className="min-w-0">
                    {prop.kind === "tags" ? (
                      <TagsValueEditor
                        tags={prop.listItems ?? (Array.isArray(prop.value) ? prop.value : [])}
                        vaultTags={vaultTags}
                        onChangeTags={(nextTags) =>
                          onChange(setFrontmatterProperty(text, index, nextTags))
                        }
                      />
                    ) : prop.kind === "boolean" ? (
                      <Switch
                        aria-label={prop.key}
                        checked={prop.booleanValue === true}
                        onCheckedChange={(next) =>
                          onChange(setFrontmatterProperty(text, index, next))
                        }
                        className="relative mt-0.5 inline-flex h-4.5 w-8 shrink-0 items-center rounded-full bg-neutral-300 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 data-checked:bg-blue-600 dark:bg-neutral-700 dark:data-checked:bg-blue-500"
                      >
                        <SwitchThumb className="inline-block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-4" />
                      </Switch>
                    ) : prop.kind === "list" ? (
                      <ListValueEditor
                        propKey={prop.key}
                        items={prop.listItems ?? []}
                        onChangeItems={(nextItems) =>
                          onChange(setFrontmatterProperty(text, index, nextItems))
                        }
                      />
                    ) : prop.kind === "complex" ? (
                      <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                          Complex YAML
                        </span>
                        <button
                          type="button"
                          onClick={() => onToggleRawMode(true)}
                          className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-blue-300 dark:hover:bg-blue-950/60"
                        >
                          Edit in &lt;/&gt;
                        </button>
                      </div>
                    ) : (
                      <TextValueEditor
                        propKey={prop.key}
                        value={typeof prop.value === "string" ? prop.value : prop.value.join(", ")}
                        onCommit={(nextValue) =>
                          onChange(setFrontmatterProperty(text, index, nextValue))
                        }
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete property ${prop.key}`}
                    title={`Delete ${prop.key}`}
                    onClick={() => onChange(deleteFrontmatterProperty(text, index))}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-500 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <AddPropertyForm
              onAdd={(key, value) => {
                setAdding(false);
                onChange(addFrontmatterProperty(text, key, value));
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <PlusIcon className="size-3" />
              <span>Add property</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
