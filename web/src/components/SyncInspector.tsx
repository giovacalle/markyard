import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, isConflict, isNameExists, type VaultIndex } from "../api";
import {
  formatPendingOpLabel,
  isPermanentOpError,
  useOptionalOpsQueue,
  usePendingOps,
  type OpRuntimeStatus,
} from "../opsQueue";
import { isPermanentSyncError, useSyncStates, type FileSyncState } from "../syncQueue";
import { findNode, VAULT_INDEX_KEY } from "../treeCache";
import { useVaultSyncState } from "../vaultSync";
import { CloudIcon, CloudOffIcon } from "./icons";

type QueuedState = Exclude<FileSyncState, { status: "idle" } | { status: "synced" }>;

function isQueued(state: FileSyncState): state is QueuedState {
  return state.status === "pending" || state.status === "syncing" || state.status === "error";
}

function statusLabel(state: QueuedState): string {
  if (state.status === "syncing") {
    return "Syncing…";
  }
  if (state.status === "pending") {
    return "Waiting to sync";
  }
  if (isConflict(state.error)) {
    return "Changed on Drive — open the note to resolve";
  }
  if (state.retry !== undefined) {
    return `Failed, retrying (attempt ${state.retry.attempt} of ${state.retry.maxAttempts})`;
  }
  return isPermanentSyncError(state.error) ? "Failed" : "Failed, will retry when you ask";
}

function opStatusLabel(state: OpRuntimeStatus): string {
  if (state.status === "syncing") {
    return "Syncing…";
  }
  if (state.status === "pending") {
    return "Waiting to sync";
  }
  if (isNameExists(state.error)) {
    return "Name already exists on Drive";
  }
  if (state.retry !== undefined) {
    return `Failed, retrying (attempt ${state.retry.attempt} of ${state.retry.maxAttempts})`;
  }
  return isPermanentOpError(state.error) ? "Failed" : "Failed, will retry when you ask";
}

export function formatSyncedAt(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ROW_BUTTON_CLASS =
  "rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";

/**
 * The sync status button and its "Sync & offline" inspector: every queued upload with its exact
 * error and Retry / Discard, and the vault's offline coverage with "Pin vault offline".
 */
export function SyncInspector({
  offline,
  className = "",
  onRetry,
  onRetryOp,
  onRetryAll,
  onDiscard,
  onDiscardOp,
  onPinChange,
  onSyncVault,
}: {
  offline: boolean;
  className?: string;
  onRetry: (fileId: string) => void;
  onRetryOp?: (opId: string) => void;
  onRetryAll: () => void;
  onDiscard: (fileId: string) => void;
  onDiscardOp?: (opId: string) => void;
  onPinChange: (pinned: boolean) => void;
  onSyncVault: () => void;
}) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  const [open, setOpen] = useState(false);
  const pendingOps = usePendingOps();
  const states = useSyncStates();
  const vault = useVaultSyncState();

  const pendingCreateFileIds = new Set<string>();
  for (const item of pendingOps) {
    if (item.op.kind === "create_file") {
      pendingCreateFileIds.add(item.op.targetId);
    }
  }
  const queued = [...states].filter(
    (entry): entry is [string, QueuedState] =>
      isQueued(entry[1]) && !pendingCreateFileIds.has(entry[0]),
  );
  const totalQueued = pendingOps.length + queued.length;
  const failed =
    pendingOps.filter((item) => item.state.status === "error").length +
    queued.filter(([, state]) => state.status === "error").length;
  const syncing =
    pendingOps.some((item) => item.state.status === "syncing") ||
    queued.some(([, state]) => state.status === "syncing");

  const nameOf = (fileId: string): string => {
    const node = findNode(queryClient, fileId);
    if (node !== undefined) {
      return node.name;
    }
    const index = queryClient.getQueryData<VaultIndex>(VAULT_INDEX_KEY);
    return index?.files.find((file) => file.id === fileId)?.name ?? "Untitled note";
  };

  const unit = (count: number) =>
    pendingOps.length > 0 ? (count === 1 ? "change" : "changes") : count === 1 ? "note" : "notes";

  const summary = offline
    ? "Offline"
    : failed > 0
      ? `${failed} ${unit(failed)} failed to sync`
      : totalQueued > 0
        ? `${totalQueued} ${unit(totalQueued)} waiting to sync`
        : vault.running
          ? "Syncing vault"
          : "All changes synced";

  const handleRetryOp = (opId: string) => {
    if (onRetryOp !== undefined) {
      onRetryOp(opId);
    } else {
      void opsQueue?.retryOp(opId);
    }
  };

  const handleDiscardOp = (opId: string) => {
    if (onDiscardOp !== undefined) {
      onDiscardOp(opId);
    } else {
      void opsQueue?.discardOp(opId);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Sync status: ${summary}`}
        title="Sync & offline"
        data-state={failed > 0 ? "error" : totalQueued > 0 || syncing ? "pending" : "idle"}
        className={`relative size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-[open]:bg-neutral-100 data-[state=error]:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-[open]:bg-neutral-800 dark:data-[state=error]:text-red-400 ${className}`}
      >
        {offline ? <CloudOffIcon className="size-4" /> : <CloudIcon className="size-4" />}
        {totalQueued > 0 && (
          <span
            aria-hidden="true"
            className={`absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-3.5 font-semibold text-white ${
              failed > 0 ? "bg-red-600" : "bg-amber-500"
            }`}
          >
            {totalQueued}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-neutral-200 bg-white p-3 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <PopoverTitle className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
          Sync & offline
        </PopoverTitle>
        <p role="status" className="mt-1 text-xs text-neutral-700 dark:text-neutral-300">
          {summary}
        </p>

        {totalQueued > 0 && (
          <section aria-label="Sync queue" className="mt-2.5">
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
              {pendingOps.map(({ op, state }) => {
                const label = formatPendingOpLabel(op);
                return (
                  <li
                    key={op.opId}
                    aria-label={label}
                    className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
                  >
                    <p className="truncate text-xs font-medium" title={label}>
                      {label}
                    </p>
                    <p
                      className={`mt-0.5 text-[11px] ${
                        state.status === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {opStatusLabel(state)}
                    </p>
                    {state.status === "error" && (
                      <p className="mt-0.5 font-mono text-[10px] break-words text-red-600/90 dark:text-red-300/80">
                        {describeError(state.error)}
                      </p>
                    )}
                    <div className="mt-1.5 flex gap-1.5">
                      {state.status !== "syncing" && (
                        <button
                          type="button"
                          className={ROW_BUTTON_CLASS}
                          disabled={offline}
                          aria-label={`Retry ${label}`}
                          onClick={() => handleRetryOp(op.opId)}
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        className={ROW_BUTTON_CLASS}
                        aria-label={`Discard ${label}`}
                        onClick={() => {
                          if (window.confirm(`Discard "${label}" and undo this local change?`)) {
                            handleDiscardOp(op.opId);
                          }
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </li>
                );
              })}
              {queued.map(([fileId, state]) => {
                const name = nameOf(fileId);
                return (
                  <li
                    key={fileId}
                    aria-label={name}
                    className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
                  >
                    <p className="truncate text-xs font-medium" title={name}>
                      {name}
                    </p>
                    <p
                      className={`mt-0.5 text-[11px] ${
                        state.status === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {statusLabel(state)}
                    </p>
                    {state.status === "error" && (
                      <p className="mt-0.5 font-mono text-[10px] break-words text-red-600/90 dark:text-red-300/80">
                        {describeError(state.error)}
                      </p>
                    )}
                    <div className="mt-1.5 flex gap-1.5">
                      {state.status !== "syncing" &&
                        !isConflict(state.status === "error" ? state.error : null) && (
                          <button
                            type="button"
                            className={ROW_BUTTON_CLASS}
                            disabled={offline}
                            aria-label={`Retry ${name}`}
                            onClick={() => onRetry(fileId)}
                          >
                            Retry
                          </button>
                        )}
                      <button
                        type="button"
                        className={ROW_BUTTON_CLASS}
                        aria-label={`Discard ${name}`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Discard the local changes to ${name}? Drive's version stays.`,
                            )
                          ) {
                            onDiscard(fileId);
                          }
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={`${ROW_BUTTON_CLASS} mt-2`}
              disabled={offline}
              onClick={onRetryAll}
            >
              Retry all
            </button>
          </section>
        )}

        <div className="my-2.5 h-px bg-neutral-200 dark:bg-neutral-800" />

        <section aria-label="Offline vault" className="space-y-1.5">
          <p className="text-xs text-neutral-700 dark:text-neutral-300">
            {vault.total > 0
              ? `${vault.cached} / ${vault.total} notes cached offline`
              : "Vault not synced for offline use yet"}
          </p>
          {vault.lastSyncedAt !== null && (
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              Last synced {formatSyncedAt(vault.lastSyncedAt)}
            </p>
          )}
          {vault.failed > 0 && (
            <p className="text-[11px] text-red-600 dark:text-red-400">
              {vault.failed} {vault.failed === 1 ? "note" : "notes"} could not be downloaded.
            </p>
          )}
          {vault.truncated && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              The vault is larger than the offline limit; some notes are left out.
            </p>
          )}
          {vault.error !== null && vault.error !== undefined && (
            <p className="text-[11px] text-red-600 dark:text-red-400" role="alert">
              Vault sync failed: {describeError(vault.error)}
            </p>
          )}
          <label className="flex items-center justify-between gap-2 text-xs font-medium">
            <span>Pin vault offline</span>
            <input
              type="checkbox"
              role="switch"
              checked={vault.pinned}
              onChange={(event) => onPinChange(event.currentTarget.checked)}
              className="size-4 accent-neutral-900 dark:accent-neutral-100"
            />
          </label>
          <button
            type="button"
            className={ROW_BUTTON_CLASS}
            disabled={vault.running || offline}
            onClick={onSyncVault}
          >
            {vault.running ? "Syncing vault…" : "Sync vault now"}
          </button>
        </section>
      </PopoverContent>
    </Popover>
  );
}
