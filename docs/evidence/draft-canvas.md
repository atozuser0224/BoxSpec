# Draft canvas evidence

## Scope

`DraftCanvas` renders the complete agent-authored `EditorScreen` as named, stable-ID boxes. It is a controlled React component: selection, zoom, and the contract are inputs; every edit leaves the component as a typed command through `onCommand`. It does not invoke IPC or mutate a contract revision.

## Interactions

| Interaction | Gesture | Emitted command / effect |
| --- | --- | --- |
| Select | Click | Replaces selection |
| Multi-select | Ctrl-click | Toggles one stable node ID |
| Move | Drag or arrow keys | `move-node` with canvas-unit delta |
| Resize | Drag any of eight handles | `resize-node` with edge and canvas-unit delta |
| Group | Ctrl+G or Group button | `group-selected` with existing stable IDs |
| Ungroup | Ctrl+Shift+G or Ungroup button | Atomic `ungroup-selected`; removes the group and preserves child IDs/order |
| Align | Labeled mode selector and Apply button | Atomic `align-selected` for two or more supported boxes |
| Distribute | Labeled axis selector and Apply button | Atomic `distribute-selected` for three or more supported boxes |
| Reparent | Pointer drop, or keyboard-accessible parent selector and Move button | `reparent-node` with existing ID, new parent, and append order |
| Delete | Delete/Backspace or Delete button | `delete-node` for each top-level selected node |
| Duplicate | Ctrl+D | `duplicate-node`; the reducer owns new-ID generation |
| Create | Region tool drag | `create-region` with parent-relative bounds |
| Pan | Pan tool or Space-drag | Scrolls the canvas viewport only |
| Zoom | Slider or Ctrl-wheel | Calls `onZoom`; pointer deltas remain logical canvas units |

Nested selections are normalized so an ancestor and its selected descendant are not moved, grouped, reparented, or deleted twice. Drop targets exclude the moving node and its descendants. Root deletion and resize are disabled. Keyboard destructive actions ignore inputs, editable content, and active IME composition.

Align and distribute activate only when every selected node has the same parent, top-left anchor placement, and fixed width and height. Their reducers apply the compound geometry edit in one cloned contract, producing one revision and one undo step. Unsupported flow/fill selections keep both actions disabled and show `Arrange requires same-parent fixed anchor boxes.` Keyboard reparent accepts exactly one node and lists only different, non-leaf, non-descendant parents; it appends deterministically and preserves the node ID.

Selection outlines, resize handles, review outlines, and labels use inverse zoom sizing so their screen-space thickness remains stable. Every node exposes `data-node-id`, `data-testid="canvas-node-{id}"`, and selection state. Resize handles expose `data-testid="resize-{id}-{edge}"`; the active drop container exposes `data-drop-parent="true"`.

The structure bar exposes `align-mode`, `align-selection`, `distribute-axis`, `distribute-selection`, `ungroup-selection`, `reparent-target`, and `reparent-selection` test IDs. All controls are native buttons or labeled selects in the canvas focus order, so their complete operation is available without a pointer.

The contract's validated `color.background`, `color.surface`, `color.text`, and `color.accent` tokens are bound to canvas-only CSS custom properties. They style the canvas surface, boxes, labels, selection outlines, handles, and region preview without changing editor chrome or geometry. Only hexadecimal color values are accepted at this renderer boundary; invalid or missing values use deterministic defaults. The surface exposes `data-testid="draft-canvas-surface"`, `data-theme-id`, and `data-theme-revision` for computed-style acceptance checks.

## Verification

From the repository root on 2026-09-22:

```text
pnpm --filter @boxspec/desktop typecheck
Exit 0

pnpm --filter @boxspec/desktop build:renderer
Exit 0
Vite 8.3.0: 24 modules transformed; production bundle completed

pnpm --filter @boxspec/e2e test:e2e
Exit 0
6/6 passed in 50.5 s
```

The build includes the `App.tsx` draft-mode integration and serialized draft command queue. The Electron suite submitted a complete agent-authored layout through the external MCP bridge, observed it auto-open at draft revision 1, performed a real south-handle pointer resize and observed revision 2, Ctrl-selected two stable nodes, grouped them and observed revision 3, published the layout, and reread the resulting approved revision through MCP context. The test used actual UI gestures and runtime persistence rather than renderer state injection.

## Remaining limits

- Rename remains an inspector command rather than an inline canvas editor.
- Multi-node move and delete commands are emitted in sequence; the desktop command owner serializes them against the latest draft revision. Group, ungroup, align, and distribute are atomic.
- Align and distribute intentionally do not convert flow/fill layout into pixel anchors; unsupported selections remain visible and disabled.
- Real Electron coverage exercises pointer resize and grouping; pointer move and cross-container reparent remain implemented but lack equivalent persisted E2E evidence.
- The new ungroup, align, distribute, and keyboard-reparent controls have typecheck/build coverage; their focused persisted Electron cases are assigned to the E2E owner.
