# BoxSpec P1 release evidence checklist

Audit date: 2026-09-22 (Asia/Seoul)

This is the release decision ledger. The normative requirements remain in [`p1-acceptance.md`](./p1-acceptance.md); evidence claim rules and campaign counts are in [`evidence/README.md`](./evidence/README.md). Static specification validation, source presence, or an author's assertion is never treated as runtime proof.

## Status vocabulary

- **VERIFIED:** the cited command ran successfully and exercised the stated criterion.
- **PARTIAL:** meaningful implementation and execution evidence exists, but at least one mandatory criterion remains open.
- **IMPLEMENTED / UNVERIFIED:** production code exists without sufficient execution evidence.
- **FAIL:** an executed mandatory target did not pass.
- **BLOCKED:** a named environment, client, signing identity, or external facility is unavailable.
- **OPEN:** implementation or release evidence is still required.
- **OUT OF P1:** excluded from the release claim.

Only VERIFIED closes a criterion. A green module suite does not close its entire B item when required product, client, installer, hardware, or negative-matrix evidence remains absent.

## Executive release gate

**P1 release status: NOT READY.**

The source build, integrated package suites, real Electron editor, official MCP SDK path, actual Codex read path, trusted verifier, native guarded apply, agent-first live layout draft, and 17-theme gallery all have executed evidence. The latest frozen root ledger records install/frozen-install, build, typecheck, and recursive tests at exit `0`; that baseline contains 115 passing tests. The current Electron artifact records 7/7 tests in 76.98 seconds. The latest independent security gate records 56/56, with later module additions recorded separately.

Release remains blocked by both implementation and environment gates. The most material implementation gaps are parts of the required editor command set, accessibility/visual-baseline verification, spatial/dependency/asset review, adopted mode, partial approval, update/rollback support, and the save-latency target. Environment and campaign gates include signing, clean-VM installation, native Korean IME/DPI/multi-monitor/assistive-technology runs, two absent or failing real clients, three projects × three screens × three clients, and an installed-app vertical recovery and managed-drift run.

## Current B00-B16 matrix

| ID | Current state | Accepted executed evidence | Mandatory open gate |
|---|---|---|---|
| **B00** | **PARTIAL** | Exact pins and lockfile; fresh empty `pnpm install --frozen-lockfile` exit `0`; Node and Electron SQLite 3.53.4 query smokes exit `0`; root build/typecheck/recursive tests exit `0`; compatibility and direct-license records exist. See [`progress.md`](./progress.md), [`compatibility.md`](./compatibility.md), and [`sqlite-diagnosis.md`](./evidence/sqlite-diagnosis.md). | Final packaged/transitive license inventory and notices are not proved. Prescribed `editor-domain`, `layout-engine`, `compiler-web`, `project-index`, and shared-UI workspace boundaries are absent or folded into other packages without a recorded scope decision. Packaging composition remains in progress. |
| **B01** | **PARTIAL, high coverage** | Core typecheck/build exit `0`; Core 22/22; independent Core/canonical security 6/6; closed schema, semantic negatives, ordinal canonical hashes, policy boundaries, migrations, and exact future-major read-only values are exercised. See [`core.md`](./evidence/core.md). | The release index does not yet enumerate every required semantic/capability negative and representative breakpoint case as a complete fixture matrix. |
| **B02** | **PARTIAL** | Real SQLite restart/history/revision/idempotency/undo/redo/import isolation tests in Core 22/22; Electron performs 20 edits, undo/redo, save and cold relaunch. Runtime 13/13 plus the bounded drift evidence prove semantic JSON reconciliation, isolated import drafts, managed generated restore/unmanage and restart persistence. See [`runtime.md`](./evidence/runtime.md) and [`source-drift-recovery.md`](./evidence/source-drift-recovery.md). | Crash-at-every-Core-persistence-boundary and failed-export reconstruction are not fully indexed. Arbitrary TypeScript/CSS-to-contract inference is explicitly unsupported rather than silently resolved. |
| **B03** | **PARTIAL / ACTIVE** | Desktop build/typecheck exit `0`; Electron 7/7 proves the three-pane editor, policy round trips, 20 edits, keyboard/composition guards, resize, multi-select/group, save and relaunch. Ungroup, align/distribute, keyboard reparent and responsive resizable/drawer panels are implemented and build/typecheck. See [`draft-canvas.md`](./evidence/draft-canvas.md) and [`workspace-panels.md`](./evidence/workspace-panels.md). | The new compound commands and panels have no final Electron interaction/relaunch evidence. Full draw/move/cross-container reparent E2E and native IME remain unverified. |
| **B04** | **PARTIAL** | Core 22/22 and dist smoke prove deterministic three-file React output, hashes, fixed 64/260/fill output, stable node selectors, and generated TSX syntax. Verifier builds the sample. | Executable flex/grid/overlay golden fixtures and explicit unsupported-capability fixtures are not fully evidenced. Complete prevention of slot/global geometry escape is not proved as a compiler-only criterion. |
| **B05** | **PARTIAL, strong Windows path evidence** | Local IPC 24/24; change-manager 31/31; independent native/path 27/27; canonical helper two consecutive 55/55; protected profile/pipe DACL, grant revocation, traversal/device/ADS/case/junction/hardlink/root-swap and new-parent handling pass. See [`local-ipc.md`](./evidence/local-ipc.md), [`change-manager.md`](./evidence/change-manager.md), and [`safe-fs.md`](./evidence/safe-fs.md). | Native folder chooser is mocked in E2E. Low-disk, antivirus/contention, every quoting combination, LFS/submodule policy, and clean-installed permission behavior remain open. No same-user OS sandbox is claimed. |
| **B06** | **PARTIAL** | Bridge build and 10/10; local IPC 24/24; official MCP v2 subprocess → stdio → restricted named pipe → runtime 1/1; exact 15 tools and negative protocol cases; actual Codex CLI Sol/high capabilities and context calls exit `0`. Three config syntaxes are generated and displayed separately from handshake state. See [`bridge.md`](./evidence/bridge.md). | OpenCode's one real Sol/high attempt exited `1`; Claude Code is absent. Neither has a successful handshake. Full connect/read/start/submit/verify/report/cancel through all three clients and packaged signed launcher proof remain open. |
| **B07** | **PARTIAL** | Change-manager 31/31 uses real temporary Git repositories/worktrees and covers complete immutable snapshots, mutation, scope, identity, stale source, deletions, revocation and native application. | Explicit LFS/submodule/unsupported-monorepo diagnosis, concurrent lease campaign, and a dedicated original-tree-unchanged artifact are not fully indexed. |
| **B08** | **OPEN** | Compiler, worktree, bridge, context and candidate primitives run independently; actual Codex reads context. | No real external client has implemented a new production slot and submitted it through the complete worktree → candidate → verification → review path. Existing proposal/context reads do not satisfy this requirement. |
| **B09** | **PARTIAL / ACTIVE, real browser** | Existing verifier 11/11 and real Chromium evidence cover render/geometry/interaction failures. New accessibility and sealed visual-baseline engines typecheck and pass 8/8 module tests with real Chromium, including deliberate FAIL/UNSUPPORTED/STALE cases. See [`verifier.md`](./evidence/verifier.md) and [`verifier-checks.md`](./evidence/verifier-checks.md). | The new engines are not wired into the full verifier/report pipeline or approved-baseline persistence. Missing-font, hidden/0x0, clipping/overflow, transformed movement, and shared-component regression are not a complete executed matrix. |
| **B10** | **PARTIAL / ACTIVE IMPLEMENTATION** | Change-manager now passes 37/37 and `createSubsetCandidate` proves a new full snapshot/tree identity, parent authority invalidation, whole-file subset safety and fresh-verification requirement. See [`partial-approval.md`](./evidence/partial-approval.md). | Trusted project-index closure, runtime child verification, server-issued change IDs, ReviewPanel and new-child verify → fresh review → apply E2E are not integrated. [`review-panel.md`](./evidence/review-panel.md) explicitly records the UI as deferred. |
| **B11** | **PARTIAL, strong native apply evidence** | Canonical helper 55/55 twice; native/path 27/27; change-manager 31/31; public native apply, exact bytes, journal cleanup, injected crash, restart classification/restoration, BEFORE/AFTER/UNKNOWN preservation and APPLIED reconciliation are covered. Runtime 13/13 proves bounded managed contract/generated drift preflight, import-draft/restore, whole-unit restore/unmanage and restart behavior without conflating CM recovery. | `UNKNOWN` overwrite decisions correctly remain fail-closed and require explicit recovery. Low-disk, antivirus/locked-file, forced process termination at every packaged multi-file stage, and installed-app drift/recovery remain open. |
| **B12** | **PARTIAL / ACTIVE through added theme scope** | `@boxspec/themes` typecheck/build and 6/6; 17 trusted presets and 17 local token studies; theme application preserves topology/geometry/policy; Electron 7/7 changes tokens/rendered color, rereads context and persists across restart. See [`themes.md`](./evidence/themes.md) and [`theme-gallery.md`](./evidence/theme-gallery.md). | Project asset/dependency indexing is assigned but not yet accepted. Baseline/candidate spatial vectors and evidence linkage, dependency closure integration, asset hash/license/thumbnail review, and unrelated-name collision tests remain open. The 17-preset gallery is not evidence for an approved three-candidate comparison flow. |
| **B13** | **OPEN / ACTIVE** | Managed-mode stable IDs and regression guards have partial evidence. A bounded adopted-web mapper is assigned. | No adopted/reference artifact has been accepted. Minimum mapping patches, stable dynamic instance keys, measurement-based guarantee labels, and shared-component multi-screen regression remain open. |
| **B14** | **PARTIAL; 500 ms target not closed** | Stable error envelopes, bounded MCP payloads/concurrency, synthetic composition guards, Unicode/space paths, keyboard focus behavior, 1100×720 relaunch, and honest unsupported states are exercised. A real isolated sample measured SQLite-durable editor commands at 8.94–50.77 ms and unchanged export at 39.38 ms. Desktop source now distinguishes local durability from export pending/synced. See [`save-performance.md`](./evidence/save-performance.md). | The sample is not a p95 UI confirmation benchmark. Changed source export takes 7.747–13.017 seconds because 15–25 one-shot native helper processes each rehash a 67 MB executable; no ≤500 ms source-sync claim exists. Native Korean IME, 125/150/200% DPI, multi-monitor, assistive technology, contrast, full resource/usage accounting and reference-machine memory/latency report remain open. |
| **B15** | **PARTIAL / ACTIVE** | Doctor typecheck/build and 6/6; real doctor exits `2` DEGRADED. The isolated updater decision/recovery engine typechecks and passes 10/10, including signature/tamper/channel/downgrade/rollback cases. See [`updater.md`](./evidence/updater.md). | Integrated package/smoke remains pending after a concurrent-source integrity abort. Updater production ports, signing identity/key/publisher policy, network/feed/install composition and external update campaign are absent; clean VM, offline first run, packaged verifier/client and uninstall/reinstall are unproved. See [`packaging.md`](./evidence/packaging.md). |
| **B16** | **OPEN release gate** | Root recursive 115-test baseline exits `0`; latest independent security gate is 56/56; focused late suites cover runtime authority, themes, verifier engines and updater; final runtime 13/13; Electron baseline 7/7; 20 consecutive editor edits; real false-PASS negatives; exact candidate/report/apply bindings, native crash recovery and bounded managed-drift recovery at module/runtime level. | No installed-app vertical path, 3×3×3 client/project/screen campaign, 20 full candidate/apply cycles, complete §24 negative matrix, native IME/DPI/clean-VM campaign, or packaged recovery/drift campaign. Release cannot be claimed. |

## Added user scope

These additions do not waive B00-B16 requirements.

| Added scope | State | Evidence | Open boundary |
|---|---|---|---|
| Agent-first live layout canvas | **VERIFIED for the exercised path** | Runtime draft tests; Electron 7/7 submits a full proposal through official SDK/IPC, auto-opens it, pointer-resizes and groups stable-ID nodes, publishes through **이 배치로 구현**, rereads the new MCP context, and relaunches. | No automatic wake-up of an arbitrary external client session, stale-draft rebase UI, handoff reopen UI, ungroup, or keyboard-only reparent. |
| 17 sourced design themes | **VERIFIED for catalog/gallery/apply path** | Themes 6/6; 17/17 strict catalog load; 17 local previews; Electron theme test changes trusted tokens and computed color while preserving geometry, context and restart. Source crawl recorded 13 direct HTTP 200 and four explicit 403 results. | Presets are BoxSpec token interpretations, not copied source designs. The compiler does not turn every token into complete product styling. |

## Fresh accepted evidence ledger

| Evidence | Command / result | Accepted claim |
|---|---|---|
| Workspace integration | final `pnpm install --frozen-lockfile`, root `pnpm build`, root `pnpm typecheck`, recursive `pnpm test`: exit `0` | Frozen 115-test workspace baseline on this host; later packages require a new final root freeze |
| Core | direct TypeScript checks/build exit `0`; Vitest 22/22 | Schema/policy/canonicalization/migration/SQLite/compiler unit and integration scope |
| Bridge and IPC | bridge 10/10; local IPC 24/24; official SDK runtime 1/1 | Exact safe tool protocol and authenticated local transport |
| Change manager | frozen baseline 31/31; later direct 37/37; runtime integration; native path 27/27 | Worktree/freeze/identity/review/native apply/recovery plus module-level subset child scope |
| Native helper | SHA-256 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`, 67,548,236 bytes; 55/55 twice | Exact tested Windows helper artifact and bounded race-resistant file operations |
| Verifier | direct 11/11; real Chromium reports | Real build/render/geometry/interaction and deliberate FAIL behavior |
| Runtime/themes | runtime package tests recorded in security ledger; themes 6/6 | Draft publication/crash binding and trusted theme application |
| Electron | `tests/e2e/artifacts/results.json`: 7 expected, 0 unexpected, 0 skipped, 76,983 ms; SHA-256 `2F7A15C0D9F37710FDFC6CF343A162A01191D8E124DF5E4DD4F47A1F268FDEA7` | Current unpackaged production-build editor path including live draft, 20 edits and themes |
| Independent security | latest full `pnpm test:security`: 56/56; focused late suites are recorded separately | Only the named independent regressions; not untested installer/hardware/client boundaries |
| Actual clients | Codex CLI exit `0`; OpenCode exit `1`; Claude absent | Codex two-read compatibility only; no three-client claim |
| Doctor | tests 6/6; real doctor exit `2` DEGRADED | Diagnostic truthfulness and redaction, not product health |

## Release blockers by cause

### Product implementation or product-performance blockers

- Exercise the bounded managed contract/generated drift resolutions in the final installed-app campaign; keep arbitrary source-to-contract inference unsupported.
- Add the prescribed missing package boundaries or record and approve an explicit architecture deviation.
- Execute and accept the new B03 editor commands and adjustable/drawer behavior in Electron.
- Integrate the tested accessibility and visual-baseline engines into trusted reports and baseline persistence.
- Integrate B10 subset children with trusted dependency closure, runtime re-verification and spatial review; complete B12 asset review.
- Implement the P1 Adopted/Reference boundary or mark the release scope narrower than the production plan.
- Compose the tested updater decision engine with production trust identities, bounded install ports and real update/rollback campaigns.
- Prove the split SQLite-durable UI confirmation at p95 within the 500 ms autosave target, and separately reduce or explicitly expose the measured 7.747–13.017 second changed-source export latency.

### Environment, authority, or campaign blockers

- Obtain a signing identity and run the exact signed artifact on a clean supported Windows VM.
- Install and pass Claude Code; diagnose and pass OpenCode without fallback.
- Run native Korean IME, 125/150/200% DPI, multi-monitor and assistive-technology campaigns.
- Complete three real projects × three screens × three clients and the installed-app vertical apply/recovery campaign.
- Run offline first use, update failure/rollback, uninstall/reinstall, packaged browser/verifier and packaged MCP client tests.

## Scope exclusions

P2/P3 items remain outside the P1 claim: Unity and other adapters, collaboration/cloud services, arbitrary build systems, broad plugin ecosystems, automatic perfect code-to-layout reverse engineering, and unattended external-client wake-up. A schema enum, dormant source, or theme catalog entry does not constitute support for an excluded profile.
