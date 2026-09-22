# BoxSpec P1 dependency license inventory

Checked: **2026-09-22** (Asia/Seoul)

This B00 inventory covers the actual selected direct runtime, build, SDK, browser, database, and client/toolchain components in the reconciled manifests and lockfile. It is not the final shipped third-party notice. The workspace installation now completes on the build host, but no final packaged artifact has been license-scanned. The release must regenerate a complete transitive inventory from the frozen lockfile and inspect every bundled binary.

## Actual selected dependency licenses

| Component | Exact version | SPDX/license | Intended role/distribution | Verification |
|---|---:|---|---|---|
| Node.js | `24.19.0` build runtime; Electron embeds `24.21.0` | MIT, with bundled third-party notices | Development runtime; an application-owned runtime may be distributed for the MCP bridge | Version VERIFIED locally/upstream; license VERIFIED upstream |
| pnpm | `11.19.0` | MIT | Build/package manager only; do not ship as an app runtime unless explicitly needed | Version VERIFIED locally; license VERIFIED by npm metadata/upstream |
| Electron | `44.4.3` | MIT, plus Chromium/Node/third-party notices in the distribution | Shipped desktop runtime | Version/license VERIFIED upstream; packaged notices NOT RUN |
| Chromium inside Electron | `152.0.7977.130` | BSD-style Chromium license plus many third-party licenses | Shipped inside Electron | Embedded version VERIFIED upstream; final `LICENSES.chromium.html` retention NOT RUN |
| TypeScript | `7.0.2` | Apache-2.0 | Build-only compiler | VERIFIED by npm metadata/upstream |
| React | `19.3.0` | MIT | Shipped renderer code | VERIFIED by npm metadata/upstream |
| React DOM | `19.3.0` | MIT | Shipped renderer code | VERIFIED by npm metadata/upstream |
| Vite | `8.3.0` | MIT | Build/dev server; generated application bundles may contain Vite runtime helpers | VERIFIED by npm metadata/upstream |
| `@vitejs/plugin-react` | `6.1.1` | MIT | Build-only plugin | VERIFIED by npm metadata/upstream |
| esbuild | `0.27.2` direct; `0.28.2` also resolved transitively | MIT | Desktop bundler dependency and transitive build tooling | Direct and resolved versions VERIFIED from manifests/lock; license VERIFIED by registry metadata |
| `@electron/packager` | `20.3.0` | BSD-2-Clause | Windows application packaging tool | Version VERIFIED from manifest/lock; license VERIFIED by registry metadata; final packaged output NOT SCANNED |
| concurrently / cross-env / wait-on | `9.2.1` / `10.1.0` / `9.0.3` | MIT | Development and launch orchestration only | Versions VERIFIED from manifest/lock; licenses VERIFIED by registry metadata |
| tsx | `4.20.6` | MIT | Development/test TypeScript runner | Version VERIFIED from manifest/lock; license VERIFIED by registry metadata |
| Vitest | `5.0.1` | MIT | Test runner | Version VERIFIED from manifests/lock; license VERIFIED by registry metadata |
| AJV | `8.17.1` | MIT | Shipped core JSON Schema validation | Version VERIFIED from manifest/lock; license VERIFIED by registry metadata |
| `@modelcontextprotocol/server` | `2.0.0` | MIT | Shipped MCP bridge | VERIFIED by npm metadata/upstream |
| `@modelcontextprotocol/core` | `2.0.0` | MIT | Transitive shipped dependency of the server package | VERIFIED by npm metadata/upstream |
| `@modelcontextprotocol/client` | `2.0.0` | MIT | Test/diagnostic client; ship only if runtime diagnostics use it | VERIFIED by npm metadata/upstream |
| Zod | `4.6.5` | MIT | Shipped schema validation dependency | VERIFIED by npm metadata/upstream |
| Playwright test | `1.63.0` | Apache-2.0 | Test/verification controller | VERIFIED by npm metadata/upstream |
| Playwright | `1.63.0` | Apache-2.0 | Browser automation library, directly or through the test package | VERIFIED by npm metadata/upstream |
| Playwright-managed Chromium | revision coupled to Playwright `1.63.0`; existing cache provenance not established by B00 | Chromium BSD-style plus bundled third-party licenses | Verification browser, potentially shipped or downloaded at first run | Exact paired revision and notices NOT RUN |
| better-sqlite3 | `13.0.3` | MIT | Shipped native SQLite driver | Version/license and installed package VERIFIED; bundled Windows x64 binary runtime-tested; final packaged-artifact scan NOT RUN |
| SQLite amalgamation/library | `3.53.4` observed from the installed better-sqlite3 binary | Public domain; project offers a warranty-of-title license separately | Bundled in the native driver | Version VERIFIED by direct runtime query; upstream licensing VERIFIED |
| DefinitelyTyped packages | `@types/node 24.10.1`, `@types/react 19.3.0`, `@types/react-dom 19.3.0`, `@types/better-sqlite3 9.6.0` | MIT | Compile-time declarations only | Versions VERIFIED from manifests/lock; licenses VERIFIED by registry metadata |

## Lockfile and installation reconciliation

The current direct dependency line matches the selected compatibility matrix: TypeScript `7.0.2`, Vite `8.3.0`, React plugin `6.1.1`, Vitest `5.0.1`, Electron `44.4.3`, React `19.3.0`, Playwright `1.63.0`, MCP server/client `2.0.0`, and better-sqlite3 `13.0.3`. The lockfile resolves those exact entries. It also resolves transitive packages, including a second esbuild version, that must be captured by the final generated notice rather than inferred from this direct-component table.

Foundation applied a package-specific pnpm build policy and `pnpm install --force` exited `0`. `better-sqlite3: false` intentionally suppresses the package's erroneous implicit Windows gyp hook; it does not remove the publisher's bundled binary. The installed `prebuilds/win32-x64.node` is 1,989,632 bytes with SHA-256 `E21E5EFD71FBA66578E95B62554D9028064A80DAFD7221BF8A8EF155DE8D240A`. It loaded under system Node 24.19.0 and Electron 44.4.3 / Node 24.21.0, and the system Node query reported SQLite `3.53.4`. See [SQLite native-module diagnosis](evidence/sqlite-diagnosis.md).

`@electron/rebuild` and `electron-builder` were researched candidates, but neither is selected in the current manifests or lockfile. They are therefore excluded from the actual dependency table and final notice unless a later dependency change adds them.

## Toolchain and external client licenses

These tools were inventoried because they affect reproducibility or P1 client testing. They are not dependencies to redistribute with BoxSpec by default.

| Tool | Observed version/state | License | Distribution decision/status |
|---|---|---|---|
| npm | `11.17.0` | Artistic-2.0 | Comes with the observed Node installation; build tool only |
| Corepack | `0.35.0` | MIT | Comes with Node installation; build tool only |
| Git for Windows | `2.55.0.windows.3` | GPL-2.0-only for Git, with separately licensed bundled components | External prerequisite/tool; do not copy into the application without a separate distribution review |
| Python | `3.11.9`; launcher default `3.12.10` | PSF-2.0, with bundled notices | Spec tooling only; not selected for the production runtime |
| Codex CLI | `0.155.0-alpha.9.2` | External client; license must be taken from its actual distribution if ever bundled | Detected only; do not redistribute or copy credentials |
| OpenCode | `1.18.32` | MIT upstream project | Detected external client; do not bundle by default |
| Claude Code | absent | Proprietary/external terms | No local artifact to inventory or redistribute |

## Obligations for the shipped package

1. Preserve the Electron distribution's own license files and Chromium third-party notice material. The Electron MIT line does not replace Chromium's `LICENSES.chromium.html` and other notices.
2. Include the MIT and Apache-2.0 texts and copyright notices for dependencies actually present in the production bundle. Generated notice content must come from the frozen lockfile, not this manually selected direct list.
3. If the verification Chromium is bundled, retain the browser build's license and third-party notices beside the binary. If it is downloaded on first run, show the source/version/hash and preserve its notice files in the installed cache.
4. Reconfirm the packaged native binary hash and embedded SQLite version against the installed evidence above. SQLite is public domain, while the better-sqlite3 driver remains MIT-licensed.
5. Keep build-only tools out of the production artifact where practical. Their presence in `devDependencies` does not by itself prove they are absent from the packaged output.
6. Do not bundle Git, Codex, Claude Code, OpenCode, their login data, or their credential stores. BoxSpec detects user-installed clients and reports capability/version state.
7. Re-run license review after any dependency proposal or lockfile change. A package's top-level SPDX identifier does not cover all native binaries, downloaded browsers, fonts, or embedded assets.

## Final release verification still required

- Generate the final dependency graph from the exact pnpm lockfile, including optional/platform dependencies and licenses.
- Scan unpacked and packaged application trees independently; compare them to find accidental development dependencies.
- Extract Electron and Playwright browser notices from the exact downloaded binaries.
- Record hashes and sources for Electron, the verification browser, native SQLite binary, installer/updater components, and any fonts.
- Review license texts for dynamically downloaded artifacts and offline installer contents.
- Produce `THIRD_PARTY_NOTICES` from the packaged artifact and have the release owner review unknown, custom, copyleft, or missing-license rows.

## Verification evidence

Package version, engine, license, and repository fields were queried read-only with:

```powershell
npm view <package>@<version> version engines license repository.url --json
```

All selected npm metadata queries returned exit code `0`. The Electron component versions came from its official release record. Node release/runtime data came from the official Node release index and the local executable. The earlier B00 `pnpm exec` probes triggered automatic dependency reconciliation and failed with exit code `1`; those failed probe results are not used as runtime evidence. Foundation subsequently repaired the installation with targeted build permissions and `pnpm install --force` exited `0`.

Registry REST lookups using `Invoke-RestMethod https://registry.npmjs.org/<package>/<version>` returned exit code `0` for `@electron/packager`, the four selected DefinitelyTyped packages, Vitest, AJV, esbuild, tsx, concurrently, cross-env, and wait-on. Their versions and SPDX identifiers in the table above match that metadata.

The installed better-sqlite3 metadata, prebuild size, and SHA-256 were inspected read-only. A direct in-memory query under system Node exited `0`, reported SQLite `3.53.4`, and returned `42`. Foundation's Electron smoke against the same installed addon also exited `0` and returned `42`. These results establish the installed native artifact and its database license identity; the final packaged application tree and third-party notice set remain unscanned.

## Official license sources

- Node.js license: <https://github.com/nodejs/node/blob/v24.19.0/LICENSE>
- pnpm license: <https://github.com/pnpm/pnpm/blob/v11.19.0/LICENSE>
- Electron license: <https://github.com/electron/electron/blob/v44.4.3/LICENSE>
- Chromium license: <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>
- TypeScript license: <https://github.com/microsoft/TypeScript/blob/v7.0.2/LICENSE.txt>
- React license: <https://github.com/facebook/react/blob/v19.3.0/LICENSE>
- Vite license: <https://github.com/vitejs/vite/blob/v8.3.0/LICENSE>
- Vite React plugin license: <https://github.com/vitejs/vite-plugin-react/blob/plugin-react%406.1.1/LICENSE>
- esbuild license: <https://github.com/evanw/esbuild/blob/v0.27.2/LICENSE.md>
- Electron Packager license: <https://github.com/electron/packager/blob/v20.3.0/LICENSE>
- concurrently license: <https://github.com/open-cli-tools/concurrently/blob/v9.2.1/LICENSE>
- cross-env license: <https://github.com/kentcdodds/cross-env/blob/v10.1.0/LICENSE>
- wait-on license: <https://github.com/jeffbski/wait-on/blob/v9.0.3/LICENSE>
- tsx license: <https://github.com/privatenumber/tsx/blob/v4.20.6/LICENSE>
- Vitest license: <https://github.com/vitest-dev/vitest/blob/v5.0.1/LICENSE>
- AJV license: <https://github.com/ajv-validator/ajv/blob/v8.17.1/LICENSE>
- MCP TypeScript SDK license: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE>
- Zod license: <https://github.com/colinhacks/zod/blob/v4.6.5/LICENSE>
- Playwright license: <https://github.com/microsoft/playwright/blob/v1.63.0/LICENSE>
- better-sqlite3 license: <https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/LICENSE>
- SQLite copyright/public-domain statement: <https://sqlite.org/copyright.html>
- DefinitelyTyped license: <https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE>
- npm license: <https://github.com/npm/cli/blob/v11.17.0/LICENSE>
- Corepack license: <https://github.com/nodejs/corepack/blob/v0.35.0/LICENSE.md>
- Git license: <https://github.com/git/git/blob/v2.55.0/COPYING>
- Python license: <https://docs.python.org/3/license.html>
- OpenCode license: <https://github.com/anomalyco/opencode/blob/dev/LICENSE>
- npm registry metadata endpoint used for package checks: <https://registry.npmjs.org/>
