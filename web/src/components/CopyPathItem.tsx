import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

const CONFIRM_MS = 900;

/**
 * "Copy path" row of a tree actions popover: writes the root-relative path to the clipboard, shows
 * "Copied" briefly, then closes the popover.
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
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
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
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      {state === "copied" ? (
        <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CopyIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
      )}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : "Copy path"}
      </span>
    </button>
  );
}
