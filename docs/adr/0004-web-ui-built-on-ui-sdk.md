---
status: accepted
---

# Web UI widgets are built on ui-sdk first; plain buttons and inputs stay native

The web app depends on `@ui-sdk/react`, a headless library of behaviors: keyboard navigation, focus, ARIA, popups and selection. In November 2026 an audit found about 24 widgets written by hand next to it: a native `<select>` that opened the OS dropdown instead of an app-styled popup, hand-written `radiogroup`, `switch`, `listbox` and `tooltip` roles, `aria-pressed` toggles, `<details>`, popovers acting as menus, and custom arrow-key handlers. Each one repeated behavior ui-sdk already ships and tests. Each one also stayed invisible to ui-sdk's agent bridge (`createAgent`), which reads component state and calls component actions. Keeping the library without using it costs bundle weight and gives nothing back.

## Decision

- Every interactive widget is built on the matching `@ui-sdk/react` component: select, menu, toggle, switch, checkbox, segmented control, listbox, combobox, autocomplete, command, collapsible, toolbar, hover card, tooltip, toast, dialog, popover, tree, date picker, and so on. Start from `web/node_modules/@ui-sdk/react/docs/llms.txt` and the component's page. Those docs ship with the installed version.
- Another library or hand-rolled markup is allowed only when ui-sdk has no component that fits. The commit body says why. Example: ui-sdk's `Drawer` is always an overlay sheet, so the docked `md:` sidebars (InfoDrawer, attachment info) stay as they are.
- A plain `<button>` with a simple `onClick` stays a native `<button>`. A plain text `<input>` that is not part of a widget stays a native `<input>`.

## Why plain buttons and inputs stay native

ui-sdk's own Button page says: "For a plain click handler, a native `button` is enough." Its `Button` adds a pending state for async actions, a slow-action announcement, and a way to stay focusable while disabled. The app's roughly 120 plain buttons need none of that. Moving them would be churn: a large diff and test changes with no new behavior. The same holds for standalone text inputs. The user chose this on 2026-11-25.

When a button or input does need what ui-sdk adds, use the ui-sdk part (`@ui-sdk/react/button`, `@ui-sdk/react/input`). Examples are an async save that must not submit twice, a disabled control that must stay focusable, or a field an agent should be able to set through the bridge.

## Styling

ui-sdk parts render unstyled. Style them with Tailwind through their `data-*` state attributes (`data-pressed`, `data-checked`, `data-open`, `data-highlighted`, ...) so they match the app in light and dark mode. The strict CSP in `AGENTS.md` still applies: no inline style attributes and no `<style>` tags.
