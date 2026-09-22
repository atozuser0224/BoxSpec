# Managed source-drift recovery evidence

Date: 2026-09-22

## Scope and authority boundaries

`packages/runtime/src/source-drift-recovery.ts` implements a bounded inspection and resolution-planning layer for two owned namespaces only:

- authoritative contract exports at `.boxspec/screens/<screenId>.contract.json`;
- deterministic compiler output below `src/boxspec/generated/`.

The helper does not write files, persist approvals, or infer a layout contract from arbitrary TypeScript or CSS. Runtime persistence and the native managed-write journal remain the trusted execution boundary. Change-manager task drift and interrupted-apply `UNKNOWN` recovery are separate flows and are not accepted as managed source drift inputs.

## Safety properties exercised

- Inspection binds project, manifest hash, managed kind, screen identity, expected ownership hash, observed hash, intended hash, approved contract revision/hash, and the complete generated screen unit into content-derived IDs.
- Resolution requires the live manifest hash and every file observation for the unit to still match the inspection. Any change produces `STALE_INSPECTION` before an action plan is returned.
- A valid external contract export can produce an import-draft plan only when Core parsing succeeds and project, screen, and approved base revision match. Approval remains unchanged. The plan restores the authoritative export only after the injected import-draft port succeeds.
- Missing, invalid, stale-revision, or foreign contract JSON offers authoritative restore only.
- Generated code offers deterministic full-screen-unit restore or durable screen-level unmanage. It never offers code-to-contract inference.
- Unmanage performs no file mutation and suppresses later helper-generated writes for that screen. The runtime caller must also exclude that screen from future save compilation and manifest ownership.
- Managed paths reject traversal, absolute paths, alternate data streams, Windows device aliases, control characters, non-NFC spellings, and paths outside the two exact namespaces.

## Verification

Focused tests use real temporary directories and files. The contract-import case also opens a real SQLite-backed `BoxSpecCore`, calls `importScreenDraft` on externally edited JSON, verifies the approved screen did not change, and executes the restore through an injected hash-checking writer.

```text
Command: pnpm --filter @boxspec/runtime exec vitest run test/source-drift-recovery.test.ts
Exit: 0
Result: 1 test file passed; 8 tests passed
```

The eight cases cover validated contract import plus authoritative restore, stale file refusal, stale manifest refusal, generated code inference refusal with full-unit restore, clean prior-compiler output migration, durable unmanage behavior, semantic-only JSON serialization, and protected managed paths.

```text
Command: pnpm exec tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck packages/runtime/src/source-drift-recovery.ts
Exit: 0
```

The integrated runtime caller was then verified after adding live manifest rechecking, semantic contract-export preflight, and generated-output exclusion for unmanaged screens:

```text
Command: pnpm --filter @boxspec/runtime typecheck
Exit: 0

Command: pnpm --filter @boxspec/runtime exec vitest run test/runtime.integration.test.ts -t "persists authoring state and rejects a revoked grant before idempotent replay"
Exit: 0
Result: 1 test passed; 4 skipped
Duration: 24.60s
```

That real integration case verifies all-save preflight preservation, generated restore, durable unmanage across restart and later save, Core-backed external-contract import with returned source-hash/identity checks, layout proposal creation, and authoritative export restore. It also rewrites the same approved contract with different JSON formatting and verifies save accepts the semantic equality and restores canonical bytes.

An earlier full-suite attempt used the integration case's former 30-second timeout and returned exit 1 when that case reached the timeout; it reported no assertion or safety failure, and the other 11 tests passed. The case timeout is now 120 seconds, and the final isolated rerun above completed in 24.60 seconds.

An ESLint command was attempted but the repository does not provide an `eslint` executable, so no lint result is claimed.

## Runtime integration contract

Before resolving, the runtime must re-read and hash `.boxspec/generated-manifest.json`, observe every path in the selected drift's `unitSnapshots`, and pass all evidence to `planManagedSourceDriftResolution`. It must also verify the current approved contract still matches the returned base revision/hash before storing an import proposal.

For save, restore, contract re-export, and unmanage, the runtime must persist one complete operation intent before the first file mutation, include exact BEFORE/AFTER hashes for every output, execute the manifest last, and use the native safe-filesystem journal on Windows. A conflict in any preflight leaves every prior byte untouched. Restart recovery accepts only exact BEFORE or AFTER bytes; any other bytes remain blocked for explicit inspection.

Screen-level unmanage must remove the screen's generated ownership entries and persist the unmanaged screen ID atomically with that manifest operation. Future saves continue exporting the authoritative contract but skip compilation, preflight, ownership, and writes for that screen's generated files.

## Unsupported behavior

Arbitrary application source, handwritten slots, and generated TypeScript/CSS cannot be translated into an approved contract by this helper. Such a proposal requires an explicit adapter or agent workflow and a later human approval. A missing adapter remains `UNSUPPORTED_RESOLUTION`; it is never returned as resolved.

A syntactically malformed `.boxspec/generated-manifest.json` currently fails closed in the runtime reader with `APPLY_CONFLICT`; it is not converted into a `MANAGEMENT_MANIFEST` drift row with an explicit repair action. Missing manifests and conflicts described by a valid manifest are handled. This is a bounded recovery/UX limitation: malformed manifest bytes are preserved and no managed output is written.
