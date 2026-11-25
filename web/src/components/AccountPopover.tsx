import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { useState } from "react";
import type { ThemePreference } from "../theme";
import {
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "./icons";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof SunIcon;
}[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

export function AccountPopover({
  email,
  name,
  cloudSync,
  theme,
  onThemeChange,
  signingOut,
  onSignOut,
  onOpenSettings,
}: {
  email: string;
  name?: string;
  cloudSync?: boolean;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  signingOut: boolean;
  onSignOut: () => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const displayName = name?.trim() || undefined;
  const initial = (displayName ?? email).slice(0, 1).toUpperCase() || "?";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={displayName ? `Account: ${displayName} (${email})` : `Account: ${email}`}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 data-[open]:bg-neutral-100 dark:hover:bg-neutral-800/80 dark:data-[open]:bg-neutral-800"
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          {initial}
        </span>
        {displayName ? (
          <span className="flex min-w-0 flex-1 flex-col" title={`${displayName} (${email})`}>
            <span className="truncate text-xs leading-tight font-medium text-neutral-800 dark:text-neutral-200">
              {displayName}
            </span>
            <span className="truncate text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
              {email}
            </span>
          </span>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200"
            title={email}
          >
            {email}
          </span>
        )}
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="z-50 w-64 rounded-xl border border-neutral-200 bg-white p-2 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <div className="px-2 py-1.5">
          <PopoverTitle className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
            Account
          </PopoverTitle>
          {displayName ? (
            <>
              <p
                className="mt-0.5 truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100"
                title={displayName}
              >
                {displayName}
              </p>
              <p
                className="truncate text-[11px] text-neutral-500 dark:text-neutral-400"
                title={email}
              >
                {email}
              </p>
            </>
          ) : (
            <p
              className="mt-0.5 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200"
              title={email}
            >
              {email}
            </p>
          )}
          {cloudSync === true && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span>Cloud sync active</span>
            </p>
          )}
        </div>

        <div className="my-1.5 h-px bg-neutral-200 dark:bg-neutral-800" />

        <div className="px-2 py-1">
          <span className="block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            Theme
          </span>
          <SegmentedControl
            aria-label="Theme"
            value={theme}
            onValueChange={(next) => {
              if (next !== null) {
                onThemeChange(next);
              }
            }}
            className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-950"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <SegmentedControlItem
                key={value}
                value={value}
                className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-checked:bg-white data-checked:text-neutral-950 data-checked:shadow-xs dark:text-neutral-400 dark:hover:text-neutral-100 dark:data-checked:bg-neutral-800 dark:data-checked:text-neutral-50"
              >
                <Icon className="size-3.5" />
                <span>{label}</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <div className="my-1.5 h-px bg-neutral-200 dark:bg-neutral-800" />

        {onOpenSettings && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
          >
            <SettingsIcon className="size-3.5" />
            <span>Settings</span>
          </button>
        )}

        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setOpen(false);
            onSignOut();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-950 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
        >
          <LogOutIcon className="size-3.5" />
          <span>Sign out</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
