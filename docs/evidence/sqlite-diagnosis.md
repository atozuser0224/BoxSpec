# SQLite native-module diagnosis

Checked: **2026-09-22** on Windows 11 Pro `10.0.26200`, x64.

## Decision

Keep `better-sqlite3@13.0.3` and the bundled `prebuilds/win32-x64.node`. The failed install did **not** indicate a missing or incompatible prebuilt binary. It was an unnecessary implicit `node-gyp rebuild` triggered by the package layout on Windows. The selected fix is the narrow pnpm policy already applied by the foundation owner:

```yaml
allowBuilds:
  better-sqlite3: false
```

This is an explicit denial for this package's dependency build script, as defined by pnpm's [`allowBuilds` setting](https://pnpm.io/settings/build#allowbuilds). It does not disable other reviewed dependency builds. The installed addon has since loaded and executed the same in-memory query under both the system Node runtime and Electron 44.4.3.

## Exact failure cause

The published `better-sqlite3@13.0.3` package has all four conditions below:

1. `binding.gyp` is present at the package root.
2. `package.json` has no `install` or `preinstall` script.
3. `package.json` declares `"gypfile": false`.
4. The npm tarball already contains `prebuilds/win32-x64.node`.

npm documents that a root `binding.gyp` plus no package-defined `install` or `preinstall` causes it to synthesize `node-gyp rebuild` as the install command. See [npm lifecycle scripts, lines describing the implicit `node-gyp rebuild`](https://docs.npmjs.com/cli/v11/using-npm/scripts/#npm-install). `gypfile: false` did not suppress that synthesized command in this Windows case. Upstream issue [WiseLibs/better-sqlite3#1516](https://github.com/WiseLibs/better-sqlite3/issues/1516) records the same `better-sqlite3 13.0.3`, Node `24.19.0`, npm `11.17.0`, Windows 11 x64 combination and the same unwanted command despite a bundled `prebuilds/win32-x64.node`.

The package's own `binding.gyp` attempts to make the generated build a no-op when a host prebuild exists. The install still enters node-gyp configuration first. On this host Python is available, but no Visual Studio C++ build environment is installed, so node-gyp's configuration fails at Visual Studio discovery. The official [node-gyp Windows prerequisites](https://github.com/nodejs/node-gyp#on-windows) require Python and the Visual Studio `Desktop development with C++` workload.

This evidence rules out the suspected alternatives for the observed failure:

- **Platform/architecture mismatch:** the host is `win32`/`x64`, and the installed package contains the exact `prebuilds/win32-x64.node` selected by its `lib/binding.js`.
- **Node/Electron ABI mismatch:** v13 uses Node-API, the binding is compiled with `NAPI_VERSION=10`, and both Node 24 runtimes expose Node-API 10. Node documents Node-API 10 support from Node `22.14.0+` and ABI stability for compatible Node-API addons in the [Node-API version matrix](https://nodejs.org/api/n-api.html#node-api-version-matrix). The dual runtime smoke tests are the decisive evidence for this exact binary.
- **Download, SSL, or missing GitHub release asset:** the prebuild is inside the integrity-checked npm package. The [v13.0.3 GitHub release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3) has source archives rather than separate binary assets, so a second runtime download is neither expected nor required.

## Observed package and runtime evidence

| Evidence | Result | Status |
|---|---|---|
| Installed package metadata | `better-sqlite3 13.0.3`, engine `node >=22`, MIT, `gypfile: false`, no install/preinstall script | VERIFIED locally, read-only |
| Bundled Windows binary | `prebuilds/win32-x64.node`, 1,989,632 bytes, SHA-256 `E21E5EFD71FBA66578E95B62554D9028064A80DAFD7221BF8A8EF155DE8D240A` | VERIFIED locally, read-only |
| Binding selection | `lib/binding.js` selects `${platform}-${arch}.node` before `build/Debug` or `build/Release` | VERIFIED from installed package source |
| Addon API | `binding.gyp` defines `NAPI_VERSION=10`; `src/better_sqlite3.cpp` registers a Node-API module | VERIFIED from installed package source |
| System Node smoke | Node `24.19.0`, module ABI `137`, Node-API `10`; addon reports SQLite `3.53.4`; `select 42` returns `42` | PASS, exit `0`, independently rerun by B00 |
| Electron smoke | Electron `44.4.3`, embedded Node `24.21.0`, Node-API `10`; same installed addon loads and `select 42` returns `42` | PASS, exit `0`, foundation-owned run |
| Build tools | `cl.exe`, `msbuild.exe`, `cmake.exe`, and `ninja.exe` absent from PATH; both standard Visual Studio directories absent | VERIFIED locally, probe exit `0` |
| Python | `python 3.11.9`; `py 3.12.10` | VERIFIED locally, both exit `0` |

The Electron runtime tuple is also published on the official [Electron 44.4.3 release page](https://releases.electronjs.org/release/v44.4.3): Node `24.21.0`, Chromium `152.0.7977.130`, and V8 `15.2.124.28`.

## Command and exit evidence

No install command was run by this diagnosis task.

| Command or owning task | Exit | Material result |
|---|---:|---|
| Foundation: `pnpm install` with `better-sqlite3` build allowed | `1` | implicit `node-gyp rebuild`; `gyp ERR! find VS could not use PowerShell to find Visual Studio 2017 or newer` and requested `Desktop development with C++` |
| Foundation: `pnpm install --force` after `allowBuilds.better-sqlite3: false` | `0` | deterministic install completed while retaining the bundled prebuild |
| B00: direct `node -e` using `createRequire()` from `packages/core/package.json`, opening `:memory:` and running `select sqlite_version()` plus `select 42` | `0` | `{"node":"v24.19.0","modules":"137","napi":"10","platform":"win32","arch":"x64","sqlite":"3.53.4","value":42}` |
| Foundation: `$env:ELECTRON_RUN_AS_NODE='1'; & .\apps\desktop\node_modules\.bin\electron.cmd -e "const D=require('./packages/core/node_modules/better-sqlite3'); const db=new D(':memory:'); console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,napi:process.versions.napi,value:db.prepare('select 42 as n').get()})); db.close();"; $electronExit=$LASTEXITCODE; Remove-Item Env:ELECTRON_RUN_AS_NODE; exit $electronExit` | `0` | `{"electron":"44.4.3","node":"24.21.0","napi":"10","value":{"n":42}}` |
| `Get-Command cl.exe, msbuild.exe, cmake.exe, ninja.exe` plus standard Visual Studio directory checks | `0` | all four commands and both Visual Studio directories absent |
| `python --version`; `py --version` | `0`; `0` | Python `3.11.9`; launcher-selected Python `3.12.10` |
| Installed binary `Get-Item` and `Get-FileHash -Algorithm SHA256` | `0` | size and SHA-256 recorded above |

## Repair options

### Selected: use the bundled Node-API prebuild

Retain `better-sqlite3@13.0.3`, deny its erroneous implicit build through the package-specific `allowBuilds` entry, and require runtime smokes in both Node and Electron. This is the least disruptive path because it uses the publisher's npm artifact, needs no extra compiler, and has now passed both target runtimes on Windows x64.

The guardrail is runtime evidence: every dependency or runtime upgrade must repeat the Node and Electron load/query tests. Packaging must also prove that `prebuilds/win32-x64.node` is unpacked where Electron can load it; the packaging evidence owns that gate.

### Contingency: install an official C++ toolchain and build per target

Use this only if a target platform lacks a bundled prebuild, an integrity check fails, or policy requires source compilation. Install Visual Studio Build Tools with the `Desktop development with C++` workload and an appropriate Windows SDK, then explicitly build against the intended runtime headers. node-gyp documents that third-party runtimes such as Electron require their target headers via `--dist-url` or `--nodedir`. A Node-built native artifact must not be assumed to be an Electron artifact without an actual Electron load test.

This contingency is currently more disruptive and unnecessary for the tested Windows x64 build. Windows arm64 and other operating systems remain separate artifact/test rows even though the npm package also contains additional prebuilds.

## Remaining limits

- The successful in-memory query proves native loading and SQLite execution, not migrations, transactions, crash recovery, concurrent access, or application shutdown behavior.
- The packaged application must retain the native binary outside `app.asar` where required and rerun create/close/reopen persistence through the packaged executable.
- Windows arm64, macOS, and Linux have not been runtime-tested by this build.
- `node:sqlite` is not the selected replacement. Node 24 documentation labels it Stability `1.2` (release candidate), so it must not be described as a stable P1 substitute.
