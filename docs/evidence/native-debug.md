# Windows native safe-fs rename diagnosis

Date: 2026-09-22 (Asia/Seoul)

Scope: independent, read-only review of `crates/boxspec-safe-fs` plus bounded reproductions under unique `%TEMP%` directories. No project/source file was used as a mutation target.

## Result

The reported `ERROR_INVALID_PARAMETER` was caused by the API surface, not by the retained-parent security design or the x64 field offsets. On Windows 11 25H2 build 26200.9168, `SetFileInformationByHandle(FileRenameInfo = 3)` rejected a `FILE_RENAME_INFO` containing a non-null `RootDirectory` and relative leaf with Win32 error 87. `NtSetInformationFile(FileRenameInformation = 10)` accepted the same source/parent handles and the same buffer layout and returned `STATUS_SUCCESS`.

The safe repair is the current design direction: retain the validated parent handle, keep the source artifact open with `DELETE` access, and call `NtSetInformationFile` with information class 10 and a relative leaf. Do not fall back to a lexical absolute destination or release the retained ancestors. A racing destination remains fail closed because `ReplaceIfExists` is false.

Official contracts:

- Microsoft documents `FileRenameInformation (10)` for `NtSetInformationFile`, with `FILE_RENAME_INFORMATION` and required `DELETE` access on the source: <https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile>.
- Microsoft documents that `RootDirectory` is the destination-directory handle for relative rename, and that the parent can be opened for traverse/read-attributes while the internal relative open requests write/synchronize: <https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information>.
- Microsoft documents handle-relative `NtCreateFile`, `FILE_OPEN_REPARSE_POINT`, `FILE_SYNCHRONOUS_IO_NONALERT`, and share compatibility: <https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile>.
- The Win32 documentation says `FILE_RENAME_INFO.RootDirectory` can carry a directory handle, but the host reproduction below establishes that the wrapper rejects that form on this supported host: <https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info>.

## Independent API reproduction

Temporary root: `C:\Users\j\AppData\Local\Temp\boxspec-rename-api-probe-be98e11c024c480b92e2efedec0126ce`

The probe used a 64-bit buffer with `RootDirectory` at offset 8, `FileNameLength` at 16, and `FileName` at 20. It varied only the API/information-class pair:

```text
pointerSize=8;headerOffset=20;
setOk=False;setError=87;setDest=False;
ntStatus=0x00000000;ntDest=True
```

This rules out the field offsets as the explanation for error 87. It also confirms that changing to the native information class preserves the non-lexical destination anchor.

## Real helper evidence

Framework-dependent helper SHA-256 `ee18e54064f0dabcd62438cb1722a550901c9693a02679770f92bebfc332efa1` completed `inspect_root`, `prepare_replace`, and `commit_replace` against `C:\Users\j\AppData\Local\Temp\boxspec-native-debug-a127a016c4e6481482131aa242d51ed8`. All processes exited 0, responses were `ok: true`, stderr was empty, and the committed bytes were exactly `after-native-debug`. Expected, reported, and independently recomputed SHA-256 were all:

```text
893c94b0a3fdd54e89c31399ae5ba5ea5697097caf3ef176bd28cd0f3b2bc635
```

Self-contained helper SHA-256 `6fe6ef78be2ba43b590c99b75ea9c437a6d54fdfbfb5fe130726d7db330def5e` was then exercised at `C:\Users\j\AppData\Local\Temp\boxspec-native-recovery-01c4f1b2945a4ea98cb4495c13f480d0`:

- `recover_replace(finish_after)` from a prepared BEFORE state returned AFTER and exact SHA-256 `fa1d12920a771bfe5d11252bcce860f6734e042de04fdcdbf7caff5ce19c4570`.
- `commit_replace` followed by `recover_replace(restore_before)` returned BEFORE and exact SHA-256 `3a60a98d1aa6a3de6f24d5d5d424653871e275d5fdae50382c956ec17767c38f`.
- Both recovery processes exited 0 with `ok: true` and empty stderr.

An independent UNKNOWN-state refusal ran at `C:\Users\j\AppData\Local\Temp\boxspec-native-unknown-68b8b081d956460fabb94a9ceaee9e72`. After prepare, the target was changed to unrelated bytes. `recover_replace(finish_after)` returned `ok: false`, code `UNKNOWN_STATE`; the file stayed byte-for-byte unchanged at SHA-256 `30d4812557d73156ad212e7c3a659f3a1b82f8d7082eacef2b13d363210c8359`.

The source owner continued rebuilding after these runs. These hashes identify the exact artifacts tested and must not be attributed to a later binary without a rerun.

Final-candidate rerun: self-contained helper SHA-256 `d9d9e123d129624667b5119f5d07e3b0c541530321fe9584b072030f43326d3f`, 67,544,140 bytes. The hash was checked immediately before and after the run and did not change. At `C:\Users\j\AppData\Local\Temp\boxspec-native-final-16b53d62b9244d40896dafa8ba065dc5`:

- `inspect_root` returned `ok: true`.
- real `prepare_replace` plus `commit_replace` exited 0, returned `ok: true`, emitted no stderr, and produced exact independently hashed bytes `5800596a3de240189cabafe41c409d624120e82526b46ceadf525c703f01da96`;
- `recover_replace(finish_after)` from BEFORE exited 0, returned AFTER, emitted no stderr, and produced the same exact expected hash; and
- an unrelated user edit caused `recover_replace(finish_after)` to return `UNKNOWN_STATE`; the target stayed unchanged at `16dd82023e7cd252aa873696e4146024f3ba3d0b7575ec405d393dd1ec6e2464`.

The frozen candidate added stricter target/artifact sharing and supersedes that hash. Self-contained helper SHA-256 `bf40eda44e5b8718982ecbfdb1588bf36b39f3728619d11bb1e2c95f21f66f3b`, 67,544,140 bytes, was checked immediately before and after the independent run at `C:\Users\j\AppData\Local\Temp\boxspec-native-frozen-47bf2ec870cb430ba3cb10b7cf4fda5c` and did not change. `inspect_root` succeeded; real prepare/commit exited 0 with `ok: true`, empty stderr, and exact expected/actual SHA-256 `52fcbe2bc8dd82ea25212e16bd93fa139006d8e5e899a03bdbd04ecbfdb54713`. An unrelated edit again returned `UNKNOWN_STATE` and remained unchanged at `968061b803d76ea8ad9889d7415965ffba6105082204fbc55a65e87c07dcb4f5`.

A protocol-strictness-only rebuild supersedes the prior package: final self-contained SHA-256 `9a6303c25b08f2cd3a9c942cca3c69efe965adba59f734eae5234afbf1de77a8`, 67,544,140 bytes. Its hash was stable before and after the independent valid-request smoke run at `C:\Users\j\AppData\Local\Temp\boxspec-native-protocol-final-aa3704b2f5334117ac454888773611a7`. Inspect, prepare, and commit all returned `ok: true`; commit exited 0 with empty stderr and exact expected/actual SHA-256 `eedb15cf1a9b69f3c17f9d47b9ff7930aead6a10e895053df211681034b0a65a`.

## Remaining implementation concerns

1. The owner corrected the rename buffer to meet Microsoft's documented `sizeof(FILE_RENAME_INFORMATION) + FileNameLength` minimum, pinned each raw parent handle with `DangerousAddRef`/`DangerousRelease`, and set `UNICODE_STRING.MaximumLength` to `Length + 2`. The final-candidate rerun above covers those changes.
2. Access/share logic is consistent with the documented contract: artifacts have `DELETE`; directory handles have generic read (including traverse/read-attributes); `FILE_SHARE_WRITE` permits the rename target open; omitting `FILE_SHARE_DELETE` pins root/ancestors; `FILE_OPEN_REPARSE_POINT` prevents final-component reparse following; and `replace = false` refuses a racing destination.
3. `preparedId` remains unsealed caller-controlled base64 JSON. Hash, identity, parent, root, and state rechecks limit drift, but they do not authenticate authority. SEC-038 still requires a helper-held seal or an independently authenticated journal binding.

No concurrent ancestor-swap stress campaign or forced process-kill-at-every-boundary campaign was run in this diagnosis. Those remain release evidence gates even though the reviewed primitive avoids lexical artifact open/rename/delete after validation.
