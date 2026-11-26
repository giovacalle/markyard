import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Tabs, TabsList, TabsPanel, TabsTab, TabsTabIcon } from "@ui-sdk/react/tabs";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type DefaultMode,
  updateSettings,
  useSettings,
  validateFolderSetting,
} from "../settings";
import type { ThemePreference } from "../theme";
import { setViewPref, useViewPrefs, type ViewPrefKey } from "../viewPrefs";
import { ChevronIcon, CloseIcon } from "./icons";

type FolderKey = "attachmentsFolder" | "dailyNotesFolder" | "templatesFolder";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3
        id={id}
        className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 aria-invalid:border-red-500 dark:border-neutral-700 dark:bg-neutral-950 dark:placeholder:text-neutral-500";

/** A folder-name setting: edited as a draft, saved on blur or Enter when valid. */
function FolderField({
  settingKey,
  label,
  placeholder,
  help,
  allowEmpty = false,
}: {
  settingKey: FolderKey;
  label: string;
  placeholder?: string;
  help?: string;
  allowEmpty?: boolean;
}) {
  const settings = useSettings();
  const saved = settings[settingKey];
  const fallback = DEFAULT_SETTINGS[settingKey];
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const error = draft === null ? null : validateFolderSetting(draft, { allowEmpty });

  const commit = () => {
    if (draft !== null && error === null) {
      updateSettings({ [settingKey]: draft.trim() } as Partial<AppSettings>);
      setDraft(null);
    }
  };

  return (
    <div className="space-y-1">
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="text"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : help ? helpId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className={INPUT_CLASS}
        />
        {saved !== fallback && draft === null && (
          <button
            type="button"
            aria-label={`Reset ${label.toLowerCase()}`}
            onClick={() => updateSettings({ [settingKey]: fallback } as Partial<AppSettings>)}
            className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Reset
          </button>
        )}
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        help && (
          <p id={helpId} className="text-xs text-neutral-500 dark:text-neutral-400">
            {help}
          </p>
        )
      )}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{label}</span>
      <SegmentedControl
        aria-label={label}
        value={value}
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next);
          }
        }}
        className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-950"
      >
        {options.map((option) => (
          <SegmentedControlItem
            key={option.value}
            value={option.value}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-checked:bg-white data-checked:text-neutral-950 data-checked:shadow-xs dark:text-neutral-400 dark:hover:text-neutral-100 dark:data-checked:bg-neutral-800 dark:data-checked:text-neutral-50"
          >
            {option.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="block text-xs text-neutral-500 dark:text-neutral-400">
            {description}
          </span>
        )}
      </span>
      <Switch
        aria-label={label}
        aria-describedby={description ? descriptionId : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-neutral-300 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 data-checked:bg-blue-600 data-disabled:opacity-50 dark:bg-neutral-700 dark:data-checked:bg-blue-500"
      >
        <SwitchThumb className="inline-block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-4.5" />
      </Switch>
    </div>
  );
}

const SECTIONS = [
  { value: "appearance", label: "Appearance" },
  { value: "editor", label: "Editor" },
  { value: "vault", label: "Vault" },
  { value: "sync", label: "Sync & Storage" },
] as const;

type SectionValue = (typeof SECTIONS)[number]["value"];

/** Below the `md` breakpoint: the same query the rest of the app uses for narrow screens. */
const NARROW_QUERY = "(max-width: 47.99rem)";

function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isNarrow() {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function useNarrowScreen() {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

const THEMES: readonly { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const MODES: readonly { value: DefaultMode; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "edit", label: "Edit" },
];

const VIEW_TOGGLES: readonly { key: ViewPrefKey; label: string; description: string }[] = [
  {
    key: "readOnly",
    label: "Read-only mode",
    description: "Lock notes against accidental edits. Also toggleable from the note header.",
  },
  {
    key: "focusMode",
    label: "Focus mode",
    description:
      "Dim everything outside the active paragraph. Also toggleable from the editor toolbar.",
  },
  {
    key: "typewriterMode",
    label: "Typewriter mode",
    description:
      "Keep the cursor line centered while writing. Also toggleable from the editor toolbar.",
  },
];

export function SettingsDialog({
  open,
  onClose,
  vaultName,
  onChangeVault,
  theme,
  onThemeChange,
  cloudSync,
  vaultPinned,
  onPinVaultChange,
  pendingSyncCount,
  onClearCache,
}: {
  open: boolean;
  onClose: () => void;
  /** The active vault folder's name, when known. */
  vaultName?: string;
  onChangeVault: () => void;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  cloudSync?: boolean;
  vaultPinned: boolean;
  /** Omitted where the offline vault is unavailable (no service worker storage). */
  onPinVaultChange?: (pinned: boolean) => void;
  /** Notes saved here but not yet on Drive: clearing the cache would lose them. */
  pendingSyncCount: number;
  onClearCache: () => Promise<void>;
}) {
  if (!open) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-1/2 left-1/2 z-40 flex h-[min(36rem,calc(100dvh-2rem))] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <div className="space-y-0.5">
            <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
            <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
              Vault folders, editor defaults and local storage.
            </DialogDescription>
          </div>
          <DialogClose
            type="button"
            aria-label="Close settings"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <CloseIcon className="size-4" />
          </DialogClose>
        </div>
        <SettingsBody
          vaultName={vaultName}
          onChangeVault={onChangeVault}
          theme={theme}
          onThemeChange={onThemeChange}
          cloudSync={cloudSync}
          vaultPinned={vaultPinned}
          onPinVaultChange={onPinVaultChange}
          pendingSyncCount={pendingSyncCount}
          onClearCache={onClearCache}
        />
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({
  vaultName,
  onChangeVault,
  theme,
  onThemeChange,
  cloudSync,
  vaultPinned,
  onPinVaultChange,
  pendingSyncCount,
  onClearCache,
}: Omit<Parameters<typeof SettingsDialog>[0], "open" | "onClose">) {
  const settings = useSettings();
  const viewPrefs = useViewPrefs();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const narrow = useNarrowScreen();
  // Narrow screens start on the section list (nothing selected); wide screens always show one.
  const [section, setSection] = useState<SectionValue | null>(null);
  const selected = narrow ? section : (section ?? "appearance");
  const drilledIn = narrow && selected !== null;
  const backRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<SectionValue, HTMLButtonElement | null>>>({});
  // The section a narrow drill-in came from, so Back returns focus to its tab.
  const returnTo = useRef<SectionValue | null>(null);

  useEffect(() => {
    if (drilledIn) {
      backRef.current?.focus();
    } else if (narrow && returnTo.current !== null) {
      tabRefs.current[returnTo.current]?.focus();
      returnTo.current = null;
    }
  }, [drilledIn, narrow]);

  const clearCache = async () => {
    setClearing(true);
    try {
      await onClearCache();
      setCleared(true);
    } finally {
      setClearing(false);
      setConfirmingClear(false);
    }
  };

  const vaultControls = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
            Vault folder
          </span>
          <span
            data-testid="settings-vault-name"
            className="block truncate text-xs text-neutral-500 dark:text-neutral-400"
            title={vaultName}
          >
            {vaultName ?? "Not configured"}
          </span>
        </span>
        <button
          type="button"
          disabled={pendingSyncCount > 0}
          title={
            pendingSyncCount > 0
              ? "Wait until every note is saved to Drive before changing vault."
              : undefined
          }
          onClick={onChangeVault}
          className="shrink-0 rounded-lg disabled:opacity-50 border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Change vault…
        </button>
      </div>
      <FolderField
        settingKey="attachmentsFolder"
        label="Attachments folder"
        placeholder={DEFAULT_SETTINGS.attachmentsFolder}
        help="Uploaded images go here, directly under the vault folder."
      />
      <SwitchRow
        label="Show attachments folder"
        description="Show the attachments folder in the file tree, move picker and command palette."
        checked={settings.showAttachmentsFolder}
        onChange={(showAttachmentsFolder) => updateSettings({ showAttachmentsFolder })}
      />
      <FolderField
        settingKey="dailyNotesFolder"
        label="Daily notes folder"
        placeholder="Vault root (leave empty)"
        help="e.g. Daily — created automatically if missing"
        allowEmpty
      />
      <FolderField
        settingKey="templatesFolder"
        label="Templates folder"
        placeholder={DEFAULT_SETTINGS.templatesFolder}
        help="Notes here become / templates; Daily.md shapes new daily notes."
      />
    </>
  );

  const editorControls = (
    <>
      <Segmented
        label="Default mode"
        value={settings.defaultMode}
        options={MODES}
        onChange={(defaultMode) => updateSettings({ defaultMode })}
      />
      <SwitchRow
        label="URL link previews"
        description="Hover cards and bookmark cards for web links."
        checked={settings.linkPreviewsEnabled}
        onChange={(linkPreviewsEnabled) => updateSettings({ linkPreviewsEnabled })}
      />
      {VIEW_TOGGLES.map(({ key, label, description }) => (
        <SwitchRow
          key={key}
          label={label}
          description={description}
          checked={viewPrefs[key]}
          onChange={(next) => setViewPref(key, next)}
        />
      ))}
    </>
  );

  const syncControls = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          Cloud sync
        </span>
        <span
          data-testid="settings-cloud-sync"
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
            cloudSync === true
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
              : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${cloudSync === true ? "bg-emerald-500" : "bg-neutral-400"}`}
          />
          {cloudSync === true ? "Active (Cloudflare D1)" : "Local only"}
        </span>
      </div>
      {onPinVaultChange && (
        <SwitchRow
          label="Offline vault"
          description={
            vaultPinned
              ? "Every note is kept on this device."
              : "Only notes you open are kept on this device."
          }
          checked={vaultPinned}
          onChange={onPinVaultChange}
        />
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Local cache
            </span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              {pendingSyncCount > 0
                ? "Wait until every note is saved to Drive before clearing."
                : "Cached folders and notes on this device; reloaded from Drive."}
            </span>
          </span>
          {!confirmingClear && (
            <button
              type="button"
              disabled={pendingSyncCount > 0 || clearing}
              onClick={() => {
                setCleared(false);
                setConfirmingClear(true);
              }}
              className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Clear local cache
            </button>
          )}
        </div>
        {confirmingClear && (
          <div
            role="group"
            aria-label="Confirm clearing the local cache"
            className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200"
          >
            <span>Clear the cache and reload the vault from Drive?</span>
            <span className="flex shrink-0 gap-1.5">
              <button
                type="button"
                disabled={clearing}
                onClick={() => setConfirmingClear(false)}
                className="rounded-md px-2 py-1 font-medium hover:bg-red-100 disabled:opacity-50 dark:hover:bg-red-900/50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => void clearCache()}
                className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {clearing ? "Clearing…" : "Clear cache"}
              </button>
            </span>
          </div>
        )}
        {cleared && (
          <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
            Local cache cleared.
          </p>
        )}
      </div>
    </>
  );

  const content: Record<SectionValue, ReactNode> = {
    appearance: <Segmented label="Theme" value={theme} options={THEMES} onChange={onThemeChange} />,
    editor: editorControls,
    vault: vaultControls,
    sync: syncControls,
  };

  return (
    <Tabs
      orientation="vertical"
      activation={narrow ? "manual" : "automatic"}
      value={selected}
      onValueChange={(next) => {
        if (next !== null) {
          returnTo.current = narrow ? next : null;
          setSection(next as SectionValue);
        }
      }}
      className="flex min-h-0 flex-1"
    >
      <TabsList
        aria-label="Settings sections"
        hidden={drilledIn}
        className="flex w-full shrink-0 flex-col gap-0.5 overflow-y-auto p-2 md:w-48 md:border-r md:border-neutral-200 md:dark:border-neutral-800"
      >
        {SECTIONS.map(({ value, label }) => (
          <TabsTab
            key={value}
            value={value}
            ref={(element: HTMLButtonElement | null) => {
              tabRefs.current[value] = element;
            }}
            className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-selected:bg-neutral-100 data-selected:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-selected:bg-neutral-800 dark:data-selected:text-neutral-50"
          >
            {label}
            <TabsTabIcon className="text-neutral-400 md:hidden dark:text-neutral-500">
              <ChevronIcon className="size-4" />
            </TabsTabIcon>
          </TabsTab>
        ))}
      </TabsList>
      {selected !== null && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {narrow && (
            <button
              ref={backRef}
              type="button"
              aria-label="Back to settings sections"
              onClick={() => setSection(null)}
              className="mx-2 mt-2 inline-flex items-center gap-1 self-start rounded-lg px-2 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <ChevronIcon aria-hidden="true" className="size-4 rotate-180" />
              Sections
            </button>
          )}
          {SECTIONS.map(({ value, label }) => (
            <TabsPanel
              key={value}
              value={value}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none"
            >
              <Section title={label}>{content[value]}</Section>
            </TabsPanel>
          ))}
        </div>
      )}
    </Tabs>
  );
}
