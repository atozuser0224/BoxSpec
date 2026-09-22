# BoxSpec security architecture and negative test plan

This document is a pre-implementation security review. It derives requirements from `BoxSpec_Production_Plan_ko.md` and the shipped MCP contract. It does not claim that any control is implemented or that a worktree, Electron `utilityProcess`, browser request interception, or process separation is an operating-system filesystem/network sandbox.

## Authoritative references

- Production plan §0.1 (the seven invariants), §§3.1 and 3.4 (grant and stale behavior), §6.6 (override hashes and revision publication), §§8.1 and 9.1–9.4 (single writer, trust storage, persistence, recovery), §§10.2–10.6 (local bridge, grants, tools, idempotency), §§13.1–13.5 (task/candidate lifecycle), §§14.4–14.5 (protected files and frozen snapshots), §§15.1–15.6 (trusted evidence), §16 (approval binding), §§19.1–19.5 (threat and process/path boundaries), §21.1 (interfaces), and §§24.1–24.5 (release-blocking tests).
- `agent/AGENTS.md`, “Architecture” and “Safety and integrity”.
- `contracts/mcp-tools.json`, especially `boxspec_list_projects`, `boxspec_start_task`, `boxspec_propose_patch`, `boxspec_submit_candidate`, `boxspec_verify_candidate`, `boxspec_get_report`, and `boxspec_request_review`.

## Security invariants

1. Core is the only authorization, policy, revision, candidate, report, approval, and apply state writer. UI IPC and MCP translate requests into the same Core use cases. A bridge, renderer, agent, candidate, or project-local policy file cannot grant authority.
2. Every request is authorized from server-held state, not `clientInfo`, a path supplied by a client, a UI claim, or a candidate claim. A mutation binds `principalId`, `grantId`, `projectId`, `taskId` where applicable, a canonical request payload hash, and `requestId`.
3. A grant is scoped by project identity and capabilities: metadata read, bounded source/context read, staging write, verification, and an approved execution profile are separate permissions. It expires, can be revoked, and is rechecked at every operation and long-running-job boundary. Approval, unlock, baseline replacement, original-project apply, secret reads, and arbitrary shell execution are never MCP capabilities (§10.5).
4. An approved project root has a stable server-side identity: canonical final path, volume identity and directory file identity captured through a handle. Caller paths never select or expand a grant. Root identity and containment are revalidated before filesystem mutations.
5. Node scope and file scope are independent. Dependency closure can widen verification, but cannot silently widen write scope. Protected paths always win over allowed paths. A project-local `.boxspec/policies/project-policy.json` is proposal/portability data and cannot replace the profile-held trust grant (§9.1).
6. Candidate identity is derived by Core from a copied snapshot. It is not derived from agent-provided check results, timestamps, path strings, or an editable worktree. Candidate creation always allocates a new immutable `candidateId`; resubmission never mutates a prior candidate (§13.3).
7. Verification executes the frozen snapshot and uses packaged verifier code, server-held policy, approved fixtures, and approved baselines outside candidate-writable locations. Missing, unsupported, cancelled, timed-out, errored, or unexecuted required checks cannot aggregate to `PASS` (§15.1).
8. A report is sealed to the exact candidate and complete verification inputs. AI review and agent messages are evidence annotations only; they cannot override deterministic failures.
9. Approval is a new server-held record created only through trusted UI. It is not the task state `PENDING_APPROVAL`. It binds the complete immutable tuple listed below and is single-use for an apply transaction.
10. Apply copies exact bytes from the verified snapshot. It never rebuilds from the worktree, selects an arbitrary subset from a passing candidate, or resolves “current” policy/profile/contract values. Any binding mismatch or original-source drift stops before the first original-project mutation.
11. Multi-file apply is recoverable, not falsely described as atomic. Every destructive step follows a durable intent journal. Recovery changes only files named by that transaction and never runs `git reset`, `git clean`, automatic stash, or broad rollback (§9.4).
12. If a target is neither the recorded before state nor after state, it is `UNKNOWN`. Recovery does not overwrite, delete, or restore that file without a new explicit user decision (§25.1).
13. Electron editor content is packaged and trusted; untrusted candidate code never shares its DOM, preload, session, or Node privileges. All IPC validates sender/frame and runtime-validates payloads. A screenshot is inert image data (§19.2).
14. Execution profiles accurately describe their isolation. Approved argv, environment, cwd, browser egress interception, utility-process separation, and worktrees do not imply filesystem or whole-process network isolation (§19.3).

## Required internal bindings

The immutable candidate manifest should contain a format/hash-algorithm version and a lexicographically sorted list of normalized project-relative paths. Each entry binds file kind, exact byte length, SHA-256 of exact bytes, and security-relevant metadata. Newline, BOM, and Unicode contents are not normalized before byte hashing. Reparse points, symlinks, special files, and multiply-linked files are rejected from agent-writable/candidate output unless a future adapter explicitly models them. Case-folded or Windows-normalized duplicate paths are rejected.

`treeHash` is SHA-256 over canonical JSON for that manifest, including every source file and generated output that verification will read or execute. A changed-files-only hash is insufficient if build configuration or imported source remains mutable. Snapshot storage is Core-owned; read-only ACLs are defense in depth because a same-user malicious process remains in the stated threat model limitation. Rehash at snapshot completion, verification start, verification end, review opening, approval, and apply preparation.

A sealed verification/approval binding must include at least:

```text
projectId, taskId, candidateId, candidateTreeHash,
baseContractRevision, baseContractHash, effectiveContractHash, layoutOverridesHash,
baseCommit, baseManifestHash,
generatorVersion, policyRevision, policyHash,
verificationProfileId, verificationProfileHash,
dependencyLockHash, fixturesHash,
reportId, reportStatus, evidenceManifestHash,
changed-file manifest hash, createdAt
```

The report status is `PASS` only when the approved profile's complete required-check set is present exactly once and every required check is `PASS`. Extra unknown checks cannot satisfy requirements. The evidence manifest binds each artifact's type, size, and content hash. Approval rechecks the sealed report rather than trusting an MCP response cached by the renderer.

## State machines and authority

The production plan's task state remains the user-facing workflow. Candidate, report, approval, and apply transaction need separate durable records so a single task enum does not erase security-relevant history.

```text
Task: READY/IMPLEMENTING -> SNAPSHOTTING -> VERIFYING
                                      |          |
                                      |          +-> NEEDS_REPAIR / FAILED / STALE
                                      |          +-> PENDING_APPROVAL
                                      +-> FAILED / STALE

Candidate: COLLECTING -> FROZEN -> VERIFYING -> VERIFIED_PASS
                         |              |          |
                         +-> INVALID    +-> VERIFIED_NONPASS
                                                    
Trusted UI only: VERIFIED_PASS -> REVIEW_OPEN -> APPROVED(binding)
                                                |
Apply transaction:                              PREPARED
                                                   -> APPLYING
                                                   -> APPLIED
                                                   -> RECOVERY_REQUIRED
                                                   -> ROLLED_BACK / MANUAL_INTERVENTION
```

Guards:

- `submit_candidate`: live grant, owned task, correct principal, task in an allowed state, matching revision, live lease, correct staging identity, path policy pass, clean supported baseline, deterministic generator rerun, then copy and hash. A foreign task/worktree/candidate is rejected.
- `verify_candidate`: candidate belongs to the task and principal, is `FROZEN`, all bindings match, the profile is approved and unchanged, and the snapshot rehash matches. Verification consumes only the snapshot.
- `request_review`: report belongs to exactly that candidate and task, complete closure matches, status is `PASS`, grant is live, and neither contract, policy, profile, snapshot nor base source is stale. Its success only means `PENDING_APPROVAL`.
- `approve`: only trusted UI/main-to-Core IPC with a fresh review nonce bound to the displayed diff/evidence. Rehash and source-drift checks run again. Renderer data cannot supply or alter the approval tuple.
- `prepareApply`: consumes the sealed approval once, validates branch/HEAD, tracked and untracked collision set, every before hash, root identity, free space, permissions, and path safety without writing originals.
- `apply`: consumes a confirmed Core-side plan/transaction ID, not arbitrary file operations from IPC. Grant revocation/cancellation before mutation aborts. Once mutation starts, cancellation is observed only at a journaled safe boundary and recovery remains mandatory.
- Any new candidate, contract revision, policy revision, profile change, fixture/baseline change, source manifest drift, or snapshot mismatch makes dependent review/approval records stale. `APPLIED` remains historical.

## Windows path policy

Accept one logical project-relative path format at API boundaries (forward slashes is simplest) and never URL-decode it. Parse first, then reject before joining:

- empty segments, `.` and `..`; leading slash/backslash; absolute, drive-absolute, and drive-relative forms (`C:\x`, `C:/x`, `C:x`); UNC, extended/device/NT object manager forms (`\\server`, `\\?\`, `\\.\`, `\??\`, `GLOBALROOT`, named pipes);
- NUL/control characters, colons/alternate data streams, wildcards where unsupported, trailing spaces/dots, and Windows reserved device names in every segment even with extensions or mixed case (`CON`, `con.txt`, `NUL`, `COM1` …);
- paths colliding under Windows case folding or the filesystem's normalization, and path aliases that resolve to another approved/protected entry;
- paths over configured component/total length limits, binary or oversized patch content, and unsupported file kinds.

Containment is determined with path-aware relative comparison and final handle identity on the same approved volume, never string prefix (`C:\project2` is not under `C:\project`). For every existing ancestor and the final entry, open without following reparse points, inspect attributes/tags, and reject unexpected symlink/junction/mount-point/reparse traversal. For a new target, inspect the closest existing ancestor. Re-run the complete walk immediately before temp creation and immediately before replacement. Prefer handle-relative/native operations where available; if the implementation only performs check-then-open with ordinary Node paths, document the residual junction-swap race and do not claim race-safe containment.

Reject candidate-created reparse points and hard links. For existing writable targets, reject unexpected multiple-link count, because modifying one hard link can modify protected content through another name. Keep temp and backup files in the validated target directory with unpredictable names, exclusive creation, no-follow inspection, and final containment recheck.

Protected matching occurs after canonicalization and Windows comparison normalization. It covers `.git`, `.env` and variants selected by policy, keys/certificates, app credentials/runtime policy, approved baselines, verifier assets, auth/payment/store/business-service paths, lockfiles/package manifests/global CSS/router by default, plus any project grant exclusions (§§14.4 and 19.4).

## Trusted execution profiles

An approved execution profile is immutable by content hash and contains the exact executable final path and identity/hash, an argv template with typed non-shell substitutions, canonical snapshot cwd, timeout, output/payload limits, exact environment-name allowlist, network intent, process-tree policy, and verifier/check-set version. At launch, re-resolve and rehash the executable/profile. Start with a minimal environment; do not inherit dangerous variables such as `NODE_OPTIONS` merely because the parent has them. Secrets are referenced by server-side handles and are never placed in renderer/MCP responses or logs.

MCP never accepts a shell command string. Native executables receive an argv array. A required `.cmd` profile is a separately approved fixed launcher with dedicated Windows quoting tests; no MCP/user string is concatenated into `cmd /c`. Metacharacters (`&|<>^%!`), quotes, Unicode, and trailing backslashes must arrive as literal arguments or the launch is refused. Package install/lifecycle scripts remain separately approved arbitrary-code execution.

Timeout/cancel terminates the owned process tree (for example with a Windows job object) and records whether cleanup succeeded. Browser request interception may enforce the preview browser policy, but its status is not reported as whole-process `network denied`. Builds and candidate JavaScript can access everything available to that OS user unless a separately implemented container/VM profile says otherwise.

Verifier controllers, geometry rules, fixtures, policies, and golden baselines are loaded by immutable ID/hash from packaged or Core-owned locations. A candidate file with the same name is ignored. Candidate build config still executes project code; this risk must be shown in the execution approval.

## Durable apply and recovery

Use a per-transaction journal under the Core-owned profile directory. It binds the sealed approval and, for each operation, operation kind, validated target identity/path, before-existence/hash/size, after-existence/hash/size, temp path/hash, backup path/hash, and a monotonic phase. Journal updates use temp-write, flush, atomic replace, and directory flush where supported. The journal itself has a checksum/version and is never stored under the candidate or project root.

Required ordering:

1. Revalidate the complete approval closure and source baseline; allocate transaction `PREPARING`.
2. Materialize exact candidate bytes into same-directory exclusive temp files. Hash, flush, and validate free space/path/permissions. Prepare and hash recoverable backups.
3. Persist and flush the full intent journal before the first target mutation.
4. For each file, revalidate path/root/before state, mark `REPLACING`, perform the replacement/create/delete, then verify the after state and persist `AFTER_CONFIRMED`.
5. Rehash all targets. Publish any accepted layout override as the next contract revision through the same transaction protocol; do not expose a half-published revision.
6. Persist `COMMITTED`, mark the approval consumed and task `APPLIED`, then clean disposable temp data. Backups/journal follow retention policy and are not ordinary candidate TTL data.

On startup, recovery verifies journal integrity and classifies each target from disk:

- `BEFORE`: exact recorded before state (including absence for create);
- `AFTER`: exact recorded after state (including absence for delete);
- `UNKNOWN`: anything else, an inaccessible/locked path, changed root identity, invalid journal, or missing/corrupt required backup.

If any entry is `UNKNOWN`, automatic forward-completion and rollback stop and the recovery UI shows evidence. If every entry is `BEFORE`/`AFTER`, Core can offer deterministic completion or rollback of this transaction only, rechecking paths before each operation. A rollback restores only `AFTER` entries whose valid backup matches the journal; it never overwrites `UNKNOWN`.

## Security negative suite

Each test asserts the domain error/state, zero unauthorized original-project writes, durable audit/event linkage, and no false `PASS`. Release evidence must use real Windows filesystem behavior and a real packaged verifier/browser where named; unit mocks alone do not satisfy §24.5.

### Grants, MCP, and state ownership

| ID | Attack/failure | Required result |
|---|---|---|
| G01 | Spoof `clientInfo` as an approved client | Pairing/grant still required; self-declaration grants nothing. |
| G02 | Unpaired principal lists projects or guesses `projectId` | No discovery; `PAIRING_REQUIRED`/`PROJECT_NOT_GRANTED`. |
| G03 | Principal A uses principal B's `taskId`, candidate, report, artifact, or request ID | Reject without existence oracle beyond the authorized scope. |
| G04 | Revoke/expire grant during prepare, verify, review, and before apply | Next boundary stops; no approval reuse or original mutation. In-progress apply reaches a journaled safe boundary. |
| G05 | Same request ID + same canonical payload concurrently through two bridges | Exactly one effect and the same durable result. |
| G06 | Same request ID + different payload/order/Unicode representation | `IDEMPOTENCY_CONFLICT`; no second effect. |
| G07 | Stale revision/lease, foreign staging root, foreign candidate ID | `REVISION_CONFLICT`, `OUT_OF_SCOPE`, or `CANDIDATE_STALE`; no auto-rebase. |
| G08 | Request report/review for `FAIL`, `ERROR`, `UNVERIFIED`, `STALE`, timeout, cancellation, empty check set, missing required check, duplicate check ID | Never enters review eligibility/PASS. |
| G09 | Call invented `approve`, `unlock`, `apply_to_main`, `run_shell`, `read_secret` tools | Unknown tool; no analogous generic IPC endpoint exists. |
| G10 | Bridge stdout includes a log/banner/BOM before MCP data | Client test fails clearly; logs only on stderr/file. |
| G11 | App stopped, bridge reconnect storm, two bridges, disconnect mid-job | `APP_NOT_RUNNING` or durable resumable status; no hidden Core or duplicated job. |

### Windows paths and protected content

| ID | Attack/failure | Required result |
|---|---|---|
| P01 | `../x`, `a/../../x`, `./x`, mixed `/` and `\`, leading separator | Reject before filesystem access. |
| P02 | `C:\x`, `C:/x`, `C:x`, UNC share, `\\?\`, `\\.\`, `\??\`, `GLOBALROOT`, named-pipe/device paths | Reject as non-relative/device paths. |
| P03 | `file:stream`, `file::$DATA`, embedded NUL/control, trailing dot/space | Reject; no alternate stream or Windows-normalized alias is created. |
| P04 | `CON`, `con.txt`, `NUL`, `AUX`, `PRN`, `COM1`/`LPT9` variants | Reject each segment independent of case/extension. |
| P05 | Allowed `src/ui` versus sibling `src/ui-evil` or root `project2` versus `project` | Boundary-aware containment rejects sibling-prefix escape. |
| P06 | Existing ancestor junction/symlink/mount point to outside, protected directory, user home, or another volume | Reject read/write/collect/apply; protected target unchanged. |
| P07 | Final file is symlink/reparse point; dangling junction is nearest existing ancestor | Reject. |
| P08 | New path is validated, then attacker swaps an ancestor to a junction before create/replace | Final recheck/handle-relative operation stops; test records residual race if native safety is absent. |
| P09 | Candidate creates a junction/symlink/reparse entry or hard link to `.git/config`, `.env`, verifier policy, or external file | Candidate invalid; target unchanged. |
| P10 | Same logical path with case-only, trailing-dot/space, 8.3 alias, or filesystem normalization collision | Reject manifest ambiguity and protected-path alias. |
| P11 | Delete/replace `.git`, `.env`, key/cert, credentials, baseline, policy, lockfile/package config, router/auth/store/business file | `PROTECTED_PATH`, including mixed-case/alias spelling. |
| P12 | Oversized text, binary content, sparse/huge file, too many entries, very long path/component | Deterministic resource/protected error; bounded memory/disk use. |
| P13 | Korean and space-containing valid path, UTF-8 BOM, CRLF | Works byte-exactly; hash/apply preserves contents and spelling. |

### Candidate, verifier, Electron, and execution

| ID | Attack/failure | Required result |
|---|---|---|
| V01 | Modify worktree after submit | Frozen candidate/report unchanged; a new submit yields new ID/hash. |
| V02 | Modify Core snapshot before/during verify or after PASS | Rehash detects it; report/review becomes `STALE`/error, never PASS/apply. |
| V03 | Candidate changes verifier script, policy, fixture, baseline, generated shell, or report/artifact file | Trusted copy is used; protected/generator mismatch fails candidate. |
| V04 | Agent reports PASS or supplies expected geometry/check result | Ignored; expected values come from approved contract/profile. |
| V05 | Replace a PASS candidate/report with another candidate after approval | Full binding mismatch stops apply; approval is not reusable. |
| V06 | Change policy/profile executable, generator, dependency lock, fixture, baseline, contract revision, or source manifest after verify | Dependent report/approval is stale; reverify required. |
| V07 | Attempt partial apply from a whole-candidate PASS | Refuse or create a new subset candidate and reverify dependency closure. |
| V08 | Required browser/build check crashes, hangs, is unsupported, is cancelled, or produces malformed output | `ERROR`/`UNVERIFIED`/`FAIL`; no aggregation to PASS. |
| V09 | Execution arg contains quotes, spaces, Korean, `%PATH%`, `!`, `&`, `|`, `^`, `<`, `>`, or trailing slash | Literal argv or refusal; no injected command. Dedicated `.cmd` matrix required. |
| V10 | Candidate uses `NODE_OPTIONS`, inherited package env, lifecycle script, child process, or changes cwd executable | Only exact approved environment/profile is used; separately approved code-execution risk remains visible. |
| V11 | Timeout/cancel spawns grandchildren | Owned process tree is terminated or cleanup failure is durable and blocks PASS. |
| V12 | Candidate preview calls Electron/Node APIs, top navigation, `window.open`, download, permission APIs, `file:`/custom protocols, or external network | No editor/preload/Node access; navigation/popup/download/permissions rejected; only declared browser network policy reported. |
| V13 | Malicious preview sends forged IPC, embeds UI lookalike, or returns HTML as screenshot | Sender/frame/schema checks reject IPC; review renders inert pixels and trusted chrome. |
| V14 | Renderer navigates away or loads remote content; child frame invokes preload | Navigation denied and IPC sender rejected; no generic filesystem/process method exposed. |

### Source drift, apply, and crash recovery

| ID | Attack/failure | Required result |
|---|---|---|
| A01 | Original branch/HEAD changes, tracked file changes, new untracked target collision, deletion, chmod/attribute/identity change before approval/apply | Stop before first mutation with stale/conflict evidence. |
| A02 | Change an unrelated protected/imported file covered by `baseManifestHash` | Candidate becomes stale even if changed output paths match. |
| A03 | Low disk while preparing temp/backups | No original mutation; durable failure and cleanup-safe temp state. |
| A04 | Target locked or antivirus races each create/replace/delete | Retry only bounded safe operations; otherwise journaled recovery state, no skipped file. |
| A05 | Kill process after every journal/temp/backup/replace/verify/commit boundary for a 3-file mix of create/replace/delete | Startup classification is correct; result can reach exact all-before or all-after, never silent mixture. |
| A06 | Kill between OS replacement and journal phase update | Disk hashes classify the file as AFTER and recovery remains deterministic. |
| A07 | User edits an already replaced file before recovery | File is UNKNOWN; no auto overwrite/rollback. |
| A08 | Delete/corrupt journal, backup, temp, or change root identity before recovery | `MANUAL_INTERVENTION`; no guessed rollback. |
| A09 | Cancel/revoke during APPLYING | Stop only at safe boundary; transaction remains recoverable. |
| A10 | Crash while publishing accepted override/new contract revision | Source and revision reconcile through the same transaction; old candidate is stale after completed revision publish; no half-visible approved revision. |
| A11 | Retry apply/approve request after success or with changed canonical payload | Returns original result or idempotency conflict; never applies twice. |
| A12 | Cleanup/TTL runs with pinned baseline, approval journal, active/recovery transaction | Retained; ordinary candidate quota cleanup cannot delete recovery inputs. |

For A05, inject a deterministic crash at every durability boundary and run both forward completion and rollback choices. Assert exact SHA-256 values, file absence/presence, journal phase, SQLite state, contract export/revision, task history, and that unrelated user files are byte-identical.

## Contract gaps requiring an ADR or explicit internal type

1. **Approval closure is not represented by the MCP report shape.** Production plan §13.3 requires candidate `generatorVersion`, `policyHash`, `dependencyLockHash`, `fixturesHash`, and `verificationProfileHash`; §16 binds approval to candidate hash, contract revision, report ID, and policy revision. `boxspec_get_report` exposes `reportId`, candidate/tree/base/effective/override hashes and statuses, but not policy revision/hash, verification profile hash, evidence manifest hash, base revision/commit/manifest, generator version, dependency lock, or fixture hash. This is safe only if a sealed internal `VerificationBinding`/`ApprovalBinding` carries the full tuple and apply never consults mutable current values. Decide whether the MCP report also exposes these for reviewability.
2. **Recovery needs states outside the task enum.** §13.1 has `APPLYING` and `APPLIED`, while §§9.4 and 25.1 require startup recovery and an UNKNOWN/manual path. Use a separate durable apply-transaction enum (`PREPARING/APPLYING/RECOVERY_REQUIRED/MANUAL_INTERVENTION/ROLLED_BACK/COMMITTED`) or extend the task schema. Do not map UNKNOWN to generic `FAILED` and discard the transaction.
3. **Candidate hash extent is underspecified.** §13.3 says `treeHash`, while §14.5 says snapshot hash and §15 executes builds. Define whether the hash covers the entire executable snapshot, not only `changedFiles`; otherwise an unbound imported/config file can change verification behavior.
4. **Accepted override publication crosses SQLite and project files.** §6.6 requires the new contract revision publish in the same apply journal, while §9.2 makes SQLite authoritative and §9.4 acknowledges filesystem operations are not one atomic transaction. The apply design needs an explicit pending/visible revision protocol and crash reconciliation rules.
5. **Windows race resistance needs an implementation decision.** §19.4 requires ancestor reparse checks and a final recheck but does not specify handle-relative/native mutation. Ordinary path-based Node operations leave a check/use race. Either ship a narrow native helper and test the swap race, or document/block combinations that cannot meet the containment guarantee.

All five are release-significant. None permits weakening the approval, hash, path, or user-data protections while awaiting an ADR.
