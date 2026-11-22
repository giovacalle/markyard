import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { useState } from "react";
import type { DriveNode } from "../api";
import { CopyPathItem } from "./CopyPathItem";
import { FolderInputIcon, MoreHorizontalIcon, TrashIcon } from "./icons";

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Actions for ${file.name}`}
        title="More actions"
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-300/70 hover:text-neutral-900 data-[open]:bg-neutral-300/70 data-[open]:text-neutral-900 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-100 dark:data-[open]:bg-neutral-700 dark:data-[open]:text-neutral-100"
      >
        <MoreHorizontalIcon className="size-3.5" />
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="z-50 w-44 rounded-xl border border-neutral-200 bg-white p-1 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        {onMove && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onMove(file);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            <FolderInputIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
            <span>Move to…</span>
          </button>
        )}
        {getPath && <CopyPathItem getPath={getPath} onDone={() => setOpen(false)} />}
        {(getPath || onMove) && onDelete && (
          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
        )}
        {onDelete && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onDelete(file);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/60"
          >
            <TrashIcon className="size-3.5" />
            <span>Delete</span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
