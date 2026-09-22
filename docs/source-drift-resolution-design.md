# P1 source-drift resolution design

- Status: Proposed implementation boundary
- Date: 2026-09-22
- Scope: exported contracts, deterministic managed outputs, active-task drift, and interrupted-apply recovery

## The specification defines separate drift domains

The production plan uses the word `drift` for related but different states. They require different evidence and recovery actions.

1. **External code drift.** The approved layout contract is the source of structural intent, while code is the implementation source. BoxSpec detects external code changes and offers: propose that the code change be represented in the contract, restore code from the contract, or stop managing that area. Detection must not silently change the approved contract ([production plan, lines 208-214](../BoxSpec_Production_Plan_ko.md)). Stable node IDs and grouping are structural, not filename heuristics ([production plan, lines 195-204](../BoxSpec_Production_Plan_ko.md)).
2. **Approved database snapshot versus exported contract JSON.** Startup reconciliation compares the authoritative database snapshot with its JSON export. An external JSON edit is a new import draft, never a silent approved revision ([production plan, lines 391-395](../BoxSpec_Production_Plan_ko.md)).
3. **Active task and candidate drift.** Before apply, branch, HEAD, and relevant file hashes are checked against the frozen baseline. A mismatch stops the old candidate. The runbook requires comparison, explicit approval of a new baseline, and new verification ([production plan, lines 401-413 and 994-999](../BoxSpec_Production_Plan_ko.md)).
4. **Interrupted apply with user edits.** The journal classifies each file as before, after, or unknown. An unknown file is not overwritten without a per-file user decision ([production plan, lines 405-413 and 994-998](../BoxSpec_Production_Plan_ko.md)).

The three external-code choices do not replace import-draft reconciliation, task rebaseline, or crash recovery.

## Current implementation and the conflation

Core already implements the exported-contract primitives:

- `reconcileScreen(projectId, screenId)` returns `current`, `missing`, `drift`, or `invalid`;
- `importScreenDraft({ path, draftId, importedAt })` validates and stores external JSON without publishing it;
- `repairExport(projectId, screenId)` writes the approved database snapshot.

These methods are defined in [packages/core/src/core.ts, lines 41-59](../packages/core/src/core.ts). The core test changes an export, obtains `drift`, imports it as a draft, and proves that the approved screen is unchanged ([packages/core/test/core.test.ts, lines 175-187](../packages/core/test/core.test.ts)).

Change-manager has two correct and narrower protections:

- review/apply recomputes branch, HEAD, the complete source manifest, and changed target hashes against the frozen task ([packages/change-manager/src/manager.ts, lines 1109-1138](../packages/change-manager/src/manager.ts));
- `RecoveryInspection.sourceDriftPaths` contains only files classified `UNKNOWN` in an unfinished apply journal ([packages/change-manager/src/manager.ts, lines 904-932](../packages/change-manager/src/manager.ts)).

Runtime currently exposes the latter recovery rows as generic source drift. It uses the transaction ID as `driftId`, returns the unknown paths, and calculates `detectedTreeHash` from the path names alone ([packages/runtime/src/runtime.ts, lines 743-753](../packages/runtime/src/runtime.ts)). This has three problems:

- it does not inspect exported contract JSON or deterministic generated files;
- it duplicates interrupted-apply recovery under unrelated actions;
- a hash of path names does not bind the content the user inspected.

`resolveSourceDrift` is therefore correctly fail-closed today, but its current inspector is not a truthful preview of the three proposed resolutions. The shared interface advertises `propose-contract`, `restore-contract`, and `unmanage` without a drift kind or observed hashes ([packages/shared/src/runtime.ts, lines 138-171](../packages/shared/src/runtime.ts)).

There is also a write-order defect. `saveProject` writes each exported contract before it checks generated files for external changes ([packages/runtime/src/runtime.ts, lines 597-634](../packages/runtime/src/runtime.ts)). An external contract edit can be overwritten before it becomes an import draft, and a later generated-file conflict leaves earlier writes completed. P1 requires a complete preflight before the first write.

Finally, runtime opens Core without `exportRoot` ([packages/runtime/src/runtime.ts, lines 1365-1371](../packages/runtime/src/runtime.ts)). Core's configured export path includes `<exportRoot>/<projectId>/.boxspec/...`, while runtime writes `<projectRoot>/.boxspec/...`. Runtime must not call `reconcileScreen` or `repairExport` as if those path conventions were already connected.

## Typed drift model

P1 should create a persisted, content-bound inspection record rather than derive drift from recovery transactions.

```ts
type DriftKind =
  | "CONTRACT_EXPORT"
  | "MANAGED_GENERATED"
  | "MANAGEMENT_MANIFEST";

interface DriftPathSnapshot {
  path: string;
  expectedHash: string | null;
  observedHash: string | null;
  intendedHash: string | null;
}

interface SourceDriftSnapshot {
  driftId: string;
  projectId: string;
  kind: DriftKind;
  screenId: string | null;
  baseContractRevision: number | null;
  baseContractHash: string | null;
  manifestHash: string | null;
  paths: DriftPathSnapshot[];
  supportedResolutions: Array<"propose-contract" | "restore-contract" | "unmanage">;
  detectedTreeHash: string;
  detectedAt: string;
}
```

`detectedTreeHash` is the canonical hash of the kind, project/screen identity, contract revision/hash, manifest hash, and sorted path snapshots. The persisted record is the authority for `driftId`. Resolution reloads the record and rechecks root identity plus every observed path hash immediately before doing anything. A mismatch returns a recoverable stale/conflict result and performs no write.

The existing public fields can remain while `kind`, `screenId`, per-path hashes, and `supportedResolutions` are added. The existing resolution input can remain `{ projectId, driftId, resolution }` because the persisted `driftId` record binds the inspected content. `{ resolved: true }` is returned only after the selected resolution actually completes. Preparing a prompt or reporting unsupported inference is not resolution.

Interrupted apply records are excluded from this store and remain available only through `listRecovery`, `inspectRecovery`, and `recoverApply`.

## A. Exported contract JSON

Runtime inspects `.boxspec/screens/<screenId>.contract.json` for every approved screen using a safely resolved project-relative path. It compares the observed document with the approved Core contract and classifies:

| Observed export | Supported actions |
|---|---|
| Semantically equal to the approved contract | No drift record |
| Valid same-project/screen contract based on the current revision, but content differs | `propose-contract`, `restore-contract` |
| Missing, malformed, foreign identity, unsupported version, or stale revision | `restore-contract`; import remains unavailable until explicitly rebased or repaired |

`propose-contract` is a bounded operation for this kind:

1. Recheck the observed byte hash and approved base revision/hash.
2. Call Core's validated import-draft path so the exact external document and source hash are durably retained.
3. Create a user-editable layout draft from that imported contract. Its target revision is normalized to `approvedRevision + 1`; the approved database contract remains unchanged.
4. Restore the authoritative approved export through the managed-write journal. This is safe because the external version is already preserved as an import/layout draft.
5. Return resolved with the new layout-draft ID. Publication still requires the separate trusted user action.

`restore-contract` rechecks the observed hash and writes the canonical approved contract bytes to the export through the same managed-write journal. It does not create a revision.

`unmanage` is invalid for exported contract JSON. The database contract remains authoritative; management of its recovery export cannot be relinquished through a source-code option.

Core's current import table has no list/get/promote API. Runtime can immediately convert the validated contract returned by `importScreenDraft` into its persisted layout-draft record, while the Core row remains the import audit record. Because runtime currently uses a different export-root convention, integration should either add Core byte/explicit-path comparison and import methods or pass a runtime-safe resolved path to the existing parser. Windows restore writes must still use runtime's native managed writer; Core's direct filesystem writer is not a substitute for that journal.

### Example

Before inspection, Core owns screen `dashboard` revision 5. Its export is also revision 5 but a user changed the external JSON name and layout.

- **Propose contract:** BoxSpec preserves the external bytes as an import draft, opens a layout draft targeting revision 6, restores the revision-5 approved export, and waits for the user's layout-publication decision.
- **Restore contract:** BoxSpec replaces the edited export with the canonical revision-5 database snapshot after the inspected hash still matches.
- No path silently publishes revision 6.

## B. Deterministic managed generated output

The compiler owns `src/boxspec/generated/*.layout.tsx`, CSS, and type output; agents are forbidden from editing these generated shells ([production plan, lines 272-284](../BoxSpec_Production_Plan_ko.md)). Runtime already stores the last generated hashes in `.boxspec/generated-manifest.json` and can compile intended bytes from the current approved contract.

Inspection builds a three-way comparison for each managed output:

- `expectedHash`: last BoxSpec-written hash from the trusted manifest;
- `observedHash`: current file hash, or null when missing;
- `intendedHash`: fresh deterministic compiler output for the approved contract.

A changed, deleted, or unexpectedly occupied generated path creates `MANAGED_GENERATED` drift. An invalid or missing manifest creates `MANAGEMENT_MANIFEST` drift. If the manifest is missing but every output exactly equals fresh intended bytes, BoxSpec may offer manifest repair. It must not infer ownership of differing existing files.

The managed unit is one screen's complete compiler output set, not an arbitrary single generated file. The TSX, CSS, and type files are coupled. Resolution preflights the complete unit even if only one file is visibly different.

`restore-contract`:

1. Recheck the stored root, contract, manifest, and observed hashes.
2. Recompile exact intended bytes from the approved revision with the recorded compiler version.
3. Replace the unit's files through the existing native managed-write journal, with the inspected observed hash supplied as the expected before hash.
4. Write the new manifest only after the output replacements complete.
5. Do not reset Git, delete unrelated files, or touch slots/adopted source.

`unmanage`:

1. Recheck observed hashes.
2. Preserve every existing byte in the screen's generated unit.
3. Persist a screen-level unmanaged record in runtime state and remove the unit from the next managed manifest.
4. Future save/compile preflight skips writes for that unit and the UI marks it unmanaged.

Unmanage never means deleting files, revoking a project grant, changing contract locks, or marking the source as verified. Re-management needs a separate explicit flow and is outside this resolution call.

`propose-contract` cannot be derived from arbitrary changed TSX/CSS in P1. The plan explicitly rejects claims of perfect automatic two-way synchronization ([production plan, lines 208-212](../BoxSpec_Production_Plan_ko.md)). Until a target-specific adapter or an external agent returns a full validated layout proposal, this action returns `UNSUPPORTED_CAPABILITY` for `MANAGED_GENERATED`. It must not return `{ resolved: true }`. A future agent handoff may carry the diff and stable node context, but generating a prompt alone leaves the drift open.

### Example

The manifest and approved compiler both expect hash `A` for `dashboard.layout.tsx`; the current file has user hash `U`.

- **Restore contract:** if the file still hashes to `U`, BoxSpec replaces the complete dashboard generated unit with compiler output and records the resulting manifest.
- **Unmanage:** if the unit still matches the inspected observations, BoxSpec preserves `U` and the other current unit files, excludes that screen unit from later managed saves, and displays the loss of contract-to-code enforcement.
- **Propose contract:** unsupported until an adapter or agent supplies a real contract proposal; no source is modified.

## C. Active task or candidate source drift

This is not a managed-output resolution. Change-manager already binds task source branch, HEAD, complete manifest, and relevant target hashes. Any change makes the candidate non-reviewable or non-applicable.

Change-manager has no rebaseline API. The bounded recovery is:

1. Keep the stale task/candidate/report as audit evidence and cancel it if still cancellable.
2. Show the detected branch/HEAD/manifest/target difference.
3. After the user accepts the current source as the new baseline, call `start_task` again.
4. Produce a new candidate and run trusted verification again.
5. Require a fresh code review and apply approval.

No old PASS, review nonce, approval, or candidate bytes carry into the new task.

### Example

A task starts at commit `C0`; the user edits `src/App.tsx` before approval. The candidate becomes stale. BoxSpec does not restore `C0` and does not rewrite the contract. The user reviews the difference, starts a new task at the current source state `C1`, and verifies a new candidate.

## D. Interrupted apply with UNKNOWN files

An unfinished apply journal whose target matches neither before nor after remains in the recovery workflow. The user chooses preserve-current, restore-before, or finish-after for each unknown path under the existing nonce-bound inspection. It is never presented as `propose-contract`, `restore-contract`, or `unmanage`.

### Example

The journal records before hash `B` and intended after hash `A`, but the current file hashes to `U`. Generic source-drift resolution does nothing. Recovery shows `UNKNOWN` and refuses to overwrite `U` without the user's explicit per-file decision.

## Save preflight and write ordering

`saveProject` becomes plan-then-write:

1. Resolve and validate every contract export, generated output, and manifest path.
2. Read all approved contracts and compile all intended outputs in memory.
3. Snapshot all current byte hashes.
4. Compare contract exports, managed manifest entries, generated outputs, and unmanaged screen records.
5. If any drift exists, persist typed drift snapshots and return a recoverable conflict. Write nothing.
6. If preflight passes, write contract exports, generated units, and finally the manifest through managed journals.

Each native prepare call receives the preflight's expected observed hash. A change after inspection or preflight fails closed. Multi-file filesystem atomicity is not claimed; existing per-file journal recovery handles a crash after writing begins.

This ordering prevents the present failure in which a contract export is overwritten before a later generated conflict is reported.

## Minimal owned-file plan

| Owner | Work | Required proof |
|---|---|---|
| Runtime helper | Add typed inspection, canonical drift digest, supported-resolution calculation, and observed-hash recheck in `packages/runtime/src/source-drift-recovery.ts` | Unit tests cover changed/missing/invalid contract, generated changed/deleted/untracked, invalid manifest, content change after inspection, and stable canonical ordering |
| Runtime/state store | Persist drift snapshots and unmanaged screen units; exclude CM recovery rows; orchestrate import draft, restore, and unmanage; make `saveProject` preflight before writes | No writes on any preflight failure; exact replay is idempotent; restart retains unresolved drift and unmanaged state |
| Core | Expose safe explicit-path or byte-level reconcile/render/import primitives, or document runtime-safe use of existing import result; approved publication remains a separate user command | External valid JSON becomes a draft; approved revision/hash remain unchanged; foreign/invalid/stale JSON cannot publish |
| Change-manager | No new drift resolution logic; continue stale detection and restart tasks from a new baseline | Old candidate/report/approval cannot apply after rebaseline |
| Desktop | Render drift kind, hashes/diff summary, and only supported actions; keep recovery in its existing UI | No disabled action reports success; contract import opens a draft; unmanaged warning persists |

The existing three resolution strings can remain. The runtime selects semantics by the persisted drift kind and rejects unsupported combinations. Shared types need only additive drift metadata if the desktop requires typed rendering.

## Acceptance criteria

1. Startup and explicit inspection detect exported-contract drift independently of interrupted apply journals.
2. A valid externally edited contract becomes an import/layout draft; the approved Core revision and hash do not change.
3. Restoring an export or generated unit requires the current hashes to equal the inspected hashes and uses the native managed-write journal on Windows.
4. `saveProject` completes all drift checks before its first write.
5. Managed generated drift compares manifest, observed bytes, and fresh deterministic compiler output.
6. Unmanage preserves source bytes, persists at screen-unit scope, and prevents future generated writes to that unit.
7. Contract exports cannot be unmanaged.
8. Arbitrary TS/TSX/CSS changes are never claimed to have been converted into a contract without an actual adapter or agent proposal.
9. Active-task source drift invalidates the old candidate and requires a new task, verification, review, and approval.
10. Interrupted-apply `UNKNOWN` files appear only in recovery and remain protected by per-file user decisions.
11. No resolution runs `git reset`, `git clean`, commit, push, recursive deletion, grant mutation, or code approval.
12. `{ resolved: true }` means the filesystem/management drift was actually resolved; queued analysis or unsupported inference cannot return success.

## Unsupported cases

- Inferring a trustworthy layout contract from arbitrary hand-edited application TS, TSX, CSS, routing, or business logic without an adapter or external-agent proposal.
- Importing malformed, foreign-project, foreign-screen, future-unsupported, or stale-revision contract JSON directly into an editable current-revision proposal.
- Unmanaging authoritative contract exports or protected business logic.
- Reusing a stale task's PASS report, candidate, nonce, or approval after any source rebaseline.
- Automatically overwriting a file that changed after inspection or is `UNKNOWN` in an apply journal.
