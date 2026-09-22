# Windows packaging evidence

This file records executed evidence only. Packaging design or source presence is not a passing result.

## Selected stack

- Target: Windows x64, per-user install.
- Electron: pinned in `apps/desktop/package.json` and recorded by the generated artifact manifest.
- Packager: `@electron/packager`, pinned in `apps/desktop/package.json`.
- Installer container: Windows IExpress, containing the portable ZIP and `install.ps1`.
- Runtime: packaged Electron; no arbitrary system Node dependency.
- Application payload: ASAR. Electron Packager embeds the Windows ASAR header digest when ASAR packaging is enabled.
- Browser: not bundled.
- Signing: no signing identity was provided; release signing is blocked.
- Update client/channels: not implemented; release is blocked.

## Commands and results

Pending integrated build. Record each attempt in this table without converting failures or skipped checks to PASS.

| Time (UTC) | Command | Exit | Artifact/evidence | Result |
|---|---|---:|---|---|
| pending | `pnpm --filter @boxspec/desktop package:win` | not run | `build/windows/artifact-manifest.json` | Awaiting canonical dependency install and integrated desktop build. |
| pending | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/smoke-windows.ps1` | not run | `build/windows/smoke-result.json` | Awaiting package artifact. |

## Evidence interpretation

An unpacked launch proves only that the package starts on this build host. The SQLite probe runs `BoxSpecCore` through `BoxSpec.exe`, loads the packaged `better-sqlite3` native binding from `app.asar.unpacked`, writes through Core, closes, reopens the same database, and writes again. It proves native ABI load and a narrow persistence cycle, not every persistence transaction. Installer smoke uses `BOXSPEC_INSTALL_ROOT` to keep installation and uninstall mutations inside `build/windows/smoke`. A retained sentinel proves the test profile was not deleted.

The package is not P1-release-ready until the exact artifact is code signed and tested in a clean Windows VM. This environment has not established installer reputation, enterprise policy compatibility, stable/beta update behavior, update rollback, migration rollback, or a packaged verifier browser. Bridge inclusion and a real MCP protocol call must be recorded separately; launcher presence alone is insufficient.

## Required release evidence still open

- Authenticode signature and timestamp verification for setup and installed executables.
- Trusted download manifest/signature verification and tamper rejection.
- Clean Windows VM install, launch, uninstall, reinstall, and preserved user state.
- Offline first run with an actually disconnected network.
- Packaged bridge invocation from a real supported MCP client.
- Packaged verifier and exact browser launch; unavailable browser must remain explicit.
- Stable and beta channel separation.
- Successful update, interrupted/corrupt update, previous-version rollback, and migration backup restore.
