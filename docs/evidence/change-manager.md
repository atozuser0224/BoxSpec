# Change manager evidence

## Implemented boundary

`@boxspec/change-manager` exports `createChangeManager`. It returns separate `agent`, `verifier`, and `desktop` controllers. The MCP/runtime integration receives only the agent controller. Project grant creation/revocation, review nonce issuance, approval, source apply, and recovery are desktop-controller operations. Trusted verification recording is on the verifier controller.

An MCP grant is durably bound to its exact `grantId`, `projectId`, `principalId`, permission set, expiry, revision, canonical root identity, allowed write prefixes, protected prefixes, and approved execution profiles. Revocation is persisted and survives restart. Every agent task is bound to the creating principal and grant; another principal cannot read, patch, freeze, review, or cancel it.

Task creation uses a real detached Git worktree at the current source HEAD. It records the branch, HEAD, complete tracked/nonignored source manifest hash, approved contract revision/hash, policy revision/hash, generator version, dependency lock hash, fixture hash, and verification profile ID/hash. A worktree is treated only as staging isolation. It is not represented as a filesystem or network sandbox.

Candidate freeze copies exact regular-file bytes into a separate snapshot, rejects symlinks/junctions, hardlinks, special files, Windows alias-prone paths, scope escapes, protected paths, and case/NFC collisions, and records explicit deletion entries. The tree hash is domain separated with `boxspec-candidate-tree-v1\0` and covers the complete ordinal-sorted snapshot manifest, including path, size, content SHA-256, and executable bit. Every verifier, review, approval, and apply transition rehashes or compares the sealed identity.

The verifier controller accepts PASS/FAIL/UNVERIFIED/ERROR/STALE records but does not trust a supplied identity: it first loads and rehashes the frozen snapshot, then compares project, task, tree, contract, override, commit, manifest, generator, policy, dependency, fixture, and profile bindings. Only a current PASS can enter review.

Desktop review issues a fresh five-minute nonce stored by hash. Agent review requests never receive it. Approval consumes that nonce and seals the current trusted record. It returns a separate one-time apply confirmation token, also stored by hash. Apply checks token, approval expiry and single use, grant identity/revision, frozen bytes, source branch/HEAD, full source manifest, and each target before hash before the first mutation.

Apply writes a checksummed, versioned intent journal with the root volume/file identity, immutable approval seal, and every before/after/backup/temp path and hash before source mutation. Each replacement is staged and journaled. Recovery classifies only exact `BEFORE`, exact `AFTER`, or `UNKNOWN`. Any inaccessible, linked, corrupt, or third-party value is `UNKNOWN`, persists as source drift, and blocks automated writes. When all paths are BEFORE/AFTER, the desktop must explicitly choose transaction-wide `restore-before` or `finish-after`. Startup idempotently finishes cleanup and approval/task state for a committed `APPLIED` journal.

On Windows, public apply uses `NativeSafeFsClient` only when the trusted application composition root supplies the helper path and its expected SHA-256. The client re-hashes the executable before every bounded one-request process invocation. It delegates root inspection, handle-relative directory creation, prepare/commit/classify/recover/finalize operations to the native helper and seals each returned `preparedId` into the journal before commit. The helper is a filesystem precondition executor, not an approval or OS authorization boundary: grants, protected-path policy, candidate identity, trusted verification, approval, and recovery authority remain in change-manager. The native client must never be exposed through MCP or configured from project input.

## Verification run

Environment: Windows, Node 24.19.0, Git 2.55.0.windows.3.

| Command | Exit | Result |
|---|---:|---|
| `node_modules/.bin/tsc.cmd -p packages/change-manager/tsconfig.json --noEmit` | 0 | Strict package typecheck passed. |
| direct Vitest 5.0.1 module: `vitest.mjs run --root packages/change-manager --config vitest.config.ts` | 0 | 2 files, 31 tests passed in 42.25s. |
| direct Vitest native filter: `vitest.mjs run --config vitest.config.ts -t native` | 0 | 3 native integration tests passed; module-relative helper lookup is independent of process CWD. |
| `node_modules/.bin/tsc.cmd -p packages/change-manager/tsconfig.json` | 0 | ESM JS and declarations emitted to `packages/change-manager/dist`. |
| `node_modules/.bin/tsc.cmd -p packages/runtime/tsconfig.json --noEmit` | 0 | Runtime compiles against the final change-manager declarations. |
| `node_modules/.bin/tsc.cmd -p apps/desktop/tsconfig.json --noEmit` | 0 | Desktop compiles against the final runtime/change-manager declarations. |
| direct Vitest 5.0.1 module: `vitest.mjs run --root packages/runtime` | 0 | 1 file, 4 real runtime integration tests passed in 35.52s, including trusted verification, desktop approval, and native apply. |
| `node --test tests/security/native-helper.test.mjs tests/security/path-policy.test.mjs` | 0 | Independent native/path boundary suite: 27/27 passed. |

The tests create actual temporary Git repositories and detached worktrees. They cover full snapshot bytes; staging mutation after freeze; stale task revisions; grant expiry and durable revocation; principal reuse; allowed/protected scope; symlink traversal; Windows device/ADS/wildcard/normalization paths; verification identity mismatch; single-use desktop review nonce; apply confirmation token mismatch; verification and approval expiry; changed-target drift; unrelated full-source and HEAD drift; explicit deletion; faults after journal preparation, target move, replacement, pre-final verification, and committed `APPLIED`; restart rollback; committed-state reconciliation; and ambiguous post-crash user edits that remain untouched.

Three integration cases exercise the canonical self-contained native helper at `crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe`, pinned to SHA-256 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`. They cover idempotent handle-relative creation of missing managed-write directories, public `createChangeManager` approval/apply of existing and new files through a previously absent nested parent with exact committed bytes and sidecar cleanup, and an injected crash after native replacement followed by restart classification as `AFTER` and explicit restoration of the exact `BEFORE` bytes. Directory intents are sealed in the journal before creation. Both native and portable recovery paths reject an invalid recovery decision with `INVALID_REQUEST` before mutation. The safe-filesystem owner separately reports two consecutive 55/55 native runs for directory creation, exact replace/recovery/finalize, drift, hardlink, junction, root substitution, cleanup, and concurrent ancestor swap against the same binary/hash.

## Release boundary

Windows public source mutation is enabled only when the caller supplies the canonical pinned native helper through trusted application configuration. Without that capability, apply fails closed with `UNSUPPORTED_CAPABILITY`. The TypeScript path-based apply backend can only be selected through `src/testing.ts`, which is absent from package exports; there is no environment-variable bypass.

The TypeScript path validation remains defense in depth for grants, worktrees, freeze, and negative tests; ordinary Node path operations do not close the Windows reparse-point swap race. Product packaging still has to provide the trusted canonical helper location and pinned hash. An absent or mismatched helper remains fail closed. Recovery exposes `BEFORE`, `AFTER`, and `UNKNOWN`; `UNKNOWN` has no automated mutation path and requires manual intervention outside this API. If an apply stops after creating a sealed intended parent but before adding its file, recovery preserves file bytes and may leave that empty intended directory in place; it never follows or replaces a reparse point to remove it.
