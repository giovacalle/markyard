import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchChildren, searchDriveNotes, type DriveNode, type SearchHit } from "../api";
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
  /** Opens the vault-wide Attachments manager. */
  onOpenAttachments?: () => void;
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
  const { attachmentsFolder } = useSettings();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [cachedFiles, setCachedFiles] = useState<CachedFile[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [driveHits, setDriveHits] = useState<SearchHit[]>([]);
  const [searchingDrive, setSearchingDrive] = useState(false);

  // Reset state, load local full-text cache, and warm unexpanded folders whenever opened.
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery(initialQuery);
    setActiveIndex(0);
    setDriveHits([]);
    setSearchingDrive(false);
    setRecentIds(getRecentFileIds());
    setTreeVersion((v) => v + 1);

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

    // Focus input immediately on open.
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    // Opportunistically warm unexpanded folders in cache so nested notes show up in local search.
    const warmController = new AbortController();
    if (!offline) {
      const { folders } = collectIndexedTree(queryClient);
      const unloaded = folders
        .filter(
          (f) =>
            !isHiddenAttachmentsFolder(f, attachmentsFolder) &&
            queryClient.getQueryData(childrenKey(f.node.id)) === undefined,
        )
        .slice(0, MAX_WARM_FOLDERS);
      if (unloaded.length > 0) {
        void Promise.allSettled(
          unloaded.map(async (f) => {
            const nodes = await fetchChildren(f.node.id, warmController.signal);
            queryClient.setQueryData(childrenKey(f.node.id), nodes);
            void writeCachedFolder(f.node.id, nodes);
          }),
        ).then(() => {
          if (active) {
            setTreeVersion((v) => v + 1);
          }
        });
      }
    }

    return () => {
      active = false;
      window.clearTimeout(focusTimer);
      warmController.abort();
    };
  }, [open, initialQuery, offline, queryClient, attachmentsFolder]);

  const trimmed = query.trim();
  const isCommandMode = trimmed.startsWith(">");
  const isHeadingMode = trimmed.startsWith("#");
  const isTagMode = /^tag:/i.test(trimmed);
  const effectiveQuery = isTagMode
    ? trimmed.slice(4).trim().replace(/^#/, "")
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
    const folders = allFolders.filter((f) => !isHiddenAttachmentsFolder(f, attachmentsFolder));
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
        onSelect: () => runAndClose(onOpenAttachments),
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
          setActiveIndex(0);
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
          badge: "⌘⇧I",
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
      badge: "⌘\\",
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

    // 1b. Frontmatter tag filter mode (`tag:...`).
    if (isTagMode) {
      const contentSources = new Map<string, string>();
      for (const f of cachedFiles) {
        contentSources.set(f.fileId, f.text);
      }
      if (openFileId !== null) {
        contentSources.set(openFileId, getCurrentText());
      }

      if (effectiveQuery.length === 0) {
        const tagCounts = new Map<string, { label: string; count: number }>();
        for (const [fileId, text] of contentSources) {
          if (!notesById.has(fileId)) {
            continue;
          }
          for (const tag of extractFrontmatterTags(text)) {
            const key = tag.toLowerCase();
            const existing = tagCounts.get(key);
            if (existing) {
              existing.count += 1;
            } else {
              tagCounts.set(key, { label: tag, count: 1 });
            }
          }
        }
        return Array.from(tagCounts.values())
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "accent" }))
          .map(({ label, count }) => ({
            id: `tag:${label.toLowerCase()}`,
            section: "Tags",
            label: `#${label}`,
            badge: `${count} ${count === 1 ? "note" : "notes"}`,
            icon: <HashIcon className="size-4" />,
            onSelect: () => {
              setQuery(`tag:${label}`);
              setActiveIndex(0);
              inputRef.current?.focus();
            },
          }));
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
      return matched.map(({ fileId, entry, tags }) => ({
        id: `tag-note:${fileId}`,
        section: "Tagged notes",
        label: entry.node.name,
        subtitle: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
        badge: tags.map((tag) => `#${tag}`).join(" "),
        icon: <FileIcon className="size-4" />,
        onSelect: () => runAndClose(() => onOpenFile(fileId)),
      }));
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
    if (defaultTargetFolder && !offline) {
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

  const clampedActive = items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);

  useEffect(() => {
    if (!open || clampedActive < 0) {
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${clampedActive}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, clampedActive]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length > 0) {
        setActiveIndex((prev) => (prev + 1) % items.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) {
        setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
      }
      return;
    }
    if (event.key === "Enter") {
      if (clampedActive >= 0 && items[clampedActive]) {
        event.preventDefault();
        items[clampedActive].onSelect();
      }
    }
  };

  // Group items sequentially by section while preserving flat indices for keyboard navigation.
  const sections: { title: string; entries: { item: PaletteItem; flatIndex: number }[] }[] = [];
  items.forEach((item, flatIndex) => {
    const last = sections[sections.length - 1];
    if (last && last.title === item.section) {
      last.entries.push({ item, flatIndex });
    } else {
      sections.push({ title: item.section, entries: [{ item, flatIndex }] });
    }
  });

  const activeItemId = clampedActive >= 0 ? `${listboxId}-opt-${clampedActive}` : undefined;

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-950/45 px-3 pt-[12vh] backdrop-blur-[1px] sm:px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2.5 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
          {isHeadingMode || isTagMode ? (
            <HashIcon className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          ) : (
            <SearchIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeItemId}
            aria-label="Search notes and commands"
            placeholder="Search notes, content, tag:, > commands, # headings…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
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

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Search results"
          className="max-h-[55vh] overflow-y-auto p-1.5"
        >
          {sections.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {emptyMessage}
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="mb-1.5 last:mb-0">
                <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                  {section.title}
                </div>
                {section.entries.map(({ item, flatIndex }) => {
                  const isActive = flatIndex === clampedActive;
                  return (
                    <button
                      key={item.id}
                      id={`${listboxId}-opt-${flatIndex}`}
                      type="button"
                      role="option"
                      aria-label={item.subtitle ? `${item.label} — ${item.subtitle}` : item.label}
                      aria-selected={isActive}
                      data-index={flatIndex}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => item.onSelect()}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isActive
                          ? "bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50"
                          : "text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
                      }`}
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
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="hidden items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/70 px-3.5 py-1.5 text-[11px] text-neutral-500 sm:flex dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-400">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>tag: Tags</span>
            <span>&gt; Commands</span>
            <span># Headings</span>
          </div>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
