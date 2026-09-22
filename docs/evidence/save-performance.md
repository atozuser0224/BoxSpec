# Save confirmation performance investigation

Date: 2026-09-22

## Result

The approximately 11 second save observed in the Electron campaign is caused by
repeated startup of the 67 MB self-contained .NET safe-filesystem helper and by
re-hashing that executable before every native request. SQLite persistence is not
the bottleneck in this measurement.

There are two different durable checkpoints in the current product:

1. `executeEditorCommand` commits the edited contract and command record in a
   SQLite transaction. The database uses WAL mode and `synchronous=FULL`. A
   successful IPC result therefore confirms that the BoxSpec database contains
   the edit.
2. `saveProject` exports the contract, generated React files, and generated
   manifest to the project tree. A source save is complete only after every
   changed file is exact AFTER, each native replacement has been finalized, and
   the durable managed-save batch has been removed.

On this machine, four database edit samples completed in **8.94-50.77 ms**. A
changed source export completed in **7.747-9.049 s** after a screen rename, and
the first export completed in **13.017 s**. The B14 `save confirmation <=500ms`
target is supported by this small sample only when confirmation means the first,
database-durable checkpoint. It is not met for source export, and this document
does not claim a 500 ms source-write result.

## Reference machine and method

The measurements ran on the repository's real built artifacts and a newly
created directory under the Windows temporary directory. The harness deleted
only that temporary directory after each run.

| Item | Value |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200, build 26200 |
| CPU | Intel Core i7-1165G7, 8 logical processors |
| Node | 24.19.0 |
| PowerShell | 7.6.5 |
| Native helper | `crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe` |
| Helper size | 67,548,236 bytes |
| Helper SHA-256 | `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8` |

The runtime run used `createBoxSpecRuntime`, created one real project and one
screen, and called the public runtime operations. It recorded:

- initial `saveProject`;
- an unchanged `saveProject`;
- four `rename-screen` editor commands, each committed before timing stopped;
- three `saveProject` calls immediately after a rename; and
- close/reopen of the same isolated state.

The native microbenchmarks used the packaged executable and protocol 1. The
production-client samples called `NativeSafeFsClient`. The direct samples sent
the same protocol requests to the pinned artifact without the client's
pre-spawn hash read; this was a measurement control only, not a proposed
production mode. Each replacement used a new file below the isolated approved
root and retained the normal `inspect_root`, `ensure_directory`,
`prepare_replace`, `commit_replace`, and `finalize_replace` sequence.

`performance.now()` measured elapsed wall time around awaited calls. These are
small diagnostic samples on one development machine, not p95 results. No clean
boot, antivirus exclusion, CPU isolation, or filesystem-cache flush was used.

## Measurements

### Native startup and executable verification

| Probe | Samples | First (ms) | Following median (ms) | Range (ms) |
| --- | ---: | ---: | ---: | ---: |
| Read and SHA-256 the 67 MB helper in the existing Node process | 8 | 139.15 | 120.00 | 104.90-139.15 |
| Spawn helper and call `inspect_root`, without client pre-hash | 8 | 186.68 | 142.30 | 127.77-186.68 for following calls |
| Real `NativeSafeFsClient.inspectRoot` | 8 | 339.61 | 412.05 | 340.50-683.48 for following calls |

The hash-only median over all eight samples was 124.97 ms. The direct-spawn
median over all eight samples was 160.86 ms; the production-client median was
412.05 ms.

"Following" here means that the OS file cache and runtime may be warm. It is
not a warm helper process: protocol 1 accepts one request, emits one response,
and exits, so **every native request starts a fresh .NET process**. The first
production-client sample being faster than several later samples also shows
that this is repeated process/I/O cost with material host variance, rather than
a single cold-start penalty that disappears after the first call.

One real production-client file lifecycle took:

| Phase | Time (ms) |
| --- | ---: |
| `inspectRoot` | 667.46 |
| `ensureDirectory` | 1,022.28 |
| `prepareReplace` | 1,534.81 |
| `commitReplace` | 689.24 |
| `finalizeReplace` | 513.85 |
| **Total** | **4,427.64** |

That lifecycle made five process starts and five complete executable hash reads.
As a control, three direct lifecycles with the client hash step omitted took
586.15, 600.21, and 653.55 ms; the median phase breakdown was 108.95 ms inspect,
117.00 ms ensure, 124.65 ms prepare, 125.92 ms commit, and 127.64 ms finalize.
Caching only the executable hash would therefore still leave five process
starts and did not demonstrate a path to a 500 ms source save.

### End-to-end runtime

| Operation | Result |
| --- | ---: |
| Runtime open | 218.65 ms |
| Create project | 446.26 ms |
| Create screen (database and runtime state) | 47.34 ms |
| First source save | **13,016.82 ms** |
| Unchanged source save | 39.38 ms |
| Durable database editor command, n=4 | 8.94, 9.89, 13.12, 50.77 ms |
| Changed source save after rename, n=3 | **7,747.08, 8,574.32, 9,049.01 ms** |
| Runtime close | 69.54 ms |
| Runtime reopen | 849.79 ms |

The first one-screen export planned five outputs:

- `.boxspec/screens/<screen>.contract.json`;
- three generated React/CSS/types files; and
- `.boxspec/generated-manifest.json`.

Five changed outputs caused 25 native requests/process starts: five native
requests per file. Renaming the screen changed three outputs (contract, generated
TSX containing the contract hash, and manifest), causing 15 native
requests/process starts. The CSS and types outputs were hash-identical and were
skipped. The unchanged save made no native replacement calls and completed in
39.38 ms.

For every changed file, runtime also performs two durable runtime-state writes:
one after prepare to persist `preparedId` and before/after hashes before commit,
and one after verified finalize to remove that per-file journal. The complete
batch is durably added before the first replacement and removed only after every
output is exact AFTER. Those writes are necessary crash-recovery boundaries.
The unchanged 39.38 ms save includes the batch add/remove state writes but no
native replacement, which makes them a minor part of the multi-second result on
this machine.

## Code-path diagnosis

- `packages/core/src/repository.ts` configures SQLite with WAL and
  `synchronous=FULL`; editor mutations update the screen and insert the command
  inside one transaction.
- `packages/runtime/src/runtime.ts` returns from `executeEditorCommand` only
  after that transaction. `saveProject` separately compiles all screens,
  persists a complete output batch, and resumes it.
- On Windows, `#writeManagedFile` calls `inspectRoot`, `ensureDirectory`,
  `prepareReplace`, persists the prepared replacement, calls `commitReplace`,
  verifies the returned AFTER hash, calls `finalizeReplace`, and removes the
  per-file journal.
- `packages/change-manager/src/native-safe-fs.ts` calls `verifyExecutable` for
  every request. That method reads and hashes the complete executable. The
  request then spawns `boxspec-safe-fs.exe --protocol 1`.
- The native helper intentionally handles exactly one request per protocol 1
  process. Every mutation request independently opens and validates the root,
  ancestors, identities, containment, reparse status, and bound hashes.
- At measurement time, `apps/desktop/src/renderer/App.tsx` set `dirty=true`
  after the already-durable editor command and changed to `SAVED` only after
  the separate source export finished. The visible label therefore described
  source-export state, not whether the contract edit survived restart. This UI
  ambiguity was corrected during the investigation as described below.

The output-count correlation, the near-zero cost of an unchanged save, and the
native microbenchmarks identify repeated executable verification and one-shot
.NET startup as the bottleneck. The database and compiler are not consistent
with the measured multi-second scaling.

## Smallest safety-preserving remedy

### Safe-filesystem owner

Add an opt-in, bounded session form of the existing protocol. A practical shape
is newline-delimited protocol-1 request/response objects under a new explicit
argument such as `--session-protocol 1`. Keep the existing one-request protocol
for compatibility and recovery tooling.

The session is an amortization boundary only. Every request must retain the
current schema validation, per-request input/output limits, independent root and
path opening, root-identity comparison, reparse/volume/containment checks,
prepared-ID binding, hash checks, and `FlushFileBuffers` behavior. Put a maximum
request count and lifetime on a session. Do not combine prepare and commit:
runtime must durably persist `preparedId` between those two responses.

### Change-manager owner

Add a serialized, save-batch-scoped `NativeSafeFsClient` session. Read and
SHA-256 verify the executable immediately before the one session spawn, then
send request-ID-bound operations through that child with the existing timeouts
and byte limits applied per response. A new save/recovery batch gets a new
verified process.

If the child exits or its framing becomes invalid during a mutation, return an
ambiguous/recoverable failure. Do not blindly replay commit. The runtime's
durable managed-write journal and `classify_recovery` must decide whether the
target is BEFORE, AFTER, or UNKNOWN.

This changes neither caller authority nor durability ordering. It removes 14
process starts and executable reads from a three-output rename save and 24 from
a five-output first save.

### Runtime owner

Pass the batch-scoped native session through `#resumeManagedSaveBatch` and
`#writeManagedFile`. Inspect and compare the approved root identity once when
the batch starts, then continue to supply that identity to every native request;
the helper must still reopen and validate it on every operation. Call
`ensureDirectory` once per unique managed parent in the batch. For a one-screen
first save this changes the request model from 25 calls to 19 calls (one inspect,
three unique parent ensures, and prepare/commit/finalize for five files), all in
one verified helper process.

Keep all existing durable checkpoints:

1. persist the complete batch before the first file;
2. prepare one file;
3. fsync the per-file journal containing `preparedId` before commit;
4. commit and require the exact expected AFTER hash;
5. finalize exact artifacts;
6. durably remove the per-file journal; and
7. remove the batch only after all outputs are exact AFTER.

Do not replace these steps with one native multi-file call unless the helper
also becomes the durable journal owner and proves equivalent crash recovery;
that is a larger design and is not needed to address the measured bottleneck.

### Desktop owner

This part of the remedy was applied concurrently and passed the desktop owner's
direct TypeScript check. After a successful editor command, the UI now reports
`LOCAL SAVED · SOURCE PENDING`; during `saveProject` it reports `LOCAL SAVED ·
EXPORTING`; and only a completed `saveProject` reports `SOURCE SYNCED`. A
successful database acknowledgement does not clear the pending-export state.

This gives the user a measured sub-500 ms database confirmation without
misreporting source durability. If the product requires the Save button itself
to mean that source files are written, its success must continue to wait for the
full source checkpoint.

## Required remeasurement

The batch-session change has not been implemented or timed in this
investigation. After implementation, repeat the same isolated first-save,
unchanged-save, and three changed-save samples, then run a larger sample for p50
and p95 on the documented reference machine. Record helper process count,
executable verification count, changed-output count, and recovery behavior.

Do not mark the full source-write 500 ms target complete unless those measured
end-to-end source saves meet it. Also retain fault-injection evidence for process
termination after prepare-journal fsync, during commit, after AFTER verification,
and before batch removal; recovery must never overwrite UNKNOWN content.
