# Core implementation evidence

## Implemented surface

`@boxspec/core` exports the shared `LayoutContract` model, the packaged JSON Schema,
schema plus semantic validation, canonical JSON and contract hashing, hard/soft/free
layout policy evaluation, typed revisioned commands, SQLite persistence, safe
import/export reconciliation, and deterministic managed React shell generation.

The persistence entry point is `BoxSpecCore.open({ databasePath, exportRoot? })`.
Its public operations are `createProject`, `createScreen`, `getScreen`,
`listScreens`, `execute`, `undo`, `redo`, `history`, `exportScreen`,
`importScreenDraft`, `reconcileScreen`, `repairExport`, and `close`.
`openExternalContract` admits unsupported schema versions only as immutable
documents. `migrateContractDocument` and `migrateContractFile` handle registered
older-version migrations; future versions cannot be downgraded.

Agent full-contract replacement is default-denied outside existing scalar layout
leaves. Top-level policy, assertions, verification checks, target, design system,
breakpoints, identity, topology, locks, responsive rules, and sizing object shape
cannot be weakened through that path. Hard fields and ancestor changes that can
move hard-constrained descendants are rejected. Soft fields require explicit
numeric bounds; free fields remain subject to schema and semantic validation.

SQLite uses `better-sqlite3` 13.0.3 with WAL, foreign keys, FULL synchronous
commits, an idempotent command log, before/after hashes, optimistic revision
checks, and durable bounded undo/redo stacks. A normal edit clears redo. Undo and
redo are new commands and revisions rather than rewriting a revision number.

The React compiler version `boxspec-react-shell/1.1.0` emits deterministic TSX,
CSS Module, and node-ID type files.
The dashboard output contains header height 64px, sidebar width 260px, fill main,
compact sidebar visibility, and `data-boxspec-node` selectors. Source and contract
hashing use the shared canonical JSON v1 implementation and ordinal key ordering.
Supported design tokens are emitted as inherited `--boxspec-*` CSS variables.
Background, surface, text, accent, body font, and medium radius tokens are applied
to the root and appropriate semantic node roles. Spacing, display-font, border,
and radius variants remain available to managed slots as variables; explicit
contract padding, gap, size, and placement always win, so theme application does
not rewrite geometry or assertions. Supported colors require hexadecimal syntax,
font lists use a strict character allowlist, dimensions remain numeric, and
unknown token names are never interpolated into generated CSS.

## Verification run on 2026-09-22

From the repository root:

```text
node packages/core/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit --composite false
exit 0
```

```text
node packages/core/node_modules/vitest/vitest.mjs run packages/core/test
exit 0
Test Files  1 passed (1)
Tests       24 passed (24)
```

The suite covers the production dashboard, invalid schema dimensions, duplicate
IDs, missing parents/assertion references, cycles, overlapping breakpoints,
incompatible sizing, fixed-size conflicts, Unicode canonical ordering, hard
sidebar 260-to-320 rejection, soft boundaries, free fields, ancestor bypass,
non-scalar overrides, top-level policy weakening, sizing-shape replacement,
deterministic output, a real TypeScript syntax check of generated TSX, SQLite
restart/history/export, revision drift, command idempotency, undo, redo, persisted
redo after restart, external drift/import-draft isolation, invalid import
rejection, and malformed command rejection.
Compiler coverage also verifies visible theme styling, inherited spacing/font/
color/radius variables, unchanged node geometry and assertions, distinct and
repeatable source hashes, rejection of color/font CSS injection, and omission of
unknown hostile token names.
Version lifecycle cases cover unknown-field-preserving read-only open, normal
write rejection, a raw pre-migration backup, deterministic double execution,
full final schema/semantic validation, atomic publish, and original-byte restore
after a nondeterministic migration failure.

Read-only documents use an exact JSON clone rather than layout canonicalization.
The reviewer reproduction now preserves `0.123456789` and nested
`0.000000123456789` without three-decimal normalization, while `parseLayoutContract`
still returns `READ_ONLY` for schema `2.0.0`.

```text
node --test tests/security/core-policy.test.mjs tests/security/canonical-integrity.test.mjs
exit 0
tests 7, pass 7, fail 0
```

This independently authored suite exercises top-level policy weakening, the
260-to-320 hard sidebar attack, lock/non-layout/topology mutation, ancestor
bypass, ordinal canonicalization, and manifest identity.

```text
packages/core/node_modules/.bin/tsc.cmd -p packages/core/tsconfig.json
node --input-type=module -e <dist smoke>
exit 0
{"generatorVersion":"boxspec-react-shell/1.1.0","revision":1,"files":3,"contractHash":"d253b7efb378c84dd07806273550132272908d4fb0245bc7e11b3a847e74145d","sourceHash":"ec5b710fa21ba0125b1e87c12bf69c7aa6f54a8ec93a91baa1d79718cf6d6853"}
```

The current dist smoke imported `packages/core/dist/index.js`, parsed the
production dashboard, and generated all three shell files. SQLite open, restart,
history, undo/redo, and export behavior remain covered by the package suite.

A second dist smoke applied and compiled all 17 trusted theme presets. Every
output contained its selected background token and an active root background
rule; all 17 source hashes were distinct. The command exited 0 with:

```text
{"generatorVersion":"boxspec-react-shell/1.1.0","themesCompiled":17,"distinctSourceHashes":17}
```

The `@boxspec/themes` integration suite was rerun against compiler 1.1.0: exit 0,
6/6 tests passed, including stale revision rejection for draft and approved theme
application.

The authoritative and packaged layout schemas both hash to
`AE0AC479FA0663BD0CBB16813FC4A4919A475EC2862A8012F687D3D8BC701123`
with SHA-256.

## Boundaries and remaining work

Authenticated principal and project-grant derivation belongs to the runtime
boundary. Runtime must construct the internal `actor`; raw IPC or MCP input must
not choose it. Candidate/report/approval/apply state and source-tree hash guards
belong to runtime/change-manager and are not simulated in core.

Schema 1.0.0 is supported. Older versions require an explicitly registered,
monotonically advancing migration; no speculative built-in legacy transform is
shipped without an authoritative legacy schema. React output was syntax checked
and byte-stability tested; browser rendering and geometry evidence belong to the
verifier. The atomic export path fsyncs file content and attempts directory fsync,
tolerating Windows errors that indicate directory fsync is unsupported.
