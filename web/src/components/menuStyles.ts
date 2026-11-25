/** Tailwind classes shared by the app's ui-sdk Menus, matching the Popover panels (light and dark). */

/** The "…" trigger of a file tree row. */
export const ACTIONS_MENU_TRIGGER_CLASS =
  "rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-300/70 hover:text-neutral-900 data-open:bg-neutral-300/70 data-open:text-neutral-900 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-100 dark:data-open:bg-neutral-700 dark:data-open:text-neutral-100";

const MENU_PANEL_CLASS =
  "z-50 rounded-xl border border-neutral-200 bg-white p-1 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100";

/** The popup of a file tree row's actions. */
export const ACTIONS_MENU_CONTENT_CLASS = `${MENU_PANEL_CLASS} w-44`;

/** The popup of an attachment card's copy menu. */
export const COPY_MENU_CONTENT_CLASS = `${MENU_PANEL_CLASS} w-40`;

const MENU_ITEM_BASE_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none transition-colors select-none data-disabled:cursor-not-allowed data-disabled:opacity-40";

export const MENU_ITEM_CLASS = `${MENU_ITEM_BASE_CLASS} text-neutral-700 data-highlighted:bg-neutral-100 data-disabled:data-highlighted:bg-transparent dark:text-neutral-200 dark:data-highlighted:bg-neutral-800 dark:data-disabled:data-highlighted:bg-transparent`;

export const MENU_ITEM_DESTRUCTIVE_CLASS = `${MENU_ITEM_BASE_CLASS} text-red-600 data-highlighted:bg-red-50 dark:text-red-400 dark:data-highlighted:bg-red-950/60`;

export const MENU_SEPARATOR_CLASS = "my-1 border-t border-neutral-200 dark:border-neutral-800";
