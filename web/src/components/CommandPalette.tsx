import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent } from "@ui-sdk/react/dialog";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { modShortcut } from "../platform";
import {
  fetchAttachments,
  fetchChildren,
  searchDriveNotes,
  type AttachmentItem,
  type DriveNode,
  type SearchHit,
} from "../api";
import { attachmentThumbUrl } from "../attachmentRefs";
import { matchAttachmentTags } from "../attachmentTags";
import { attachmentsQueryKey, AttachmentThumb } from "./AttachmentDialogs";
import { ATTACHMENT_TAGS_MUTATION_KEY } from "./AttachmentTags";
import {
  extractHeadings,
  findContentSnippet,
  fuzzyMatch,
  getRecentFileIds,
  matchFrontmatterTags,
  todayNoteName,
  type ContentSnippet,
  type HeadingItem,
} from "../commandSearch";
import { extractFrontmatterTags } from "../frontmatter";
import { normalizeFileName } from "../fileName";
import {
  readAllCachedFiles,
  readAllPendingWrites,
  writeCachedFolder,
  type CachedFile,
} from "../localCache";
import { isLocalId } from "../localIds";
import { useOptionalOpsQueue } from "../opsQueue";
import { copyAsRichText } from "../richCopy";
import { useSettings } from "../settings";
import { toggleViewPref, useViewPrefs } from "../viewPrefs";
import type { ThemePreference } from "../theme";
import {
  childrenKey,
  collectIndexedTree,
  findNoteByNameInFolder,
  findParent,
  type IndexedFolder,
} from "../treeCache";
import {
  CalendarIcon,
  CheckSquareIcon,
  ClockIcon,
  CloudIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  FocusIcon,
  FolderInputIcon,
  FolderPlusIcon,
  HashIcon,
  HistoryIcon,
  ImageIcon,
  SettingsIcon,
  LockIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  TrashIcon,
  TypewriterIcon,
} from "./icons";

export interface FolderTarget {
  id: string;
  name: string;
}

interface PaletteItem {
  id: string;
  section: string;
  label: string;
  subtitle?: string;
  badge?: string;
  icon: ReactNode;
  matchIndices?: number[];
  snippet?: ContentSnippet;
  onSelect: () => void;
}

const DRIVE_SEARCH_DEBOUNCE_MS = 220;
const MAX_WARM_FOLDERS = 12;
const ATTACHMENTS_WARM_STALE_MS = 30_000;
const EMPTY_ATTACHMENTS: readonly AttachmentItem[] = [];

function isHiddenAttachmentsFolder(folder: IndexedFolder, attachmentsFolder: string): boolean {
  return (
    attachmentsFolder.length > 0 &&
    ((folder.path.length === 0 && folder.node.name === attachmentsFolder) ||
      folder.path[0] === attachmentsFolder)
  );
}

function HighlightedText({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices || indices.length === 0) {
    return <>{text}</>;
  }
  const hitSet = new Set(indices);
  const parts: ReactNode[] = [];
  let buffer = "";
  let inHit = false;

  const flush = (key: number) => {
    if (buffer.length === 0) {
      return;
    }
    if (inHit) {
      parts.push(
        <mark
          key={key}
          className="rounded-xs bg-blue-100 px-0 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
        >
          {buffer}
        </mark>,
      );
    } else {
      parts.push(<span key={key}>{buffer}</span>);
    }
    buffer = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const isHit = hitSet.has(i);
    if (isHit !== inHit) {
      flush(i);
      inHit = isHit;
    }
    buffer += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

function SnippetLine({ snippet }: { snippet: ContentSnippet }) {
  return (
    <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
      {snippet.before}
      <mark className="rounded-xs bg-amber-100 px-0.5 text-neutral-900 dark:bg-amber-900/60 dark:text-amber-100">
        {snippet.match}
      </mark>
      {snippet.after}
    </span>
  );
}

export function CommandPalette({
  open,
  initialQuery = "",
  offline,
  openFileId,
  openFileName,
  rootFolder,
  sidebarCollapsed,
  theme,
  getCurrentText,
  onClose,
  onOpenFile,
  onCreateNote,
  onCreateFolder,
  onCreateNamedNote,
  onOpenTodayNote,
  onOpenTasks,
  onOpenAttachments,
  onOpenSettings,
  onRenameCurrent,
  onDeleteCurrent,
  onMoveCurrent,
  onVersionHistory,
  vaultPinned,
  onPinVaultChange,
  onSyncVault,
  onToggleSidebar,
  onThemeChange,
  onSignOut,
  onJumpToHeading,
}: {
  open: boolean;
  /** Optional pre-filled query when opened from an explicit action (e.g. clicking a tag pill). */
  initialQuery?: string;
  offline: boolean;
  openFileId: string | null;
  openFileName?: string;
  rootFolder?: DriveNode;
  sidebarCollapsed: boolean;
  theme: ThemePreference;
  getCurrentText: () => string;
  onClose: () => void;
  /** `path`: a Drive search hit's folder names below the root, for revealing it in the tree. */
  onOpenFile: (id: string, path?: readonly string[]) => void;
  onCreateNote: (folder: FolderTarget) => void;
  onCreateFolder?: (folder: FolderTarget) => void;
  onCreateNamedNote: (folder: FolderTarget, name: string) => void;
  onOpenTodayNote: () => void;
  /** Opens the vault-wide Tasks dashboard. */
  onOpenTasks?: () => void;
  /** Opens the vault-wide Attachments manager, optionally selecting `attachmentId`. */
  onOpenAttachments?: (attachmentId?: string) => void;
  /** Opens the Settings dialog. */
  onOpenSettings?: () => void;
  onRenameCurrent: () => void;
  onDeleteCurrent: () => void;
  /** Opens the "Move to…" picker for the open note. */
  onMoveCurrent?: () => void;
  /** Opens Drive's version history for the open note. */
  onVersionHistory?: () => void;
  vaultPinned?: boolean;
  onPinVaultChange?: (pinned: boolean) => void;
  onSyncVault?: () => void;
  onToggleSidebar: () => void;
  onThemeChange: (theme: ThemePreference) => void;
  onSignOut: () => void;
  onJumpToHeading: (heading: HeadingItem) => void;
}) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  const { attachmentsFolder, showAttachmentsFolder } = useSettings();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsLabelId = useId();
  const [query, setQuery] = useState("");
  const [cachedFiles, setCachedFiles] = useState<CachedFile[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [driveHits, setDriveHits] = useState<SearchHit[]>([]);
  const [searchingDrive, setSearchingDrive] = useState(false);

  const attachmentsQuery = useQuery({
    queryKey: attachmentsQueryKey(attachmentsFolder),
    queryFn: ({ signal }) => fetchAttachments(signal, attachmentsFolder),
    enabled: false,
  });
  const attachments = attachmentsQuery.data?.attachments ?? EMPTY_ATTACHMENTS;

  const hasOpenAttachments = Boolean(onOpenAttachments);

  // Opportunistically warm the attachments list without triggering the global offline detector.
  useEffect(() => {
    if (!open || offline || !hasOpenAttachments) {
      return;
    }
    const key = attachmentsQueryKey(attachmentsFolder);
    const state = queryClient.getQueryState(key);
    const isFresh =
      state?.data !== undefined && Date.now() - state.dataUpdatedAt < ATTACHMENTS_WARM_STALE_MS;
    if (isFresh) {
      return;
    }
    const controller = new AbortController();
    void fetchAttachments(controller.signal, attachmentsFolder)
      .then((data) => {
        if (
          !controller.signal.aborted &&
          queryClient.isMutating({ mutationKey: ATTACHMENT_TAGS_MUTATION_KEY }) === 0
        ) {
          queryClient.setQueryData(key, data);
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [open, offline, hasOpenAttachments, attachmentsFolder, queryClient]);

  // Reset state and focus the input in the same commit that opens the palette. A trigger that
  // opens it with flushSync keeps focus() inside the user gesture, so iOS raises the keyboard.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    setQuery(initialQuery);
    setDriveHits([]);
    setSearchingDrive(false);
    setRecentIds(getRecentFileIds());
    setTreeVersion((v) => v + 1);
    inputRef.current?.focus();
  }, [open, initialQuery]);

  // Load the local full-text cache whenever opened.
  useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;
    void Promise.all([readAllCachedFiles(), readAllPendingWrites()]).then(([files, pending]) => {
      if (!active) {
        return;
      }
      const merged = new Map<string, CachedFile>();
      for (const f of files) {
        merged.set(f.fileId, f);
      }
      for (const p of pending) {
        merged.set(p.fileId, {
          fileId: p.fileId,
          text: p.text,
          revision: p.baseRevision,
          updatedAt: p.updatedAt,
        });
      }
      setCachedFiles(Array.from(merged.values()));
    });

    return () => {
      active = false;
    };
  }, [open, initialQuery]);

  // Opportunistically warm unexpanded folders in cache so nested notes show up in local search.
  useEffect(() => {
    if (!open || offline) {
      return;
    }
    let active = true;
    const warmController = new AbortController();
    const { folders } = collectIndexedTree(queryClient);
    const unloaded = folders
      .filter(
        (f) =>
          !isLocalId(f.node.id) &&
          (showAttachmentsFolder || !isHiddenAttachmentsFolder(f, attachmentsFolder)) &&
          queryClient.getQueryData(childrenKey(f.node.id)) === undefined,
      )
      .slice(0, MAX_WARM_FOLDERS);
    if (unloaded.length > 0) {
      void Promise.allSettled(
        unloaded.map(async (f) => {
          const raw = await fetchChildren(f.node.id, warmController.signal);
          const nodes = opsQueue !== null ? opsQueue.overlayListing(f.node.id, raw) : raw;
          queryClient.setQueryData(childrenKey(f.node.id), nodes);
          void writeCachedFolder(f.node.id, nodes);
        }),
      ).then(() => {
        if (active) {
          setTreeVersion((v) => v + 1);
        }
      });
    }

    return () => {
      active = false;
      warmController.abort();
    };
  }, [open, offline, queryClient, opsQueue, attachmentsFolder, showAttachmentsFolder]);

  const trimmed = query.trim();
  const isCommandMode = trimmed.startsWith(">");
  const isHeadingMode = trimmed.startsWith("#");
  const isTagMode = /^tag:/i.test(trimmed);
  const effectiveQuery = isTagMode
    ? trimmed.slice(4).trim().replace(/^#+/, "")
    : isCommandMode || isHeadingMode
      ? trimmed.slice(1).trim()
      : trimmed;

  // Debounced Google Drive search for notes not yet cached locally.
  useEffect(() => {
    if (!open || offline || isCommandMode || isHeadingMode || isTagMode || trimmed.length < 2) {
      setDriveHits([]);
      setSearchingDrive(false);
      return;
    }

    const controller = new AbortController();
    setSearchingDrive(true);
    const timer = window.setTimeout(() => {
      void searchDriveNotes(trimmed, controller.signal)
        .then((hits) => {
          if (!controller.signal.aborted) {
            setDriveHits(hits);
            setSearchingDrive(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchingDrive(false);
          }
        });
    }, DRIVE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, offline, isCommandMode, isHeadingMode, isTagMode, trimmed]);

  const defaultTargetFolder = useMemo<FolderTarget | null>(() => {
    if (openFileId !== null) {
      const parent = findParent(queryClient, openFileId);
      if (parent) {
        return { id: parent.id, name: parent.name };
      }
    }
    return rootFolder ? { id: rootFolder.id, name: rootFolder.name } : null;
  }, [queryClient, openFileId, rootFolder, treeVersion]);

  const prefs = useViewPrefs();

  const runAndClose = useCallback(
    (action: () => void) => {
      onClose();
      action();
    },
    [onClose],
  );

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) {
      return [];
    }
    void treeVersion;
    const { notes, folders: allFolders } = collectIndexedTree(queryClient);
    const folders = showAttachmentsFolder
      ? allFolders
      : allFolders.filter((f) => !isHiddenAttachmentsFolder(f, attachmentsFolder));
    const notesById = new Map(notes.map((n) => [n.node.id, n]));
    const todayName = todayNoteName();

    // Build all available commands.
    interface CommandDef {
      id: string;
      label: string;
      keywords: string;
      subtitle?: string;
      badge?: string;
      icon: ReactNode;
      quick?: boolean;
      onSelect: () => void;
    }

    const allCommands: CommandDef[] = [];

    if (defaultTargetFolder) {
      allCommands.push({
        id: "cmd:new-note",
        label: "New note",
        keywords: "create add file markdown untitled",
        subtitle: `In ${defaultTargetFolder.name}`,
        icon: <PlusIcon className="size-4" />,
        quick: true,
        onSelect: () => runAndClose(() => onCreateNote(defaultTargetFolder)),
      });
      if (onCreateFolder) {
        allCommands.push({
          id: "cmd:new-folder",
          label: "New folder",
          keywords: "create add directory subfolder",
          subtitle: `In ${defaultTargetFolder.name}`,
          icon: <FolderPlusIcon className="size-4" />,
          onSelect: () => runAndClose(() => onCreateFolder(defaultTargetFolder)),
        });
      }
    }

    if (rootFolder) {
      allCommands.push({
        id: "cmd:daily-note",
        label: "Today's note",
        keywords: `daily journal date ${todayName}`,
        subtitle: todayName,
        badge: "Daily",
        icon: <CalendarIcon className="size-4" />,
        quick: true,
        onSelect: () => runAndClose(onOpenTodayNote),
      });
    }

    if (onOpenTasks) {
      allCommands.push({
        id: "cmd:open-tasks",
        label: "Open Tasks",
        keywords: "todo checklist dashboard checkbox due tags",
        icon: <CheckSquareIcon className="size-4" />,
        onSelect: () => runAndClose(onOpenTasks),
      });
    }

    if (onOpenAttachments) {
      allCommands.push({
        id: "cmd:open-attachments",
        label: "Open Attachments",
        keywords: "images pictures files uploads media unused delete trash",
        icon: <ImageIcon className="size-4" />,
        onSelect: () => runAndClose(() => onOpenAttachments()),
      });
    }

    if (onOpenSettings) {
      allCommands.push({
        id: "cmd:open-settings",
        label: "Open Settings",
        keywords: "settings preferences vault folders daily templates attachments",
        icon: <SettingsIcon className="size-4" />,
        onSelect: () => runAndClose(onOpenSettings),
      });
    }

    if (openFileId !== null) {
      allCommands.push({
        id: "cmd:headings",
        label: "Jump to heading…",
        keywords: "outline sections toc # headings",
        subtitle: openFileName ?? "Current note",
        badge: "#",
        icon: <HashIcon className="size-4" />,
        quick: true,
        onSelect: () => {
          setQuery("#");
          inputRef.current?.focus();
        },
      });
      allCommands.push({
        id: "cmd:rename",
        label: "Rename current note",
        keywords: "title edit name file",
        subtitle: openFileName,
        icon: <EditIcon className="size-4" />,
        quick: true,
        onSelect: () => {
          onClose();
          window.setTimeout(onRenameCurrent, 0);
        },
      });
      if (onMoveCurrent) {
        allCommands.push({
          id: "cmd:move",
          label: "Move current note to…",
          keywords: "relocate folder transfer reparent",
          subtitle: openFileName,
          icon: <FolderInputIcon className="size-4" />,
          onSelect: () => {
            onClose();
            window.setTimeout(onMoveCurrent, 0);
          },
        });
      }
      if (onVersionHistory) {
        allCommands.push({
          id: "cmd:version-history",
          label: "Version history",
          keywords: "revisions restore previous older drive diff compare undo",
          subtitle: offline ? "Needs a connection" : openFileName,
          icon: <HistoryIcon className="size-4" />,
          onSelect: () => {
            onClose();
            window.setTimeout(onVersionHistory, 0);
          },
        });
      }
      allCommands.push({
        id: "cmd:copy-rich-text",
        label: "Copy as Rich Text",
        keywords: "clipboard html export share paste formatted",
        subtitle: openFileName,
        icon: <CopyIcon className="size-4" />,
        onSelect: () =>
          runAndClose(() => void copyAsRichText(getCurrentText()).catch(() => undefined)),
      });
      allCommands.push({
        id: "cmd:delete",
        label: "Delete current note",
        keywords: "trash remove erase",
        subtitle: openFileName,
        icon: <TrashIcon className="size-4 text-red-500 dark:text-red-400" />,
        onSelect: () => runAndClose(onDeleteCurrent),
      });
      allCommands.push(
        {
          id: "cmd:toggle-info-drawer",
          label: "Toggle Info Drawer",
          keywords: "outline stats words properties frontmatter details panel",
          badge: modShortcut("⇧I"),
          icon: <PanelRightIcon className="size-4" />,
          onSelect: () => runAndClose(() => toggleViewPref("infoDrawerOpen")),
        },
        {
          id: "cmd:toggle-read-only",
          label: "Toggle Read-Only Mode",
          keywords: "lock view protect preview",
          badge: prefs.readOnly ? "On" : undefined,
          icon: <LockIcon className="size-4" />,
          onSelect: () => runAndClose(() => toggleViewPref("readOnly")),
        },
        {
          id: "cmd:toggle-focus-mode",
          label: "Toggle Focus Mode",
          keywords: "dim paragraph writing distraction zen",
          badge: prefs.focusMode ? "On" : undefined,
          icon: <FocusIcon className="size-4" />,
          onSelect: () => runAndClose(() => toggleViewPref("focusMode")),
        },
        {
          id: "cmd:toggle-typewriter-mode",
          label: "Toggle Typewriter Mode",
          keywords: "center cursor line scroll writing",
          badge: prefs.typewriterMode ? "On" : undefined,
          icon: <TypewriterIcon className="size-4" />,
          onSelect: () => runAndClose(() => toggleViewPref("typewriterMode")),
        },
      );
    }

    if (onPinVaultChange) {
      allCommands.push({
        id: "cmd:pin-vault",
        label: vaultPinned ? "Unpin vault offline" : "Pin vault offline",
        keywords: "offline download cache all notes sync vault",
        badge: vaultPinned ? "On" : undefined,
        icon: <CloudIcon className="size-4" />,
        onSelect: () => runAndClose(() => onPinVaultChange(!vaultPinned)),
      });
    }
    if (onSyncVault) {
      allCommands.push({
        id: "cmd:sync-vault",
        label: "Sync vault now",
        keywords: "offline download cache all notes refresh",
        icon: <CloudIcon className="size-4" />,
        onSelect: () => runAndClose(onSyncVault),
      });
    }

    allCommands.push({
      id: "cmd:toggle-sidebar",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      keywords: "toggle sidebar panel navigation zen",
      badge: modShortcut("\\"),
      icon: <PanelLeftIcon className="size-4" />,
      quick: true,
      onSelect: () => runAndClose(onToggleSidebar),
    });

    allCommands.push(
      {
        id: "cmd:theme-light",
        label: "Theme: Light",
        keywords: "appearance color light mode",
        badge: theme === "light" ? "Active" : undefined,
        icon: <SunIcon className="size-4" />,
        onSelect: () => runAndClose(() => onThemeChange("light")),
      },
      {
        id: "cmd:theme-dark",
        label: "Theme: Dark",
        keywords: "appearance color dark mode night",
        badge: theme === "dark" ? "Active" : undefined,
        icon: <MoonIcon className="size-4" />,
        onSelect: () => runAndClose(() => onThemeChange("dark")),
      },
      {
        id: "cmd:theme-system",
        label: "Theme: System",
        keywords: "appearance color auto system",
        badge: theme === "system" ? "Active" : undefined,
        icon: <MonitorIcon className="size-4" />,
        onSelect: () => runAndClose(() => onThemeChange("system")),
      },
      {
        id: "cmd:sign-out",
        label: "Sign out",
        keywords: "logout account disconnect",
        icon: <LogOutIcon className="size-4" />,
        onSelect: () => runAndClose(onSignOut),
      },
    );

    // 1. Heading jump mode (`#...`).
    if (isHeadingMode) {
      if (openFileId === null) {
        return [];
      }
      const headings = extractHeadings(getCurrentText());
      const out: PaletteItem[] = [];
      for (const h of headings) {
        const match = effectiveQuery
          ? fuzzyMatch(effectiveQuery, h.text)
          : { score: 0, indices: [] };
        if (match === null) {
          continue;
        }
        out.push({
          id: `heading:${h.index}`,
          section: openFileName ? `Headings in ${openFileName}` : "Headings",
          label: h.text,
          badge: `H${h.level}`,
          icon: <HashIcon className="size-4" />,
          matchIndices: match.indices,
          onSelect: () => {
            onClose();
            window.setTimeout(() => onJumpToHeading(h), 0);
          },
        });
      }
      return out;
    }

    // 1b. Frontmatter & attachment tag filter mode (`tag:...`).
    if (isTagMode) {
      const contentSources = new Map<string, string>();
      for (const f of cachedFiles) {
        contentSources.set(f.fileId, f.text);
      }
      if (openFileId !== null) {
        contentSources.set(openFileId, getCurrentText());
      }

      if (effectiveQuery.length === 0) {
        const tagCounts = new Map<string, { label: string; notes: number; images: number }>();
        for (const [fileId, text] of contentSources) {
          if (!notesById.has(fileId)) {
            continue;
          }
          for (const tag of extractFrontmatterTags(text)) {
            const key = tag.toLowerCase();
            const existing = tagCounts.get(key);
            if (existing) {
              existing.notes += 1;
            } else {
              tagCounts.set(key, { label: tag, notes: 1, images: 0 });
            }
          }
        }
        if (onOpenAttachments) {
          for (const attachment of attachments) {
            for (const tag of attachment.tags ?? []) {
              const key = tag.toLowerCase();
              const existing = tagCounts.get(key);
              if (existing) {
                existing.images += 1;
              } else {
                tagCounts.set(key, { label: tag, notes: 0, images: 1 });
              }
            }
          }
        }
        return Array.from(tagCounts.values())
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "accent" }))
          .map(({ label, notes: noteCount, images: imageCount }) => {
            const parts: string[] = [];
            if (noteCount > 0) {
              parts.push(`${noteCount} ${noteCount === 1 ? "note" : "notes"}`);
            }
            if (imageCount > 0) {
              parts.push(`${imageCount} ${imageCount === 1 ? "image" : "images"}`);
            }
            return {
              id: `tag:${label.toLowerCase()}`,
              section: "Tags",
              label: `#${label}`,
              badge: parts.join(" · "),
              icon: <HashIcon className="size-4" />,
              onSelect: () => {
                setQuery(`tag:${label}`);
                inputRef.current?.focus();
              },
            };
          });
      }

      const needle = effectiveQuery.toLowerCase();
      const matched: {
        fileId: string;
        entry: (typeof notes)[number];
        tags: string[];
        rank: number;
      }[] = [];
      for (const [fileId, text] of contentSources) {
        const entry = notesById.get(fileId);
        if (!entry) {
          continue;
        }
        const tags = matchFrontmatterTags(text, effectiveQuery);
        if (tags.length === 0) {
          continue;
        }
        const best = tags[0].toLowerCase();
        const rank = best === needle ? 0 : best.startsWith(needle) ? 1 : 2;
        matched.push({ fileId, entry, tags, rank });
      }
      matched.sort((a, b) => a.rank - b.rank || a.entry.node.name.localeCompare(b.entry.node.name));
      const noteResults: PaletteItem[] = matched.map(({ fileId, entry, tags }) => ({
        id: `tag-note:${fileId}`,
        section: "Tagged notes",
        label: entry.node.name,
        subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
        badge: tags.map((tag) => `#${tag}`).join(" "),
        icon: <FileIcon className="size-4" />,
        onSelect: () => runAndClose(() => onOpenFile(fileId)),
      }));

      const attachmentResults: PaletteItem[] = [];
      if (onOpenAttachments) {
        const matchedAttachments: {
          attachment: (typeof attachments)[number];
          tags: string[];
          rank: number;
        }[] = [];
        for (const attachment of attachments) {
          const tags = matchAttachmentTags(attachment.tags, effectiveQuery);
          if (tags.length === 0) {
            continue;
          }
          const best = tags[0].toLowerCase();
          const rank = best === needle ? 0 : best.startsWith(needle) ? 1 : 2;
          matchedAttachments.push({ attachment, tags, rank });
        }
        matchedAttachments.sort(
          (a, b) => a.rank - b.rank || a.attachment.name.localeCompare(b.attachment.name),
        );
        for (const { attachment, tags } of matchedAttachments) {
          attachmentResults.push({
            id: `tag-attachment:${attachment.id}`,
            section: "Tagged attachments",
            label: attachment.name,
            badge: tags.map((tag) => `#${tag}`).join(" "),
            icon: (
              <AttachmentThumb
                src={attachmentThumbUrl(attachment.id, 64)}
                alt=""
                className="size-5 rounded border border-neutral-200 dark:border-neutral-700"
              />
            ),
            onSelect: () => runAndClose(() => onOpenAttachments(attachment.id)),
          });
        }
      }

      return [...noteResults, ...attachmentResults];
    }

    // 2. Commands-only mode (`>...`).
    if (isCommandMode) {
      const scored = allCommands
        .map((cmd) => {
          if (effectiveQuery.length === 0) {
            return { cmd, score: 0, indices: [] as number[] };
          }
          const labelHit = fuzzyMatch(effectiveQuery, cmd.label);
          const kwHit = fuzzyMatch(effectiveQuery, `${cmd.label} ${cmd.keywords}`);
          if (!labelHit && !kwHit) {
            return null;
          }
          return {
            cmd,
            score: labelHit ? labelHit.score + 50 : kwHit!.score,
            indices: labelHit?.indices ?? [],
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.score - a.score);

      const folderCmds = folders
        .map((f) => {
          const label = `New note in ${f.node.name}`;
          const hit = effectiveQuery
            ? fuzzyMatch(effectiveQuery, `${label} ${f.path.join("/")}`)
            : null;
          if (effectiveQuery && !hit) {
            return null;
          }
          return {
            id: `cmd:new-in:${f.node.id}`,
            section: "Folders",
            label,
            subtitle: f.path.length > 0 ? f.path.join(" / ") : undefined,
            icon: <FolderIcon className="size-4" />,
            matchIndices: hit?.indices,
            onSelect: () => runAndClose(() => onCreateNote({ id: f.node.id, name: f.node.name })),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 6);

      return [
        ...scored.map(({ cmd, indices }) => ({
          id: cmd.id,
          section: "Commands",
          label: cmd.label,
          subtitle: cmd.subtitle,
          badge: cmd.badge,
          icon: cmd.icon,
          matchIndices: indices,
          onSelect: cmd.onSelect,
        })),
        ...folderCmds,
      ];
    }

    // 3. Empty query: Recents + Quick actions.
    if (trimmed.length === 0) {
      const recentItems: PaletteItem[] = [];
      for (const id of recentIds) {
        const entry = notesById.get(id);
        if (!entry) {
          continue;
        }
        recentItems.push({
          id: `recent:${entry.node.id}`,
          section: "Recent",
          label: entry.node.name,
          subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
          badge: entry.node.id === openFileId ? "Open" : undefined,
          icon: <ClockIcon className="size-4" />,
          onSelect: () => runAndClose(() => onOpenFile(entry.node.id)),
        });
        if (recentItems.length >= 6) {
          break;
        }
      }

      // If user has no recents yet, show up to 5 notes from the tree so the palette feels immediately useful.
      const fallbackNotes: PaletteItem[] =
        recentItems.length === 0
          ? notes.slice(0, 5).map((entry) => ({
              id: `note:${entry.node.id}`,
              section: "Notes",
              label: entry.node.name,
              subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
              badge: entry.node.id === openFileId ? "Open" : undefined,
              icon: <FileIcon className="size-4" />,
              onSelect: () => runAndClose(() => onOpenFile(entry.node.id)),
            }))
          : [];

      const quickCmds: PaletteItem[] = allCommands
        .filter((c) => c.quick)
        .map((c) => ({
          id: c.id,
          section: "Quick actions",
          label: c.label,
          subtitle: c.subtitle,
          badge: c.badge,
          icon: c.icon,
          onSelect: c.onSelect,
        }));

      return [...recentItems, ...fallbackNotes, ...quickCmds];
    }

    // 4. Unified search query: Notes (fuzzy name/path) + Content (local + Drive) + Folders + Commands + Create-on-the-fly.
    const result: PaletteItem[] = [];
    const shownNoteIds = new Set<string>();

    // 4a. Local fuzzy filename + path matches.
    const nameScored = notes
      .map((entry) => {
        const nameHit = fuzzyMatch(trimmed, entry.node.name);
        const fullPath =
          entry.path.length > 0 ? `${entry.path.join("/")}/${entry.node.name}` : entry.node.name;
        const pathHit = fuzzyMatch(trimmed, fullPath);
        if (!nameHit && !pathHit) {
          return null;
        }
        const recentBoost = recentIds.includes(entry.node.id) ? 15 : 0;
        const score = (nameHit ? nameHit.score + 60 : pathHit!.score) + recentBoost;
        return { entry, score, indices: nameHit?.indices ?? [] };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    for (const { entry, indices } of nameScored) {
      shownNoteIds.add(entry.node.id);
      result.push({
        id: `note:${entry.node.id}`,
        section: "Notes",
        label: entry.node.name,
        subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
        badge: entry.node.id === openFileId ? "Open" : undefined,
        icon: <FileIcon className="size-4" />,
        matchIndices: indices,
        onSelect: () => runAndClose(() => onOpenFile(entry.node.id)),
      });
    }

    // 4b. Drive filename matches not already in local cache.
    for (const hit of driveHits) {
      if (shownNoteIds.has(hit.node.id)) {
        continue;
      }
      const nameHit = fuzzyMatch(trimmed, hit.node.name);
      if (nameHit) {
        shownNoteIds.add(hit.node.id);
        result.push({
          id: `drive-name:${hit.node.id}`,
          section: "Notes",
          label: hit.node.name,
          subtitle: hit.path.length > 0 ? hit.path.join(" / ") : undefined,
          badge: "Drive",
          icon: <FileIcon className="size-4" />,
          matchIndices: nameHit.indices,
          onSelect: () => runAndClose(() => onOpenFile(hit.node.id, hit.path)),
        });
      }
    }

    // 4c. Local full-text content matches (IndexedDB + live active draft).
    if (trimmed.length >= 2) {
      const contentSources = new Map<string, string>();
      for (const f of cachedFiles) {
        contentSources.set(f.fileId, f.text);
      }
      if (openFileId !== null) {
        contentSources.set(openFileId, getCurrentText());
      }

      const contentItems: PaletteItem[] = [];
      for (const [fileId, text] of contentSources) {
        if (shownNoteIds.has(fileId)) {
          continue;
        }
        const entry = notesById.get(fileId);
        if (!entry) {
          continue;
        }
        const snippet = findContentSnippet(text, trimmed);
        if (snippet) {
          shownNoteIds.add(fileId);
          contentItems.push({
            id: `content:${fileId}`,
            section: "In note content",
            label: entry.node.name,
            subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
            badge: `L${snippet.line}`,
            icon: <SearchIcon className="size-4" />,
            snippet,
            onSelect: () => runAndClose(() => onOpenFile(fileId)),
          });
        } else {
          const matchedTags = matchFrontmatterTags(text, trimmed);
          if (matchedTags.length === 0) {
            continue;
          }
          shownNoteIds.add(fileId);
          contentItems.push({
            id: `content-tag:${fileId}`,
            section: "In note content",
            label: entry.node.name,
            subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
            badge: "Tag",
            icon: <HashIcon className="size-4" />,
            snippet: {
              before: "Tag ",
              match: `#${matchedTags[0]}`,
              after: matchedTags.length > 1 ? ` (+${matchedTags.length - 1})` : "",
              line: 1,
            },
            onSelect: () => runAndClose(() => onOpenFile(fileId)),
          });
        }
        if (contentItems.length >= 8) {
          break;
        }
      }

      // Append Drive full-text matches not already surfaced locally.
      for (const hit of driveHits) {
        if (shownNoteIds.has(hit.node.id)) {
          continue;
        }
        shownNoteIds.add(hit.node.id);
        contentItems.push({
          id: `drive-content:${hit.node.id}`,
          section: "In note content",
          label: hit.node.name,
          subtitle: hit.path.length > 0 ? hit.path.join(" / ") : "Matched on Google Drive",
          badge: "Drive",
          icon: <SearchIcon className="size-4" />,
          onSelect: () => runAndClose(() => onOpenFile(hit.node.id, hit.path)),
        });
      }

      result.push(...contentItems);
    }

    // 4c2. Matching attachments (filename or direct Drive tags).
    if (onOpenAttachments && attachments.length > 0) {
      const needle = trimmed.replace(/^#+/, "").toLowerCase();
      const attMatches = attachments
        .map((attachment) => {
          const nameHit = fuzzyMatch(trimmed, attachment.name);
          const matchedTags =
            needle.length > 0 ? matchAttachmentTags(attachment.tags, trimmed) : [];
          if (!nameHit && matchedTags.length === 0) {
            return null;
          }
          let score = nameHit ? nameHit.score + 50 : 0;
          if (matchedTags.length > 0) {
            const best = matchedTags[0].toLowerCase();
            const tagBoost = best === needle ? 220 : best.startsWith(needle) ? 170 : 120;
            score = Math.max(score, tagBoost);
          }
          return { attachment, score, indices: nameHit?.indices ?? [], matchedTags };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.score - a.score || a.attachment.name.localeCompare(b.attachment.name))
        .slice(0, 6);

      for (const { attachment, indices, matchedTags } of attMatches) {
        const displayTags =
          matchedTags.length > 0 ? matchedTags : (attachment.tags ?? []).slice(0, 3);
        result.push({
          id: `attachment:${attachment.id}`,
          section: "Attachments",
          label: attachment.name,
          subtitle: displayTags.length > 0 ? displayTags.map((t) => `#${t}`).join(" ") : undefined,
          badge: matchedTags.length > 0 ? "Tag" : "Image",
          icon: (
            <AttachmentThumb
              src={attachmentThumbUrl(attachment.id, 64)}
              alt=""
              className="size-5 rounded border border-neutral-200 dark:border-neutral-700"
            />
          ),
          matchIndices: indices,
          onSelect: () => runAndClose(() => onOpenAttachments(attachment.id)),
        });
      }
    }

    // 4d. Matching folders (quick create note in folder).
    const folderMatches = folders
      .map((f) => {
        const hit = fuzzyMatch(trimmed, f.node.name);
        return hit ? { f, score: hit.score } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { f } of folderMatches) {
      result.push({
        id: `folder-new:${f.node.id}`,
        section: "Folders",
        label: `New note in ${f.node.name}`,
        subtitle: f.path.length > 0 ? `${f.path.join(" / ")} / ${f.node.name}` : f.node.name,
        icon: <FolderIcon className="size-4" />,
        onSelect: () => runAndClose(() => onCreateNote({ id: f.node.id, name: f.node.name })),
      });
    }

    // 4e. Matching commands.
    const cmdMatches = allCommands
      .map((cmd) => {
        const labelHit = fuzzyMatch(trimmed, cmd.label);
        const kwHit = fuzzyMatch(trimmed, `${cmd.label} ${cmd.keywords}`);
        if (!labelHit && !kwHit) {
          return null;
        }
        return {
          cmd,
          score: labelHit ? labelHit.score + 50 : kwHit!.score,
          indices: labelHit?.indices ?? [],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { cmd, indices } of cmdMatches) {
      result.push({
        id: cmd.id,
        section: "Commands",
        label: cmd.label,
        subtitle: cmd.subtitle,
        badge: cmd.badge,
        icon: cmd.icon,
        matchIndices: indices,
        onSelect: cmd.onSelect,
      });
    }

    // 4f. Create-on-the-fly when query is a valid filename not already present in the target folder.
    if (defaultTargetFolder) {
      const normalized = normalizeFileName(trimmed);
      if (normalized.ok) {
        const alreadyExists = findNoteByNameInFolder(
          queryClient,
          defaultTargetFolder.id,
          normalized.name,
        );
        if (!alreadyExists) {
          result.push({
            id: `create:${normalized.name}`,
            section: "Create",
            label: `Create "${normalized.name}"`,
            subtitle: `In ${defaultTargetFolder.name}`,
            badge: "New",
            icon: <PlusIcon className="size-4" />,
            onSelect: () =>
              runAndClose(() => onCreateNamedNote(defaultTargetFolder, normalized.name)),
          });
        }
      }
    }

    return result;
  }, [
    open,
    treeVersion,
    queryClient,
    attachmentsFolder,
    showAttachmentsFolder,
    defaultTargetFolder,
    rootFolder,
    openFileId,
    openFileName,
    sidebarCollapsed,
    prefs.readOnly,
    prefs.focusMode,
    prefs.typewriterMode,
    theme,
    isHeadingMode,
    isCommandMode,
    isTagMode,
    effectiveQuery,
    trimmed,
    recentIds,
    driveHits,
    cachedFiles,
    attachments,
    offline,
    getCurrentText,
    runAndClose,
    onClose,
    onOpenFile,
    onCreateNote,
    onCreateFolder,
    onCreateNamedNote,
    onOpenTodayNote,
    onOpenTasks,
    onOpenAttachments,
    onOpenSettings,
    onRenameCurrent,
    onDeleteCurrent,
    onMoveCurrent,
    onVersionHistory,
    vaultPinned,
    onPinVaultChange,
    onSyncVault,
    onToggleSidebar,
    onThemeChange,
    onSignOut,
    onJumpToHeading,
  ]);

  if (!open) {
    return null;
  }

  // Group items sequentially by section, keeping the computed order (filtering is app-side).
  const sections: { title: string; items: PaletteItem[] }[] = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.title === item.section) {
      last.items.push(item);
    } else {
      sections.push({ title: item.section, items: [item] });
    }
  }

  const emptyMessage = isHeadingMode
    ? openFileId === null
      ? "Open a note to jump to its headings."
      : "No matching headings in this note."
    : isTagMode
      ? effectiveQuery.length === 0
        ? "No tagged notes in local cache."
        : "No locally cached notes match that tag."
      : isCommandMode
        ? "No matching commands."
        : searchingDrive
          ? "Searching Google Drive…"
          : "No matching notes or commands.";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-50 bg-neutral-950/45 backdrop-blur-[1px]" />
      {/* initialFocus="none": the layout effect above focuses the input inside the opening tap. */}
      <DialogContent
        initialFocus="none"
        aria-label="Command palette"
        className="fixed top-[12vh] left-1/2 z-50 flex w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl outline-none sm:w-[calc(100vw-2rem)] dark:border-neutral-800 dark:bg-neutral-900"
      >
        <Command
          filter={false}
          query={query}
          onQueryChange={(next, details) => {
            // Escape closes the palette in one press, even with a query (ui-sdk would clear it first).
            if (details.reason === "escape-key") {
              onClose();
              return;
            }
            setQuery(next);
          }}
          className="flex min-h-0 flex-col"
        >
          <div className="flex items-center gap-2.5 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
            {isHeadingMode || isTagMode ? (
              <HashIcon className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
            ) : (
              <SearchIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
            )}
            <CommandInput
              ref={inputRef}
              aria-label="Search notes and commands"
              placeholder="Search notes, content, tag:, > commands, # headings…"
              className="min-w-0 flex-1 border-0 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            {searchingDrive && (
              <span
                className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500"
                role="status"
              >
                Searching Drive…
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close command palette"
              className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Esc
            </button>
          </div>

          <CommandEmpty className="text-center text-sm text-neutral-500 data-empty:px-3 data-empty:py-8 dark:text-neutral-400">
            {emptyMessage}
          </CommandEmpty>
          {/* CommandList names itself after the input; keep the list's own name. */}
          <span id={resultsLabelId} hidden>
            Search results
          </span>
          <CommandList
            aria-labelledby={resultsLabelId}
            className="max-h-[55vh] overflow-y-auto p-1.5 empty:p-0"
          >
            {sections.map((section) => (
              <CommandGroup key={section.title} className="mb-1.5 last:mb-0">
                <CommandGroupLabel className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
                  {section.title}
                </CommandGroupLabel>
                {section.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    aria-label={item.subtitle ? `${item.label} — ${item.subtitle}` : item.label}
                    onSelect={() => {
                      item.onSelect();
                    }}
                    className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-neutral-700 transition-colors data-highlighted:bg-neutral-100 data-highlighted:text-neutral-950 dark:text-neutral-200 dark:data-highlighted:bg-neutral-800 dark:data-highlighted:text-neutral-50"
                  >
                    <span className="mt-0.5 shrink-0 text-neutral-400 dark:text-neutral-500">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        <HighlightedText text={item.label} indices={item.matchIndices} />
                      </span>
                      {item.snippet ? (
                        <SnippetLine snippet={item.snippet} />
                      ) : (
                        item.subtitle && (
                          <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                            {item.subtitle}
                          </span>
                        )
                      )}
                    </span>
                    {item.badge && (
                      <span className="mt-0.5 shrink-0 rounded bg-neutral-200/70 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-700/80 dark:text-neutral-300">
                        {item.badge}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>

        <div className="hidden items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/70 px-3.5 py-1.5 text-[11px] text-neutral-500 sm:flex dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-400">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>tag: Tags</span>
            <span>&gt; Commands</span>
            <span># Headings</span>
          </div>
          <span>{modShortcut("K")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
