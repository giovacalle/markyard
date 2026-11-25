import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toggle } from "@ui-sdk/react/toggle";
import {
  lazy,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  fetchContent,
  isConflict,
  isNameExists,
  isNotFound,
  describeError,
  isRateLimited,
  isTooLarge,
  isUnauthenticated,
  NotUtf8Error,
  type DriveNode,
  type Revision,
} from "../api";
import { normalizeFileName, stripMarkdownExtension } from "../fileName";
import {
  extractFrontmatterTags,
  joinFrontmatter,
  parseFrontmatter,
  parseFrontmatterEditable,
  splitFrontmatter,
} from "../frontmatter";
import { hasUploadPlaceholder } from "../imageUploads";
import {
  CACHE_STALE_TIMESTAMP,
  deleteCachedRemoteFile,
  readAllCachedFiles,
  readCachedFile,
  renameCachedChild,
  writeCachedFile,
  writeCachedRemoteFile,
} from "../localCache";
import { isLocalId } from "../localIds";
import { useOptionalOpsQueue, usePendingOps } from "../opsQueue";
import { useExternalChange, useOptionalDriveChanges } from "../driveChanges";
import {
  isPermanentSyncError,
  useFileDiscardVersion,
  useFileSyncState,
  useSyncQueue,
} from "../syncQueue";
import { renameChild, useNodeFolderPath, useNodeName } from "../treeCache";
import type { HeadingItem } from "../commandSearch";
import { setViewPref, toggleViewPref, useViewPrefs } from "../viewPrefs";
import { modShortcut } from "../platform";
import { CopyRichTextButton } from "./CopyRichTextButton";
import type { EditorHandle } from "./Editor";
import { HistoryIcon, LockIcon, PanelRightIcon, UnlockIcon } from "./icons";
import { InfoDrawer } from "./InfoDrawer";
import { PropertiesBar } from "./PropertiesBar";
import { PropertiesEditor } from "./PropertiesEditor";
import { RetryScope, type OnRetry } from "./RetryScope";
import { formatRevisionDate, VersionHistoryDialog } from "./VersionHistoryDialog";

export const MAX_PREVIEW_BYTES = 65_536;
export const AUTOSAVE_DELAY_MS = 1_500;

const UTF8_ENCODER = new TextEncoder();
const NOOP = () => {};
/** How long the "Updated from Drive" notice stays up. */
const UPDATED_TOAST_MS = 4_000;
const RELOAD_CONFIRM = "Discard your changes and load the version on Drive?";

export type DocumentMode = "preview" | "edit";

export interface DocumentHandle {
  getText: () => string;
  startRename: () => void;
  jumpToHeading: (heading: { line: number; index: number }) => void;
  openVersionHistory: () => void;
}

function PreviewLoadFailed() {
  return (
    <p className="text-red-600" role="alert">
      Unable to load the preview. Reload the page and try again.
    </p>
  );
}

const Preview = lazy(() =>
  import("./Preview")
    .then((m) => ({ default: m.Preview }))
    .catch(() => ({ default: PreviewLoadFailed })),
);

function EditorLoadFailed() {
  return (
    <p className="text-red-600" role="alert">
      Unable to load the editor. Reload the page and try again.
    </p>
  );
}

type EditorComponent = typeof import("./Editor").Editor;
type EditorProps = Parameters<EditorComponent>[0];

let editorImport: Promise<EditorComponent> | null = null;
let loadedEditor: EditorComponent | null = null;

/**
 * Fetches and evaluates the CodeMirror chunk ahead of the first Preview → Editor switch. Safe to
 * call repeatedly; a failed load is forgotten so the next call tries again.
 */
export function preloadEditor(): Promise<EditorComponent> {
  editorImport ??= import("./Editor").then(
    (m) => {
      loadedEditor = m.Editor;
      return m.Editor;
    },
    (error: unknown) => {
      editorImport = null;
      throw error;
    },
  );
  return editorImport;
}

const LazyEditor = lazy(() =>
  preloadEditor()
    .then((Editor) => ({ default: Editor }))
    .catch(() => ({ default: EditorLoadFailed })),
);

/** Renders the editor without a Suspense round-trip once its chunk is already loaded. */
function EditorSlot(props: EditorProps) {
  // Pinned at mount: swapping component types later would remount CodeMirror mid-edit.
  const [Loaded] = useState(() => loadedEditor);
  if (Loaded !== null) {
    return <Loaded {...props} />;
  }
  return (
    <Suspense
      fallback={
        <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
          Loading editor…
        </p>
      }
    >
      <LazyEditor {...props} />
    </Suspense>
  );
}

/** Runs `task` when the browser is idle (or on the next macrotask where idle callbacks are missing). */
function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(task, 0);
  return () => window.clearTimeout(timer);
}

function MergeLoadFailed() {
  return (
    <p className="text-red-600" role="alert">
      Unable to load the merge view. Reload the page and try again.
    </p>
  );
}

const ConflictMerge = lazy(() =>
  import("./ConflictMerge")
    .then((m) => ({ default: m.ConflictMerge }))
    .catch(() => ({ default: MergeLoadFailed })),
);

function renameErrorMessage(error: unknown): string {
  if (isNameExists(error)) {
    return "A file with this name already exists in this folder.";
  }
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This note could not be found.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to rename the note. Try again.";
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      'button, a, input, textarea, select, summary, details, [data-properties-editor], [role="toolbar"], [role="alert"], [role="dialog"]',
    ) !== null
  );
}

function clickedInsideEditorContent(event: MouseEvent<HTMLDivElement>): boolean {
  const path = event.nativeEvent.composedPath?.() ?? [];
  for (const node of path) {
    if (node instanceof Element && node.classList.contains("cm-content")) {
      return true;
    }
  }
  return false;
}

export function DocumentView({
  fileId,
  sessionKey,
  fallbackName,
  fallbackPath,
  initialMode = "preview",
  autoFocusEditor = false,
  offline = false,
  offlineMessage,
  leadingControl,
  trailingControl,
  documentRef,
  onDirtyChange = NOOP,
  onFileRenamed,
  onNotFound,
  onTagClick,
  onRevealInTree,
}: {
  fileId: string;
  /** Stable key kept across `local:` → real Drive ID remap so CodeMirror never unmounts. */
  sessionKey?: string;
  fallbackName?: string;
  fallbackPath?: readonly string[];
  initialMode?: DocumentMode;
  autoFocusEditor?: boolean;
  offline?: boolean;
  offlineMessage?: string;
  leadingControl?: ReactNode;
  trailingControl?: ReactNode;
  documentRef?: RefObject<DocumentHandle | null>;
  onDirtyChange?: (dirty: boolean) => void;
  onFileRenamed?: (node: DriveNode, previousName?: string) => void;
  /** Drive answered 404 for this note's content. */
  onNotFound?: (fileId: string) => void;
  onTagClick?: (tag: string) => void;
  /** Expands the file tree down to this note and scrolls it into view. */
  onRevealInTree?: () => void;
}) {
  return (
    <RetryScope className="flex min-h-0 flex-1 flex-col">
      {(onRetry) => (
        <DocumentContent
          fileId={fileId}
          sessionKey={sessionKey}
          fallbackName={fallbackName}
          fallbackPath={fallbackPath}
          initialMode={initialMode}
          autoFocusEditor={autoFocusEditor}
          offline={offline}
          offlineMessage={offlineMessage}
          leadingControl={leadingControl}
          trailingControl={trailingControl}
          documentRef={documentRef}
          onDirtyChange={onDirtyChange}
          onFileRenamed={onFileRenamed}
          onNotFound={onNotFound}
          onTagClick={onTagClick}
          onRevealInTree={onRevealInTree}
          onRetry={onRetry}
        />
      )}
    </RetryScope>
  );
}

function DocumentContent({
  fileId,
  sessionKey,
  fallbackName,
  fallbackPath,
  initialMode,
  autoFocusEditor,
  offline,
  offlineMessage,
  leadingControl,
  trailingControl,
  documentRef,
  onDirtyChange,
  onFileRenamed,
  onNotFound,
  onTagClick,
  onRevealInTree,
  onRetry,
}: {
  fileId: string;
  sessionKey?: string;
  fallbackName?: string;
  fallbackPath?: readonly string[];
  initialMode: DocumentMode;
  autoFocusEditor: boolean;
  offline: boolean;
  offlineMessage?: string;
  leadingControl?: ReactNode;
  trailingControl?: ReactNode;
  documentRef?: RefObject<DocumentHandle | null>;
  onDirtyChange: (dirty: boolean) => void;
  onFileRenamed?: (node: DriveNode, previousName?: string) => void;
  /** Drive answered 404 for this note's content. */
  onNotFound?: (fileId: string) => void;
  onTagClick?: (tag: string) => void;
  onRevealInTree?: () => void;
  onRetry: OnRetry;
}) {
  const queryClient = useQueryClient();
  const syncQueue = useSyncQueue();
  const containerRef = useRef<HTMLElement>(null);
  const activeSessionKey = sessionKey ?? fileId;
  const [viewMode, setViewMode] = useState<{ sessionKey: string; mode: DocumentMode }>({
    sessionKey: activeSessionKey,
    mode: initialMode,
  });
  const [renamed, setRenamed] = useState<{ fileId: string; name: string } | null>(null);
  const mode: DocumentMode = viewMode.sessionKey === activeSessionKey ? viewMode.mode : initialMode;
  const { data, error, refetch } = useQuery({
    queryKey: ["files", fileId, "content"],
    networkMode: isLocalId(fileId) ? "always" : "online",
    queryFn: async ({ signal }) => {
      if (isLocalId(fileId)) {
        return (await readCachedFile(fileId)) ?? { text: "", revision: "" };
      }
      const generation = syncQueue.writeGeneration(fileId);
      try {
        const fresh = await fetchContent(fileId, signal);
        const current = queryClient.getQueryData<{ text: string; revision: string }>([
          "files",
          fileId,
          "content",
        ]);
        // A local edit was queued or an upload landed while this read was in flight: Drive's
        // answer may predate it, so keep what is saved locally instead of reverting to it.
        if (current !== undefined && syncQueue.writeGeneration(fileId) !== generation) {
          return current;
        }
        const pending = await writeCachedRemoteFile(fileId, fresh.text, fresh.revision);
        if (pending !== undefined) {
          return { text: pending.text, revision: pending.baseRevision };
        }
        syncQueue.observeRemoteRevision(fileId, fresh.revision, fresh.text);
        return fresh;
      } catch (err) {
        if (isNotFound(err)) {
          const current = queryClient.getQueryData<{ text: string; revision: string }>([
            "files",
            fileId,
            "content",
          ]);
          if (current !== undefined && syncQueue.writeGeneration(fileId) !== generation) {
            return current;
          }
          const pending = await deleteCachedRemoteFile(fileId);
          if (pending !== undefined) {
            return { text: pending.text, revision: pending.baseRevision };
          }
        }
        throw err;
      }
    },
    staleTime: 30_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (isLocalId(fileId)) {
      return;
    }
    let active = true;
    void readCachedFile(fileId).then((cached) => {
      if (!active || cached === undefined) {
        return;
      }
      const state = queryClient.getQueryState(["files", fileId, "content"]);
      if (
        state?.data !== undefined ||
        isUnauthenticated(state?.error) ||
        isNotFound(state?.error)
      ) {
        return;
      }
      queryClient.setQueryData(["files", fileId, "content"], cached, {
        updatedAt: CACHE_STALE_TIMESTAMP,
      });
    });
    return () => {
      active = false;
    };
  }, [fileId, queryClient]);

  const notFound = isNotFound(error);
  useEffect(() => {
    if (notFound) {
      onNotFound?.(fileId);
    }
  }, [notFound, fileId, onNotFound]);

  useEffect(() => {
    void activeSessionKey;
    if (window.matchMedia?.("(max-width: 47.99rem)").matches) {
      containerRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, [activeSessionKey]);

  const title = mode === "preview" ? "Preview" : "Editor";
  const cachedNodeName = useNodeName(fileId);
  const cachedFolderPath = useNodeFolderPath(fileId);
  const folderPath =
    cachedFolderPath !== null
      ? cachedFolderPath
      : fallbackPath !== undefined
        ? fallbackPath.join(" / ")
        : "";
  const knownFileName =
    cachedNodeName ?? (renamed?.fileId === fileId ? renamed.name : undefined) ?? fallbackName;
  const fileName = knownFileName ?? title;

  const handleRenamed = useCallback(
    (updated: DriveNode, previousName?: string) => {
      setRenamed({ fileId: updated.id, name: updated.name });
      renameChild(queryClient, updated.id, updated);
      void renameCachedChild(updated.id, updated);
      onFileRenamed?.(updated, previousName);
    },
    [queryClient, onFileRenamed],
  );

  return (
    <section
      ref={containerRef}
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col bg-white dark:bg-neutral-950"
    >
      {data !== undefined ? (
        <DocumentSession
          key={activeSessionKey}
          fileId={fileId}
          fileName={fileName}
          folderPath={folderPath}
          hasKnownName={knownFileName !== undefined}
          remote={data}
          mode={mode}
          autoFocusEditor={autoFocusEditor}
          offline={offline}
          offlineMessage={offlineMessage}
          leadingControl={leadingControl}
          trailingControl={trailingControl}
          documentRef={documentRef}
          onModeChange={(next) => setViewMode({ sessionKey: activeSessionKey, mode: next })}
          onDirtyChange={onDirtyChange}
          onRenamed={handleRenamed}
          onTagClick={onTagClick}
          onRevealInTree={onRevealInTree}
          onRetry={onRetry}
        />
      ) : (
        <>
          {(leadingControl || trailingControl || offline) && (
            <header
              data-offline={offline ? "true" : undefined}
              className={`flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2 transition-colors sm:px-6 ${
                offline
                  ? "border-red-200 bg-red-50/90 dark:border-red-900/70 dark:bg-red-950/55"
                  : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {leadingControl}
                <div className="flex min-w-0 flex-col">
                  <h2 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                    {fileName}
                  </h2>
                  <FolderPath path={folderPath} onReveal={onRevealInTree} />
                </div>
                {offline && offlineMessage && (
                  <span
                    role="status"
                    title={offlineMessage}
                    className="min-w-0 truncate text-xs font-medium text-red-700 dark:text-red-300"
                  >
                    {offlineMessage}
                  </span>
                )}
              </div>
              {trailingControl && (
                <div className="flex shrink-0 items-center gap-2">{trailingControl}</div>
              )}
            </header>
          )}
          <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
            {error ? (
              <DocumentError error={error} onRetry={() => onRetry(refetch)} />
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
                Loading note…
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RenameableTitle({
  fileId,
  fileName,
  hasKnownName,
  startRenameRef,
  onRenamed,
}: {
  fileId: string;
  fileName: string;
  hasKnownName: boolean;
  startRenameRef: RefObject<(() => void) | null>;
  onRenamed: (node: DriveNode, revision?: string, previousName?: string) => void;
}) {
  const opsQueue = useOptionalOpsQueue();
  const syncQueue = useSyncQueue();
  const [editing, setEditing] = useState(false);
  const [rawName, setRawName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const mutation = useMutation({
    mutationFn: async ({ name, previousName }: { name: string; previousName?: string }) => {
      if (opsQueue !== null) {
        const res = await opsQueue.renameFile(fileId, name, previousName);
        return { node: res.node, revision: res.revision, previousName };
      }
      const res = await syncQueue.renameFile(fileId, name);
      return { node: res.node, revision: res.revision, previousName };
    },
    onSuccess: ({ node, revision, previousName }) => {
      onRenamed(node, revision || undefined, previousName);
      setEditing(false);
      setValidationError(null);
    },
  });

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    cancelledRef.current = false;
    setValidationError(null);
    mutation.reset();
    setRawName(hasKnownName ? stripMarkdownExtension(fileName) : "");
    setEditing(true);
  }, [fileName, hasKnownName, mutation]);

  useEffect(() => {
    startRenameRef.current = startEditing;
    return () => {
      if (startRenameRef.current === startEditing) {
        startRenameRef.current = null;
      }
    };
  }, [startEditing, startRenameRef]);

  const cancelEditing = () => {
    cancelledRef.current = true;
    setEditing(false);
    setValidationError(null);
    mutation.reset();
  };

  const commitRename = () => {
    if (cancelledRef.current || mutation.isPending) {
      return;
    }
    const result = normalizeFileName(rawName);
    if (!result.ok) {
      setValidationError(result.error);
      inputRef.current?.focus();
      return;
    }
    if (hasKnownName && result.name === fileName) {
      setEditing(false);
      setValidationError(null);
      return;
    }
    setValidationError(null);
    mutation.mutate({ name: result.name, previousName: hasKnownName ? fileName : undefined });
  };

  const activeError =
    validationError ?? (mutation.error !== null ? renameErrorMessage(mutation.error) : null);

  if (editing) {
    const showExtSuffix = !rawName.trim().toLowerCase().endsWith(".md");
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline">
          <span className="inline-grid items-center">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 whitespace-pre px-1 py-0.5 text-sm font-semibold"
            >
              {rawName.length > 0 ? `${rawName} ` : "Untitled "}
            </span>
            <input
              ref={inputRef}
              type="text"
              aria-label="File name"
              aria-invalid={activeError !== null}
              value={rawName}
              disabled={mutation.isPending}
              onChange={(event) => {
                setRawName(event.target.value);
                if (validationError !== null) {
                  setValidationError(null);
                }
                if (mutation.error !== null) {
                  mutation.reset();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditing();
                }
              }}
              onBlur={() => {
                commitRename();
              }}
              className={`col-start-1 row-start-1 w-full min-w-[4ch] border-0 bg-transparent px-1 py-0.5 text-sm font-semibold text-neutral-900 caret-neutral-900 focus:outline-none focus:ring-0 disabled:opacity-50 dark:text-neutral-100 dark:caret-neutral-100 ${
                activeError !== null ? "underline decoration-red-500 underline-offset-4" : ""
              }`}
            />
          </span>
          {showExtSuffix && (
            <span className="shrink-0 text-sm font-semibold text-neutral-400 dark:text-neutral-500">
              .md
            </span>
          )}
        </div>
        {activeError !== null && (
          <p className="px-1 text-xs text-red-600 dark:text-red-400" role="alert">
            {activeError}
          </p>
        )}
      </div>
    );
  }

  return (
    <h2 className="min-w-0 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
      <button
        type="button"
        aria-label={hasKnownName ? undefined : "Rename note"}
        onClick={startEditing}
        title="Click to rename"
        className="block max-w-full truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-neutral-800"
      >
        {fileName}
      </button>
    </h2>
  );
}

/** The note's folder path under its name; a button that reveals the note in the tree when it can. */
function FolderPath({
  path,
  onReveal,
  className = "",
}: {
  path: string;
  onReveal?: () => void;
  className?: string;
}) {
  if (path.length === 0) {
    return null;
  }
  const base = `truncate text-left text-[11px] leading-tight text-neutral-400 dark:text-neutral-500 ${className}`;
  if (onReveal === undefined) {
    return (
      <span data-testid="document-path" title={path} className={base}>
        {path}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="document-path"
      title={`Show in file tree: ${path}`}
      onClick={onReveal}
      className={`${base} max-w-full cursor-pointer self-start rounded-sm underline-offset-2 transition-colors hover:text-neutral-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:text-neutral-300`}
    >
      {path}
    </button>
  );
}

function DocumentSession({
  fileId,
  fileName,
  folderPath,
  hasKnownName,
  remote,
  mode,
  autoFocusEditor,
  offline,
  offlineMessage,
  leadingControl,
  trailingControl,
  documentRef,
  onModeChange,
  onDirtyChange,
  onRenamed,
  onTagClick,
  onRevealInTree,
  onRetry,
}: {
  fileId: string;
  fileName: string;
  folderPath: string;
  hasKnownName: boolean;
  remote: { text: string; revision: string };
  mode: DocumentMode;
  autoFocusEditor: boolean;
  offline: boolean;
  offlineMessage?: string;
  leadingControl?: ReactNode;
  trailingControl?: ReactNode;
  documentRef?: RefObject<DocumentHandle | null>;
  onModeChange: (mode: DocumentMode) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRenamed: (node: DriveNode, previousName?: string) => void;
  onTagClick?: (tag: string) => void;
  onRevealInTree?: () => void;
  onRetry: OnRetry;
}) {
  const queryClient = useQueryClient();
  const syncQueue = useSyncQueue();
  const syncState = useFileSyncState(fileId);
  const pendingOps = usePendingOps();
  const isLocalFile = isLocalId(fileId);
  const localFileOp = isLocalFile
    ? pendingOps.find((entry) => entry.op.targetId === fileId)
    : undefined;
  const isOpSyncing = localFileOp?.state.status === "syncing";
  const discardVersion = useFileDiscardVersion(fileId);
  const sessionEpochRef = useRef(syncQueue.sessionEpoch);
  const prevDiscardVersionRef = useRef(discardVersion);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Set when a margin mousedown ended editing, so the click that follows does not reopen it.
  const swallowCanvasClickRef = useRef(false);
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const startRenameRef = useRef<(() => void) | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerId = useId();
  const prefs = useViewPrefs();
  const readOnly = prefs.readOnly;
  const [focusOnEnter, setFocusOnEnter] = useState(autoFocusEditor);
  const [base, setBase] = useState(remote);
  const [localSavedText, setLocalSavedText] = useState(remote.text);
  const [draft, setDraft] = useState(remote.text);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [mergeRemote, setMergeRemote] = useState<{ text: string; revision: string } | null>(null);
  const [rawYamlMode, setRawYamlMode] = useState(false);
  const [vaultTags, setVaultTags] = useState<string[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const frontmatter = useMemo(() => parseFrontmatter(draft), [draft]);
  const editableFrontmatter = useMemo(() => parseFrontmatterEditable(draft), [draft]);
  const split = useMemo(() => splitFrontmatter(draft), [draft]);
  const isPreview = mode === "preview";
  const editorActive = !isPreview && mergeRemote === null;
  const editorText = rawYamlMode ? draft : split.body;
  const rawYamlModeRef = useRef(rawYamlMode);
  rawYamlModeRef.current = rawYamlMode;
  // Pinned to the frontmatter prefix CodeMirror's current buffer is split against. Never
  // overwritten while the editor is active (typing YAML or a leading newline into the body must
  // not shift the prefix out from under CM6); refreshed only when CM6 is hidden or explicitly synced.
  const frontmatterRawRef = useRef(split.frontmatterRaw);
  if (!editorActive) {
    frontmatterRawRef.current = split.frontmatterRaw;
  }

  const hasUnflushedDraft = draft !== localSavedText;
  const saveError = syncState.status === "error" ? syncState.error : null;
  const permanentError = saveError !== null && isPermanentSyncError(saveError);
  // A 413 `too_large` error refuses the oversized payload, not a shortened edit the user makes next.
  const blocksNewSave = permanentError && !isTooLarge(saveError);
  const hasActiveUploadPlaceholder = uploadingImages && hasUploadPlaceholder(draft);
  const isSyncing = syncState.status === "syncing";
  const isPendingLocal = syncState.status === "pending";
  const isSynced = syncState.status === "synced";
  const dirty = hasUnflushedDraft || (saveError !== null && draft !== base.text);
  const sessionLostWithUnsaved = isUnauthenticated(saveError) && draft !== base.text;

  const prevRemoteRef = useRef(remote);
  // Apply background Drive updates seamlessly when clean; never clobber unsaved edits or local saves.
  useEffect(() => {
    const discarded = discardVersion !== prevDiscardVersionRef.current;
    if (discarded) {
      prevDiscardVersionRef.current = discardVersion;
    }
    if (!discarded && remote === prevRemoteRef.current) {
      return;
    }
    prevRemoteRef.current = remote;
    if (discarded) {
      setBase(remote);
      setLocalSavedText(remote.text);
      draftRef.current = remote.text;
      frontmatterRawRef.current = splitFrontmatter(remote.text).frontmatterRaw;
      setDraft(remote.text);
      setEditorGeneration((n) => n + 1);
      return;
    }
    if (isSynced && remote.text === localSavedText) {
      setBase(remote);
      return;
    }
    if (remote.text === draft && remote.revision !== base.revision) {
      setBase(remote);
      return;
    }
    if (hasUnflushedDraft || isPendingLocal || isSyncing || saveError !== null) {
      if (base.revision === "" && remote.revision !== "") {
        setBase(remote);
      }
      return;
    }
    if (remote.text === base.text && remote.revision !== base.revision) {
      setBase((prev) => ({ ...prev, revision: remote.revision }));
      return;
    }
    if (
      remote.revision !== base.revision ||
      remote.text !== base.text ||
      remote.text !== draft ||
      remote.text !== localSavedText
    ) {
      setBase(remote);
      setLocalSavedText(remote.text);
      draftRef.current = remote.text;
      frontmatterRawRef.current = splitFrontmatter(remote.text).frontmatterRaw;
      setDraft(remote.text);
      setEditorGeneration((n) => n + 1);
    }
  }, [
    remote,
    discardVersion,
    draft,
    localSavedText,
    hasUnflushedDraft,
    isSynced,
    isPendingLocal,
    isSyncing,
    saveError,
    base.revision,
    base.text,
  ]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Only warn on unload if the session already expired and local edits could be lost on refresh.
  useEffect(() => {
    if (!sessionLostWithUnsaved) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sessionLostWithUnsaved]);

  const reloadMutation = useMutation({
    mutationFn: () => fetchContent(fileId),
    onSuccess: (fresh) => {
      void syncQueue.discardFile(fileId, fresh.revision, fresh.text);
      setBase(fresh);
      setLocalSavedText(fresh.text);
      draftRef.current = fresh.text;
      frontmatterRawRef.current = splitFrontmatter(fresh.text).frontmatterRaw;
      setDraft(fresh.text);
      setEditorGeneration((n) => n + 1);
      queryClient.setQueryData(["files", fileId, "content"], fresh);
      void writeCachedFile(fileId, fresh.text, fresh.revision);
    },
  });

  const compareMutation = useMutation({
    mutationFn: () => fetchContent(fileId),
    onSuccess: setMergeRemote,
  });

  // The merged text replaces the draft and syncs against the Drive tag just fetched.
  const handleSaveMerged = (merged: string) => {
    if (mergeRemote === null) {
      return;
    }
    setMergeRemote(null);
    void syncQueue.discardFile(fileId, mergeRemote.revision, mergeRemote.text);
    setBase(mergeRemote);
    localSavedTextRef.current = merged;
    draftRef.current = merged;
    frontmatterRawRef.current = splitFrontmatter(merged).frontmatterRaw;
    setLocalSavedText(merged);
    setDraft(merged);
    setEditorGeneration((n) => n + 1);
    syncQueue.enqueueSave(fileId, merged, mergeRemote.revision, mergeRemote.text);
  };

  const fileIdRef = useRef(fileId);
  const draftRef = useRef(draft);
  const localSavedTextRef = useRef(localSavedText);
  const baseRevisionRef = useRef(base.revision);
  const baseTextRef = useRef(base.text);
  const blocksNewSaveRef = useRef(blocksNewSave);
  const reloadingRef = useRef(reloadMutation.isPending);
  fileIdRef.current = fileId;
  draftRef.current = draft;
  localSavedTextRef.current = localSavedText;
  baseRevisionRef.current = base.revision;
  baseTextRef.current = base.text;
  blocksNewSaveRef.current = blocksNewSave;
  reloadingRef.current = reloadMutation.isPending;

  const flushPendingDraft = useCallback(() => {
    const activeId = fileIdRef.current;
    if (
      blocksNewSaveRef.current ||
      reloadingRef.current ||
      syncQueue.sessionEpoch !== sessionEpochRef.current ||
      syncQueue.isDeleted(activeId) ||
      syncQueue.discardVersion(activeId) !== prevDiscardVersionRef.current
    ) {
      return;
    }
    const currentDraft = draftRef.current;
    if (currentDraft === localSavedTextRef.current) {
      return;
    }
    localSavedTextRef.current = currentDraft;
    syncQueue.enqueueSave(activeId, currentDraft, baseRevisionRef.current, baseTextRef.current);
  }, [syncQueue]);

  // Flush any pending draft locally and queue background sync when switching files, hiding, or leaving.
  useEffect(() => {
    const handlePageHide = () => flushPendingDraft();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingDraft();
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flushPendingDraft();
    };
  }, [flushPendingDraft]);

  const canSave =
    (hasUnflushedDraft || (saveError !== null && !permanentError)) &&
    !reloadMutation.isPending &&
    !blocksNewSave;

  const triggerSave = useCallback(() => {
    if (!canSave) {
      return;
    }
    localSavedTextRef.current = draft;
    setLocalSavedText(draft);
    syncQueue.enqueueSave(fileId, draft, base.revision, base.text);
  }, [canSave, draft, syncQueue, fileId, base.revision, base.text]);

  // Local-first autosave: flushes edits into IndexedDB and starts background Drive sync after a pause.
  useEffect(() => {
    if (
      !hasUnflushedDraft ||
      reloadMutation.isPending ||
      blocksNewSave ||
      hasActiveUploadPlaceholder
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      triggerSave();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    hasUnflushedDraft,
    reloadMutation.isPending,
    blocksNewSave,
    hasActiveUploadPlaceholder,
    triggerSave,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        triggerSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [triggerSave]);

  const handleDraftChange = useCallback(
    (nextDraft: string) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      if (nextDraft === base.text && saveError !== null) {
        localSavedTextRef.current = base.text;
        setLocalSavedText(base.text);
        queryClient.setQueryData(["files", fileId, "content"], base);
        void syncQueue.discardFile(fileId, base.revision, base.text);
      }
    },
    [base, saveError, queryClient, syncQueue, fileId],
  );

  // Preview checkbox toggles (and restored versions) are complete edits: store and sync them
  // right away, like a save.
  const handleToggleTask = useCallback(
    (nextText: string) => {
      setDraft(nextText);
      draftRef.current = nextText;
      if (blocksNewSaveRef.current || reloadingRef.current) {
        return;
      }
      localSavedTextRef.current = nextText;
      setLocalSavedText(nextText);
      syncQueue.enqueueSave(fileId, nextText, baseRevisionRef.current, baseTextRef.current);
    },
    [fileId, syncQueue],
  );

  const statusText =
    isSyncing || isOpSyncing
      ? "Saving…"
      : hasUnflushedDraft
        ? "Unsaved changes"
        : isPendingLocal || isLocalFile
          ? "Saved locally"
          : isSynced
            ? "Saved"
            : "";

  const handleReload = () => {
    if (window.confirm(RELOAD_CONFIRM)) {
      onRetry(() => reloadMutation.mutate());
    }
  };

  // Drive reported that someone else changed this note.
  const driveChanges = useOptionalDriveChanges();
  const externalChange = useExternalChange(fileId);
  const hasLocalWork = hasUnflushedDraft || isPendingLocal || isSyncing || saveError !== null;
  const hasLocalWorkRef = useRef(hasLocalWork);
  hasLocalWorkRef.current = hasLocalWork;
  const [externalBanner, setExternalBanner] = useState(false);
  const [updatedToast, setUpdatedToast] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);
  useEffect(() => {
    if (restoredFrom === null) {
      return;
    }
    const timer = window.setTimeout(() => setRestoredFrom(null), UPDATED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [restoredFrom]);
  // A restored version is one undoable edit in the editor, saved through the sync queue with the
  // note's current Drive tag, so a concurrent change on Drive still surfaces as a conflict.
  const handleRestore = (text: string, revision: Revision) => {
    setHistoryOpen(false);
    const nextSplit = splitFrontmatter(text);
    frontmatterRawRef.current = nextSplit.frontmatterRaw;
    editorHandleRef.current?.replaceText(rawYamlModeRef.current ? text : nextSplit.body);
    handleToggleTask(text);
    setRestoredFrom(formatRevisionDate(revision.modifiedTime));
  };
  // Whole-note edits from the Info Drawer (removing an image): one undoable editor change, saved
  // right away like a task toggle.
  const handleReplaceText = (text: string) => {
    if (text === draftRef.current) {
      return;
    }
    const nextSplit = splitFrontmatter(text);
    frontmatterRawRef.current = nextSplit.frontmatterRaw;
    editorHandleRef.current?.replaceText(rawYamlModeRef.current ? text : nextSplit.body);
    handleToggleTask(text);
  };
  const handleEditorChange = useCallback(
    (nextEditorText: string) => {
      const nextDraft = rawYamlModeRef.current
        ? nextEditorText
        : joinFrontmatter(frontmatterRawRef.current, nextEditorText);
      handleDraftChange(nextDraft);
    },
    [handleDraftChange],
  );
  const handleFrontmatterChange = useCallback(
    (nextDraft: string) => {
      const nextSplit = splitFrontmatter(nextDraft);
      frontmatterRawRef.current = nextSplit.frontmatterRaw;
      handleDraftChange(nextDraft);
      editorHandleRef.current?.syncText(rawYamlModeRef.current ? nextDraft : nextSplit.body);
    },
    [handleDraftChange],
  );
  const handleToggleRawYaml = useCallback((nextRaw: boolean) => {
    rawYamlModeRef.current = nextRaw;
    setRawYamlMode(nextRaw);
    const currentDraft = draftRef.current;
    const nextSplit = splitFrontmatter(currentDraft);
    frontmatterRawRef.current = nextSplit.frontmatterRaw;
    if (nextRaw) {
      editorHandleRef.current?.syncText(currentDraft, 0);
      editorHandleRef.current?.focus(false);
    } else {
      editorHandleRef.current?.syncText(nextSplit.body);
    }
  }, []);
  useEffect(() => {
    if (externalChange === null) {
      return;
    }
    driveChanges?.dismissExternal(fileId);
    if (hasLocalWorkRef.current) {
      setExternalBanner(true);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["files", fileId, "content"], exact: true });
    setUpdatedToast(true);
  }, [externalChange, driveChanges, fileId, queryClient]);
  useEffect(() => {
    if (!updatedToast) {
      return;
    }
    const timer = window.setTimeout(() => setUpdatedToast(false), UPDATED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [updatedToast]);
  const handleExternalReload = () => {
    if (window.confirm(RELOAD_CONFIRM)) {
      setExternalBanner(false);
      onRetry(() => reloadMutation.mutate());
    }
  };
  const handleExternalCompare = () => {
    setExternalBanner(false);
    onRetry(() => compareMutation.mutate());
  };

  // Becomes true on the first switch to Editor and stays true for this note's session.
  const [editorWarm, setEditorWarm] = useState(!isPreview);
  if (!isPreview && !editorWarm) {
    setEditorWarm(true);
  }

  // Warm the editor chunk while the note is read, so the first click into it does not wait.
  useEffect(() => {
    if (readOnly) {
      return;
    }
    return whenIdle(() => {
      void preloadEditor().catch(() => undefined);
    });
  }, [readOnly]);

  // Collect locally cached vault tags for PropertiesEditor autocomplete (no network requests).
  useEffect(() => {
    if (isPreview) {
      return;
    }
    let active = true;
    void readAllCachedFiles().then((cached) => {
      if (!active) {
        return;
      }
      const byLower = new Map<string, string>();
      const addFrom = (text: string) => {
        for (const tag of extractFrontmatterTags(text)) {
          const lower = tag.toLowerCase();
          if (!byLower.has(lower)) {
            byLower.set(lower, tag);
          }
        }
      };
      for (const file of cached) {
        addFrom(file.text);
      }
      for (const [, entry] of queryClient.getQueriesData<{ text: string }>({
        queryKey: ["files"],
      })) {
        if (entry?.text !== undefined) {
          addFrom(entry.text);
        }
      }
      setVaultTags(
        Array.from(byLower.values()).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "accent" }),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [isPreview, queryClient]);

  const jumpToHeading = useCallback(
    ({ line, index }: Pick<HeadingItem, "line" | "index">) => {
      if (isPreview) {
        const headings = canvasRef.current?.querySelectorAll(
          ".markdown-preview h3, .markdown-preview h4, .markdown-preview h5, .markdown-preview h6",
        );
        const target = headings?.[index];
        if (target instanceof HTMLElement) {
          target.scrollIntoView?.({ behavior: "smooth", block: "start" });
        }
        return;
      }
      const prefixLines = (frontmatterRawRef.current.match(/\r\n|\r|\n/g) ?? []).length;
      const targetLine = rawYamlModeRef.current ? line : Math.max(1, line - prefixLines);
      editorHandleRef.current?.goToLine(targetLine);
    },
    [isPreview],
  );

  // Locking a note while editing returns it to Preview; Preview stays locked until unlocked.
  useEffect(() => {
    if (readOnly && !isPreview) {
      onModeChange("preview");
    }
  }, [readOnly, isPreview, onModeChange]);

  // Cmd/Ctrl+Shift+I toggles the Info Drawer.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        toggleViewPref("infoDrawerOpen");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleDrawerJump = (heading: HeadingItem) => {
    jumpToHeading(heading);
    // The overlay sheet covers the note on phones: get it out of the way after a jump.
    if (window.matchMedia?.("(max-width: 47.99rem)").matches) {
      toggleViewPref("infoDrawerOpen");
    }
  };

  useEffect(() => {
    if (!documentRef) {
      return;
    }
    const handle: DocumentHandle = {
      getText: () => draftRef.current,
      startRename: () => {
        startRenameRef.current?.();
      },
      jumpToHeading,
      openVersionHistory: () => setHistoryOpen(true),
    };
    documentRef.current = handle;
    return () => {
      if (documentRef.current === handle) {
        documentRef.current = null;
      }
    };
  }, [documentRef, jumpToHeading]);

  // Return to rendered Markdown on clicks/focus outside the editor canvas or Escape.
  // Intentionally ignores window.blur so Alt/Cmd+Tab or switching browser tabs keeps your cursor.
  useEffect(() => {
    if (isPreview) {
      return;
    }
    // The Info Drawer counts as part of the canvas: using it never ends an editing session.
    const isInsideCanvas = (event: Event) => {
      const path = event.composedPath?.() ?? [];
      return [canvasRef.current, drawerRef.current].some(
        (area) =>
          area !== null &&
          (path.includes(area) || (event.target instanceof Node && area.contains(event.target))),
      );
    };

    const isDialogOpen = () => document.querySelector('[role="dialog"]') !== null;

    const handleOutsideMouseDown = (event: globalThis.MouseEvent) => {
      if (!isDialogOpen() && !isInsideCanvas(event)) {
        onModeChange("preview");
      }
    };
    const handleOutsideFocusIn = (event: FocusEvent) => {
      const canvas = canvasRef.current;
      if (
        !isDialogOpen() &&
        event.target instanceof Element &&
        event.target !== document.body &&
        (!canvas || !event.target.contains(canvas)) &&
        !isInsideCanvas(event)
      ) {
        onModeChange("preview");
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      // An open completion menu in the editor handles Escape first (and prevents its default).
      if (event.key !== "Escape" || event.defaultPrevented || isDialogOpen()) {
        return;
      }
      event.preventDefault();
      onModeChange("preview");
    };

    document.addEventListener("mousedown", handleOutsideMouseDown, true);
    document.addEventListener("focusin", handleOutsideFocusIn);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideMouseDown, true);
      document.removeEventListener("focusin", handleOutsideFocusIn);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isPreview, onModeChange]);

  const handleCanvasMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    swallowCanvasClickRef.current = false;
    if (isPreview || event.button !== 0) {
      return;
    }
    if (isInteractiveTarget(event.target) || clickedInsideEditorContent(event)) {
      return;
    }
    // The canvas itself, not the note column inside it: the margins around the note end editing.
    if (event.target === event.currentTarget) {
      swallowCanvasClickRef.current = true;
      onModeChange("preview");
      return;
    }
    event.preventDefault();
    editorHandleRef.current?.focus(true);
  };

  const handleCanvasPointerDown = () => {
    if (isPreview && !readOnly) {
      void preloadEditor().catch(() => undefined);
    }
  };

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (swallowCanvasClickRef.current) {
      swallowCanvasClickRef.current = false;
      return;
    }
    if (!isPreview || readOnly || event.button !== 0) {
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }
    const selectedText = window.getSelection?.()?.toString().trim() ?? "";
    if (selectedText.length > 0) {
      return;
    }
    setFocusOnEnter(true);
    onModeChange("edit");
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          data-offline={offline ? "true" : undefined}
          className={`flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2 transition-colors sm:px-6 ${
            offline
              ? "border-red-200 bg-red-50/90 dark:border-red-900/70 dark:bg-red-950/55"
              : "border-neutral-200 dark:border-neutral-800"
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {leadingControl}
            <div className="flex min-w-0 flex-col">
              <RenameableTitle
                fileId={fileId}
                fileName={fileName}
                hasKnownName={hasKnownName}
                startRenameRef={startRenameRef}
                onRenamed={(node, revision, previousName) => {
                  if (revision && !hasLocalWorkRef.current) {
                    setBase((prev) => ({ ...prev, revision }));
                  }
                  onRenamed(node, previousName);
                }}
              />
              <FolderPath path={folderPath} onReveal={onRevealInTree} className="px-1" />
            </div>
            <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400" role="status">
              {statusText}
            </span>
            {offline && offlineMessage && (
              <span
                title={offlineMessage}
                className="min-w-0 truncate text-xs font-medium text-red-700 dark:text-red-300"
                role="status"
              >
                {offlineMessage}
              </span>
            )}
            {readOnly && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                <LockIcon className="size-3" />
                Read-only
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CopyRichTextButton getText={() => draftRef.current} />
            <button
              type="button"
              aria-label="Version history"
              disabled={offline}
              title={
                offline
                  ? "Version history needs a connection"
                  : isLocalFile
                    ? "Version history is available after this note syncs to Drive."
                    : "Version history: compare and restore"
              }
              onClick={() => setHistoryOpen(true)}
              className={`${HEADER_ICON_BUTTON_CLASS} disabled:opacity-40`}
            >
              <HistoryIcon className="size-4" />
            </button>
            <Toggle
              aria-label="Read-only mode"
              title={readOnly ? "Unlock editing" : "Lock the note against accidental edits"}
              pressed={readOnly}
              onPressedChange={(pressed) => setViewPref("readOnly", pressed)}
              className={HEADER_ICON_BUTTON_CLASS}
            >
              {readOnly ? <LockIcon className="size-4" /> : <UnlockIcon className="size-4" />}
            </Toggle>
            <button
              type="button"
              aria-label="Document info"
              aria-expanded={prefs.infoDrawerOpen}
              aria-controls={prefs.infoDrawerOpen ? drawerId : undefined}
              title={`Document info (${modShortcut("⇧I")})`}
              onClick={() => toggleViewPref("infoDrawerOpen")}
              className={HEADER_ICON_BUTTON_CLASS}
            >
              <PanelRightIcon className="size-4" />
            </button>
            {trailingControl}
          </div>
        </header>

        <div
          ref={canvasRef}
          data-testid="editor-canvas"
          onMouseDown={handleCanvasMouseDown}
          onPointerDown={handleCanvasPointerDown}
          onClick={handleCanvasClick}
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-8 ${
            readOnly ? "" : "cursor-text"
          }`}
        >
          <div
            data-testid="editor-column"
            className="mx-auto flex w-full max-w-3xl flex-1 flex-col space-y-4"
          >
            {updatedToast && (
              <p
                role="status"
                className="self-center rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                Updated from Drive
              </p>
            )}
            {restoredFrom !== null && (
              <p
                role="status"
                className="self-center rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                Restored revision from {restoredFrom}
              </p>
            )}
            {externalBanner && !isConflict(saveError) && (
              <div
                className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-sm dark:border-amber-800/70 dark:bg-amber-950/50"
                role="alert"
              >
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  This note was updated on Drive
                </p>
                <p className="text-amber-800 dark:text-amber-300">
                  Your unsaved changes are kept. Reload Drive's version, or compare and merge.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={CONFLICT_BUTTON_CLASS}
                    type="button"
                    disabled={compareMutation.isPending || reloadMutation.isPending}
                    onClick={handleExternalCompare}
                  >
                    Compare & Merge
                  </button>
                  <button
                    className={CONFLICT_BUTTON_CLASS}
                    type="button"
                    disabled={reloadMutation.isPending}
                    onClick={handleExternalReload}
                  >
                    Reload
                  </button>
                  <button
                    className={CONFLICT_BUTTON_CLASS}
                    type="button"
                    onClick={() => setExternalBanner(false)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {saveError !== null && (
              <SaveError
                error={saveError}
                retry={syncState.status === "error" ? syncState.retry : undefined}
                isReloading={reloadMutation.isPending}
                reloadFailed={reloadMutation.isError}
                onRetrySave={() => onRetry(() => void syncQueue.retryFile(fileId))}
                onReload={handleReload}
                isComparing={compareMutation.isPending}
                compareFailed={compareMutation.isError}
                onCompare={() => onRetry(() => compareMutation.mutate())}
              />
            )}
            {isPreview && mergeRemote === null && frontmatter !== null && (
              <PropertiesBar frontmatter={frontmatter} onTagClick={onTagClick} />
            )}
            {mergeRemote !== null ? (
              <Suspense
                fallback={
                  <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
                    Loading merge view…
                  </p>
                }
              >
                <ConflictMerge
                  mine={draft}
                  remote={mergeRemote.text}
                  onSave={handleSaveMerged}
                  onCancel={() => setMergeRemote(null)}
                />
              </Suspense>
            ) : isPreview ? (
              <DocumentBody text={draft} onToggleTask={readOnly ? undefined : handleToggleTask} />
            ) : null}
            {editorWarm && (
              // Kept mounted (hidden) after the first edit so later switches skip CodeMirror setup.
              <div
                hidden={isPreview || mergeRemote !== null}
                data-testid="editor-slot"
                className="flex flex-1 flex-col"
              >
                <EditorSlot
                  key={editorGeneration}
                  initialText={editorText}
                  text={editorText}
                  active={!isPreview && mergeRemote === null}
                  onChange={handleEditorChange}
                  onUploadingChange={setUploadingImages}
                  editorRef={editorHandleRef}
                  autoFocus={focusOnEnter}
                  aboveEditor={
                    <PropertiesEditor
                      text={draft}
                      frontmatter={editableFrontmatter}
                      rawMode={rawYamlMode}
                      vaultTags={vaultTags}
                      onChange={handleFrontmatterChange}
                      onToggleRawMode={handleToggleRawYaml}
                    />
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {historyOpen && (
        <VersionHistoryDialog
          fileId={fileId}
          fileName={fileName}
          currentText={draft}
          readOnly={readOnly}
          offline={offline}
          onRestore={handleRestore}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {prefs.infoDrawerOpen && (
        <InfoDrawer
          id={drawerId}
          fileId={fileId}
          text={draft}
          frontmatter={frontmatter}
          drawerRef={drawerRef}
          readOnly={readOnly}
          offline={offline}
          onEditText={handleReplaceText}
          onJump={handleDrawerJump}
          onClose={() => toggleViewPref("infoDrawerOpen")}
        />
      )}
    </div>
  );
}

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 aria-expanded:bg-neutral-100 aria-expanded:text-neutral-900 data-pressed:bg-amber-100 data-pressed:text-amber-800 data-pressed:ring-1 data-pressed:ring-inset data-pressed:ring-amber-300 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:aria-expanded:bg-neutral-800 dark:aria-expanded:text-neutral-100 dark:data-pressed:bg-amber-950/70 dark:data-pressed:text-amber-300 dark:data-pressed:ring-amber-800";

const CONFLICT_BUTTON_CLASS =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";

function SaveError({
  error,
  retry,
  isReloading,
  reloadFailed,
  onRetrySave,
  onReload,
  isComparing,
  compareFailed,
  onCompare,
}: {
  error: unknown;
  retry?: { attempt: number; maxAttempts: number; at: number };
  isReloading: boolean;
  reloadFailed: boolean;
  onRetrySave: () => void;
  onReload: () => void;
  isComparing: boolean;
  compareFailed: boolean;
  onCompare: () => void;
}) {
  if (isConflict(error)) {
    return (
      <div
        className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm dark:border-red-900/60 dark:bg-red-950/50"
        role="alert"
      >
        <p className="text-red-700 dark:text-red-300">
          This note changed on Drive since you opened it. Your changes are not saved.
        </p>
        {reloadFailed && (
          <p className="text-red-700 dark:text-red-300">
            Unable to load the remote version. Try again.
          </p>
        )}
        {compareFailed && (
          <p className="text-red-700 dark:text-red-300">
            Unable to load the Drive version to compare. Reload it, or keep editing.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className={CONFLICT_BUTTON_CLASS}
            type="button"
            disabled={isComparing || isReloading}
            onClick={onCompare}
          >
            Compare & merge
          </button>
          <button
            className={CONFLICT_BUTTON_CLASS}
            type="button"
            disabled={isReloading}
            onClick={onReload}
          >
            Reload the remote version
          </button>
        </div>
      </div>
    );
  }
  if (isUnauthenticated(error)) {
    return (
      <p
        className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
        role="alert"
      >
        Your session has ended. Your changes are not saved.
      </p>
    );
  }
  if (isNotFound(error)) {
    return (
      <p
        className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
        role="alert"
      >
        This note could not be found. It may have been deleted. Your changes are not saved.
      </p>
    );
  }
  if (isTooLarge(error)) {
    return (
      <p
        className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
        role="alert"
      >
        This note is larger than 10 MB and cannot be saved.
      </p>
    );
  }
  const message = isRateLimited(error)
    ? "Google Drive is busy. Your changes are saved locally and will sync when retried."
    : error instanceof TypeError
      ? "Unable to reach the server. Your changes are saved locally and will sync when online."
      : "Unable to sync to Drive. Your changes are saved locally.";
  return (
    <div
      className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900/60 dark:bg-red-950/50"
      role="alert"
    >
      <p className="text-red-700 dark:text-red-300">{message}</p>
      <p className="text-xs text-red-600/90 dark:text-red-300/80">Reason: {describeError(error)}</p>
      {retry !== undefined && (
        <p className="text-xs text-red-600/90 dark:text-red-300/80">
          Retrying automatically (attempt {retry.attempt} of {retry.maxAttempts})…
        </p>
      )}
      <button
        className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
        type="button"
        onClick={onRetrySave}
      >
        Retry
      </button>
    </div>
  );
}

function DocumentBody({
  text,
  onToggleTask,
}: {
  text: string;
  onToggleTask?: (nextText: string) => void;
}) {
  const exceedsPreviewCap = useMemo(
    () =>
      text.length > MAX_PREVIEW_BYTES || UTF8_ENCODER.encode(text).byteLength > MAX_PREVIEW_BYTES,
    [text],
  );

  if (text.trim().length === 0) {
    return (
      <p className="text-sm text-neutral-400 dark:text-neutral-500">
        Click anywhere to start writing…
      </p>
    );
  }

  if (exceedsPreviewCap) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
          This note is larger than 64 KB, so it is shown as plain text.
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-100 p-4 font-mono text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          {text}
        </pre>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
          Loading preview…
        </p>
      }
    >
      <Preview text={text} onToggleTask={onToggleTask} />
    </Suspense>
  );
}

function DocumentError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isNotFound(error)) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400" role="alert">
        This note could not be found. It may have been deleted.
      </p>
    );
  }
  if (isTooLarge(error)) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400" role="alert">
        This file is larger than 10 MB and cannot be opened.
      </p>
    );
  }
  if (error instanceof NotUtf8Error) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400" role="alert">
        This file is not valid UTF-8 text and cannot be opened.
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="text-red-600 dark:text-red-400" role="alert">
        Unable to load this note.
      </p>
      <button
        className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
        type="button"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
