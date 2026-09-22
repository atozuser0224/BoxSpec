# BoxSpec implementation progress

Updated: 2026-09-22 (Asia/Seoul)

This log distinguishes implementation evidence from the supplied static specification fixtures. `SPEC_VALIDATION_REPORT.json` is never used as proof that the product works.

## Current release status

P1 is not release-ready. The B00 workspace and shared contracts are implemented and reproducibly installed. The AI-authored live-draft loop, theme gallery, runtime/MCP integration, native managed writes, aggregate package suites, and source-workspace Electron E2E have real evidence. Isolated Windows packaging and the packaged trusted-verifier profile are still being completed. Unsupported, unexecuted, unknown, and stale checks are not PASS.

## B00 foundation

- Initialized a pnpm monorepo and Git repository without resetting, cleaning, stashing, or deleting source files.
- Preserved the supplied package under `spec/`: 27 source files were copied and compared to their corresponding originals immediately after copy; mismatches: 0.
- Published `@boxspec/shared` schema-aligned types, exhaustive errors, candidate/report/approval integrity bindings, service ports, role-specific IPC envelopes, desktop use cases, fixed canonical hashing, and an internal integrity-binding JSON Schema.
- Added strict TypeScript 7 configuration, ESM/NodeNext package convention, exact dependency pins, one lockfile, explicit pnpm dependency-build policy, architecture docs, and ADRs.
- Active `contracts/mcp-tools.json` clarifies all 15 output schema roots as objects for MCP SDK v2. The preserved `spec/contracts/mcp-tools.json` baseline is unchanged.

## Exact dependency/runtime line

| Component | Pinned/tested version | Current evidence |
|---|---:|---|
| Build Node | 24.19.0 | local executable reported version |
| Electron Node | 24.21.0 | runtime smoke through Electron 44.4.3 |
| pnpm | 11.19.0 | install and frozen install |
| TypeScript | 7.0.2 | shared/core/change-manager/verifier/bridge direct builds |
| Electron | 44.4.3 | binary launched; SQLite addon loaded |
| React / React DOM | 19.3.0 | pinned; desktop build passed before the final live-draft API addition |
| Vite / React plugin | 8.3.0 / 6.1.1 | pinned; sample typecheck passed |
| Vitest | 5.0.1 | pinned; package suites running independently |
| Playwright | 1.63.0 | pinned; verifier browser suite and final theme-aware desktop E2E passed |
| MCP server/client | 2.0.0 / 2.0.0 | pinned; actual SDK client/stdio/local-IPC/runtime test passed |
| better-sqlite3 | 13.0.3 | Node and Electron N-API load/query smoke passed |
| SQLite engine | 3.53.4 | reported by in-memory query |

`better-sqlite3@13.0.3` includes `prebuilds/win32-x64.node`, but on this host its implicit Windows gyp hook ran anyway and failed because Visual Studio C++ build tools are absent. This matches the upstream v13 Windows install defect. The workspace explicitly denies that erroneous build hook and relies on the bundled Node-API binary only after direct runtime proof. This is not an `--ignore-scripts` claim.

## Command and evidence log

| Command / operation | Exit | Evidence or result |
|---|---:|---|
| initial `Get-ChildItem -Force; rg --files` | 0 | confirmed specification-only starting folder and no Git repository |
| safe copy to `spec/` + per-file SHA-256 comparison | 0 | 27 copied files; 0 source/copy mismatches |
| `node/npm/pnpm/corepack/git --version` | 0 | Node 24.19.0, npm 11.17.0, pnpm 11.19.0, corepack 0.35.0, Git 2.55.0.windows.3 |
| first shared `pnpm --filter @boxspec/shared typecheck` | 0 | shared types compiled; this wrapper also reconciled the then-current install, so later direct checks supersede it |
| first `pnpm install --force` during recovery | 1 | pnpm had auto-added a duplicate `allowBuilds` YAML mapping |
| `pnpm install --force` after repairing build policy | 0 | 414 packages linked; esbuild postinstalls completed |
| normalized `pnpm install` with better-sqlite3 build allowed | 1 | `node-gyp` could not find Visual Studio C++ workload |
| `pnpm install --force` with bundled N-API policy | 0 | 309 packages linked; no native source build |
| direct Node in-memory SQLite query | 0 | SQLite 3.53.4; `select 42` returned 42 |
| Electron with `ELECTRON_RUN_AS_NODE=1`, loading core better-sqlite3 | 0 | Electron 44.4.3, Node 24.21.0, N-API 10; `select 42` returned 42 |
| final dependency reconciliation and `pnpm install --frozen-lockfile` | 0 | exact lock covers all 18 workspace projects; already up to date and Electron postinstall completed |
| packaging `pnpm deploy --legacy --prod` attempts | nonzero / unsafe side effect | pnpm pruned source workspace development links; packaging was stopped and source-root deploy is now forbidden |
| full node_modules quarantine followed by fresh `pnpm install --frozen-lockfile` | 0 | actual empty install restored 14 workspace links; representative shared/runtime/desktop/MCP links audited present |
| `node apps/desktop/node_modules/electron/install.js`; Electron version smoke | 0 / 0 | restored downloaded Electron artifact after the deploy damage; `electron.exe` reports 44.4.3 |
| later apps/mcp dev-dependency lock reconciliation + frozen install | 0 / 0 | lockfile remains reproducible |
| theme workspace/runtime dependency reconciliation + frozen install | 0 / 0 | 15 workspaces; runtime-to-themes and themes-to-core/shared links verified; Electron artifact retained |
| `python -m pip install -r spec/tools/requirements.txt` | 0 | installed pinned jsonschema 4.26.0 |
| preserved package `python tools/validate_spec.py` from `spec/` | 0 | all static schema/fixture checks passed; product runtime still untested by this command |
| active root `python tools/validate_spec.py` | 1 | original script recursively entered pnpm `node_modules` links and hit a missing vendor path; use preserved-package validation plus active contract tests |
| active MCP schema parse/count | 0 | 15 tools and 15 object-root output schemas |
| direct TS7 build: shared/core/change-manager/verifier/bridge | 0 each | current `dist` outputs created |
| direct TS7 typecheck: sample dashboard | 0 | CSS side-effect declaration fixed |
| direct TS7 typecheck: desktop/CLI/local-IPC/E2E | 0 each | strict TS7 checks pass after focused fixes |
| direct TS7 typecheck: runtime | 0 | live-draft, recovery, native-write, and trusted-theme adapter compiled in the final root typecheck |
| core direct Vitest | 0 | 22/22 passed; see `docs/evidence/core.md` |
| bridge direct Vitest | 0 | 9/9 passed, including schema/result validation |
| local-IPC direct Vitest | 0 | 19/19 passed, including Windows named-pipe auth, cancellation, app-down, and DACL checks |
| local-IPC final Windows suite | 0 | 24/24 passed after NETWORK-SID denial and final dependency rebuild |
| change-manager direct Vitest | 0 | 28/28 passed in the later integrated run |
| verifier direct Vitest | 0 | 10/10 passed |
| independent `node --test tests/security/*.test.mjs` | 0 | 37/37 passed |
| final independent security rerun | 0 | 56/56 passed, including helper races, live-draft/publish recovery, native managed-write recovery, trusted themes, injection negatives, and verifier descendant timeout |
| actual MCP v2 client -> stdio -> authenticated local IPC -> runtime test | 0 | 1/1 passed with the official client package |
| first final-freeze root build | 1 | newly added project-index exposed two real TS boundary errors; fixed before the successful final run |
| final root `pnpm build` | 0 | all 17 script-bearing projects across 18 workspaces built after the final CM/project-index/verifier changes; desktop renderer/main, runtime, MCP, verifier, updater, themes, and sample emitted |
| final root `pnpm typecheck` | 0 | all 17 script-bearing projects passed strict TS7 checks at the immutable package snapshot |
| root `pnpm test` first integrated run | 1 | core compiler test harness hit TS7 `TS5112`; fixed with `--ignoreConfig` and core reran 22/22 |
| intermediate runtime integration reruns | 1 | exposed stale policy scope, missing fixtures, native root identity, and missing-parent handling; each cause was fixed without converting failures to PASS |
| final-freeze recursive test attempt | 1 | adopted-web declared Vitest but had no tests; placeholder script and unused Vitest dependency were removed instead of using `passWithNoTests` |
| next recursive test attempt | 1 | project-index 8/9 exposed duplicate derived affected paths; derived set was deduplicated while duplicate user input remains rejected |
| final recursive `pnpm test` | 0 | 168 tests passed: shared 4, updater 10, core 24, bridge 10, project-index 9, local IPC 24, change-manager 37, verifier 24, themes 6, runtime 13, CLI 6, and actual MCP SDK 1 |
| shared live-draft declaration build/typecheck | 0 | list/open/update/publish desktop ports bind base hash/revision, draft revision, complete contract, and node-diff implementation handoff |
| isolated demo-project creation smoke | 0 | created a new repo only under ignored `build/`; repo-local Git identity used and no existing path overwritten |
| pre-theme desktop E2E | 0 | 6/6 in 59.1s; independent repeat 6/6 in 50.5s: relaunch, 20 edits, official SDK/pipe proposal, canvas editing, layout publication |
| final theme-aware desktop E2E | 0 | TypeScript check passed; Playwright Electron 7/7 in 76,983.18 ms; results SHA-256 `2F7A15C0D9F37710FDFC6CF343A162A01191D8E124DF5E4DD4F47A1F268FDEA7` |
| final native safe-filesystem artifact hash/size + Windows integration | 0 | 67,548,236 bytes; SHA-256 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`; stabilized suite 55 assertions |
| live public theme metadata crawl + catalog build | 0 | 17 source snapshots, 17 validated presets, and 17 local SVG token studies; bounded unauthenticated crawl and package-owned trusted catalog |
| `@boxspec/themes` typecheck/build/test/dist smoke | 0 | strict TS7 and build passed; 6/6 tests; presentation changed while protected geometry remained unchanged |
| shared packaged-verifier manifest declaration typecheck/build/test | 0 | 4/4: strict profile/tool/browser/fixture identities plus complete ordinal toolchain/browser execution-closure inventories; packaged factory and Electron-owned run remain pending |
| `@boxspec/adopted-web` final build/typecheck | 0 | compile-only static-analysis package; no tests or integration evidence were completed before final freeze and none are claimed |
| `@boxspec/project-index` final build/test | 0 | 9/9 tests after affected-path set repair; package is not yet composed into the production runtime |
| `@boxspec/updater` final build/test | 0 | 10/10 signed-envelope, replay, rollback, crash, and journal-integrity tests; production feed/signing and desktop integration remain unavailable |
| `git init` | 0 | new repository initialized; no source commit created automatically |

## Preservation note

The supplied `MANIFEST.sha256` does not validate its own `SPEC_VALIDATION_REPORT.json` on this machine; the manifest check reported that single mismatch in both the original package and its byte-identical copy. The copy itself was verified against the original files with zero mismatches before active implementation changes. The preserved package was not rewritten to conceal the upstream manifest inconsistency.

## Shared integrity decisions

- Candidate tree identity covers the complete immutable source snapshot used by verification, with a separate changed-path projection for review and apply.
- Verification binds project, task, candidate, base revision/commit/manifest, contract/effective/override hashes, policy, profile, fixtures, dependency lock, generator, report status, and evidence.
- Desktop approval uses a server-issued review nonce; the renderer cannot mint an approval record.
- Apply uses an opaque, single-use confirmation token and reloads the server-side plan by transaction ID.
- Recovery first returns a journal-bound nonce and classifies paths as BEFORE/AFTER/UNKNOWN. Every UNKNOWN path requires an explicit user decision; stale recovery evidence is rejected.
- Wire IPC does not accept a caller-selected principal. Identity is connection-bound and operations are role-specific allowlists.
- Canonical JSON uses fixed ordinal key/path ordering, three-decimal number normalization, UTF-8, and SHA-256. Locale-dependent sorting is forbidden for identity hashes.
- Agent contract proposals are isolated live layout drafts. They appear directly on a clean canvas, bind immutable base revision/hash plus a separate draft revision, and publish only through a trusted desktop action. Layout publication creates an implementation handoff; it never approves source code.
- The native helper identity is published once through `@boxspec/shared/native-tools`; runtime, desktop, tests, and packaging consume its protocol, paths, size, and hash rather than maintaining separate trusted constants.
- The packaged verifier manifest is parsed through `@boxspec/shared/verification-tools`. It binds `process.execPath`, trusted wrapper scripts, browser, five fixtures, fixed profile IDs, argv/environment/timeouts, hashes, and sizes. Separately hashed ordinal inventories bind every regular toolchain and browser support file; every asset path is resolved beneath `process.resourcesPath`.
- Theme gallery application resolves a renderer-supplied theme ID against a trusted local catalog. It may change presentation tokens but must preserve topology and layout geometry.

## Open release blockers

- The self-contained Windows safe-filesystem helper and change-manager integration passed their assertions; final packaged-path hash-pinned invocation is still required. No environment-variable bypass is acceptable.
- The production verifier is unavailable until packaging emits the complete trusted verification manifest/assets and an actual packaged Electron-owned verification run succeeds.
- `@boxspec/adopted-web`, `@boxspec/project-index`, and `@boxspec/updater` are isolated package foundations added at final freeze. Adopted-web is compile-only; project-index and updater have package tests but are not wired into the production desktop/runtime. Their presence is not a capability claim.
- Packaging must finish from an isolated `build/**` workspace. Running pnpm deploy from the source root is forbidden because both legacy and modern deploy modes were observed pruning the shared development install.
- Windows parent-directory concurrent reparenting cannot be described as fully eliminated without stronger relative-handle primitives and adversarial evidence.
- Installer is unsigned unless a real signing identity is available. Update/signing/clean-VM evidence remains open.
- Native managed saves were observed around 11 seconds in E2E; the B14 500 ms responsiveness target is not met or claimed.
- Three-client compatibility, 20 consecutive edits, crash recovery, IME/DPI, clean-VM, and pilot matrices remain unexecuted or incomplete.
