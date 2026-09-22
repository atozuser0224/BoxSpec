# Desktop editor evidence

Date: 2026-09-22  
Scope: `apps/desktop/**`

## Delivered path

The Electron main process owns one `@boxspec/runtime` instance and one authenticated
`@boxspec/local-ipc` host. The renderer can only reach the typed methods exposed by
`src/preload/preload.ts`; there is no generic invoke surface.

The running UI supports:

- creating and reopening a real project and screen;
- editing the complete layout contract, policies, names, sizes, hierarchy, and stable-ID nodes;
- persisted undo, redo, save, and cold restart;
- direct display of the newest agent-authored complete layout draft on a clean canvas;
- isolated draft drag, resize, delete, atomic group/ungroup, reparent, align,
  distribute, region, and inspector edits;
- publishing through **이 배치로 구현**, producing an `AWAITING_AGENT` handoff and a single approved revision increment;
- review inspection and desktop-only approve/apply when the full sealed verification closure passes;
- recovery inspection followed by a nonce-bound strategy and an explicit decision for every `UNKNOWN` path;
- source-drift inspection with explicit propose-contract, restore-contract, and
  stop-managing resolution actions;
- separate configuration-diff, apply, pairing, and diagnostic states for Codex, Claude Code, and OpenCode.
- a searchable, filterable 17-preset design-theme gallery whose CSS token studies
  never load remote preview content; applying a trusted preset preserves node
  topology and geometry and follows draft or approved-screen revision rules.
- persisted 200–360 px left and 272–440 px right split panels, with accessible
  drawers below 1100×720 and IME-safe keyboard resizing.

The direct agent draft flow has no approve/import inbox. A new draft auto-opens only
when the current canvas is clean. Otherwise the UI preserves the active work and shows
`New AI layout draft available`. Publication is separate from code review and apply.

## Electron boundary

`BrowserWindow` uses `nodeIntegration: false`, `contextIsolation: true`, and
`sandbox: true`. Main validates the exact window, `webContents`, main frame, origin,
and bundled file URL for every IPC call. Navigation, popups, downloads, webviews,
permissions, and unexpected protocols are denied. Packaged builds always use the
bundled renderer and ignore `BOXSPEC_RENDERER_URL`. Candidate HTML is never inserted
into the trusted renderer; review uses typed data and inert evidence references.
The packaged CSP has `connect-src 'self'`; Vite loopback HTTP/WebSocket access is
injected only while the development server is running.

Review approval is fail-closed unless the summary is `PENDING_APPROVAL`, both report
and verification are `PASS`, every check is `PASS`, all candidate/report/evidence
hashes match, and the runtime supplies a fresh nonce. Recovery IPC rejects extra
fields, unknown enums, duplicate paths, more than 512 decisions, paths over 1,024
characters, and aggregate path data over 65,536 characters.

## Verification

Commands were run from the repository root unless a directory is shown.

| Command | Result |
| --- | --- |
| `pnpm --filter @boxspec/runtime build` | exit 0 |
| `pnpm --filter @boxspec/desktop typecheck` | exit 0 |
| `pnpm --filter @boxspec/desktop build` | exit 0; Vite 22 modules, renderer/main/preload emitted |
| `node --test tests/security/desktop-boundary.test.mjs` | exit 0; 4/4 passed |
| `node apps/desktop/scripts/ipc-smoke.mjs` | exit 0 in 2.60 s |
| `pnpm exec vitest run test/runtime.integration.test.ts -t "persists authoring state"` from `packages/runtime` | exit 0; 1 passed, 3 skipped |
| `node node_modules/playwright/cli.js test --config playwright.config.ts` from `tests/e2e` | exit 0; 7/7 passed in 76.98 s |

The authenticated IPC smoke creates a temporary Git project, creates a durable
15-minute runtime grant, starts a current-user/SYSTEM-only Windows named pipe, writes
an ACL-protected pairing profile, authenticates a separate profile client, and calls
the real `boxspec_get_capabilities` runtime tool.

On Windows the desktop always supplies the runtime with the trusted
`NATIVE_SAFE_FS_MANIFEST` from `@boxspec/shared/native-tools`. Development resolves
the canonical repository helper and packaged builds resolve
`resources/native/boxspec-safe-fs.exe` relative to the installed executable. The
runtime verifies the manifest SHA-256 before every managed source write. A missing or
altered helper cannot fall back to lexical writes; local database editing remains
available while save, client configuration, and apply fail closed.

The targeted runtime integration proves that an agent proposal becomes an isolated
`AWAITING_USER` draft at target revision `rN+1`, user edits advance only the draft
revision, publish advances the approved contract exactly once, the handoff reports
the affected stable node IDs, a revoked grant cannot replay the proposal, and the
published revision survives runtime restart.

The Electron campaign writes its reproducible screenshots and logs to
`tests/e2e/artifacts`. It launches the production build with an isolated
`BOXSPEC_DATA_DIR` and `LOCALAPPDATA`; only the native Windows folder chooser response
is replaced because Playwright cannot operate that dialog. Project creation, preload,
IPC, runtime persistence, official MCP SDK stdio, authenticated named pipe, and the
renderer remain real.

The seven Electron cases cover the fixed three-pane geometry, dark 13px workspace,
hard/soft/free policy round trips, composition guards, Escape cancellation, keyboard
undo/redo/save, 20 consecutive edits, cold relaunch, three client config formats,
official SDK proposal over authenticated IPC, automatic draft display, pointer resize,
Ctrl multi-select/group with stable IDs, trusted publication, external context reread,
and a filtered theme selection whose rendered canvas colors and design tokens change
while node IDs, parents, order, layout, placement, and locks remain unchanged. Fifteen
screenshots plus renderer logs and MCP request/results are retained under
`tests/e2e/artifacts`.

The desktop composes verification only through the verifier-owned authoritative
loaders re-exported by `@boxspec/runtime`. Production reads the hash-sealed closure
from `resources/verification-tools.json`; development reads the same layout from
`build/verification-dev`. Missing or altered assets leave the editor online while
verifier capability stays unavailable. The consumer is built and type-checked; the
bundle producer and full verify/review/apply Electron campaign remain pending.

## Current limits

- Client configuration written state is distinct from a proven live handshake. The
  diagnostic remains `handshake unverified` until a client actually connects.
- Accessibility and screenshot-baseline verification remain unsupported verifier
  checks and therefore cannot be promoted to `PASS`.
- The automated suite does not drive the native Windows directory chooser or prove a
  signed installer on a clean machine.
- Pointer resize currently has exact geometry for agent-authored fixed-size,
  anchor-positioned nodes. Converting flow/fill nodes uses the editor's bounded
  fallback geometry and can visibly jump.
- Editor commands reported durable local SQLite completion in 8.94–50.77 ms. The UI
  labels this `LOCAL SAVED · SOURCE PENDING`, shows `EXPORTING` during managed source
  export, and shows `SOURCE SYNCED` only after `saveProject` finishes. Measured source
  export took roughly 7.7–13.0 seconds, so the 500 ms target applies only to local
  durability and remains unmet for source export.
- A packaged verifier bundle and clean-machine full verify/review/apply campaign have
  not yet been produced; verifier capability remains unavailable without that trusted
  closure.
