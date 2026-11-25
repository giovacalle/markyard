import { Toolbar, ToolbarButton } from "@ui-sdk/react/toolbar";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AccessoryAction {
  label: string;
  icon: ReactNode;
  run: () => void;
}

/** An on-screen keyboard taller than this shrinks the visual viewport while editing. */
const KEYBOARD_MIN_HEIGHT = 120;
/** Height of the bar itself, reserved below the last editor line while the bar shows. */
const BAR_HEIGHT = 48;

function matches(query: string): boolean {
  return window.matchMedia?.(query).matches ?? false;
}

/** Pixels between the bottom of the layout viewport and the visual viewport (the keyboard). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

/**
 * Compact formatting bar pinned right above the on-screen keyboard. It shows on touch and
 * narrow screens, or whenever the keyboard shrinks the visual viewport. Taps never move focus,
 * so the keyboard stays up. Offsets go through the CSSOM (`element.style`), which the strict
 * CSP allows, never through inline style attributes.
 */
export function AccessoryBar({ actions }: { actions: AccessoryAction[] }) {
  const inset = useKeyboardInset();
  const touch = matches("(pointer: coarse)") || matches("(max-width: 47.99rem)");
  const visible = touch || inset >= KEYBOARD_MIN_HEIGHT;
  const barRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    barRef.current?.style.setProperty("bottom", `${inset}px`);
    spacerRef.current?.style.setProperty("height", `${inset + BAR_HEIGHT}px`);
  }, [inset, visible]);

  if (!visible) {
    return null;
  }
  return (
    <>
      <div ref={spacerRef} aria-hidden="true" data-testid="accessory-bar-spacer" />
      <Toolbar
        ref={barRef}
        aria-label="Formatting accessory bar"
        className="fixed inset-x-0 z-30 flex h-12 items-center gap-1 overflow-x-auto border-t border-neutral-200 bg-neutral-50/95 px-2 backdrop-blur-xs dark:border-neutral-800 dark:bg-neutral-900/95"
      >
        {actions.map((action) => (
          <ToolbarButton
            key={action.label}
            aria-label={action.label}
            title={action.label}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={action.run}
            className="inline-flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md px-2 text-sm font-medium text-neutral-700 active:bg-neutral-200 dark:text-neutral-300 dark:active:bg-neutral-800"
          >
            {action.icon}
          </ToolbarButton>
        ))}
      </Toolbar>
    </>
  );
}
