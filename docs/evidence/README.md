# P1 release evidence index

Audit date: 2026-09-22 (Asia/Seoul)

This directory indexes reproducible BoxSpec evidence. The current decision is in [`../release-checklist.md`](../release-checklist.md), and the exact requirements are in [`../p1-acceptance.md`](../p1-acceptance.md).

## Claim rules

An accepted claim records the command or operation, exit/result, environment, exercised boundary, and limitations. A file's existence, source review, typecheck, screenshot without provenance, supplied static fixture, or agent statement does not prove runtime behavior. `UNKNOWN`, `UNSUPPORTED`, `NOT RUN`, timeout, cancellation, missing output, malformed output, and tool error are never PASS.

Evidence states are:

| State | Meaning |
|---|---|
| VERIFIED | The cited run exercised the stated criterion |
| PARTIAL | Executed proof exists, but mandatory adjacent criteria remain open |
| IMPLEMENTED / UNVERIFIED | Production code exists without adequate execution proof |
| NOT RUN | Runnable in principle but not executed |
| BLOCKED | A named environment, client, identity or facility is unavailable |
| FAIL | The command ran and the criterion failed |
| STALE | Tested source, lockfile, contract, policy, profile, candidate or artifact changed afterward |

Counts from different suites are not added unless their cases are known to be disjoint. The independent-security count does not claim installer, hardware, client, or every product scenario.

## Current evidence inventory

| Area | Evidence record | Current accepted result | Limit that remains visible |
|---|---|---|---|
| Workspace/toolchain | [`../progress.md`](../progress.md), [`../compatibility.md`](../compatibility.md), [`sqlite-diagnosis.md`](./sqlite-diagnosis.md) | Final frozen install, root build/typecheck/test and Node/Electron SQLite smokes exit `0` | Packaged/transitive notices and installed artifact are separate |
| Core | [`core.md`](./core.md) | Typecheck/build exit `0`; 22/22; independent Core/canonical 6/6 | Browser, authority, candidate and apply belong to other boundaries |
| Bridge | [`bridge.md`](./bridge.md) | Build exit `0`; 10/10; official SDK runtime 1/1; actual Codex read probe exit `0` | OpenCode failed one attempt; Claude absent; packaged launcher open |
| Local IPC | [`local-ipc.md`](./local-ipc.md) | Typecheck/build exit `0`; Windows named-pipe suite 24/24; real SDK and desktop IPC smokes pass | Same-user process isolation is not claimed; clean-installed ACL run open |
| Change manager | [`change-manager.md`](./change-manager.md), [`partial-approval.md`](./partial-approval.md) | Latest direct suite 37/37; native apply/recovery plus safe whole-file child-candidate creation | Trusted dependency-closure/runtime/UI/E2E wiring remains open |
| Runtime and managed drift | [`runtime.md`](./runtime.md), [`source-drift-recovery.md`](./source-drift-recovery.md) | Strict build exit `0`; runtime 13/13; bounded managed contract/generated drift and restart paths pass | Installed package run remains open; arbitrary source-to-contract inference is unsupported |
| Native helper | [`safe-fs.md`](./safe-fs.md), [`native-debug.md`](./native-debug.md) | Canonical SHA-256 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`; 55/55 twice; native/path 27/27 | Signing/publisher and packaged invocation open; no same-user sandbox claim |
| Verifier | [`verifier.md`](./verifier.md), [`verifier-checks.md`](./verifier-checks.md) | Existing 11/11 plus accessibility/visual engines 8/8 with real Chromium | New engines are not wired into the full report/baseline persistence path |
| Desktop/editor | [`desktop.md`](./desktop.md), [`draft-canvas.md`](./draft-canvas.md), [`workspace-panels.md`](./workspace-panels.md) | Desktop build/typecheck; boundary 4/4; IPC smoke; live draft editor exercised in Electron; new compound commands/panels build | New compound commands/panels and native/hardware interaction lack final Electron proof |
| Electron E2E | [`e2e.md`](./e2e.md), `tests/e2e/artifacts` | Current JSON: 7 expected, 0 unexpected, 0 skipped, 76,983 ms | Production build on development host, not installed/signed/clean VM |
| Themes | [`themes.md`](./themes.md), [`theme-gallery.md`](./theme-gallery.md), [`theme-sources.md`](./theme-sources.md) | 6/6; 17/17 strict catalog; 17 local previews; real Electron apply/restart | Token interpretations; full product styling is outside this evidence |
| Diagnostics | [`diagnostics.md`](./diagnostics.md), `apps/cli/doctor-output.json` | CLI 6/6; real doctor exit `2` DEGRADED with truthful states | It is not a healthy-product or per-client-call result |
| Save performance | [`save-performance.md`](./save-performance.md) | Isolated SQLite-durable commands 8.94–50.77 ms; unchanged export 39.38 ms | Changed export 7.747–13.017 s; small samples are not p95 and no ≤500 ms source-sync claim is made |
| Packaging and updater | [`packaging.md`](./packaging.md), [`updater.md`](./updater.md) | Updater state machine typechecks and passes 10/10; final package build remains pending | Production updater ports/trust identities and all package/install campaigns remain open |
| Security | [`security.md`](./security.md), [`../security-review.md`](../security-review.md), [`../security-test-plan.md`](../security-test-plan.md) | Latest full independent gate 56/56; focused later suites recorded separately | Only named reproductions; remaining audit boundaries stay open |
| User workflow | [`../user-guide.md`](../user-guide.md), [`../runbooks`](../runbooks) | Links/UTF-8/commands/tool names checked; behavior claims link to runtime evidence | Documentation is not product execution by itself |

Active product integration for B03 editor commands, B09 accessibility/visual verification, B10 partial review, B12 project indexing, B13 adopted-web mapping and B15 updates remains **unaccepted** beyond the module evidence indexed above. Assignment or source presence is not implementation evidence. B10 specifically remains open until a trusted closure produces a new child candidate that is reverified, reviewed under a fresh nonce and applied in E2E.

## Current integrated run

The latest complete root ledger records:

| Operation | Result |
|---|---|
| Normal install followed by `pnpm install --frozen-lockfile` | exit `0` |
| Root `pnpm build` | exit `0` |
| Root `pnpm typecheck` | exit `0` |
| Recursive package tests | exit `0`; frozen baseline Core 22, Bridge 10, Local IPC 24, Change manager 31, Verifier 11, Themes 6, Runtime 4, CLI 6, MCP SDK runtime 1; total 115 |
| Full independent `pnpm test:security` | latest exit `0`; 56/56 |
| Later focused security runs | Runtime authority 7/7; theme negatives 2/2 |
| Later full runtime suite | strict build exit `0`; 13/13 in 59.39 seconds, including bounded managed drift and real verifier/browser/native apply |
| Later isolated additions | Change manager 37/37; verifier accessibility/visual engines 8/8; updater 10/10 | Module evidence only; no final integrated root/package claim |
| Electron Playwright | exit `0`; 7/7 in 76.98 seconds |

The current Electron result file is `tests/e2e/artifacts/results.json`, SHA-256 `2F7A15C0D9F37710FDFC6CF343A162A01191D8E124DF5E4DD4F47A1F268FDEA7`. It covers the editor/relaunch campaign, 20 edits, client-state UI, agent proposal and published context reread, and the theme gallery. It does not cover installed packaging, real Claude/OpenCode calls, code candidate approval/apply, managed source-drift UI, or native IME/DPI.

A later B10/B11 packaged candidate spec typechecks but is **UNRUN**: the frozen package did not yet contain `resources/verification-tools.json`. Its source presence cannot replace a PASS candidate/report/nonce/apply result.

## Required campaign indices

### Three projects × three screens × three clients

Release requirement: 27 complete cells. Each cell needs the real client version/protocol and connect, capabilities, context, task, candidate, verification/report, and cancel or trusted-review outcome.

- Complete accepted cells: **0 / 27**.
- Partial evidence: one temporary project/screen through actual Codex successfully called capabilities and context only.
- OpenCode 1.18.32 made one bounded Sol/high attempt and exited `1` with no stderr.
- Claude Code was absent.

Config generation or executable presence does not count as a cell.

### Twenty consecutive changes

- **Editor durability subcampaign: 20 / 20 VERIFIED.** Electron performed 20 consecutive UI edits, then three undo and three redo operations, saved and relaunched with the exact final revision/value.
- **Full implementation/apply subcampaign: 0 / 20.** There are not 20 distinct external-agent task/candidate/report/apply identities over the fixed structure.

The editor result is accepted for B02/B03 durability and only partial B16 evidence.

### False-PASS campaign

Verified negative examples include hard 260→320 policy violation, ancestor/top-level policy bypass, stale/tampered candidate and profile identity, transparent overlay hit interception, ambient-environment stripping, missing browser behavior before installation, unsupported required verifier checks, malformed/oversized MCP input, stale revision, foreign project, revoked grant, pre-cancel, timeout, invalid Core output, hardlink/junction/path escapes, wrong/replayed approval tokens, source/HEAD/full-manifest drift, and UNKNOWN recovery preservation.

No executed listed negative became PASS. The campaign is still **PARTIAL** because the complete §24 matrix is not indexed: missing-font, all visibility/clipping/overflow cases, shared-component regressions, low disk/antivirus/lock races, all installed-app failures, and all three real clients remain open.

### Installed app, native interaction, and recovery

| Campaign | Accepted status |
|---|---|
| Unpackaged production-build Electron editor | 7/7 VERIFIED on this host |
| Signed clean-VM install/launch/uninstall/reinstall | 0; BLOCKED/NOT RUN |
| Native Korean IME | NOT RUN; synthetic composition only |
| Windows 125/150/200% DPI and multi-monitor | NOT RUN |
| Native assistive technology/accessibility | NOT RUN |
| Module-level native apply/recovery | PARTIAL; helper 55/55, change-manager 31/31 and native/path 27/27 |
| Packaged app apply/crash/recovery | NOT RUN |
| Bounded managed contract/generated drift | VERIFIED in runtime 13/13; installed-app UI campaign remains NOT RUN |
| Arbitrary application source → contract inference | UNSUPPORTED by design; never reported resolved |

## Added user-scope evidence

### Agent-first live canvas

Accepted exercised path:

1. Official SDK subprocess submits the complete agent contract through stdio and authenticated local IPC.
2. A clean desktop auto-opens the isolated draft without import approval.
3. Playwright pointer resize and Ctrl multi-select/group edit stable-ID nodes.
4. **이 배치로 구현** publishes one trusted revision and creates the implementation handoff.
5. The external client rereads the new exact context and Electron relaunch preserves it.

The current evidence does not prove automatic external-session wake-up, stale-draft rebase, handoff reopening, ungroup, or keyboard-only reparent.

### Seventeen sourced themes

Accepted exercised path:

- 17 package-owned presets and 17 local generated token-study previews pass strict parsing.
- Search/mode/style filters and explicit application run in real Electron.
- Trusted theme ID resolution changes allowed presentation tokens and rendered color while preserving nodes, parents, order, geometry and locks.
- MCP context reread, save and relaunch preserve the chosen theme.

The source crawl records 13 direct HTTP 200 responses and four 403 responses. A blocked source is never rewritten as successful retrieval. Presets are original BoxSpec interpretations, not copied screenshots, CSS, or endorsements.

## Artifact and review hygiene

Large binaries may remain outside Git only when the evidence record includes stable path, byte size, SHA-256 and reproduction instructions. Never store credentials, pairing tokens, raw private-project content, or unredacted diagnostic bundles.

Module-owner evidence can establish its named boundary. Release status changes only after this audit verifies the exact source/artifact and preserves failures, skips, unsupported checks and environmental limits.
