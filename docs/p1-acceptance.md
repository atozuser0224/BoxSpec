# BoxSpec P1 acceptance map (B00-B16)

This is an implementation and release checklist extracted from the authoritative production plan and its machine contracts. It does not claim that any item is implemented. A checkbox may be closed only with the evidence stated here and in the backlog. `MUST` is a release requirement; `TARGET` requires measured evidence but the numeric threshold may be adjusted through a recorded decision; `SUGGESTION` is not a release blocker by itself.

Citation shorthand: **Plan** = `BoxSpec_Production_Plan_ko.md`; **BUILD prompt** = `agent/BUILD_AGENT_PROMPT.md`; **AGENTS** = `agent/AGENTS.md`; **Layout schema** = `contracts/layout-contract.schema.json`; **Context-slice schema** = `contracts/context-slice.schema.json`; **MCP contract** = `contracts/mcp-tools.json`. Line numbers refer to the supplied v1.0.0 package.

## Authority and release boundary

- Security invariants and protection of human approval outrank convenience examples. The JSON data shape is governed by `contracts/layout-contract.schema.json`, the MCP API shape by `contracts/mcp-tools.json`, and semantics/state/ownership by the plan. Conflicts require an ADR plus coordinated schema, document, and test changes. [Plan §29, lines 1040-1044; BUILD prompt lines 9-15]
- P1 means Windows, managed React/TypeScript/Vite, existing repository connection, and external Codex/Claude Code/OpenCode clients over local stdio MCP. P1 is complete only when persistence, recovery, security, compatibility, and actual-agent E2E pass. [Plan §2.2, lines 70-80]
- A static demo, fixtures-only validation, mocked MCP success, or a first vertical demonstration is not P1 completion. Real browser rendering, actual MCP calls, actual constraint failures, original-project application, and crash recovery are required. [AGENTS lines 35-39; BUILD prompt lines 40, 56-67; Plan §23.2, lines 944-950]
- P2 Unity (`B18`), P3 React Native Android (`B19`), and the managed runner adapters (`B17`) are excluded from the P1 release gate. Their values may appear in forward-compatible schemas, but P1 must report them as experimental/unavailable rather than supported. Next.js, UI Toolkit, iOS, macOS/Linux, remote MCP, vision/freehand recognition, realtime collaboration, and arbitrary framework conversion are also outside P1. [Plan lines 58-60, 70-80, 808-810, 927-930]

## Non-negotiable cross-cutting acceptance

- [ ] Approved hard fields cannot be changed by an agent; a proposal and human approval are separate operations. Ancestor layout, global CSS, transforms, tokens, and overflow may not be used to evade final-geometry enforcement. [Plan lines 30-38, 246-268]
- [ ] PASS comes only from server-collected trusted evidence. Agent claims and optional AI visual review never override deterministic failures. Missing, unsupported, failed, or unexecuted required checks are not PASS. [Plan lines 32-37, 661-674, 706-716; AGENTS lines 17-23]
- [ ] The verified, reviewed, approved, and applied candidate is the same immutable identity. At minimum bind tree/candidate hash, base and effective contract hashes, layout override hash, report, policy revision/hash, generator version, fixtures/profile hashes, and base source state. Recheck hashes at verification start/end, approval, and apply. [Plan lines 33-35, 258-264, 609-617, 651-657, 718-724]
- [ ] No automatic reset, clean, stash, overwrite, baseline replacement, hidden initial commit, or deletion of user work. Recovery affects only the recorded transaction. [Plan lines 92-104, 401-413; AGENTS lines 17-23]
- [ ] Human approval, contract unlock, baseline replacement, and original-project apply exist only in the trusted UI. MCP exposes no `approve`, `unlock`, `apply_to_main`, `run_shell`, `delete_project`, or `read_secret`. [Plan lines 445-477; BUILD prompt lines 56-67]
- [ ] Core is the sole policy and persistence writer. Electron UI IPC and MCP call the same use cases; neither duplicates authorization logic. Domain packages remain independent of Electron, React, and MCP SDK imports. [Plan lines 336-340, 832-874; AGENTS lines 11-15]
- [ ] External project text, comments, image text, and asset names are untrusted data and cannot unlock contracts, alter policy, upload externally, or widen access. [Plan lines 772-806]
- [ ] Worktrees/process separation are never described as filesystem or network sandboxing. The UI states that BoxSpec cannot prevent writes made through independently granted original-repository access. [Plan lines 35-38, 651-657, 774-790]
- [ ] Unknown capability, target, state, field, or check is rejected or reported unsupported/unverified; it is never ignored or coerced to PASS. [Plan lines 36-38, 706-716, 832-874]
- [ ] All implementation claims are tied to actual commands, exit codes, artifacts, and unresolved blockers in `docs/progress.md`; unit, contract, integration, browser E2E, compatibility, and security evidence are separated. [BUILD prompt lines 69-81; AGENTS lines 29-39]

## Required first vertical path

Do this path before styling candidates, freehand recognition, Unity, React Native, or collaboration. Passing it is an integration milestone, not the P1 release gate. [BUILD prompt lines 25-40; Plan §28, lines 1023-1038]

1. [ ] Install/run the Windows Electron app and connect the supplied React dashboard as an explicitly approved project.
2. [ ] Create and persist a target layout with header 64, sidebar 260, and main fill; restart and reopen it.
3. [ ] Make sidebar width and topology hard and main internal presentation free; revision the approved contract.
4. [ ] Compile a deterministic React layout shell and prepare a scoped worktree via the local stdio bridge.
5. [ ] From a real Codex or OpenCode client, read the exact context revision and implement the main project-list slot.
6. [ ] Freeze the candidate, render the real Vite page in a browser, and pass geometry plus search-click interaction checks.
7. [ ] Show the actual changes and violations, obtain trusted UI approval, and apply only files whose hashes match the verified candidate.
8. [ ] Repeat with a second agent request to add a filter while preserving the approved structure.
9. [ ] Submit a deliberate 320px sidebar; it must fail verification and leave the original unchanged.
10. [ ] Change an original file immediately before apply; apply must stop with an explicit conflict.
11. [ ] Kill the process during a normal apply; startup recovery must classify and recover the journaled transaction without overwriting an unknown user edit.

## Machine contract baseline (B01/B06)

- [ ] Layout Contract v1.0.0 is a closed object requiring `schemaVersion, projectId, screenId, name, revision, target, coordinateSpace, rootNodeId, defaultPolicy, breakpoints, designSystem, nodes, assertions, verification`; unknown root properties fail. IDs use `^[A-Za-z][A-Za-z0-9_-]{0,95}$`; revision starts at 1. [Layout schema lines 1-55, 225-243]
- [ ] Contract bounds are enforced: 1-32 breakpoints, 1-10,000 nodes, 0-10,000 assertions, 1-64 viewports and fixture IDs, and 1-8 required checks. Required check values are exactly `schema, policy, layout, types, build, interactions, accessibility, visual`. [Layout schema lines 92-125, 153-220]
- [ ] Layout modes are `row|column|grid|overlay|leaf`; sizing is `fixed|fill|hug`; placements are flow or fully specified anchors; padding/gap are nonnegative; grid columns are 1-24. Semantic validation additionally enforces mode-specific combinations and reference integrity. [Layout schema `$defs/size`, lines 245-315; `$defs/layout`, lines 338-401; Plan lines 230-268]
- [ ] Top-level topology policy is hard. Per-node locks are hard/free or numeric soft min/max; P1 semantics must reject topology-free overrides and accept candidate overrides only for existing scalar `/layout/...` leaves authorized by soft/free policy. [Layout schema lines 56-90, 514-564; MCP contract lines 1453-1492; Plan lines 246-264]
- [ ] Context slices are read-only, closed v1.0.0 `context-slice` objects with project/screen/revision/full contract hash/root, coordinate space, breakpoints, policy, requested scope, included nodes, assertions, total count, and nullable cursor. A slice is never persisted as the full contract or passed to the compiler. [Context-slice schema lines 1-178; Plan lines 479-483]
- [ ] MCP exposes exactly the 15 named tools from `boxspec_get_capabilities` through `boxspec_cancel_task`, over stdio. Read-only/write hints do not grant authorization. Write-like tools require idempotent `requestId`; authorization, task ownership, revision, scope, paths, and state are enforced by Core. [MCP contract lines 1-5, 7, 174, 318, 453, 660, 818, 1000, 1207, 1431, 1625, 1774, 1987, 2128, 2272, 2406; Plan lines 445-477]
- [ ] MCP successful results validate against the declared output schema and return structured content plus compact JSON text fallback. Domain failures return the declared `ok:false` envelope and MCP `isError:true`; malformed protocol/schema input remains distinct. [Plan lines 469-477; MCP contract lines 108-163]

## B00 — environment, versions, licenses, monorepo

Depends on: none. Blocks every other implementation package.

- [ ] Inspect the repository and Git state before scaffolding; preserve this specification package separately and never overwrite/reset/clean/stash existing work. [BUILD prompt lines 17-23; Plan lines 944-950]
- [ ] Create the prescribed pnpm workspace boundaries: desktop, MCP, CLI; contracts, core, editor-domain, layout-engine, compiler-web, project-index, change-manager, verifier-web, optional runner packages, shared UI; fixtures and test suites. [Plan lines 832-874]
- [ ] Verify currently installable stable Electron, Node, pnpm, TypeScript, React, MCP SDK, Playwright, and SQLite driver versions using official sources; pin exact versions and produce a reproducible lockfile. Never guess imports/flags or install a nonexistent BoxSpec package. [BUILD prompt lines 21-23; AGENTS lines 29-33; Plan lines 342-356]
- [ ] Record runtime, CLI, SDK, MCP protocol, browser, and Windows combinations plus dependency licenses in `docs/compatibility.md`. Record unsupported combinations explicitly. [BUILD prompt line 21; Plan lines 342-356]
- [ ] A Windows development install and build complete from the exact lockfile. Evidence includes commands, exit codes, artifacts, and license notice generation. [Plan lines 905-912, 982-990]

## B01 — schema, types, canonicalization, semantic validation

Depends on: B00. Enables B03, B04, B05, and B06.

- [ ] Treat unknown inputs as unknown; perform runtime JSON Schema 2020-12 validation before conversion to strict TypeScript types. Use exhaustive domain errors and cancellation; no `any` at boundaries. [Plan lines 342-354, 876-903; AGENTS lines 11-15]
- [ ] Implement the exact Layout Contract and Context Slice shapes summarized above, including closed objects, limits, enums, nullable fields, and target/capability handling. Keep their duplicated `$defs` behaviorally identical.
- [ ] Canonical JSON sorts keys and normalizes numeric values to three decimals without repeated lossy pixel rounding; equal contract input yields equal SHA-256 identity. [Plan lines 230-236]
- [ ] Semantic negative fixtures cover duplicate IDs, missing root/parent/assertion/other-node/breakpoint/fixture references, parent cycles, invalid root parentage/order, overlapping or empty breakpoint policy, min greater than max, incompatible fixed/fill/hug dependencies, grid/mode inconsistencies, negative gap, unsupported target capability, and hard/soft/topology policy violations. Schema-valid but semantic-invalid fixtures are mandatory. [Plan lines 208-214, 230-268, 952-957]
- [ ] Responsive rules use inclusive min/exclusive max; representative and breakpoint boundary widths remain distinguishable from the broader claimed support range. [Plan lines 238-244]
- [ ] Migrations back up first, schema-check, run deterministically, semantically validate, then publish. Future major versions open read-only without deleting unknown fields; unsafe downgrade allows export only. [Plan lines 397-399]
- [ ] Evidence: valid/invalid fixtures plus cycle, reference, breakpoint, conflict, capability, and canonical-hash tests. [Plan lines 911-913, 954-957]

## B02 — command store, revisions, undo, persistence, recovery

Depends on: B01. Enables B03 and B07.

- [ ] Core is the only writer. Every edit records command ID, expected revision, actor, timestamp, and before/after hashes. Revision conflicts fail rather than silently rebasing. [Plan lines 391-395]
- [ ] Persist the command/approved snapshot transaction in SQLite before reporting saved. Export JSON through temp write, fsync, and atomic replace; reconstruct failed export from DB state. [Plan lines 391-395]
- [ ] Startup reconciles approved DB snapshot versus exported JSON and shows a recovery choice. External JSON changes become import drafts, never silent approved changes. [Plan lines 391-399]
- [ ] Undo/redo are new commands; drag mutates only transient local state and pointer-up commits one command. Idempotent duplicate commands return the original result; conflicting duplicate payloads fail. [Plan lines 156-165, 391-395, 469-477]
- [ ] Crash replay produces the same revision/state and never double-applies a command. Cold restart recovers durable jobs and approvals without treating partial data as complete.
- [ ] Evidence: duplicate-command/idempotency tests, expected-revision conflicts, crash at each persistence boundary, export failure/rebuild, DB/export divergence, undo/redo replay, and restart tests. [Plan lines 913, 960]

## B03 — minimal canvas and inspector

Depends on: B01, B02. Functional editing first; polish is deferred.

- [ ] Three-pane editor implements 48px toolbar; adjustable 232px left panel (200-360); central canvas/results/overlay; adjustable 304px inspector (272-440); 28/240px jobs panel; drawer behavior below the 1100x720 design target. [Plan lines 122-154]
- [ ] Draw structured rectangles directly with stable IDs, initial `sketchBounds`, labels, nesting/reparenting, ordering, role, fixed/fill/hug, row/column/grid/overlay suggestions, lock policy, and save/reopen. Inference remains a reviewable recommendation and shows geometry movement. [Plan lines 156-204]
- [ ] Implement R/V/Space-drag/Ctrl-wheel/F, duplicate/group/ungroup, undo/redo, 1/8-unit keyboard movement, multi-select, align/distribute, and keyboard alternatives. Text editing and Korean IME composition suppress editor shortcuts. [Plan lines 156-165]
- [ ] Stable badges and button states use text as well as color; disabled actions explain why; actual result and reference canvas are visibly distinct. [Plan lines 167-171]
- [ ] Evidence: draw, label, reparent, lock, save, close, reopen E2E; keyboard and IME cases; revision/undo integration. [Plan line 914]

## B04 — deterministic managed-web compiler

Depends on: B01. Enables B08 and B09.

- [ ] Compile DOM structure, layout CSS, stable node IDs, and typed slot interfaces from approved contract/tokens/compiler version. Identical input and compiler version are byte-stable with identical source hashes. [Plan lines 272-284, 625-631; AGENTS lines 13-15]
- [ ] Map row/column to flex, explicit grid to CSS Grid, and overlay to relative parent plus anchored absolute children. Fixed size defaults to no shrink. Unsupported/ambiguous constraints return unsupported/diagnostics rather than approximate output. [Plan lines 230-236, 625-631]
- [ ] Generator-owned shell files cannot be edited by agents. Slot roots cannot change parent geometry through margin, global selectors, transforms, or hidden overflow. [Plan lines 272-284, 633-637]
- [ ] Initial supported profile is one React/TypeScript/Vite app with CSS Modules or scoped plain CSS; a monorepo requires an explicit app root. SSR, arbitrary build systems, custom Babel, and Next.js are not implicitly supported. [Plan lines 625-637]
- [ ] Evidence: byte-stable golden outputs and executable flex/grid/overlay fixtures, including unsupported capability diagnostics. [Plan line 915]

## B05 — project grants, execution profiles, and path safety

Depends on: B01. Enables B06 and B07.

- [ ] Folder choice uses an OS dialog. Initial connection grants read-only inspection; write, execution, and network are separate explicit scopes. Package/framework detection does not run install scripts. [Plan lines 92-104]
- [ ] Trust grants live in the protected user profile, not agent-editable `.boxspec/project-policy.json`. Grant review shows client, project, read/candidate-write/verify scope; grants are short-lived/process-scoped and revocable. [Plan lines 364-390, 431-437]
- [ ] Execution profiles pin validated executable path, argv array, cwd, timeout, environment-name allowlist, and network intent. No shell-string MCP input or concatenated user data through `cmd /c`; `.cmd` quoting has Windows-specific tests. [Plan lines 784-790]
- [ ] Accept project-relative paths only. Resolve canonical path and every ancestor at authorization and immediately before write, including the nearest existing ancestor of new paths. Reject traversal, absolute/UNC/device paths, ADS, reserved devices, case collisions, symlink/junction/reparse escapes, and naive prefix checks. [Plan lines 792-796]
- [ ] Protect `.git`, `.env`, keys/certs, user home, app credentials, runtime policy, trusted verifier/policies/fixtures, approved baselines, business logic, auth/payment/store/router/global CSS, lockfiles/package manifests by default. Binary patching and oversized content require separate handling; P1 binary patching is forbidden. [Plan lines 294-304, 645-649, 792-806]
- [ ] Dirty baseline is visible and blocks controlled apply; Git-less projects may edit/export contracts but require explicit Git adoption for controlled code apply. [Plan lines 92-104]
- [ ] Evidence: traversal, Unicode/space, case, junction/symlink/reparse, new-path swap, protected path, locked file, low disk, antivirus contention, and Windows quoting negative tests. [Plan lines 916, 958-960]

## B06 — local stdio MCP bridge and three-client setup

Depends on: B01, B05. Enables B08.

- [ ] Ship local stdio bridge: stdout is protocol-only; logs use stderr/local files. Bridge uses user-ACL-protected discovery and named-pipe IPC to Core, creates no independent DB, and does not auto-start a duplicate GUI/hidden Core. App-down tools return `APP_NOT_RUNNING`. [Plan lines 423-437]
- [ ] Production client configs use an absolute path to a signed launcher with bundled validated Node/runtime; development may use an absolute built JS entry. Never rely on global Node or `npx` of a nonexistent package. Merge only the BoxSpec entry after showing the config diff. [Plan lines 423-429, 491-542]
- [ ] Implement the exact 15-tool schemas, bounded outputs, annotations, standard structured content/text fallback, image content, declared domain error codes, request-id idempotency, ownership, lease, base revision, and foreign-task rejection. [Plan lines 439-489; MCP contract throughout]
- [ ] `get_context` requires the expected revision and returns a schema-validated bounded slice. Pages share a frozen context identity; stale cursors fail with revision conflict; protected rules are never omitted to save tokens. [Plan lines 479-483; MCP contract lines 453-659]
- [ ] Generate distinct, syntax-correct config for Codex TOML, Claude project `.mcp.json`, and OpenCode local command array. `connected` requires a real `get_capabilities -> get_context` read from that client, not config creation. [Plan lines 491-542]
- [ ] Diagnostics record client version, negotiated protocol, SDK version, and tool schema version and isolate bad executable, Unicode/space path, stdout contamination, app down, missing grant, and protocol mismatch. [Plan lines 439-443, 540-542]
- [ ] Evidence: actual client connect/read/start/submit/verify/report/cancel for all three clients; malformed/unknown request/field, duplicate request ID, stale revision, foreign task, revoked grant, oversized patch, no image capability, timeout/disconnect, app down, and two-bridge tests. [Plan lines 917, 962-965]

## B07 — task worktree and immutable candidate snapshot

Depends on: B02, B05. Enables B08 and B09.

- [ ] Task records freeze project/screen/node scope, base contract revision, base commit/manifest, policy revision, principal, allowed/protected paths, approved execution profile, request identity, lease/state/attempt/expiry/event sequence. Node scope and file scope are checked independently. [Plan lines 603-607]
- [ ] Prepare a short user-profile worktree outside the original repository. Detect LFS, submodules, monorepo symlinks, and unsupported combinations; never share writable `node_modules` with the original. [Plan lines 651-657]
- [ ] Dirty source baseline stops controlled prepare/apply. Preparing and implementing leave the original unchanged. [Plan lines 92-104, 651-657]
- [ ] Candidate submission collects only allowed changes, regenerates compiler-owned files, records the full Candidate identity, then copies/freezes a separate verification snapshot. Editing the worktree or snapshot afterward creates/requires a new candidate ID and hash. [Plan lines 609-617, 651-657]
- [ ] Concurrent tasks use single-writer contract/token leases; foreign task/worktree/candidate IDs fail; post-start contract changes make related tasks STALE. [Plan lines 613-621]
- [ ] Evidence: original tree unchanged, dirty baseline rejection, candidate hash stability, post-submit mutation detection, LFS/submodule/symlink diagnosis, and cross-task identity rejection. [Plan lines 918, 958-960]

## B08 — React slot generation workflow

Depends on: B04, B06, B07. Enables B10.

- [ ] A real external agent reads the exact frozen context revision through MCP and modifies only approved slot/new-output paths in its assigned worktree. The compiler, not the agent, owns the shell. [Plan lines 272-284, 625-657]
- [ ] Slot has one measurement root, satisfies typed props/events, uses approved bindings/components/tokens, and cannot mutate global/parent geometry. Existing hooks/controllers/handlers remain functional; preview fixtures cannot replace production binding. [Plan lines 294-304, 633-649]
- [ ] Component reuse order is explicit selection, registry, indexed candidate, then new-component proposal. Dependency changes stop for a separate proposal and installation approval. [Plan lines 286-304, 645-649]
- [ ] TS/TSX changes use syntax/type-aware edits where applicable and preserve BOM, CRLF, import order, and existing formatter. [Plan lines 645-649]
- [ ] Evidence: at least one actual external client implements a new slot and submits it via the real bridge/worktree/candidate path. [Plan line 919]

## B09 — browser render, geometry, interaction, and evidence verifier

Depends on: B04, B07. Enables B10 and B13.

- [ ] Run the ordered trusted pipeline: schema/semantic; path/ownership/policy/dependency; generator integrity; types/build/existing UI tests; real approved fixture; DOM/style/scroll/clip mapping; geometry/accessibility/interactions; visual/protected regression; optional AI review; seal evidence/report. [Plan lines 659-674]
- [ ] Run from the frozen snapshot with trusted verifier, policies, baselines, and fixtures outside candidate control. Expected geometry comes from the approved/effective contract, never agent-submitted expectations. [Plan lines 676-704]
- [ ] Collect `getBoundingClientRect`, computed style, visibility, clipping ancestors, scroll size, hit tests, roles, and labels in document CSS-pixel coordinates with scroll offset. Hidden/0x0 is not a geometry pass. Rotated P1 Managed layout is unsupported. [Plan lines 676-682]
- [ ] Apply explicit numeric/relation tolerances, valid overlap exceptions, multiline/clamp/truncation policy, and visibility/overflow as independent checks. [Plan lines 684-688]
- [ ] Execute approved populated, empty, loading, error, and long-text fixtures where applicable; approved viewport/DPR/text-scale matrix plus breakpoint before/exact/after widths. Record exactly what was verified. [Plan lines 690-696]
- [ ] Stabilize time, random seed, locale, timezone, data, viewport, browser, fonts, images, animations, caret, and external images. Unstable capture fails. Baselines are profile-specific and human-approved. [Plan lines 698-704]
- [ ] Deliberate failures detect 260->320 sidebar, transform-based movement, hidden/0x0 nodes, missing font, covered button, clipped overflow, empty/error state failure, and shared-component regression. [Plan lines 966-968]
- [ ] Evidence: real-browser reports/artifacts for correct and deliberately incorrect width, overlap, visibility, clipping, and missing interaction cases. [Plan line 920]

## B10 — candidate/report/review state machine

Depends on: B08, B09. Enables B11 and B12.

- [ ] Implement durable states `CREATED -> PREPARING -> READY -> IMPLEMENTING -> SNAPSHOTTING -> VERIFYING -> NEEDS_REPAIR|PENDING_APPROVAL -> APPLYING -> APPLIED`, with policy-allowed transitions to CANCELLED/FAILED/STALE. Cancellation during APPLYING waits for a safe transaction boundary. [Plan lines 586-601; MCP contract state enums]
- [ ] Reports distinguish PASS, FAIL, UNVERIFIED, ERROR, and STALE; every required check contributes. Never remove unverified cases from a displayed denominator. [Plan lines 706-716; MCP contract lines 1796-1912]
- [ ] Spatial review separates structure, style, content, binding, and code changes and links selected geometry/diff to evidence. Actual violations and failure reasons are visible. [Plan lines 718-724]
- [ ] Review requests accept only a currently passing report bound to the same immutable candidate/contract/policy/source identity. A new candidate or revision invalidates review; partial approval creates a new subset candidate and reruns dependency-closure verification. [Plan lines 718-724]
- [ ] Contract conflicts display alternatives and use a separate proposal. Rejection is remembered for the loop; the agent cannot directly edit/unlock the approved revision. [Plan lines 116-120, 266-268, 718-724]
- [ ] Evidence: state-transition, stale/foreign identity, cancel boundary, partial approval, and agent-claims-pass-but-verifier-fails tests. [Plan line 921]

## B11 — trusted UI apply journal and rollback/recovery

Depends on: B10.

- [ ] Freeze candidate/report/contract revision/base commit, then immediately before apply recheck original branch, HEAD, and every relevant file hash against the base. Drift stops with explicit conflict. [Plan lines 401-413]
- [ ] Journal and fsync per-file before/after hashes and backup paths before mutation; prepare temp files and verify paths, permissions, and disk space; replace sequentially and durably advance journal stages. [Plan lines 401-411]
- [ ] APPLIED is set only after final hashes exactly match the verified candidate. Publishing an approved effective override as the next contract revision occurs in the same apply journal and stales related tasks. [Plan lines 258-264, 401-411]
- [ ] On startup after crash, classify each file as before/after/unknown. Recover only transaction-owned changes; unknown content is presumed a user edit and is never overwritten without a user choice. No reset/clean/automatic stash. [Plan lines 401-413]
- [ ] User commit/push is a separate explicit choice. No MCP tool can approve or apply. [Plan lines 411-413, 445-467]
- [ ] Evidence: crash at every replacement step, source drift immediately before/during apply, low disk, lock/antivirus race, mixed before/after/unknown, and protected-file deletion. [Plan lines 922, 958-960]

## B12 — spatial diff, design tokens, and assets

Depends on: B03, B10.

- [ ] Review overlay shows baseline/candidate outlines, movement vectors, violation locations, and selected-node file/evidence linkage. Changes are categorized by structure/style/content/binding/code. [Plan lines 718-724]
- [ ] Design-system color, typography, spacing, radius, border, shadow, and icon-family values are revisioned human-approved tokens. New global values require approval; same-geometry style comparison is capped at three opt-in candidates. [Plan lines 286-292, 580-584]
- [ ] Asset index is limited to approved project folders and records ID/hash/size/type/source/license/thumbnail reference. Same names never trigger automatic replacement; raw arbitrary path reads are prohibited. [Plan lines 294-298, 445-462]
- [ ] Selected scope includes dependency closure: affected siblings/ancestors, common components, and every screen using a changed common component. [Plan lines 112-114]
- [ ] Evidence: scope/dependency closure, token-revision invalidation, asset hash/thumbnail review, and unrelated-name collision tests. [Plan line 923]

## B13 — adopted mode and regression protection

Depends on: B09, B12.

- [ ] Adopted mode proposes the minimum approved `data-boxspec-id`/mapping patch. Dynamic instances use component definition plus stable instance key, never array index. [Plan lines 639-643]
- [ ] Unextractable dynamic layout is labeled measurement-based. CSS-in-JS, dynamic classes, conditional branches, portals, shadow DOM, and canvas UI lower the guarantee unless a validated adapter exists. [Plan lines 633-643]
- [ ] Preserve router/store/hooks/navigation/API and protected business behavior. Shared-component changes reverify all consuming screens and out-of-scope geometry/functionality. [Plan lines 112-114, 294-304]
- [ ] Managed, Adopted, and Reference guarantees remain visibly distinct; Adopted claims apply only to tested states/viewports. [Plan lines 82-88]
- [ ] Evidence: existing-app behavior preserved, shared-component regression caught, mapping drift detected, and guarantee label reflects measured coverage. [Plan line 924]

## B14 — failure UX, IME, DPI, performance, and resource controls

Depends on: B03-B13.

- [ ] Failure states expose stable error code, reason, recovery action, IDs, and whether execution/checks ran. Buttons distinguish connection required, request, running, repair, review, apply, and source-drift reverify. [Plan lines 167-171, 469-477, 706-716]
- [ ] Verify Korean IME composition, full keyboard workflow/focus order, visible focus, non-color status meaning, long Korean/text content, Unicode/space paths, and 125/150/200% Windows DPI plus multi-monitor movement. [Plan lines 128-165; BUILD prompt line 75]
- [ ] Editor uses system fonts and remains usable offline; external font download is not required. Contrast/state distinction is measured before release. Editor tokens are implementation defaults except their colors are explicitly proposal values subject to measured correction. [Plan lines 140-154]
- [ ] Enforce resource controls: 10,000-node hard cap; bounded contexts/events/artifacts; default same-failure retry maximum 2; default project implementation concurrency 2 and verification browser 1; log IDs/latency/usage with unknown usage not coerced to zero. [Plan lines 812-830]
- [ ] TARGET: measure p95 drag <=20ms at 200 visible/2,000 total nodes, selection/change <=100ms, open 2,000-node contract <=2s, cached context <=300ms, save confirmation <=500ms after command, and editor idle <=500MiB on a documented reference machine. Threshold changes require recorded benchmark rationale. [Plan lines 812-828]
- [ ] Evidence: Korean/keyboard/accessibility, 125/150/200% DPI, cold restart, resource-bound failure, and reference-machine timing/memory report. [Plan line 925]

## B15 — Windows installer, signing, update, offline, uninstall

Depends on: B14.

- [ ] Produce and sign a Windows installer and bundled bridge launcher/runtime. Track installer, runtime, bridge, browser, and verifier versions and license notices. Do not trust an arbitrary system Node. [Plan lines 982-990]
- [ ] Update verifies manifest and executable trust, separates stable/beta channels, retains a recoverable prior version, and backs up before schema migration. Test the exact selected Electron packager/updater combination. [Plan lines 982-988]
- [ ] Browser is bundled or obtained through a verified first-run download. Offline/download failure preserves editing and contract saves while verification reports unavailable; app startup remains responsive. [Plan lines 984-990]
- [ ] Uninstall never deletes user projects, Git repositories, or approved contracts. Profile-cache removal is a separate confirmation. [Plan lines 988-990]
- [ ] `doctor` emits redacted JSON for install path, bridge/core, grants, browser, Git, adapter, and agent executable. It distinguishes config-written from actual-call success. [Plan lines 990-998]
- [ ] Evidence: clean-VM install, launch, signed launcher/client config, update success/failure rollback, offline first run, uninstall/reinstall, and confirmation that user project data remains. [Plan line 926]

## B16 — full security, compatibility, pilot, and release gate

Depends on: B15. No P1-ready claim until all items below pass.

- [ ] Complete the required first vertical path in an installed app with video/screenshots, command logs, immutable report/evidence, approval, apply, and recovery. [Plan lines 970-978, 1023-1038]
- [ ] Test at least three real small React projects, each with at least three screens, against all three real MCP clients. Record exact OS/runtime/browser/SDK/client combinations. [Plan lines 970-980]
- [ ] Run 20 consecutive changes over a fixed structure with zero hard-violating candidates reaching original apply. [Plan lines 970-980]
- [ ] Observe zero cases where failure, timeout, unknown, unsupported, or not-run becomes PASS. [Plan lines 970-980; AGENTS lines 19-23]
- [ ] Prove candidate/report/approval/apply hash linkage and recovery from crashes and user source drift. [Plan lines 970-978]
- [ ] Run independent security review focused on hard-lock bypass, original protection, canonical/reparse paths, permissions/grants, fake PASS, candidate mutation, stale review, and supply-chain update trust; resolve every blocking finding. [BUILD prompt lines 42-54; Plan lines 970-978]
- [ ] Test all negative matrices in §24: semantic contract failures; dirty/untracked/source-drift/apply failures; MCP malformed/stale/foreign/oversized/unknown/offline/cancel cases; geometry/visibility/font/overlay/overflow/state/shared-component regressions. [Plan lines 952-968]
- [ ] Confirm P2/P3/B17/other profiles remain excluded or accurately marked experimental/unavailable. A schema enum or dormant package is not support evidence. [Plan lines 70-88, 927-930]
- [ ] Final report separates implemented, actually tested, unsupported, unverified, and release-blocking items. [BUILD prompt lines 77-83]

## Separable work units and dispatch order

The module dependency graph in §22 is mandatory. Within it, these are independently dispatchable when each unit has one file owner and shared-interface changes stay with the integration owner. [Plan lines 905-932; AGENTS lines 29-33]

1. **Foundation wave:** B00 workspace/toolchain/licensing. Then B01 schema/types/semantic/canonicalization. B02 persistence can start after B01 public types freeze.
2. **Parallel wave after B01/B02:** B03 editor domain/UI (B01+B02), B04 compiler (B01), and B05 grants/path policy (B01). Keep domain interfaces owned centrally.
3. **Integration wave:** B06 MCP (B01+B05) and B07 worktree/snapshot (B02+B05) can run in parallel; B08 joins B04+B06+B07.
4. **Trusted verification wave:** B09 joins B04+B07; B10 integrates B08+B09; an independent reviewer attacks evidence/status/hash invariants.
5. **Safe application wave:** B11 follows B10. It should not share a writer with candidate/review state-machine work while journal interfaces are changing.
6. **Coverage wave:** B12 follows B03+B10; B13 follows B09+B12; B14 is the convergence gate across B03-B13.
7. **Release wave:** B15 packaging/update/uninstall follows B14; B16 runs the full independent security/compatibility/pilot gate after B15.

## Contradictions and ADR-required decisions

These are not permissions to weaken a requirement. Resolve each by choosing one normative representation, updating prose/schema/types/tests together, and documenting migration/compatibility impact. [Plan lines 1040-1044]

1. **Report status `BLOCKED` exists in prose but not in the machine enum.** The verifier says an unrun required check yields `UNVERIFIED` or `BLOCKED` (Plan line 674), while §15.6 and MCP report/check schemas allow only PASS/FAIL/UNVERIFIED/ERROR/STALE (Plan lines 706-716; MCP lines 1824-1851). ADR: remove `BLOCKED` from prose and define when task state FAILED applies, or add `BLOCKED` consistently to schemas, UI, aggregation, and compatibility tests.
2. **Soft-lock semantics require a unit/target, but the schema cannot encode them.** The plan says soft ranges require unit and target property (Plan lines 246-254); the lock schema contains only `path, policy, min, max` (Layout schema lines 514-564). ADR: define unit derivation from JSON Pointer and remove the prose requirement, or add explicit unit/target fields and migrate v1.0.0.
3. **P1 topology-hard is semantically stricter than the schema.** Top-level `defaultPolicy.topology` is const hard (Layout schema lines 56-90), but a per-node lock schema permits `policy: free` on `/parentId` and `/order` (lines 514-564), while the plan says topology in P1 is hard only (Plan lines 258-264). ADR: forbid those node-lock combinations with schema conditions or make the semantic rejection and diagnostic code normative.
4. **Approval identity is stronger in prose than in MCP review/report payloads.** Candidate records require generator, policy, dependency-lock, fixture and verification-profile identity (Plan lines 609-611); approval binds candidate hash, contract revision, report ID, and policy revision (lines 718-722). MCP submit/report expose tree and three contract/override hashes, and request-review accepts only task/candidate/report IDs (MCP lines 1494-1550, 1796-1912, 2272-2330). ADR: specify immutable server-side join/recheck as the wire contract, or expose the missing identity fields; tests must prove stale policy/profile/source cannot reuse approval.
5. **MCP domain errors require wire `isError:true`, but the supplied output schema describes only the structured `ok:false` body.** This can be valid because `isError` is an MCP result-envelope property, but it is currently implicit (Plan lines 469-477; MCP lines 108-163). ADR/API note: make envelope construction and JSON text fallback normative and test both without adding `isError` incorrectly inside `structuredContent`.

## Important non-contradictory distinctions

- The editor's 48px toolbar and 232px default left panel describe BoxSpec's own UI; the 64px header and 260px sidebar describe the target dashboard fixture. Keep the token/design systems separate. [Plan lines 122-154, 1023-1029]
- Unity/RN target enum values and adapter capability rows are forward-compatible data shapes. They do not satisfy P2/P3 support; P1 must advertise truthful availability status. [Layout schema lines 23-29; MCP lines 49-83; Plan lines 70-88]
- §20 performance numbers are targets to measure and calibrate, while the 10,000-node cap and no-data-loss/no-false-PASS rules are hard constraints. [Plan lines 812-830]
- The editor color values are suggestions subject to contrast testing; system-font/offline behavior, readable sizing, labeled actions, and status distinction remain mandatory. [Plan lines 140-165; BUILD prompt line 75]
