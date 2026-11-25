import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { useState } from "react";
import type { DriveNode } from "../api";
import { CopyPathItem } from "./CopyPathItem";
import {
  EditIcon,
  FolderInputIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import {
  ACTIONS_MENU_CONTENT_CLASS,
  ACTIONS_MENU_TRIGGER_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "./menuStyles";

const ICON_CLASS = "size-3.5 text-neutral-500 dark:text-neutral-400";

export function FolderActionsPopover({
  folder,
  open: controlledOpen,
  onOpenChange,
  onCreateNote,
  onCreateSubfolder,
  onRename,
  onMove,
  onDelete,
  getPath,
}: {
  folder: DriveNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreateNote?: (folder: DriveNode) => void;
  onCreateSubfolder?: (folder: DriveNode) => void;
  onRename?: (folder: DriveNode) => void;
  onMove?: (folder: DriveNode) => void;
  onDelete?: (folder: DriveNode) => void;
  /** Root-relative path for "Copy path"; the row is hidden without it. */
  getPath?: () => string | null;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  return (
    <Menu open={open} onOpenChange={(next) => setOpen(next)}>
      <MenuTrigger
        aria-label={`Actions for ${folder.name}`}
        title="Folder actions"
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className={ACTIONS_MENU_TRIGGER_CLASS}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>

      <MenuContent
        side="right"
        align="start"
        sideOffset={6}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className={ACTIONS_MENU_CONTENT_CLASS}
      >
        {onCreateNote && (
          <MenuItem
            onSelect={() => {
              onCreateNote(folder);
            }}
            className={MENU_ITEM_CLASS}
          >
            <PlusIcon className={ICON_CLASS} />
            <span>New note</span>
          </MenuItem>
        )}
        {onCreateSubfolder && (
          <MenuItem
            onSelect={() => {
              onCreateSubfolder(folder);
            }}
            className={MENU_ITEM_CLASS}
          >
            <FolderPlusIcon className={ICON_CLASS} />
            <span>New subfolder</span>
          </MenuItem>
        )}
        {onRename && (
          <MenuItem
            onSelect={() => {
              onRename(folder);
            }}
            className={MENU_ITEM_CLASS}
          >
            <EditIcon className={ICON_CLASS} />
            <span>Rename</span>
          </MenuItem>
        )}
        {onMove && (
          <MenuItem
            onSelect={() => {
              onMove(folder);
            }}
            className={MENU_ITEM_CLASS}
          >
            <FolderInputIcon className={ICON_CLASS} />
            <span>Move to…</span>
          </MenuItem>
        )}
        {getPath && <CopyPathItem getPath={getPath} onDone={() => setOpen(false)} />}
        {(onCreateNote || onCreateSubfolder || onRename || onMove || getPath) && onDelete && (
          <MenuSeparator className={MENU_SEPARATOR_CLASS} />
        )}
        {onDelete && (
          <MenuItem
            destructive
            onSelect={() => {
              onDelete(folder);
            }}
            className={MENU_ITEM_DESTRUCTIVE_CLASS}
          >
            <TrashIcon className="size-3.5" />
            <span>Delete</span>
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
