# Electron editor E2E evidence

This document records tests executed against the built Electron application. The repeatable suite is under `tests/e2e/`; its state, copied project, MCP profiles, logs, traces, SDK requests/results, and screenshots are confined to `tests/e2e/artifacts/`.

## Automated boundary

The suite launches the real Electron 44.4.3 main/preload/renderer build with Playwright's Electron driver and an isolated `BOXSPEC_DATA_DIR`. It exercises preload validation, trusted renderer IPC, runtime, SQLite command storage, the React editor, and restart. The project is a Git-initialized copy of `samples/react-dashboard` under the artifact directory.

The agent-first test uses an official MCP SDK client as a separate Node process. It launches `apps/mcp/dist/index.js`, communicates over stdio, and crosses the authenticated Windows named-pipe host owned by the running Electron process. Electron issues the scoped pairing profile through its trusted preload operation into test-owned `LOCALAPPDATA`. No test-only production role or IPC bypass is added. Retained request/result files show a whole-contract proposal at approved revision 33, `AWAITING_USER`, user pointer editing, trusted UI publication to revision 34, and a subsequent external `boxspec_get_context` read of revision 34.

Playwright cannot drive Electron's native Windows folder chooser. The suite replaces only `dialog.showOpenDialog`'s selected path with the isolated fixture path. Project creation, canonical path validation, trust handling, and persistence still cross the real application boundary. The native chooser remains unverified.

Korean text and synthetic composition events exercise composition guards. This does not prove a native Korean IME. Windows 125%, 150%, and 200% DPI, multi-monitor movement, clean-VM behavior, and native assistive technology remain separate tests.

## Latest complete run — 2026-09-22

| Command | Exit | Result |
| --- | ---: | --- |
| `cd packages/runtime; node node_modules/typescript/bin/tsc -p tsconfig.json` | 0 | Runtime production build emitted the final draft API. |
| `cd apps/desktop; npm run build` | 0 | Vite renderer and bundled Electron main/preload built. |
| `cd tests/e2e; node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 0 | E2E harness typecheck passed. |
| `cd tests/e2e; node node_modules/playwright/cli.js test --config playwright.config.ts` | 0 | 7/7 serial Electron tests passed; JSON duration 76.98 seconds. |

The tests prove:

1. Real project/screen creation; 13px dark editor; 232px/304px panels; 64px header, 260px sidebar, and fill main; hard/soft/free transitions; revision increments; Korean composition/shortcut guards; Escape cancellation with no value or revision change; undo and save.
2. Electron relaunch from isolated persisted state at 1100x720.
3. Twenty consecutive UI edits with exactly one revision per edit, followed by three undo and three redo operations.
4. A second relaunch preserving the twentieth edit and exact final revision.
5. Honest empty-review presentation and separate Codex, Claude Code, and OpenCode config-written versus handshake-unverified states.
6. External SDK whole-contract proposal through stdio and authenticated local IPC; automatic live-draft display; real Playwright pointer resize from agent-authored header height 72 to 91; Ctrl multi-select and grouping with a stable group ID; trusted **이 배치로 구현** publication; visible `AWAITING_AGENT` handoff; external context reread at revision 34; and another Electron relaunch preserving the revised layout.
7. The real 17-preset theme gallery: Escape close/reopen, search + mode + style filters, explicit selection/application at 1100x720, revision 34→35, token and computed canvas-color changes, exact preservation of IDs/order/parents/layout/placement/locks, official SDK context reread of `theme_atlassian-teamwork`, native save, and Electron relaunch persistence.

All retained renderer logs contain zero `pageerror` or `console.error` entries. SDK launcher stderr is empty in the retained calls.

## Packaged candidate/apply case — prepared, not executed

After the seven-case run, an eighth serial case was added for the installed production boundary. It is designed to launch `build/windows/unpacked/BoxSpec-win32-x64/BoxSpec.exe` with fresh test-owned `APPDATA`, `LOCALAPPDATA`, `TEMP`, and `TMP`; assert the packaged verifier/review/apply capabilities; create a second fresh Git copy of `samples/react-dashboard`; pair from the trusted renderer; and use the official MCP SDK against the packaged executable's `--mcp-stdio` entrypoint. The intended sequence is `boxspec_start_task` → `boxspec_propose_patch` → `boxspec_submit_candidate` → `boxspec_verify_candidate` → `boxspec_get_task`/`boxspec_get_report` → `boxspec_request_review` → visible review → **Approve and apply**. Assertions cover all-PASS `schema`, `policy`, `layout`, `types`, `build`, `interactions`, and `integrity` checks; candidate/report hash equality; exact source bytes; and consumed review-token and approval records.

The current E2E source passes `node tests/e2e/node_modules/typescript/bin/tsc -p tests/e2e/tsconfig.json --noEmit` with exit 0. The packaged case was not started: at final freeze, `BoxSpec.exe` existed but its authoritative sibling `resources/verification-tools.json` did not. Packaging explicitly marked the unpacked tree stale and prohibited testing it until the trusted toolchain/browser/fixture bundle was sealed. The development launch now asserts `capabilities.verifier === false` with the exact reason `Trusted verification tools are unavailable in this installation.`; this assertion is typechecked but also awaits the next permitted regression run. No packaged verification, review, approval, native apply, nonce consumption, or new screenshots are claimed here.

## Evidence identities

The Playwright JSON result is `tests/e2e/artifacts/results.json`, SHA-256 `2F7A15C0D9F37710FDFC6CF343A162A01191D8E124DF5E4DD4F47A1F268FDEA7` (`expected: 7`, `unexpected: 0`, `skipped: 0`).

The final persisted runtime state is `tests/e2e/artifacts/state/runtime-state.json`, SHA-256 `17F22A4EFE1EF115C0353F8BA05E08C724FB60950A8BBF505AC87187D2CCA9BF`. The project SQLite store is SHA-256 `DE6F41FFE40E66FDFDE034F5F717C22968428642FAE7DDE92F1E880121A6D95D`.

External MCP evidence:

- Proposal request: `mcp-boxspec_propose_contract_change-request.json`, SHA-256 `DD75D5BEBC4BE88D34031CD4A808A7F8B5E5344EDA8851DED432F4B76CD43A7D`.
- Proposal result: `mcp-boxspec_propose_contract_change-result.json`, SHA-256 `952A7234A854171F33B1816C465B162F965408524D6FCBFE2199C7AB0C66D34A`; proposal `proposal_ff0772a707d744fbacd9c0fa7a30a975`, base revision 33, `AWAITING_USER`.
- Draft context request/result: SHA-256 `CC2671ECE3989CBC3663DEB46CA17E79527A4D5B99DADF3A586F87B27E623CCA` / `E58D13B2789F8B5B2EF43AACF6379EBAC11EBFA67051CC457AC55CEC9E1E78E9`; revision 34, context hash `36c94733a423551036ee01d39ba67fa9c42b8bc67c59b504276a5b32c1cb0359`, contract hash `f335dfd2510ada19e24e5cbfb97773f21c1d0969536784469bff3f7bf4b89896`, header height 91, group `group_26400fda7c6e4d22886e5f444ca97985`.
- Theme context request/result: SHA-256 `614853D23E101DB0E9F06A2E9855E33CC534D3A97417C8CBDEBE788F2F99E07D` / `967957893624183043B1941FEA134883CD62AFA27AE2C008C5CDB31B08A2E71B`; revision 35, context hash `2f061eafab39dca91d905d44aad8fc967519ae819bbc0f65e9bf0237a15af5c6`, design system `theme_atlassian-teamwork` revision 2 with 11 tokens.

Key real-app screenshots:

- `02-editor-saved.png`: `C3D1D23E35DA474B958B50186D47E5A2576137D2DF75096F9E9BB6577BB7DE82`
- `05-twenty-edits-undo-redo.png`: `87ADFA7EC8D8CCAE4D5584C6C319422048A40DF9EEFE7D60AC48DF744348D34C`
- `07-three-client-config-written.png`: `360C160E5D567C4F26FB358FE54885488D18FBFDD6F667C8172030A18835F5AD`
- `09-agent-draft-auto-open.png`: `071B6EB6E24CAFF72E52F600EE2979B62B5075D4370F99D9CEE0C38D1C54B13E`
- `10-agent-draft-pointer-edited.png`: `9D62ED93A13DB4E7E85E759035AE3DC52BE98803B1F003984044E5EBC681613B`
- `11-layout-published-handoff.png`: `F7055060A3C4AEEE5E8DC06B170F4632AD3419351FF6D23F55AD381CD8D8CD40`
- `12-layout-published-relaunch.png`: `B06D6B63224F385FE8AAC3010C31265C01F020A2B0FE45CABC33DCE04CBF5C83`
- `13-theme-gallery-filtered.png`: `0143CD0779E217C9F2413EC5C3DAC6E67DE3F9CADD97C254998A0F995CDE165D`
- `14-theme-applied.png`: `562F752FA2E1842BA5F9967A1BEB821B1BB46595A099D1EF055951EEF6CF6182`
- `15-theme-relaunch-persisted.png`: `7F45D07E3E6F3A2C70BAB5586D6B671FF27416EDBA475306CE47D3A7635AC6FB`

## Acceptance mapping and limits

- **B02:** revision, undo/redo, save, SQLite persistence, and cold relaunch are exercised. Crash replay/reconciliation is not exercised here.
- **B03:** the three-pane canvas, sizing, inspector edits, policies, pointer resize, multi-select/group, keyboard guards, 20 edits, and reopen are exercised. Draw-region, pointer move/reparent, align/distribute, and every keyboard alternative are not all covered by this campaign.
- **B06:** one official external SDK client crosses the production stdio/pipe boundary for proposal and context read. The three config formats are written and displayed honestly; actual Claude Code and OpenCode handshakes and the full per-client route matrix remain unverified here.
- **B10/B11:** the empty review is honest. A real packaged candidate/identity/review/approval/native-apply case exists in the harness but remains unexecuted because the authoritative packaged verification manifest was absent at final freeze. Candidate diff/violations, approval/apply, source drift, and crash recovery therefore remain unverified by Electron evidence.
- **B12:** one catalog theme is filtered, explicitly applied, rendered, read through MCP, saved, and reopened while structural layout identity is preserved. Source-link browser navigation and all 17 visual variants are not exhaustively exercised here.
- **B14:** synthetic composition, keyboard focus, Unicode/space paths, 1100x720, and cold restart are covered. Native Korean IME, DPI variants, multi-monitor, accessibility, and performance/memory targets remain unverified.
- **B16:** the 20-change authoring campaign passes without silent revision loss. Installed-app proof, 3 projects × 3 screens × 3 real clients, verified candidate/apply, false-PASS negative matrix, source-drift recovery, clean VM, and crash recovery remain release blockers.

No missing, unsupported, failed, or unexecuted check is reported as PASS by this evidence.

## Reproduction

After the normal workspace build, run:

```powershell
cd tests/e2e
node node_modules/playwright/cli.js test --config playwright.config.ts
```

The run recreates `tests/e2e/artifacts/`. It does not write pairing profiles or client configuration into the real user profile.
