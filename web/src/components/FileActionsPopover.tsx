import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { useState } from "react";
import type { DriveNode } from "../api";
import { CopyPathItem } from "./CopyPathItem";
import { FolderInputIcon, MoreHorizontalIcon, TrashIcon } from "./icons";
import {
  ACTIONS_MENU_CONTENT_CLASS,
  ACTIONS_MENU_TRIGGER_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "./menuStyles";

export function FileActionsPopover({
  file,
  open: controlledOpen,
  onOpenChange,
  onMove,
  onDelete,
  getPath,
}: {
  file: DriveNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onMove?: (file: DriveNode) => void;
  onDelete?: (file: DriveNode) => void;
  /** Root-relative path for "Copy path"; the row is hidden without it. */
  getPath?: () => string | null;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  return (
    <Menu open={open} onOpenChange={(next) => setOpen(next)}>
      <MenuTrigger
        aria-label={`Actions for ${file.name}`}
        title="More actions"
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
        {onMove && (
          <MenuItem
            onSelect={() => {
              onMove(file);
            }}
            className={MENU_ITEM_CLASS}
          >
            <FolderInputIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
            <span>Move to…</span>
          </MenuItem>
        )}
        {getPath && <CopyPathItem getPath={getPath} onDone={() => setOpen(false)} />}
        {(getPath || onMove) && onDelete && <MenuSeparator className={MENU_SEPARATOR_CLASS} />}
        {onDelete && (
          <MenuItem
            destructive
            onSelect={() => {
              onDelete(file);
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
