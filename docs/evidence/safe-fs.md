# Safe filesystem helper evidence

Date: 2026-09-22  
Host: Windows 11 x64, build 26200  
Supported implementation: `crates/boxspec-safe-fs/dotnet`  
Protocol: `boxspec-safe-fs.exe --protocol 1`

## Artifact

- Canonical self-contained single-file executable: `crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe`
- Size: `67,548,236` bytes
- SHA-256: `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`
- Runtime prerequisite: none beyond supported Windows x64; the .NET runtime is included.
- Intended packaged path: `build/native/win32-x64/boxspec-safe-fs.exe`.
- Packaging requirement: hash-pin this exact artifact before every spawn and add signature/publisher verification before release.

Rust was unavailable (`rustc`, `cargo`, MSVC `cl/link`, Zig, Clang, and GCC were absent). The installed .NET SDK 8.0.425 provided the bounded no-installer route. The retained Rust files are an unbuilt design reference and are explicitly not approved for packaging because their lexical artifact opens failed security review.

## Commands and results

Self-contained publish:

```powershell
dotnet publish dotnet/BoxSpec.SafeFs.csproj -c Release -r win-x64 `
  --self-contained true -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishDir=../bin/
```

Result: exit `0`.

Adversarial suite:

```powershell
& .\tests\windows-integration.ps1 `
  -Exe .\bin\boxspec-safe-fs.exe
```

Result: two consecutive runs exited `0`, each with `passed:true`, `assertions:55`, and the executable hash listed above. The delayed 192 MiB concurrent commit held the ancestor chain: `raceAttackerMoved:false`, `raceHelperOk:true`. A zero-delay substitution before the helper opened the chain returned `ok:false` and neither changed the outside sentinel nor created an outside target. A long-chain directory test also proved that a successful ensure followed by an attacker move left the new directory only in the retained original chain and never through the substituted junction. Its timing did not deterministically land during the ensure operation, so it is not cited as in-flight lock proof. A crash-after-prepare simulation called `restore_before` while the target was already BEFORE and proved both exact sidecars were removed before the idempotent `changed:false` return.

The suite uses only newly allocated system-temp trees and covers:

| Case | Observed result |
|---|---|
| inspect approved root | final path + 128-bit file ID + volume ID returned |
| ensure missing directory tree | every segment created relative to retained parent; idempotent retry |
| ensure file/junction collision | rejected; no creation through the collision |
| two concurrent directory creators | both reopen/revalidate the final chain successfully |
| prepare/commit replacement | exact after bytes/hash, non-replacing relative rename |
| classify before/after | exact `BEFORE` then `AFTER` |
| restore/finish recovery | exact backup restored; exact temp completed |
| finalize | exact artifacts removed handle-relatively; repeat is idempotent |
| source edit after prepare | `SOURCE_DRIFT`; edit preserved |
| target hard link | `HARD_LINK`; peer preserved |
| junction/reparse ancestor | `REPARSE_POINT`; outside sentinel preserved |
| approved-root name substitution | `ROOT_IDENTITY_CHANGED`; both trees preserved |
| traversal/drive/ADS/device/superscript/trailing-dot forms | `INVALID_PATH` before traversal |
| concurrent ancestor rename/junction swap | either pre-walk rejection or rename blocked by retained handles; no outside write |

Independent diagnosis in `docs/evidence/native-debug.md` reproduced why `SetFileInformationByHandle(FileRenameInfo=3)` returned Win32 error 87 with a non-null relative root on this host. The accepted implementation uses `NtSetInformationFile(FileRenameInformation=10)` with the same retained parent and documented `FILE_RENAME_INFORMATION` layout. Microsoft documents the underlying identity rule (`FILE_ID_INFO` combines volume serial and 128-bit ID) and relative rename structure: [FILE_ID_INFO](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info), [FILE_RENAME_INFO](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info).

## Guarantee and residual boundary

The tested helper closes the ordinary ancestor-junction and leaf-replacement races for a single operation:

1. It verifies the approved root final path, volume ID, and 128-bit file ID.
2. It uses retained parent handles for each `NtCreateFile` child open and denies delete sharing on the root/ancestor chain.
3. It opens without following reparses and rejects every nonzero reparse tag.
4. It creates managed directories with NT `FILE_CREATE | FILE_DIRECTORY_FILE`, or temp/backup files with NT `FILE_CREATE`, relative to retained parents; a directory collision is reopened and fully revalidated.
5. It flushes temp/backup contents and reopens them by expected file identity/hash.
6. It pins the exact target without write/delete sharing, deletes that checked object, and renames temp relative to the retained parent with replacement disabled.
7. It reopens and proves exact AFTER before success. Recovery mutates only exact BEFORE/AFTER and rejects UNKNOWN.

The evidence does not establish an OS sandbox against another process running as the same user. Prepare and commit are separate processes; artifacts are revalidated at commit because no handle spans that boundary. `preparedId` is a descriptor for the trusted journal, not an authority token, capability, or MAC. Authorization lives in the authenticated runtime, sealed approval, and change-manager journal; untrusted MCP/renderer inputs cannot invoke the helper, and the helper grants no privilege beyond the current OS user. The caller must protect the journal and approval closure and must never expose the helper as a generic IPC tool. Same-user termination/debugging, ACL changes, volume/file-ID reuse over time, filesystem/driver defects, and denial of service remain outside the guarantee. Cross-file Windows collision detection remains a change-manager batch invariant; this one-file protocol only verifies the resolved entry name. Deterministic pre-walk substitution, post-operation move, and the shared retained-handle primitive are tested; a synchronized in-flight `ensure_directory` move is not independently demonstrated. File buffers are flushed; directory-entry durability is not claimed because Windows exposes no equivalent directory fsync through this helper. Multi-file apply is still recoverable, not atomic.

## Integration gate

The helper is integrated through `NativeSafeFsClient` with the protocol in `crates/boxspec-safe-fs/README.md`. The shared manifest pins `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`. Change-manager reports 31/31 tests and independent native/path tests 27/27: zero-parent `.boxspec/screens` multi-level creation plus idempotent retry, public exact apply with sidecar cleanup, and crash/restart classification and restore. Change-manager, runtime, and desktop typechecks exit 0.

Windows production apply must remain fail-closed until the remaining release composition checks are true:

- the packaged application invokes only the pinned path, never `PATH`;
- the full intent journal and returned `preparedId` are durable before commit;
- each committed file is finalized only after AFTER is durable;
- startup uses `classify_recovery` and refuses automatic action on UNKNOWN;
- packaging copies the self-contained artifact, pins its hash, and adds the required code-signing/publisher check;
- the Electron end-to-end save/apply/recovery suite is rerun against the rebuilt runtime and packaged executable.
