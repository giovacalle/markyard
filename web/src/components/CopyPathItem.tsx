import { MenuItem } from "@ui-sdk/react/menu";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { MENU_ITEM_CLASS } from "./menuStyles";

const CONFIRM_MS = 900;

/**
 * "Copy path" item of a tree actions menu: writes the root-relative path to the clipboard, shows
 * "Copied" briefly inside the still-open menu, then closes it via `onDone`.
 */
export function CopyPathItem({
  getPath,
  onDone,
}: {
  /** The root-relative path, or `null` when the tree cannot tell it yet. */
  getPath: () => string | null;
  onDone: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const settle = (next: "copied" | "failed") => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setState("idle");
      if (next === "copied") {
        onDone();
      }
    }, CONFIRM_MS);
  };

  return (
    <MenuItem
      closeOnSelect={false}
      onSelect={() => {
        const path = getPath();
        if (path === null || navigator.clipboard?.writeText === undefined) {
          settle("failed");
          return;
        }
        navigator.clipboard.writeText(path).then(
          () => settle("copied"),
          () => settle("failed"),
        );
      }}
      className={MENU_ITEM_CLASS}
    >
      {state === "copied" ? (
        <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CopyIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
      )}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : "Copy path"}
      </span>
    </MenuItem>
  );
}
