# Workspace panels evidence

Status: helper and desktop host integration implemented; strict typecheck and production build passed. Final Electron interaction evidence is pending.

## Contract

`WorkspacePanels` accepts only three React subtrees:

```ts
export interface WorkspacePanelsProps {
  readonly left: ReactNode;
  readonly canvas: ReactNode;
  readonly right: ReactNode;
}
```

The component owns view presentation only. It does not access project, contract, draft, theme, IPC, or editor command state. All three supplied subtrees remain mounted when the viewport switches between columns and drawers, preserving canvas and inspector state.

## Desktop resizing and persistence

At viewports at least 1100 pixels wide and 720 pixels high, the workspace uses three columns with two seven-pixel resize separators.

- Left width is clamped to 200–360 pixels; default 232.
- Right width is clamped to 272–440 pixels; default 304.
- Pointer dragging uses pointer capture and restores document cursor/selection state on completion or unmount.
- Arrow keys resize by 8 pixels and Shift+Arrow by 24 pixels.
- Home and End select the documented minimum and maximum.
- Each focusable separator exposes `role="separator"`, vertical orientation, controls, current/minimum/maximum values, and visible focus state.

The only persisted value is versioned UI preference JSON under `boxspec.workspace-panels.v1`:

```json
{"version":1,"leftWidth":232,"rightWidth":304}
```

Parsing starts from `unknown`, requires a plain version-1 record, accepts only finite numbers, rounds them, and clamps both ranges. Missing, malformed, denied, or stale storage falls back to defaults. No domain data is stored.

## Compact drawers

When viewport width is below 1100 pixels or height is below 720 pixels, the canvas remains mounted as the workspace surface and both side panels become overlay drawers. Labeled `Screens & Layers` and `Inspect & Review` buttons expose `aria-controls` and `aria-expanded`.

Only the open drawer is visible, interactive, and exposed to accessibility APIs. It uses `role="dialog"`, `aria-modal`, a visible heading and close action, backdrop dismissal, Escape dismissal, focus trapping, and focus restoration to its opener. The implementation ignores Escape during IME composition and yields its document-level trap while a separate `aria-modal` dialog such as the theme gallery is open. Focus is moved safely when a window resize hides or reveals the side-panel layout.

The drawer is responsive within the workspace, scroll containment remains delegated to the existing panel children, and reduced-motion preferences disable its short slide transition.

## Stable selectors

| Selector | Purpose |
| --- | --- |
| `workspace-panels` | responsive root; exposes compact/drawer state and both persisted widths |
| `workspace-panel-left` | left pane/drawer |
| `workspace-panel-canvas` | persistent canvas pane |
| `workspace-panel-right` | right pane/drawer |
| `workspace-resizer-left` | left width separator |
| `workspace-resizer-right` | right width separator |
| `workspace-drawer-toggle-left` | compact left opener |
| `workspace-drawer-toggle-right` | compact right opener |
| `workspace-drawer-left` | left drawer content |
| `workspace-drawer-right` | right drawer content |
| `workspace-drawer-close-left` | left close action |
| `workspace-drawer-close-right` | right close action |
| `workspace-drawer-backdrop` | compact modal backdrop |

## Verification

From `apps/desktop`:

```text
node node_modules/typescript/bin/tsc --noEmit
```

Result on 2026-09-22 after host integration: exit 0.

```text
npm run build
```

Result on 2026-09-22 after host integration: exit 0. Vite transformed 26 modules and produced the renderer bundle; Electron main and preload bundles completed through esbuild.

Desktop replaced the direct `.workspace` grid with the helper around the original left/canvas/right subtrees. Final Electron verification must still cover pointer/keyboard resizing, persistence after relaunch, corrupt-storage fallback, compact drawer focus/Escape/restore, overflow bounds, and regression checks for canvas selection/theme application/Korean IME. These interaction cases are not claimed by the build checks above.
