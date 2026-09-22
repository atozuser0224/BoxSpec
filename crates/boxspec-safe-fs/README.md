# BoxSpec safe filesystem helper

The supported implementation is `dotnet/`: a Windows-only, one-request process using retained directory handles, `NtCreateFile` relative opens, and `NtSetInformationFile` relative rename. The Rust source is an unbuilt design reference because this host has no Rust toolchain; it failed the initial lexical-parent security review and must not be packaged or invoked.

## Build and run

```powershell
dotnet publish dotnet/BoxSpec.SafeFs.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishDir=../bin/

'{"op":"inspect_root","requestId":"r1","root":"C:\\project"}' |
  .\bin\boxspec-safe-fs.exe --protocol 1
```

The process accepts exactly one bounded JSON object on stdin and emits exactly one JSON object on stdout. Diagnostics go to stderr. Invalid argv, malformed JSON, or input over 24 MiB exits nonzero; domain rejection returns exit zero with `ok:false`.

Callers must SHA-256 pin the packaged executable before every spawn. The canonical tested self-contained artifact is `bin/boxspec-safe-fs.exe`. Packaging copies those exact bytes to `build/native/win32-x64/boxspec-safe-fs.exe`; the helper does not discover itself through `PATH`.

## Protocol 1

Every request has `requestId` (1–128 ASCII letters, digits, `.`, `_`, or `-`). Mutation and recovery requests also have `transactionId`, absolute `root`, `rootIdentity`, normalized `relativePath`, and operation-specific bindings. Unknown fields are rejected.

```ts
type RootIdentity = {
  canonicalPath: string; // final path from the approved root handle
  volumeId: string;      // 16 lowercase hex characters
  fileId: string;        // 128-bit ID, 32 lowercase hex characters
};
type EntryIdentity = { volumeId: string; fileId: string };

type Request =
  | { op: "inspect_root"; requestId: string; root: string }
  | { op: "resolve_relative"; requestId: string; root: string; rootIdentity: RootIdentity;
      relativePath: string; allowMissing: boolean }
  | { op: "ensure_directory"; requestId: string; root: string; rootIdentity: RootIdentity;
      relativePath: string }
  | { op: "prepare_replace"; requestId: string; transactionId: string; root: string;
      rootIdentity: RootIdentity; relativePath: string; expectedBeforeHash: Sha256 | null;
      expectedBeforeFileId: string | null; afterBytesBase64: string | null }
  | { op: "commit_replace"; requestId: string; transactionId: string; root: string;
      rootIdentity: RootIdentity; relativePath: string; preparedId: string }
  | { op: "classify_recovery"; requestId: string; transactionId: string; root: string;
      rootIdentity: RootIdentity; relativePath: string; beforeHash: Sha256 | null;
      afterHash: Sha256 | null; preparedId: string | null }
  | { op: "recover_replace"; requestId: string; transactionId: string; root: string;
      rootIdentity: RootIdentity; relativePath: string; preparedId: string;
      decision: "restore_before" | "finish_after" }
  | { op: "finalize_replace"; requestId: string; transactionId: string; root: string;
      rootIdentity: RootIdentity; relativePath: string; preparedId: string };

type Response =
  | { ok: true; requestId: string; result: object }
  | { ok: false; requestId: string;
      error: { code: string; message: string; retryable: boolean } };
```

`expectedBeforeHash:null` means the target must be absent. `afterBytesBase64:null` means delete. A non-null payload is limited to 16 MiB. Files read for before/backup/recovery classification are limited to 256 MiB. `preparedId` is bounded base64url JSON that binds the transaction, root, relative path, parent/file/artifact identities, and before/after hashes. It is a descriptor, not an authentication token or capability. Authorization lives in the authenticated runtime, sealed approval, and trusted change-manager journal; untrusted MCP/renderer inputs cannot invoke the helper. The helper grants no privilege beyond the current OS user.

Successful result shapes are:

```ts
type InspectResult = { rootIdentity: RootIdentity; reparseTag: string };
type ResolveResult = { exists: boolean; finalPath: string; parentIdentity: EntryIdentity;
  target: null | { identity: EntryIdentity; kind: "file" | "directory" | "reparse";
    linkCount: number; reparseTag: string; size: number } };
type EnsureDirectoryResult = { finalPath: string; identity: EntryIdentity; created: string[] };
type PrepareResult = { preparedId: string; disposition: "create" | "replace" | "delete";
  beforeHash: Sha256 | null; afterHash: Sha256 | null; backupHash: Sha256 | null;
  parentIdentity: EntryIdentity };
type CommitResult = { afterHash: Sha256 | null; targetIdentity: EntryIdentity | null };
type ClassifyResult = { state: "BEFORE" | "AFTER" | "UNKNOWN"; reason: string | null;
  canRestoreBefore: boolean; canFinishAfter: boolean };
type RecoverResult = { state: "BEFORE" | "AFTER"; targetHash: Sha256 | null;
  targetIdentity: EntryIdentity | null; changed: boolean };
type FinalizeResult = { finalized: true; removedTemp: boolean; removedBackup: boolean };
```

The change-manager must durably persist its complete intent journal and `preparedId` before `commit_replace`. After durable AFTER confirmation it calls `finalize_replace`; finalize first proves the target is exact AFTER, then deletes only exact identity/hash-matched artifacts relative to the retained parent. Recovery refuses `UNKNOWN` and removes remaining exact artifacts only after reaching the selected state. `ensure_directory` is reserved for trusted runtime/change-manager parents under fixed managed-output prefixes; it must never be exposed as renderer/MCP-selected generic filesystem authority.

## Security boundary

Within one operation, the helper opens the approved root and every ancestor with no delete sharing, preventing rename/reparent while retained. Descendants and artifacts are opened relative to those handles with `FILE_OPEN_REPARSE_POINT`. It rejects any reparse tag, a volume change, a final-name alias, special/non-disk kinds, and multiply-linked writable files. Final file and artifact handles omit write/delete sharing. Temp and backup files use unpredictable same-directory names and `FILE_CREATE` (`CREATE_NEW`) relative to the retained parent. Replacement marks the exact checked target handle for deletion, then renames the checked temp with `replace=false` relative to the retained parent. A racing new leaf makes the rename fail rather than overwrite it. Directory provisioning uses `FILE_CREATE | FILE_DIRECTORY_FILE` one segment at a time relative to the retained parent. A concurrent creator is accepted only after the exact resulting entry is reopened without following reparses and passes directory, identity, volume, containment, and name checks. Partial safe directories may remain after interruption; retry is idempotent and the helper never removes them.

This is race-resistant containment for the tested Windows 11/NTFS behavior, not a same-user OS sandbox. Handles cannot authenticate the caller, defend the journal, or stop another same-user process between separate prepare/commit processes; identity and hash revalidation detects those changes. A same-user process with permission to terminate or debug the helper remains outside this boundary. Multi-file apply remains journaled and recoverable rather than atomic. `FlushFileBuffers` is applied to temp and backup file handles; the helper does not claim Windows directory-fsync durability. Executable signing and publisher verification remain packaging release requirements in addition to hash pinning.
