import { addDays, formatDate, formatDateRange, startOfMonth, todayDate } from "@ui-sdk/core/date";
import {
  CalendarDay,
  CalendarGrid,
  CalendarHeading,
  CalendarNext,
  CalendarPrevious,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
  DatePicker,
  DatePickerContent,
  DatePickerPreset,
  DatePickerTrigger,
} from "@ui-sdk/react/date-picker";
import { useState } from "react";
import { CalendarIcon, ChevronIcon, CloseIcon } from "./icons";

/** Inclusive local calendar days (`YYYY-MM-DD`), or `null` for any date. */
export type DayRange = readonly [from: string, to: string] | null;

const LABEL_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

/** `Nov 2, 2026` or `Nov 2 – 9, 2026`. */
export function dayRangeLabel([from, to]: readonly [string, string]): string {
  return from === to
    ? formatDate(from, undefined, LABEL_FORMAT)
    : formatDateRange(from, to, undefined, LABEL_FORMAT);
}

const NAV_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 data-[disabled]:pointer-events-none data-[disabled]:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

const DAY_CLASS = [
  "relative inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-[13px] tabular-nums text-neutral-800 transition-colors outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-neutral-200 dark:hover:bg-neutral-800",
  "data-[today]:font-semibold data-[today]:text-blue-600 dark:data-[today]:text-blue-400",
  "data-[outside]:text-neutral-300 dark:data-[outside]:text-neutral-600",
  "data-[preview]:rounded-none data-[preview]:bg-blue-50 dark:data-[preview]:bg-blue-950/60",
  "data-[range-middle]:rounded-none data-[range-middle]:bg-blue-50 dark:data-[range-middle]:bg-blue-950/60",
  "data-[range-start]:rounded-md data-[range-start]:bg-blue-600 data-[range-start]:text-white data-[range-end]:rounded-md data-[range-end]:bg-blue-600 data-[range-end]:text-white dark:data-[range-start]:bg-blue-500 dark:data-[range-end]:bg-blue-500",
  "data-[disabled]:cursor-not-allowed data-[disabled]:text-neutral-300 data-[disabled]:hover:bg-transparent dark:data-[disabled]:text-neutral-700",
].join(" ");

const PRESET_CLASS =
  "rounded-md px-2 py-1 text-left text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 data-[selected]:bg-blue-50 data-[selected]:text-blue-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-[selected]:bg-blue-950/60 dark:data-[selected]:text-blue-300";

/**
 * One field that opens a range calendar with presets for the upload-date filter. Days after today
 * cannot be picked; picking the same day twice filters on that single day.
 */
export function UploadDateFilter({
  value,
  onChange,
}: {
  value: DayRange;
  onChange: (value: DayRange) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const today = todayDate();
  const presets: [string, readonly [string, string]][] = [
    ["Today", [today, today]],
    ["Last 7 days", [addDays(today, -6), today]],
    ["Last 30 days", [addDays(today, -29), today]],
    ["This month", [startOfMonth(today), today]],
  ];
  const label = value === null ? "Any date" : dayRangeLabel(value);

  return (
    <DatePicker
      mode="range"
      value={value === null ? null : [value[0], value[1]]}
      onValueChange={(next) => onChange(Array.isArray(next) ? [next[0], next[1]] : null)}
      max={today}
      presentation="auto"
      fixedWeeks
      showOutsideDays
    >
      <div
        ref={setAnchor}
        className={`flex h-[30px] items-center rounded-md border bg-white text-sm dark:bg-neutral-900 ${
          value === null
            ? "border-neutral-200 dark:border-neutral-700"
            : "border-blue-300 dark:border-blue-800"
        }`}
      >
        <DatePickerTrigger
          aria-label={value === null ? "Upload date: any" : `Upload date: ${label}`}
          className="flex h-full cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-2 text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-200"
        >
          <CalendarIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Uploaded</span>
          <span className="font-medium tabular-nums">{label}</span>
          {value === null && (
            <ChevronIcon className="size-3.5 rotate-90 text-neutral-400 dark:text-neutral-500" />
          )}
        </DatePickerTrigger>
        {value !== null && (
          <button
            type="button"
            aria-label="Clear dates"
            title="Clear dates"
            onClick={() => onChange(null)}
            className="mr-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <CloseIcon className="size-3.5" />
          </button>
        )}
      </div>

      <DatePickerContent
        anchor={anchor}
        align="end"
        sideOffset={6}
        collisionPadding={12}
        aria-label="Choose upload dates"
        className="z-50 flex gap-1 rounded-xl border border-neutral-200 bg-white p-2 text-neutral-900 shadow-lg outline-none data-[presentation=sheet]:flex-col-reverse data-[presentation=sheet]:rounded-b-none data-[presentation=sheet]:p-4 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <div
          role="group"
          aria-label="Presets"
          className="flex w-28 shrink-0 flex-col gap-0.5 border-r border-neutral-100 pr-2 in-data-[presentation=sheet]:w-auto in-data-[presentation=sheet]:flex-row in-data-[presentation=sheet]:flex-wrap in-data-[presentation=sheet]:border-t in-data-[presentation=sheet]:border-r-0 in-data-[presentation=sheet]:pt-2 in-data-[presentation=sheet]:pr-0 dark:border-neutral-800"
        >
          {presets.map(([name, range]) => (
            <DatePickerPreset key={name} value={[range[0], range[1]]} className={PRESET_CLASS}>
              {name}
            </DatePickerPreset>
          ))}
        </div>
        <div className="flex flex-col gap-1 px-1">
          <div className="flex items-center justify-between gap-2">
            <CalendarPrevious className={NAV_CLASS}>
              <ChevronIcon className="size-4 rotate-180" />
            </CalendarPrevious>
            <CalendarHeading className="text-sm font-semibold" />
            <CalendarNext className={NAV_CLASS}>
              <ChevronIcon className="size-4" />
            </CalendarNext>
          </div>
          <CalendarGrid className="border-collapse">
            <CalendarWeekdays>
              {(index) => (
                <CalendarWeekday
                  index={index}
                  className="size-8 text-[11px] font-medium text-neutral-400 dark:text-neutral-500"
                />
              )}
            </CalendarWeekdays>
            <CalendarWeeks>
              {(cell) => <CalendarDay value={cell.date} className={DAY_CLASS} />}
            </CalendarWeeks>
          </CalendarGrid>
        </div>
      </DatePickerContent>
    </DatePicker>
  );
}
