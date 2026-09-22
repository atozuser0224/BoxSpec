# Independent security evidence

Date: 2026-09-22  
Platform: Windows, Node.js 24, pnpm 11

This record reports commands actually executed by the independent security reviewer. It does not treat owner claims, renderer fields, MCP responses, candidate content, or worktrees as security evidence. The architecture and negative matrix are in `docs/security-test-plan.md`; finding history and residual boundaries are in `docs/security-review.md`.

## Final implementation disposition

- MCP publishes the shared exact 15-tool allowlist and has no approve, apply, unlock, arbitrary shell, deletion, secret-read, theme-write, or recovery capability. Principal/grant authority is supplied by authenticated local IPC, not request payloads.
- Candidate, verification, approval and apply bind the complete immutable project/task/source/contract/policy/profile/dependency/fixture/report tuple. Source and frozen bytes are rehashed at the relevant boundaries.
- Windows writes use the pinned self-contained helper at SHA-256 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`. The helper performs handle-relative ancestor creation and replacement, rejects reparse points and hardlinks, and binds canonical root/volume/file identity. This is not an OS sandbox against another process running as the same user.
- Live layout drafts do not mutate approved contracts until desktop publication. Publication persists an exact intent before Core mutation and reconciles after a crash.
- Managed authoring saves persist per-file native recovery records and a complete manifest-last batch before mutation. Restart completes exact BEFORE/AFTER members and preserves UNKNOWN user content without overwriting it.
- Theme data comes from a package-owned, strictly parsed catalog. Only bounded presentation token namespaces are accepted. Geometry, nodes, locks, policy and assertions remain exact. Renderer previews are generated token studies and do not load crawled/source HTML.
- Production verifier authority comes from one strict package manifest rooted at Electron's `process.resourcesPath`, with `process.execPath` and complete toolchain/browser file-set closures bound by hash and size. Missing or changed closure bytes disable verification rather than falling back to ambient tools.
- Source-drift inspection and resolution bind the live ownership manifest and all paths in a generated unit. Unmanage is durable, and external contract import creates a draft while restoring the approved export.

## Actual runs

| Command | Actual result |
|---|---|
| `pnpm test:security` | Exit 0. All workspace builds passed; 56/56 independent tests passed in 14.10 s; the root change-manager security-filtered test passed. |
| `pnpm --filter @boxspec/change-manager test` | Exit 0, 31/31 passed in 41.52 s, including three native Windows cases. |
| `pnpm --filter @boxspec/runtime typecheck` | Exit 0. |
| `pnpm --filter @boxspec/runtime test` | Exit 0, 5/5 passed in 38.06 s, including real verifier/apply integration and managed-save batch restart. |
| `node --test tests/security/runtime-authority.test.mjs` | Exit 0, 7/7 passed. Includes foreign/stale/malformed recovery authority, live-draft isolation, publish-intent reconciliation, native managed-write finalization, mixed batch completion, UNKNOWN preservation, and trusted theme lookup/revision binding. |
| `pnpm --filter @boxspec/themes typecheck && pnpm --filter @boxspec/themes test && pnpm --filter @boxspec/themes build` | Exit 0; theme tests 6/6 passed. |
| `node --test tests/security/theme-boundary.test.mjs` | Exit 0, 2/2 passed. |
| `node --test tests/security/verifier-boundaries.test.mjs` | Exit 0, 6/6 passed, including hardlink, evidence junction, minimal environment, pre-abort and hostile descendant timeout. |
| Canonical native helper through `tests/security/native-helper.test.mjs` | Exit 0; structured result reported 55 assertions and the harness required named source-drift, hardlink, junction, root-substitution, directory-collision, concurrent-creation, raced-ensure and no-op-recovery scenarios. Assertion count is reported rather than pinned. |
| `node --test tests/security/verification-tools.test.mjs tests/security/runtime-authority.test.mjs` | Exit 0, 13/13 passed in 31.43 s. Imported toolchain and browser-support tamper, extra native module, missing asset, hardlink, junction, closure-manifest/fixture/app-executable mismatch, fixed Electron roots/capability gating, whole-unit source preflight, live manifest binding, post-inspection contract mutation, restart-persistent unmanage and draft-only import all passed. |

The independent root suite covers Windows traversal, drive-relative/UNC/device/ADS/reserved-name aliases, sibling-prefix containment, case/NFC collisions, hard-policy weakening, sidebar 320, source manifest hashing, forbidden MCP capabilities, Electron renderer/CSP/recovery input boundaries, verifier tamper/process boundaries, runtime authority and trusted themes.

## Specification traceability

The enforced boundaries derive from Production Plan §0.1; §§3.1 and 3.4; §6.6; §§8.1 and 9.1–9.4; §§10.2–10.6; §§13.1–13.5; §§14.4–14.5; §§15.1–15.6; §16; §§19.1–19.5; §21.1; and §§24.1–24.5. The concrete approval/recovery state machine, immutable tuple, Windows path attacks and A01–A12 crash matrix are recorded in `docs/security-test-plan.md`.

## Residual boundaries

- Packaged Electron launch/navigation, installer resource copy and publisher/signature verification need the packaging-owned E2E evidence. Source-level packaged URL and built CSP regressions pass.
- The package producer rejects reparse entries in verification closures but does not independently reject hardlinks before emitting the closure manifest. The packaged consumer rejects `nlink != 1`, so such an artifact loses verifier capability fail closed. A real packaged profile load and verification remains release evidence.
- Low-disk and antivirus/lock timing, forced termination at every multi-file boundary, and directory-entry durability beyond supported flush behavior were not exhaustively injected.
- The native ensure-directory timing test proves safety across observed timing outcomes and deterministic substitution cases; it does not claim a synchronized observation of an in-flight retained lock.
- Source-drift resolution and UNKNOWN overwrite remain intentionally unavailable/fail closed.
- Same-user processes can modify project and profile files directly. The worktree, Electron process split, ACLs and helper do not create an OS sandbox against that actor.

No unresolved P0/P1 hard-policy, source-protection, stale-candidate, path-containment, trusted-evidence, verifier-tool authority, IPC/MCP authority, live-draft publication, managed-save recovery, source-drift resolution, or theme-token bypass was reproduced in the final source reviewed here.
