# Windows install, update, and recovery runbook

## Supported artifact types

The packaging command produces an unpacked Windows x64 application, a portable ZIP, and an unsigned per-user setup executable. The setup executable is an offline IExpress container around the same SHA-256-verified portable ZIP. It installs under `%LOCALAPPDATA%\Programs\BoxSpec\app-<version>` without administrator rights.

Release builds must be Authenticode-signed before publication. The current development artifact intentionally includes `unsigned` in the setup filename. Do not publish it as a trusted download and do not present Windows SmartScreen warnings as a user-configurable bypass.

## Reproducible command

From the repository root on Windows, with the exact lockfile installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/smoke-windows.ps1
```

Invoke the PowerShell entry directly. A pnpm `run` wrapper can perform a root freshness install before the script starts when workspace manifests change, so it is not the canonical packaging entry. The script builds workspace dependencies and the desktop app, copies the lockfile, manifests, and compiled output into `build/package-workspace`, and runs every production install and deploy from that isolated copy. It snapshots the source lockfile, manifests, and representative dependency links before staging and fails if they change.

The command packages Electron into `build/windows/unpacked/BoxSpec-win32-x64` and writes the portable and installer artifacts. `build/windows/artifact-manifest.json` records versions, source lock hash, paths, hashes, signing state, bridge inclusion, native-helper identity, browser inclusion, and updater status. `build/windows/SHA256SUMS` is the compact hash list.

The smoke command uses only isolated directories under `build/windows/smoke`. It exercises unpacked launch, the actual `better-sqlite3` native binding through `BoxSpecCore`, a close/reopen/write cycle, quiet install, installed launch, uninstall, and preservation of an isolated profile sentinel. It does not represent a clean-VM test.

## Install and uninstall

Run `BoxSpec-<version>-win-x64-setup-unsigned.exe` for the development installer. A normal installation creates Start Menu and Desktop shortcuts and registers a per-user uninstall entry. The installer validates the embedded portable ZIP before replacing a same-version directory. A failed same-version replacement restores the previous directory when possible.

Uninstall removes only version directories recorded in `%LOCALAPPDATA%\Programs\BoxSpec\installation.json`, shortcuts, the per-user uninstall registry key, and installer metadata. It does not remove `%APPDATA%\BoxSpec`, approved contracts, project repositories, Git worktrees, candidate evidence, or migration backups. Cache/profile removal requires a separate future UI with an explicit user choice.

The portable ZIP can be extracted anywhere the user can write. Run `BoxSpec.exe`; no system Node installation is used by the desktop application.

## Update and rollback status

Stable/beta update channels, a signed manifest, executable trust verification, background download, automatic activation, and tested rollback are release blockers. They are not implemented by this package. The installer uses versioned directories and keeps other installed versions, which provides storage needed for a future rollback flow, but there is no updater or automatic rollback state machine yet.

Before any future schema migration, copy the database and contract export to a Core-owned backup, fsync it, validate the backup hash, and record it in a migration journal. A failed migration must leave the previous application and data readable. Packaging must not invent this guarantee independently of Core.

## Offline behavior and verifier availability

The editor renderer and Electron runtime are local package resources. Browser binaries are not bundled in the current artifact. Editing and saving must remain available when the verifier browser is absent; verification must report unavailable and cannot become PASS. A verified first-run browser download, retry UX, exact browser version, and its license notice remain release work. Never silently download a browser during app startup.

## Recovery and diagnostics

- If the app does not launch, compare `BoxSpec.exe` and `resources/app.asar` against `SHA256SUMS`, then inspect the Authenticode status with `Get-AuthenticodeSignature`. An unsigned development build is expected to report `NotSigned`.
- If the MCP bridge does not start, distinguish a generated client configuration from a successful protocol call. Confirm the absolute launcher path, packaged bridge entry, stderr diagnostics, grant, and protocol version. Do not put diagnostics on MCP stdout.
- If verification is unavailable, check the packaged component manifest and browser status. Missing browser or verifier code is an unavailable check, not a passing check.
- If apply recovery reports `UNKNOWN`, do not overwrite the project. Follow the transaction journal and require a trusted UI decision.
- If an install is interrupted, rerun the same verified installer. The installer stages extraction under `.install-<id>` and publishes the version directory only after payload validation.

## Release gate

Do not publish until the exact release candidate passes signed installer launch, clean-VM install/uninstall/reinstall, offline first run, bridge protocol invocation, packaged verifier/browser invocation, stable/beta update success, corrupt/tampered update rejection, migration backup restore, and failed-update rollback. Record actual commands, exit codes, hashes, and VM identity in `docs/evidence/packaging.md`.
