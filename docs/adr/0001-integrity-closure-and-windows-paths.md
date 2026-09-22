# ADR 0001: Close candidate identity and apply integrity gaps

- Status: Accepted for implementation; Windows native helper remains a release-gated follow-up
- Date: 2026-09-22
- Scope: P1 candidate verification, approval, recovery, contract publication, and Windows paths

## Context

The production plan requires the verified candidate, approved candidate, and applied bytes to be identical. The supplied MCP report schema exposes the main candidate hashes but does not carry every immutable dependency needed to make approval independent of mutable current state. The plan also describes crash recovery and Windows path validation without defining the full internal records and terminal states.

The source schemas under `spec/contracts/` are preserved unchanged. They remain the external 1.0.0 wire contract. Internal records add stricter bindings; adapters may return the existing public projection.

## Decisions

### 1. Report and approval closure

Trusted verification seals `projectId`, `taskId`, `candidateId`, base contract revision, complete candidate source tree hash, base/effective contract hashes, layout override hash, report ID and status, verification profile ID and hash, evidence hash, policy revision and hash, generator version, dependency lock hash, fixture hash, base commit, and base manifest. Runtime creates approval from a short-lived review nonce bound to this complete record. The renderer and MCP client cannot mint an approval record or supply replacement hashes.

### 2. Recovery has a manual state

Recovery classifies each affected path as `BEFORE`, `AFTER`, or `UNKNOWN`. Transactions containing `UNKNOWN` enter `MANUAL_INTERVENTION_REQUIRED` and expose the paths and evidence. They cannot automatically finish or roll back. The shared public recovery projection reports `BLOCKED`; the change-manager keeps the detailed durable state.

### 3. Tree hash scope

`treeHash` covers the canonical, sorted manifest of the complete immutable source snapshot that verification reads or executes, not just changed paths. Each entry binds the normalized relative path, file kind, SHA-256 of exact bytes, byte length, and executable bit or relevant mode. The separately recorded changed-path set is a review/apply projection. Dependencies are reproduced from the separately bound lockfile and trusted cache; any additional verification input is included in the evidence hash. Directories are implicit. Symlinks, junctions, reparse points, hardlinks to protected or external files, device files, and unsupported metadata are rejected rather than silently omitted. Case-fold duplicate paths are invalid on Windows.

### 4. Override revision publication is journaled

Applying an approved layout override publishes both source files and the next approved contract revision. The apply journal binds before/after hashes for source outputs, the database revision, and the exported contract JSON. Startup reconciliation completes only when every component is provably before or after; mixed or unknown state is blocked for user review. A database commit plus filesystem replacement is not described as a single atomic filesystem transaction.

### 5. Windows path defense uses handles where available

The TypeScript path gate rejects rooted, drive-relative, UNC/device/extended, ADS, dot traversal, reserved DOS names, trailing dot/space, and case-fold collisions. It validates the closest existing ancestor and repeats validation immediately before replacement. Junction and reparse checks apply to every ancestor.

A bounded native helper is the preferred closure: a signed Rust executable using Win32 handles to retain root and ancestor identity, compare final paths, volume/file IDs and reparse tags, create transaction temp files with `CREATE_NEW`, and recheck identities immediately before replacement. It accepts only typed inspect/prepare/commit/recovery operations over bounded JSON and never generic paths, shell commands, recursive delete, or unrestricted file reads. Until that helper and adversarial rename tests pass, BoxSpec must describe the defense as race-resistant validation, not complete same-user filesystem isolation.

## Consequences

The internal approval record is stricter than the initial MCP response schema. Verification or apply fails stale when any bound value changes. Recovery may require user action instead of forcing an automatic outcome. Packaging must hash and pin the native helper if adopted, and release evidence must include junction, reparse, case collision, source drift, and concurrent rename tests.
