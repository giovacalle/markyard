import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ApiError,
  fetchChildren,
  fetchRoot,
  fetchSession,
  isNotFound,
  isRateLimited,
  isSessionEnded,
  isTransientError,
  isUnauthenticated,
  signOut,
  type DriveNode,
  type Session,
} from "./api";
import {
  clearRecentFiles,
  recordRecentFile,
  removeRecentFile,
  todayNoteInitialContent,
  todayNoteName,
} from "./commandSearch";
import { useCloudStateSync } from "./cloudState";
import { setCustomCss, setCustomCssLoadedNotes, useCustomCss } from "./customCss";
import { AccountPopover } from "./components/AccountPopover";
import { CommandPalette, type FolderTarget } from "./components/CommandPalette";
import { DeleteFileDialog } from "./components/DeleteFileDialog";
import { DocumentView, type DocumentHandle, preloadPreview } from "./components/DocumentView";
import { FileTree } from "./components/FileTree";
import { MoveDialog } from "./components/MoveDialog";
import {
  NewFromTemplateDialog,
  type NewFromTemplateRequest,
} from "./components/NewFromTemplateDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { VaultOnboarding, VaultPickerDialog } from "./components/VaultPickerDialog";
import { SyncInspector } from "./components/SyncInspector";
import { TasksView } from "./components/TasksView";
import { AttachmentsView, type FocusAttachmentRequest } from "./components/AttachmentsView";
import { useOnlineStatus } from "./useOnlineStatus";
import {
  DeleteFolderDialog,
  FolderNameDialog,
  type FolderDialogState,
} from "./components/FolderDialogs";
import {
  CheckSquareIcon,
  FolderPlusIcon,
  GoogleLogo,
  ImageIcon,
  NotesLogo,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
} from "./components/icons";
import { RetryScope, type OnRetry } from "./components/RetryScope";
import {
  DriveChanges,
  DriveChangesContext,
  useDriveChanges,
  useDriveChangesPolling,
  useRecentDriveChanges,
} from "./driveChanges";
import { findHeading, updateLinksAfterRename } from "./linkIndex";
import { type PkmApi, PkmContext } from "./pkm";
import { dailyNoteTemplate } from "./templates";
import { readTemplates, useVaultNotes } from "./vaultDocuments";
import { moveErrorMessage, useMoveNode } from "./moveItem";
import {
  CACHE_STALE_TIMESTAMP,
  clearLocalCache,
  clearVaultCache,
  hasPersistedPendingWork,
  hydrateQueryClient,
  requestPersistentStorage,
  writeCachedFolder,
  writeCachedRoot,
  writeCachedSession,
  type PendingOp,
} from "./localCache";
import { isLocalId } from "./localIds";
import { modKeyShortcut, modShortcut } from "./platform";
import {
  OpsQueue,
  OpsQueueContext,
  useOpsQueue,
  usePendingOpsCount,
  useTotalPendingSyncCount,
} from "./opsQueue";
import {
  forgetLastOpenFile,
  rememberLastOpenFile,
  restoreLastOpenFile,
  useOpenDocument,
  wasRestoredFile,
} from "./openDocument";
import { resetSettings, useSettings } from "./settings";
import { clearExpandedFolders } from "./treeExpanded";
import { SyncQueue, SyncQueueContext, useSyncQueue } from "./syncQueue";
import { useTheme, type ThemePreference } from "./theme";
import { useVaultSync, useVaultSyncState, VaultSync, VaultSyncContext } from "./vaultSync";
import { childrenKey, findNode, findNoteByNameInFolder, knownParentId } from "./treeCache";

type WorkspacePanel = "tasks" | "attachments";

const WORKSPACE_PANELS: {
  panel: WorkspacePanel;
  label: string;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactNode;
}[] = [
  { panel: "tasks", label: "Tasks", Icon: CheckSquareIcon },
  { panel: "attachments", label: "Attachments", Icon: ImageIcon },
];

interface CreateNoteInput {
  folder: FolderTarget;
  name?: string;
  content?: string;
  initialCursor?: number;
  openExistingOnConflict?: boolean;
}

function createErrorMessage(error: unknown): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This folder could not be found.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to create the note. Try again.";
}

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 47.99rem)").matches
  );
}

async function fetchAndCacheRoot(signal?: AbortSignal): Promise<DriveNode> {
  const root = await fetchRoot(signal);
  void writeCachedRoot(root);
  return root;
}

function SignIn({ ended }: { ended: boolean }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-neutral-50 p-6 dark:bg-neutral-950">
      <section
        aria-label="Sign in"
        className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900">
            <NotesLogo className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              Markyard
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Markdown notes on Google Drive
            </p>
          </div>
        </div>

        {ended && (
          <p
            className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
            role="alert"
          >
            Your session has ended. Sign in again.
          </p>
        )}

        <a
          className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 shadow-xs transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
          href="/api/auth/login"
        >
          <GoogleLogo />
          <span>Sign in with Google</span>
        </a>
      </section>
      <p className="text-center text-xs text-neutral-400 dark:text-neutral-500">
        Independent open-source project. Not affiliated with Google LLC.
      </p>
    </main>
  );
}

function RootFolder({
  onOpen,
  onCreateInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  onMove,
  onDropMove,
  selectedId,
  revealPath,
  revealRequest,
}: {
  onOpen: (id: string) => void;
  onCreateInFolder: (folder: FolderTarget) => void;
  onCreateSubfolder: (folder: DriveNode) => void;
  onRenameFolder: (folder: DriveNode) => void;
  onDeleteFolder: (folder: DriveNode) => void;
  onDeleteFile: (file: DriveNode) => void;
  onMove: (node: DriveNode) => void;
  onDropMove: (node: DriveNode, targetFolderId: string) => void;
  selectedId: string | null;
  revealPath?: readonly string[];
  revealRequest?: number;
}) {
  return (
    <RetryScope>
      {(onRetry) => (
        <RootFolderContent
          onRetry={onRetry}
          onOpen={onOpen}
          onCreateInFolder={onCreateInFolder}
          onCreateSubfolder={onCreateSubfolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteFile={onDeleteFile}
          onMove={onMove}
          onDropMove={onDropMove}
          selectedId={selectedId}
          revealPath={revealPath}
          revealRequest={revealRequest}
        />
      )}
    </RetryScope>
  );
}

function RootFolderContent({
  onRetry,
  onOpen,
  onCreateInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  onMove,
  onDropMove,
  selectedId,
  revealPath,
  revealRequest,
}: {
  onRetry: OnRetry;
  onOpen: (id: string) => void;
  onCreateInFolder: (folder: FolderTarget) => void;
  onCreateSubfolder: (folder: DriveNode) => void;
  onRenameFolder: (folder: DriveNode) => void;
  onDeleteFolder: (folder: DriveNode) => void;
  onDeleteFile: (file: DriveNode) => void;
  onMove: (node: DriveNode) => void;
  onDropMove: (node: DriveNode, targetFolderId: string) => void;
  selectedId: string | null;
  revealPath?: readonly string[];
  revealRequest?: number;
}) {
  const { data, error, refetch } = useQuery({
    queryKey: ["root"],
    queryFn: ({ signal }) => fetchAndCacheRoot(signal),
  });

  if (data !== undefined) {
    return (
      <section aria-label={data.name}>
        <FileTree
          folderId={data.id}
          label={data.name}
          onOpen={onOpen}
          onCreateInFolder={onCreateInFolder}
          onCreateSubfolder={onCreateSubfolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteFile={onDeleteFile}
          onMove={onMove}
          onDropMove={onDropMove}
          selectedId={selectedId}
          revealPath={revealPath}
          revealRequest={revealRequest}
        />
      </section>
    );
  }

  if (error) {
    return (
      <section aria-label="Folder" className="px-2 py-2 text-sm">
        <p className="text-red-600 dark:text-red-400" role="alert">
          Unable to load the root folder.
        </p>
        <button
          className="mt-2 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          type="button"
          onClick={() => onRetry(refetch)}
        >
          Retry
        </button>
      </section>
    );
  }

  return (
    <p className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400" role="status">
      Loading root folder…
    </p>
  );
}

function EmptyWorkspace({
  rootFolder,
  creating,
  onCreate,
  onOpenFile,
}: {
  rootFolder: DriveNode | undefined;
  creating: boolean;
  onCreate: (folder: FolderTarget) => void;
  onOpenFile: (id: string) => void;
}) {
  const recent = useRecentDriveChanges();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          <NotesLogo className="size-5" />
        </div>
        <h2 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          No note selected
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Choose a Markdown file from the sidebar or start a new one.
        </p>
        {rootFolder !== undefined && (
          <button
            type="button"
            disabled={creating}
            onClick={() => onCreate(rootFolder)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            <PlusIcon className="size-3.5" />
            <span>{creating ? "Creating…" : "Create a note"}</span>
          </button>
        )}
        {recent.length > 0 && (
          <section aria-label="Recently updated on Drive" className="mt-8 text-left">
            <h3 className="px-2 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
              Recently updated on Drive
            </h3>
            <ul className="mt-1.5 space-y-0.5">
              {recent.map((change) => (
                <li key={change.id}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(change.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    <span className="truncate">{change.name}</span>
                    <time
                      dateTime={change.time}
                      className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500"
                    >
                      {formatChangeTime(change.time)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function formatChangeTime(time: string): string {
  const at = Date.parse(time);
  if (Number.isNaN(at)) {
    return "";
  }
  return new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function SessionGate({
  networkOffline,
  theme,
  onThemeChange,
  onOpDiscardedRef,
}: {
  networkOffline: boolean;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  onOpDiscardedRef: RefObject<((op: PendingOp) => void) | null>;
}) {
  return (
    <RetryScope>
      {(onRetry) => (
        <SessionContent
          onRetry={onRetry}
          networkOffline={networkOffline}
          theme={theme}
          onThemeChange={onThemeChange}
          onOpDiscardedRef={onOpDiscardedRef}
        />
      )}
    </RetryScope>
  );
}

/** `folderId`'s children: the cached listing, else fetched from Drive and cached. */
async function folderChildren(
  queryClient: QueryClient,
  opsQueue: OpsQueue,
  folderId: string,
): Promise<DriveNode[]> {
  const cached = queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
  if (cached !== undefined) {
    return cached;
  }
  if (isLocalId(folderId)) {
    return [];
  }
  return refreshFolderChildren(queryClient, opsQueue, folderId);
}

async function refreshFolderChildren(
  queryClient: QueryClient,
  opsQueue: OpsQueue,
  folderId: string,
): Promise<DriveNode[]> {
  if (isLocalId(folderId)) {
    return queryClient.getQueryData<DriveNode[]>(childrenKey(folderId)) ?? [];
  }
  const raw = await fetchChildren(folderId);
  const children = opsQueue.overlayListing(folderId, raw);
  queryClient.setQueryData(childrenKey(folderId), children);
  void writeCachedFolder(folderId, children);
  return children;
}

/** The live folder `name` directly under `root` (case-insensitive), created when missing. */
async function ensureRootSubfolder(
  queryClient: QueryClient,
  opsQueue: OpsQueue,
  root: DriveNode,
  name: string,
): Promise<DriveNode> {
  const target = name.toLowerCase();
  const find = (nodes: DriveNode[]) =>
    nodes.find((node) => node.kind === "folder" && node.name.toLowerCase() === target);
  const existing = find(await folderChildren(queryClient, opsQueue, root.id));
  if (existing !== undefined) {
    return existing;
  }
  const result = await opsQueue.createFolder({
    parentId: root.id,
    name,
    adoptExistingOnConflict: true,
  });
  return result.node;
}

function SessionContent({
  onRetry,
  networkOffline,
  theme,
  onThemeChange,
  onOpDiscardedRef,
}: {
  onRetry: OnRetry;
  networkOffline: boolean;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  onOpDiscardedRef: RefObject<((op: PendingOp) => void) | null>;
}) {
  const queryClient = useQueryClient();
  const syncQueue = useSyncQueue();
  const opsQueue = useOpsQueue();
  const driveChanges = useDriveChanges();
  const vaultSync = useVaultSync();
  const vaultState = useVaultSyncState();
  const moveNode = useMoveNode();
  const [moveTarget, setMoveTarget] = useState<DriveNode | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const pendingOpsCount = usePendingOpsCount();
  const pendingSyncCount = useTotalPendingSyncCount();
  const online = useOnlineStatus();
  const [dirty, setDirty] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Bumped by clicking the open note's folder path: the tree reveals the note again.
  const [revealRequest, setRevealRequest] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState("");
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState(false);
  const [createdFile, setCreatedFile] = useState<{
    id: string;
    name: string;
    initialCursor?: number;
  } | null>(null);
  // Folder path of a note opened from a Drive search hit, so the tree can reveal it.
  const [revealHint, setRevealHint] = useState<{ id: string; path: readonly string[] } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<DriveNode | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<DriveNode | null>(null);
  const documentRef = useRef<DocumentHandle | null>(null);
  const sessionKeysRef = useRef<Map<string, string>>(new Map());
  const lastAccountEmailRef = useRef<string | null>(null);
  const accountEpochRef = useRef(0);
  const vaultNoteList = useVaultNotes();
  const [openPanel, setOpenPanel] = useState<WorkspacePanel | null>(null);
  const [focusAttachment, setFocusAttachment] = useState<FocusAttachmentRequest | null>(null);
  const handleOpenAttachments = useCallback((attachmentId?: string) => {
    setFocusAttachment((prev) =>
      attachmentId !== undefined ? { id: attachmentId, key: (prev?.key ?? 0) + 1 } : null,
    );
    setOpenPanel("attachments");
  }, []);
  // A `[[Note#Heading]]` jump waiting for its note to load.
  const [pendingHeading, setPendingHeading] = useState<{
    fileId: string;
    heading: string;
    seq: number;
  } | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultPickerOpen, setVaultPickerOpen] = useState(false);
  const settings = useSettings();

  useEffect(() => {
    if (linkNotice === null) {
      return;
    }
    const timer = setTimeout(() => setLinkNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [linkNotice]);

  // Reopen last session's note before the open document is first read (only at `/`, no `?file=`).
  useState(restoreLastOpenFile);
  const [openFileId, openFile] = useOpenDocument();

  const sessionKeyFor = (id: string): string => {
    const existing = sessionKeysRef.current.get(id);
    if (existing !== undefined) {
      return existing;
    }
    sessionKeysRef.current.set(id, id);
    return id;
  };

  useEffect(
    () =>
      opsQueue.onIdRemapped(({ localId, realId, node }) => {
        const stableKey = sessionKeysRef.current.get(localId) ?? localId;
        sessionKeysRef.current.set(realId, stableKey);
        setCreatedFile((prev) =>
          prev?.id === localId ? { ...prev, id: realId, name: node.name } : prev,
        );
        setRevealHint((prev) => (prev?.id === localId ? { ...prev, id: realId } : prev));
        setPendingHeading((prev) =>
          prev?.fileId === localId ? { ...prev, fileId: realId } : prev,
        );
        setDeleteTarget((prev) =>
          prev?.id === localId ? { ...prev, id: realId, name: node.name } : prev,
        );
        setMoveTarget((prev) =>
          prev?.id === localId ? { ...prev, id: realId, name: node.name } : prev,
        );
        setDeleteFolderTarget((prev) =>
          prev?.id === localId ? { ...prev, id: realId, name: node.name } : prev,
        );
        setFolderDialog((prev) => {
          if (prev === null) {
            return prev;
          }
          if (prev.mode === "create" && prev.parent.id === localId) {
            return { mode: "create", parent: { id: realId, name: node.name } };
          }
          if (prev.mode === "rename" && prev.folder.id === localId) {
            return { mode: "rename", folder: { ...prev.folder, id: realId, name: node.name } };
          }
          return prev;
        });
      }),
    [opsQueue],
  );

  const openFileIdRef = useRef(openFileId);
  openFileIdRef.current = openFileId;
  useEffect(() => {
    onOpDiscardedRef.current = (op) => {
      if (op.kind === "create_file") {
        if (openFileIdRef.current === op.targetId) {
          openFile(null, { replace: true });
        }
        setCreatedFile((prev) => (prev?.id === op.targetId ? null : prev));
        setDeleteTarget((prev) => (prev?.id === op.targetId ? null : prev));
        setMoveTarget((prev) => (prev?.id === op.targetId ? null : prev));
      } else if (op.kind === "create_folder") {
        const currentOpen = openFileIdRef.current;
        if (
          currentOpen !== null &&
          isLocalId(currentOpen) &&
          findNode(queryClient, currentOpen) === undefined
        ) {
          openFile(null, { replace: true });
        }
        setCreatedFile((prev) =>
          prev !== null && isLocalId(prev.id) && findNode(queryClient, prev.id) === undefined
            ? null
            : prev,
        );
        setDeleteFolderTarget((prev) => (prev?.id === op.targetId ? null : prev));
        setMoveTarget((prev) => (prev?.id === op.targetId ? null : prev));
        setFolderDialog((prev) => {
          if (prev === null) {
            return prev;
          }
          if (prev.mode === "create" && prev.parent.id === op.targetId) {
            return null;
          }
          if (prev.mode === "rename" && prev.folder.id === op.targetId) {
            return null;
          }
          return prev;
        });
      } else if (op.kind === "rename_file") {
        setCreatedFile((prev) =>
          prev?.id === op.targetId ? { ...prev, name: op.previousName } : prev,
        );
      }
    };
    return () => {
      onOpDiscardedRef.current = null;
    };
  }, [onOpDiscardedRef, openFile, queryClient]);

  // Retries while the note loads; gives up quietly after ~3 s or when the heading is missing.
  useEffect(() => {
    if (pendingHeading === null || pendingHeading.fileId !== openFileId) {
      return;
    }
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryJump = () => {
      const text = documentRef.current?.getText() ?? "";
      const target = text.length > 0 ? findHeading(text, pendingHeading.heading) : undefined;
      if (target !== undefined) {
        documentRef.current?.jumpToHeading(target);
        setPendingHeading(null);
        return;
      }
      attempts += 1;
      if (attempts < 30) {
        timer = setTimeout(tryJump, 100);
      } else {
        setPendingHeading(null);
      }
    };
    timer = setTimeout(tryJump, 0);
    return () => clearTimeout(timer);
  }, [pendingHeading, openFileId]);

  useEffect(() => {
    driveChanges.setOpenFileId(openFileId);
  }, [driveChanges, openFileId]);

  useEffect(() => {
    if (openFileId !== null) {
      recordRecentFile(openFileId);
      rememberLastOpenFile(openFileId);
    }
  }, [openFileId]);

  const [hydrateState, setHydrateState] = useState<{
    ready: boolean;
    cachedSession: Session | null;
  }>({ ready: false, cachedSession: null });

  useEffect(() => {
    let active = true;
    const hydrateEpoch = accountEpochRef.current;
    const isStale = () => !active || accountEpochRef.current !== hydrateEpoch;
    void (async () => {
      // Load persisted outbox & structural ops before any 401 response can decide whether to wipe local state.
      await Promise.all([syncQueue.hydrate(false), opsQueue.hydrate(false)]);
      if (isStale()) {
        return;
      }
      const hasPending =
        syncQueue.getSnapshot().pendingCount > 0 ||
        opsQueue.getSnapshot().pendingCount > 0 ||
        (await hasPersistedPendingWork());
      if (isStale()) {
        return;
      }
      const cachedSession = await hydrateQueryClient(queryClient, openFileId, {
        preserveOnUnauthenticated: hasPending,
        isStale,
        expectedEmail: () => lastAccountEmailRef.current,
      });
      if (isStale()) {
        return;
      }
      if (cachedSession !== null) {
        opsQueue.applyPendingOverlaysToCache();
        if (lastAccountEmailRef.current === null) {
          lastAccountEmailRef.current = cachedSession.email;
        }
      }
      setHydrateState({ ready: true, cachedSession });
    })();
    return () => {
      active = false;
    };
    // Hydrate once on mount; subsequent opens read per-file cache in DocumentView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, syncQueue, opsQueue]);

  const { data, dataUpdatedAt, error, refetch } = useQuery({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      const session = await fetchSession(signal);
      const prevEmail = lastAccountEmailRef.current;
      lastAccountEmailRef.current = session.email;
      const switchedInDb = await writeCachedSession(session.email, session.name, session.cloudSync);
      const switched = switchedInDb || (prevEmail !== null && prevEmail !== session.email);
      if (switched) {
        accountEpochRef.current += 1;
        opsQueue.resetAll();
        syncQueue.resetAll();
        sessionKeysRef.current.clear();
        driveChanges.reset();
        vaultSync?.reset();
        clearRecentFiles();
        forgetLastOpenFile();
        clearExpandedFolders();
        openFile(null, { replace: true });
        setHydrateState({ ready: true, cachedSession: null });
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      }
      return session;
    },
  });
  const hasUnsaved = dirty || pendingSyncCount > 0;
  const session = data ?? (hasUnsaved ? (hydrateState.cachedSession ?? undefined) : undefined);
  const rootEnabled =
    session !== undefined && session.needsVaultSetup !== true && !isUnauthenticated(error);

  useEffect(() => {
    if (rootEnabled) {
      void preloadPreview().catch(() => undefined);
    }
  }, [rootEnabled]);

  const rootQuery = useQuery({
    queryKey: ["root"],
    queryFn: ({ signal }) => fetchAndCacheRoot(signal),
    enabled: rootEnabled,
  });

  /**
   * Leaves the current vault behind: its cached tree, notes and pending edits go, and every vault
   * query reloads. `root`, when given, is the new vault folder the server just accepted.
   */
  const resetVault = async (root?: DriveNode) => {
    opsQueue.resetAll();
    syncQueue.resetAll();
    sessionKeysRef.current.clear();
    driveChanges.reset();
    vaultSync?.reset();
    clearRecentFiles();
    forgetLastOpenFile();
    openFile(null, { replace: true });
    setOpenPanel(null);
    setCreatedFile(null);
    setRevealHint(null);
    setPaletteOpen(false);
    setNewFromTemplateOpen(false);
    await clearVaultCache();
    if (root !== undefined) {
      queryClient.setQueryData<Session>(["session"], (prev) =>
        prev === undefined ? prev : { ...prev, needsVaultSetup: false },
      );
    }
    await queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    if (root !== undefined) {
      queryClient.setQueryData(["root"], root);
      void writeCachedRoot(root);
    }
    if (vaultSync?.getSnapshot().pinned) {
      void vaultSync.run();
    }
  };

  const handleVaultPicked = (root: DriveNode) => {
    setVaultPickerOpen(false);
    setSettingsOpen(false);
    void resetVault(root);
  };

  const clearLocalSession = () => {
    opsQueue.resetAll();
    syncQueue.resetAll();
    sessionKeysRef.current.clear();
    driveChanges.reset();
    vaultSync?.setPinned(false);
    vaultSync?.reset();
    clearRecentFiles();
    forgetLastOpenFile();
    clearExpandedFolders();
    resetSettings();
    setCustomCss("");
    setCustomCssLoadedNotes([]);
    setPaletteOpen(false);
    setPaletteInitialQuery("");
    setNewFromTemplateOpen(false);
    setHydrateState({ ready: true, cachedSession: null });
    void clearLocalCache();
  };

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      clearLocalSession();
      void queryClient.resetQueries({ queryKey: ["session"] });
    },
  });

  const handleClearLocalData = () => {
    if (
      hasUnsaved &&
      !window.confirm("You have unsynced changes on this device. Clear local data anyway?")
    ) {
      return;
    }
    clearLocalSession();
    signOutMutation.reset();
    queryClient.clear();
    void queryClient.resetQueries({ queryKey: ["session"] });
  };

  const createNoteMutation = useMutation({
    mutationFn: async (input: CreateNoteInput) => {
      const { folder, name, content = "", openExistingOnConflict = false } = input;
      const result = await opsQueue.createFile({
        parentId: folder.id,
        name,
        initialContent: content,
        openExistingOnConflict,
        autoSuffixOnConflict: name === undefined,
      });
      return { folderId: folder.id, ...result };
    },
    onSuccess: ({ created, node }, input) => {
      setOpenPanel(null);
      if (created) {
        setCreatedFile({ id: node.id, name: node.name, initialCursor: input.initialCursor });
      } else {
        setCreatedFile(null);
      }
      openFile(node.id);
      setMobileSidebarOpen(false);
    },
  });

  const sessionEndedWithUnsaved = isUnauthenticated(error) && hasUnsaved && session !== undefined;
  const isSignedOut = isUnauthenticated(error) && hydrateState.ready && !sessionEndedWithUnsaved;

  useCloudStateSync({
    enabled: data?.cloudSync === true && !isSignedOut && !isUnauthenticated(error),
    rootFolderId: rootQuery.data?.id,
    setTheme: onThemeChange,
  });

  useCustomCss({
    accountEmail: session?.email,
    signedOut: isSignedOut,
  });

  useEffect(() => {
    if (isSignedOut) {
      opsQueue.resetAll();
      syncQueue.resetAll();
      sessionKeysRef.current.clear();
      driveChanges.reset();
      vaultSync?.stop();
      vaultSync?.reset();
      clearRecentFiles();
      forgetLastOpenFile();
      clearExpandedFolders();
      resetSettings();
      setPaletteOpen(false);
      setPaletteInitialQuery("");
      setNewFromTemplateOpen(false);
      void clearLocalCache();
    }
  }, [isSignedOut, opsQueue, syncQueue, driveChanges, vaultSync]);

  // Global keyboard shortcuts: Cmd/Ctrl+K (Command Palette) and Cmd/Ctrl+\ (Toggle sidebar).
  useEffect(() => {
    if (session === undefined || isSignedOut) {
      return;
    }
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setPaletteInitialQuery("");
        setPaletteOpen((prev) => !prev);
      } else if (key === "\\" && !event.shiftKey) {
        event.preventDefault();
        if (isMobileViewport()) {
          setMobileSidebarOpen((prev) => !prev);
        } else {
          setSidebarCollapsed((prev) => !prev);
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [session, isSignedOut]);

  useEffect(() => {
    if (data !== undefined && !isSignedOut && !isUnauthenticated(error)) {
      void driveChanges.hydrate();
      if (vaultSync !== null) {
        void vaultSync.hydrate();
      }
      if (dataUpdatedAt > CACHE_STALE_TIMESTAMP) {
        void requestPersistentStorage();
        void (async () => {
          await Promise.all([opsQueue.hydrate(false), syncQueue.hydrate(false)]);
          await opsQueue.flushAll();
          await syncQueue.flushAll();
        })();
        if (vaultSync !== null && vaultSync.getSnapshot().pinned) {
          void vaultSync.run();
        }
      }
    }
  }, [data, dataUpdatedAt, error, isSignedOut, opsQueue, syncQueue, driveChanges, vaultSync]);

  useDriveChangesPolling(
    driveChanges,
    data !== undefined && !isSignedOut && !isUnauthenticated(error) && rootQuery.isSuccess,
  );

  const sessionUnauthenticated = isSignedOut || isUnauthenticated(error);
  useEffect(() => {
    const handleOnline = () => {
      if (sessionUnauthenticated) {
        void queryClient.invalidateQueries({ queryKey: ["session"] });
        return;
      }
      const startedAt = Date.now();
      void opsQueue
        .flushAll()
        .then(() => syncQueue.flushAll())
        .then(() =>
          queryClient.invalidateQueries({
            predicate: (query) => {
              if (query.queryKey[0] === "files" && typeof query.queryKey[1] === "string") {
                if (isLocalId(query.queryKey[1]) || query.state.dataUpdatedAt >= startedAt) {
                  return false;
                }
              }
              return true;
            },
          }),
        );
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [queryClient, opsQueue, syncQueue, sessionUnauthenticated]);

  if (isSignedOut) {
    // With cached data, the 401 came after being signed in: say so.
    return (
      <SignIn
        ended={isSessionEnded(error) || data !== undefined || hydrateState.cachedSession !== null}
      />
    );
  }

  if (session?.needsVaultSetup === true) {
    return (
      <VaultOnboarding
        email={session.email}
        name={session.name}
        signingOut={signOutMutation.isPending}
        onSignOut={() => signOutMutation.mutate()}
        onPicked={handleVaultPicked}
      />
    );
  }

  if (session !== undefined) {
    const isOffline = !online || networkOffline;
    const offlineUnit =
      pendingOpsCount > 0
        ? pendingSyncCount === 1
          ? "change"
          : "changes"
        : pendingSyncCount === 1
          ? "note"
          : "notes";
    const offlineMessage = isOffline
      ? pendingSyncCount > 0
        ? `Offline — ${pendingSyncCount} ${offlineUnit} saved locally, will sync when online`
        : "Offline — showing cached notes"
      : undefined;

    const handleHideSidebar = () => {
      if (isMobileViewport()) {
        setMobileSidebarOpen(false);
      } else {
        setSidebarCollapsed(true);
      }
    };

    const handleShowSidebar = () => {
      if (isMobileViewport()) {
        setSidebarCollapsed(false);
        setMobileSidebarOpen(true);
      } else {
        setSidebarCollapsed(false);
      }
    };

    const handleRevealInTree = () => {
      handleShowSidebar();
      setRevealRequest((prev) => prev + 1);
    };

    const handleOpenFile = (id: string, path?: readonly string[]) => {
      setRevealHint(path === undefined ? null : { id, path });
      setOpenPanel(null);
      createNoteMutation.reset();
      setCreatedFile(null);
      openFile(id);
      setMobileSidebarOpen(false);
    };

    const handleCreateInFolder = (folder: FolderTarget) => {
      if (createNoteMutation.isPending) {
        return;
      }
      createNoteMutation.mutate({ folder });
    };

    const handleCreateNamedNote = (folder: FolderTarget, name: string) => {
      if (createNoteMutation.isPending) {
        return;
      }
      createNoteMutation.mutate({ folder, name });
    };

    const handleCreateFromTemplate = async (request: NewFromTemplateRequest) => {
      await createNoteMutation.mutateAsync({
        folder: request.folder,
        name: request.name,
        content: request.content,
        initialCursor: request.initialCursor,
      });
    };

    const handleOpenTodayNote = async () => {
      const root = rootQuery.data;
      if (!root) {
        return;
      }
      const now = new Date();
      const name = todayNoteName(now);
      // The vault root, or the daily notes folder from Settings (created when missing).
      const dailyFolderName = settings.dailyNotesFolder.trim();
      let folder: FolderTarget = root;
      if (dailyFolderName !== "") {
        try {
          folder = await ensureRootSubfolder(queryClient, opsQueue, root, dailyFolderName);
          if (!isOffline) {
            try {
              await folderChildren(queryClient, opsQueue, folder.id);
            } catch (err) {
              if (!isTransientError(err)) {
                throw err;
              }
            }
          }
        } catch (err) {
          setLinkNotice(
            `Could not open the “${dailyFolderName}” folder: ${createErrorMessage(err)}`,
          );
          return;
        }
      }
      const existing = findNoteByNameInFolder(queryClient, folder.id, name);
      if (existing) {
        handleOpenFile(existing.id);
        return;
      }
      if (createNoteMutation.isPending) {
        return;
      }
      // `<templates folder>/Daily.md`, when the vault has one, gives the new note its body.
      const templates = await readTemplates(queryClient, undefined, settings.templatesFolder).catch(
        () => [],
      );
      const dailyTemplateFolder = dailyFolderName !== "" ? folder.name : "";
      const dailyExpanded = dailyNoteTemplate(
        templates,
        now,
        name.replace(/\.md$/i, ""),
        dailyTemplateFolder,
      );
      const content = dailyExpanded?.text ?? todayNoteInitialContent(now);
      if (createNoteMutation.isPending) {
        return;
      }
      createNoteMutation.mutate({
        folder,
        name,
        content,
        initialCursor: dailyExpanded?.cursor,
        openExistingOnConflict: true,
      });
    };

    // Creates `<stem>.md` beside the open note (the root when its folder is unknown) and opens it,
    // or opens the note already there by that name.
    const handleCreateLinkedNote = (stem: string) => {
      const root = rootQuery.data;
      const current = vaultNoteList.find((note) => note.id === openFileId);
      const folderNode =
        current === undefined ? undefined : findNode(queryClient, current.folderId);
      const folder: FolderTarget | undefined =
        current !== undefined && current.folderId === root?.id
          ? root
          : folderNode !== undefined
            ? { id: folderNode.id, name: folderNode.name }
            : root;
      if (folder === undefined) {
        return;
      }
      const name = `${stem}.md`;
      const existing = findNoteByNameInFolder(queryClient, folder.id, name);
      if (existing) {
        handleOpenFile(existing.id);
        return;
      }
      if (createNoteMutation.isPending) {
        return;
      }
      setOpenPanel(null);
      createNoteMutation.mutate({ folder, name, content: "", openExistingOnConflict: true });
    };

    const handleOpenNoteFromLink = (id: string, options?: { heading?: string }) => {
      const note = vaultNoteList.find((item) => item.id === id);
      if (id !== openFileId) {
        handleOpenFile(id, note?.path);
      } else {
        // Already open behind a workspace panel (Tasks, Attachments): bring it back to the front.
        setOpenPanel(null);
        setMobileSidebarOpen(false);
      }
      if (options?.heading) {
        setPendingHeading((prev) => ({
          fileId: id,
          heading: options.heading ?? "",
          seq: (prev?.seq ?? 0) + 1,
        }));
      }
    };

    const pkmApi: PkmApi = {
      notes: vaultNoteList,
      currentFileId: openFileId,
      vaultPinned: vaultState.pinned,
      openNote: handleOpenNoteFromLink,
      createNote: handleCreateLinkedNote,
      loadTemplates: () => readTemplates(queryClient, undefined, settings.templatesFolder),
    };

    const handleToggleSidebar = () => {
      if (isMobileViewport()) {
        setMobileSidebarOpen((prev) => !prev);
      } else {
        setSidebarCollapsed((prev) => !prev);
      }
    };

    const handleDeleted = (fileId: string) => {
      if (createdFile?.id === fileId) {
        setCreatedFile(null);
      }
      if (openFileId === fileId) {
        openFile(null);
      }
    };

    // A note reopened from last session that no longer exists: fall back to the empty workspace.
    const handleNotFound = (fileId: string) => {
      if (wasRestoredFile(fileId) && openFileId === fileId) {
        removeRecentFile(fileId);
        openFile(null, { replace: true });
      }
    };

    // This render's name for the open note, i.e. the one before a rename lands.
    const previousName =
      openFileId === null
        ? undefined
        : (findNode(queryClient, openFileId)?.name ??
          (openFileId === createdFile?.id ? createdFile.name : undefined));
    const handleFileRenamed = (updated: DriveNode, renamedFrom?: string) => {
      if (createdFile?.id === updated.id) {
        setCreatedFile((prev) =>
          prev?.id === updated.id ? { ...prev, name: updated.name } : prev,
        );
      }
      const prevName = renamedFrom ?? previousName;
      if (prevName !== undefined && prevName !== updated.name) {
        void updateLinksAfterRename(queryClient, syncQueue, updated.id, prevName, updated.name)
          .then((count) => {
            if (count > 0) {
              setLinkNotice(`Updated links in ${count} ${count === 1 ? "note" : "notes"}`);
            }
          })
          .catch(() => setLinkNotice("Could not update links to the renamed note"));
      }
    };

    const handleFolderCreated = () => {
      // Cache and Dexie updates are applied by OpsQueue.createFolder.
    };

    const handleFolderRenamed = () => {
      // Cache and Dexie updates are applied by OpsQueue.renameFolder.
    };

    const handleFolderDeleted = () => {
      if (
        createdFile !== null &&
        (syncQueue.isDeleted(createdFile.id) || opsQueue.isPendingDeleted(createdFile.id))
      ) {
        setCreatedFile(null);
      }
      if (
        openFileId !== null &&
        (syncQueue.isDeleted(openFileId) || opsQueue.isPendingDeleted(openFileId))
      ) {
        openFile(null);
      }
    };

    const handleDropMove = (node: DriveNode, targetFolderId: string) => {
      setMoveError(null);
      moveNode(node, targetFolderId).catch((err: unknown) => setMoveError(moveErrorMessage(err)));
    };

    const syncInspectorProps = {
      offline: isOffline,
      onRetry: (fileId: string) => void syncQueue.retryFile(fileId),
      onRetryOp: (opId: string) => void opsQueue.retryOp(opId),
      onRetryAll: () => void opsQueue.flushAll({ force: true }).then(() => syncQueue.flushAll()),
      onDiscard: (fileId: string) => void syncQueue.discardFile(fileId),
      onDiscardOp: (opId: string) => void opsQueue.discardOp(opId),
      onPinChange: (pinned: boolean) => vaultSync?.setPinned(pinned),
      onSyncVault: () => void vaultSync?.run(),
    };

    const openFileNode = openFileId !== null ? findNode(queryClient, openFileId) : undefined;
    const openFileName =
      openFileNode?.name ?? (openFileId === createdFile?.id ? createdFile.name : undefined);

    const rootTitle = rootQuery.data?.name ?? "Drive";

    const mainSidebarToggle = (
      <button
        type="button"
        aria-label="Open sidebar"
        title="Open sidebar"
        onClick={handleShowSidebar}
        className={`${
          sidebarCollapsed ? "inline-flex" : "inline-flex md:hidden"
        } size-7 shrink-0 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100`}
      >
        <PanelLeftIcon className="size-4" />
      </button>
    );

    const openPalette = (initialQuery = "") => {
      setPaletteInitialQuery(initialQuery);
      setPaletteOpen(true);
    };

    // The palette commits inside the tap so its input is focused within the user gesture,
    // the only way iOS raises the on-screen keyboard. A printable key typed on a focused
    // trigger opens the palette with that key already in the query.
    const paletteTriggerProps = {
      "aria-keyshortcuts": modKeyShortcut("K"),
      onClick: () => flushSync(() => openPalette()),
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (
          event.key.length !== 1 ||
          event.key === " " ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        flushSync(() => openPalette(event.key));
      },
    };

    const headerSearchButton = (
      <button
        type="button"
        aria-label="Search notes and commands"
        title={`Search notes and commands (${modShortcut("K")})`}
        {...paletteTriggerProps}
        className={`${
          sidebarCollapsed ? "inline-flex" : "inline-flex md:hidden"
        } size-7 shrink-0 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100`}
      >
        <SearchIcon className="size-4" />
      </button>
    );

    // The sidebar shows the sync status; the main header shows it when the sidebar is away.
    const headerControls = (
      <>
        <SyncInspector
          {...syncInspectorProps}
          className={sidebarCollapsed ? "inline-flex" : "inline-flex md:hidden"}
        />
        {headerSearchButton}
      </>
    );

    return (
      <PkmContext.Provider value={pkmApi}>
        <div
          data-slot="app-shell"
          className="flex h-dvh overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
        >
          {mobileSidebarOpen && (
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setMobileSidebarOpen(false)}
              className="fixed inset-0 z-20 bg-neutral-950/40 md:hidden"
            />
          )}

          <aside
            data-region="sidebar"
            aria-label="Sidebar"
            hidden={sidebarCollapsed}
            className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 transition-transform dark:border-neutral-800 dark:bg-neutral-900 ${
              sidebarCollapsed ? "md:hidden" : "md:static md:translate-x-0"
            } ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
          >
            <div
              data-slot="sidebar-header"
              className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-2 dark:border-neutral-800"
            >
              <div className="flex min-w-0 items-center gap-1">
                <h1
                  className="truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
                  title={rootTitle}
                >
                  {rootTitle}
                </h1>
                <SyncInspector
                  {...syncInspectorProps}
                  align="start"
                  className="hidden md:inline-flex"
                />
              </div>
              <button
                type="button"
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                onClick={handleHideSidebar}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                <PanelLeftIcon className="size-4" />
              </button>
            </div>

            <div
              data-slot="sidebar-search"
              className="shrink-0 border-b border-neutral-200 px-2.5 py-2 dark:border-neutral-800"
            >
              <button
                type="button"
                {...paletteTriggerProps}
                aria-label="Search notes and commands"
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-500 transition-colors hover:border-neutral-300 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-800 dark:bg-neutral-950/60 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:text-neutral-200"
              >
                <span className="flex items-center gap-2">
                  <SearchIcon className="size-3.5" />
                  <span>Search…</span>
                </span>
                <kbd className="rounded border border-neutral-200 bg-neutral-50 px-1 py-0.5 font-sans text-[10px] font-medium text-neutral-400 pointer-coarse:hidden dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500">
                  {modShortcut("K")}
                </kbd>
              </button>
              <ToggleGroup
                aria-label="Workspace panels"
                orientation="vertical"
                value={openPanel === null ? [] : [openPanel]}
                onValueChange={(next) => {
                  setFocusAttachment(null);
                  setOpenPanel(WORKSPACE_PANELS.find((p) => p.panel === next[0])?.panel ?? null);
                  setMobileSidebarOpen(false);
                }}
                className="mt-1.5 flex flex-col gap-0.5"
              >
                {WORKSPACE_PANELS.map(({ panel, label, Icon }) => (
                  <Toggle
                    key={panel}
                    value={panel}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-pressed:bg-neutral-200/80 data-pressed:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-pressed:bg-neutral-800 dark:data-pressed:text-neutral-100"
                  >
                    <Icon className="size-3.5" />
                    <span className="truncate">{label}</span>
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>

            <nav aria-label="Files" className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
              {rootQuery.data !== undefined && (
                <div className="mb-1 flex items-center justify-between px-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                    Files
                  </span>
                  <button
                    type="button"
                    aria-label="New folder"
                    title="New folder"
                    onClick={() => setFolderDialog({ mode: "create", parent: rootQuery.data })}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </button>
                </div>
              )}
              <RootFolder
                onOpen={handleOpenFile}
                onCreateInFolder={handleCreateInFolder}
                onCreateSubfolder={(folder) => setFolderDialog({ mode: "create", parent: folder })}
                onRenameFolder={(folder) => setFolderDialog({ mode: "rename", folder })}
                onDeleteFolder={setDeleteFolderTarget}
                onDeleteFile={setDeleteTarget}
                onMove={setMoveTarget}
                onDropMove={handleDropMove}
                selectedId={openFileId}
                revealPath={revealHint?.id === openFileId ? revealHint.path : undefined}
                revealRequest={revealRequest}
              />
            </nav>

            <section
              data-slot="sidebar-account"
              aria-label="Account"
              className="mt-auto shrink-0 border-t border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              {sessionEndedWithUnsaved && (
                <div
                  className="mb-2 space-y-1 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
                  role="alert"
                >
                  <p>Your session has ended. Copy your unsaved changes, then sign in again.</p>
                  <a
                    className="font-medium text-red-800 underline dark:text-red-200"
                    href="/api/auth/login"
                  >
                    Sign in again
                  </a>
                </div>
              )}

              <AccountPopover
                email={session.email}
                name={session.name}
                cloudSync={session.cloudSync}
                theme={theme}
                onThemeChange={onThemeChange}
                signingOut={signOutMutation.isPending}
                onSignOut={() => signOutMutation.mutate()}
                onOpenSettings={() => setSettingsOpen(true)}
              />

              {signOutMutation.isError &&
                (signOutMutation.error instanceof TypeError ? (
                  <div
                    className="mt-2 space-y-1.5 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
                    role="alert"
                  >
                    <p>Unable to sign out while offline.</p>
                    <button
                      type="button"
                      onClick={handleClearLocalData}
                      className="font-medium text-red-800 underline dark:text-red-200"
                    >
                      Clear local data
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 px-2 text-xs text-red-600 dark:text-red-400" role="alert">
                    Unable to sign out. Try again.
                  </p>
                ))}
            </section>
          </aside>

          <main
            data-slot="main-stage"
            className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-neutral-950"
          >
            {createNoteMutation.isError && (
              <div
                role="alert"
                className="flex shrink-0 items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-700 sm:px-6 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-300"
              >
                <span>{createErrorMessage(createNoteMutation.error)}</span>
                <button
                  type="button"
                  onClick={() => createNoteMutation.reset()}
                  className="rounded px-1.5 py-0.5 text-xs hover:bg-red-100 dark:hover:bg-red-900/50"
                >
                  Dismiss
                </button>
              </div>
            )}

            {moveError !== null && (
              <div
                role="alert"
                className="flex shrink-0 items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-700 sm:px-6 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-300"
              >
                <span>{moveError}</span>
                <button
                  type="button"
                  onClick={() => setMoveError(null)}
                  className="rounded px-1.5 py-0.5 text-xs hover:bg-red-100 dark:hover:bg-red-900/50"
                >
                  Dismiss
                </button>
              </div>
            )}

            {linkNotice !== null && (
              <div
                role="status"
                className="flex shrink-0 items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-xs font-medium text-blue-800 sm:px-6 dark:border-blue-900/60 dark:bg-blue-950/50 dark:text-blue-200"
              >
                <span>{linkNotice}</span>
                <button
                  type="button"
                  onClick={() => setLinkNotice(null)}
                  className="rounded px-1.5 py-0.5 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/50"
                >
                  Dismiss
                </button>
              </div>
            )}

            {openPanel === "tasks" ? (
              <TasksView header={mainSidebarToggle} />
            ) : openPanel === "attachments" ? (
              <AttachmentsView
                header={mainSidebarToggle}
                offline={isOffline}
                focusAttachment={focusAttachment}
              />
            ) : openFileId !== null ? (
              <DocumentView
                fileId={openFileId}
                sessionKey={sessionKeyFor(openFileId)}
                fallbackName={openFileId === createdFile?.id ? createdFile.name : undefined}
                fallbackPath={revealHint?.id === openFileId ? revealHint.path : undefined}
                initialMode={openFileId === createdFile?.id ? "edit" : settings.defaultMode}
                autoFocusEditor={openFileId === createdFile?.id}
                initialCursor={
                  openFileId === createdFile?.id ? createdFile.initialCursor : undefined
                }
                offline={isOffline}
                offlineMessage={offlineMessage}
                leadingControl={mainSidebarToggle}
                trailingControl={headerControls}
                documentRef={documentRef}
                onDirtyChange={setDirty}
                onFileRenamed={handleFileRenamed}
                onNotFound={handleNotFound}
                onTagClick={(tag) => openPalette(`tag:${tag}`)}
                onRevealInTree={handleRevealInTree}
              />
            ) : (
              <>
                <header
                  data-slot="panel-header"
                  data-offline={isOffline ? "true" : undefined}
                  className={`min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2 transition-colors sm:px-6 ${
                    isOffline
                      ? "flex border-red-200 bg-red-50/90 dark:border-red-900/70 dark:bg-red-950/55"
                      : sidebarCollapsed
                        ? "flex border-neutral-200 dark:border-neutral-800"
                        : "flex border-neutral-200 md:hidden dark:border-neutral-800"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    {mainSidebarToggle}
                    <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      {rootTitle}
                    </span>
                    {offlineMessage && (
                      <span
                        title={offlineMessage}
                        className="min-w-0 truncate text-xs font-medium text-red-700 dark:text-red-300"
                        role="status"
                      >
                        {offlineMessage}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">{headerControls}</div>
                </header>
                <EmptyWorkspace
                  rootFolder={rootQuery.data}
                  creating={createNoteMutation.isPending}
                  onCreate={handleCreateInFolder}
                  onOpenFile={handleOpenFile}
                />
              </>
            )}
          </main>

          <CommandPalette
            open={paletteOpen}
            initialQuery={paletteInitialQuery}
            offline={isOffline}
            openFileId={openFileId}
            openFileName={openFileName}
            rootFolder={rootQuery.data}
            sidebarCollapsed={sidebarCollapsed}
            theme={theme}
            getCurrentText={() => documentRef.current?.getText() ?? ""}
            onClose={() => {
              setPaletteOpen(false);
              setPaletteInitialQuery("");
            }}
            onOpenFile={handleOpenFile}
            onCreateNote={handleCreateInFolder}
            onCreateFolder={(folder) => setFolderDialog({ mode: "create", parent: folder })}
            onCreateNamedNote={handleCreateNamedNote}
            onNewFromTemplate={() => setNewFromTemplateOpen(true)}
            onOpenTodayNote={() => void handleOpenTodayNote()}
            onOpenTasks={() => setOpenPanel("tasks")}
            onOpenAttachments={handleOpenAttachments}
            onOpenSettings={() => setSettingsOpen(true)}
            onRenameCurrent={() => documentRef.current?.startRename()}
            onDeleteCurrent={() => {
              if (openFileNode) {
                setDeleteTarget(openFileNode);
              } else if (openFileId !== null) {
                setDeleteTarget({
                  id: openFileId,
                  name: openFileName ?? "Untitled.md",
                  kind: "markdown",
                  modifiedTime: "",
                });
              }
            }}
            onMoveCurrent={() => {
              if (openFileNode) {
                setMoveTarget(openFileNode);
              }
            }}
            vaultPinned={vaultState.pinned}
            onPinVaultChange={vaultSync ? (pinned) => vaultSync.setPinned(pinned) : undefined}
            onSyncVault={vaultSync ? () => void vaultSync.run() : undefined}
            onToggleSidebar={handleToggleSidebar}
            onThemeChange={onThemeChange}
            onSignOut={() => signOutMutation.mutate()}
            onJumpToHeading={(heading) => documentRef.current?.jumpToHeading(heading)}
            onVersionHistory={() => documentRef.current?.openVersionHistory()}
          />

          <DeleteFileDialog
            file={deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onDeleted={handleDeleted}
          />

          <FolderNameDialog
            state={folderDialog}
            onClose={() => setFolderDialog(null)}
            onCreated={handleFolderCreated}
            onRenamed={handleFolderRenamed}
          />

          <MoveDialog
            node={moveTarget}
            rootId={rootQuery.data?.id}
            onClose={() => setMoveTarget(null)}
          />

          <NewFromTemplateDialog
            open={newFromTemplateOpen}
            rootFolder={rootQuery.data}
            defaultFolderId={
              openFileId !== null
                ? (knownParentId(queryClient, openFileId) ?? rootQuery.data?.id)
                : rootQuery.data?.id
            }
            onClose={() => setNewFromTemplateOpen(false)}
            onCreate={handleCreateFromTemplate}
          />

          <DeleteFolderDialog
            folder={deleteFolderTarget}
            onClose={() => setDeleteFolderTarget(null)}
            onDeleted={handleFolderDeleted}
          />

          <SettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            vaultName={rootQuery.data?.name}
            onChangeVault={() => {
              setSettingsOpen(false);
              setVaultPickerOpen(true);
            }}
            theme={theme}
            onThemeChange={onThemeChange}
            cloudSync={session.cloudSync}
            vaultPinned={vaultState.pinned}
            onPinVaultChange={vaultSync ? (pinned) => vaultSync.setPinned(pinned) : undefined}
            pendingSyncCount={pendingSyncCount}
            onClearCache={() => resetVault()}
          />

          <VaultPickerDialog
            open={vaultPickerOpen}
            currentRootId={rootQuery.data?.id}
            onClose={() => setVaultPickerOpen(false)}
            onPicked={handleVaultPicked}
          />
        </div>
      </PkmContext.Provider>
    );
  }

  if (error && !isUnauthenticated(error)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
        <section
          aria-label="Session"
          className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            Markyard
          </h1>
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            Unable to reach the server.
          </p>
          <button
            className="mt-4 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            type="button"
            onClick={() => onRetry(refetch)}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
        Loading…
      </p>
    </main>
  );
}

export function App() {
  const { preference: theme, setPreference: setTheme } = useTheme();
  const [networkOffline, setNetworkOffline] = useState(false);
  const [queryClient] = useState(() => {
    const client: QueryClient = new QueryClient({
      // A 401 on any other query or mutation means the session is gone: ask the session query again.
      queryCache: new QueryCache({
        onSuccess: () => {
          setNetworkOffline(false);
        },
        onError: (error, query) => {
          if (error instanceof TypeError) {
            setNetworkOffline(true);
          }
          if (isUnauthenticated(error) && query.queryKey[0] !== "session") {
            void client.invalidateQueries({ queryKey: ["session"] });
          }
        },
      }),
      mutationCache: new MutationCache({
        onError: (error) => {
          if (isUnauthenticated(error)) {
            void client.invalidateQueries({ queryKey: ["session"] });
          }
        },
      }),
      defaultOptions: {
        queries: {
          // Only a rate limit is worth retrying, after the delay the BFF asks for. The query stays
          // pending meanwhile, so no error shows.
          retry: (failureCount, error) => isRateLimited(error) && failureCount < 3,
          retryDelay: (_failureCount, error) =>
            (error instanceof ApiError && error.retryAfter !== undefined ? error.retryAfter : 1) *
            1000,
        },
        mutations: {
          // Local-first mutations queue into IndexedDB via OpsQueue instead of pausing offline.
          networkMode: "always",
        },
      },
    });
    return client;
  });

  const onOpDiscardedRef = useRef<((op: PendingOp) => void) | null>(null);

  const [syncQueue] = useState(
    () =>
      new SyncQueue(queryClient, {
        onNetworkError: () => setNetworkOffline(true),
        onNetworkSuccess: () => setNetworkOffline(false),
      }),
  );

  useEffect(() => () => syncQueue.dispose(), [syncQueue]);

  const [opsQueue] = useState(
    () =>
      new OpsQueue(queryClient, syncQueue, {
        onNetworkError: () => setNetworkOffline(true),
        onNetworkSuccess: () => setNetworkOffline(false),
        onOpDiscarded: (op) => onOpDiscardedRef.current?.(op),
      }),
  );

  useEffect(() => () => opsQueue.dispose(), [opsQueue]);

  const [driveChanges] = useState(() => new DriveChanges(queryClient));
  useEffect(() => driveChanges.connect(), [driveChanges]);

  const [vaultSync] = useState(() => new VaultSync(queryClient));
  // Stop (not dispose) on unmount: Strict Mode remounts effects and the instance must keep working.
  useEffect(() => () => vaultSync.stop(), [vaultSync]);

  useEffect(() => {
    syncQueue.setOnLocalFileFlush(() => void opsQueue.flushAll());
    vaultSync.setOpsHooks({
      overlayListing: opsQueue.overlayListing,
      overlayVaultIndex: opsQueue.overlayVaultIndex,
      isPendingDeleted: opsQueue.isPendingDeleted,
    });
    return () => {
      syncQueue.setOnLocalFileFlush(undefined);
      vaultSync.setOpsHooks(undefined);
    };
  }, [opsQueue, syncQueue, vaultSync]);

  useEffect(() => {
    const handleOnline = () => setNetworkOffline(false);
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SyncQueueContext value={syncQueue}>
        <OpsQueueContext value={opsQueue}>
          <DriveChangesContext value={driveChanges}>
            <VaultSyncContext value={vaultSync}>
              <SessionGate
                networkOffline={networkOffline}
                theme={theme}
                onThemeChange={setTheme}
                onOpDiscardedRef={onOpDiscardedRef}
              />
            </VaultSyncContext>
          </DriveChangesContext>
        </OpsQueueContext>
      </SyncQueueContext>
    </QueryClientProvider>
  );
}
