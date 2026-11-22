import { useEffect, useState } from "react";
import { copyAsRichText } from "../richCopy";
import { CheckIcon, CopyIcon } from "./icons";

export function CopyRichTextButton({ getText }: { getText: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = window.setTimeout(() => setState("idle"), 1_500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      aria-label="Copy as rich text"
      title={
        state === "failed" ? "Copy failed" : state === "copied" ? "Copied" : "Copy as rich text"
      }
      onClick={() => {
        copyAsRichText(getText()).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
      className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
    >
      {state === "copied" ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </button>
  );
}
