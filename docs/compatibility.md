# BoxSpec P1 compatibility matrix

Checked: **2026-09-22** (Asia/Seoul)

This record covers B00 runtime, SDK, client, browser, and OS choices for the Windows P1 build. It separates locally observed evidence from registry/documentation research and from tests that still require the application. No client login, token, credential file, or account state was inspected.

## Status meanings

- **VERIFIED (local):** command ran on this host and returned exit code 0.
- **VERIFIED (upstream):** version or behavior was confirmed in official upstream documentation or package metadata, but the dependency was not installed here as part of B00.
- **NOT RUN:** the executable or files may exist, but BoxSpec did not perform the named integration or browser test.
- **UNVERIFIED:** the required executable is absent or the product path does not exist yet.
- **BLOCKED:** an attempted verification failed before the product behavior could run.

## Selected stable line

These are the exact versions recommended to the root manifest owner. The lockfile remains owned by the foundation task.

| Component | Selected version | Required relationship | Evidence/status |
|---|---:|---|---|
| Windows build host | Windows 11 Pro `10.0.26200`, x64 | P1 target is Windows x64. Windows arm64 must be a later separately built/tested artifact because Electron 44 removed Windows ia32 and native modules are architecture-specific. | VERIFIED (local) |
| Node.js build/dev runtime | `24.19.0` | LTS line; satisfies Electron installer (`>=22.12.0`), Vite (`^20.19.0 || >=22.12.0`), MCP v2 (`>=20`), Playwright (`>=20`), and better-sqlite3 (`>=22`). Pin the observed version for this build; the official latest Node 24 LTS is `24.21.0`. | VERIFIED (local); official LTS status verified upstream |
| pnpm | `11.19.0` | Exact `packageManager` pin. pnpm's official matrix supports Node 24. Do not silently upgrade the lockfile to pnpm 12 during this build. | VERIFIED (local) |
| Electron | `44.4.3` | Latest stable npm tag when checked. Its install-time Node engine is `>=22.12.0`; its embedded runtime is Node `24.21.0`, Chromium `152.0.7977.130`, V8 `15.2.124.28`. | VERIFIED upstream; installed Electron runtime and native-addon smoke VERIFIED locally; desktop app launch NOT RUN |
| TypeScript | `7.0.2` | Latest stable npm tag; Node `>=16.20.0`. MCP SDK v2 docs require explicit `"types": ["node"]` with TypeScript 6+. | VERIFIED (upstream); compile NOT RUN |
| React / React DOM | `19.3.0` / `19.3.0` | Keep the renderer packages on the same version. | VERIFIED (upstream); render NOT RUN |
| Vite / React plugin | `8.3.0` / `6.1.1` | Both require `^20.19.0 || >=22.12.0`; Node 24.19.0 satisfies the range. | VERIFIED (upstream); build NOT RUN |
| MCP TypeScript server SDK | `@modelcontextprotocol/server@2.0.0` | Stable v2 split package. Use ESM imports only and `serveStdio` for dual-era stdio. Never mix with `@modelcontextprotocol/sdk` v1. | VERIFIED (upstream); BoxSpec bridge NOT RUN |
| MCP test client SDK | `@modelcontextprotocol/client@2.0.0` | Match the server generation exactly. Use only in integration/conformance tests and diagnostic code that needs a client. | VERIFIED (upstream); BoxSpec tests NOT RUN |
| Zod | `4.6.5` | Import as `zod/v4`, matching official MCP v2 examples. The server package currently depends on `zod ^4.2.0`. | VERIFIED (upstream); compile NOT RUN |
| Playwright test | `@playwright/test@1.63.0` | Node `>=20`. Install the Playwright-managed Chromium belonging to this exact package version and freeze the resulting browser revision in evidence. | VERIFIED (upstream); BoxSpec browser install/run NOT RUN |
| SQLite driver | `better-sqlite3@13.0.3` | Stable package, Node `>=22`. v13 uses Node-API and bundles `prebuilds/win32-x64.node` at Node-API 10. The exact bundled binary loaded under both system Node 24.19.0 and Electron 44.4.3 / Node 24.21.0, so no Electron rebuild is required for this tested Windows x64 tuple. | VERIFIED locally; both runtime smokes PASS |

`node:sqlite` is deliberately not the selected P1 persistence API. Node 24.21 documentation still labels the module **Stability 1.2 — Release candidate**. It may be reconsidered after its stability level and Electron behavior are release-qualified. Until then, the stable better-sqlite3 API plus an explicit Electron native-module smoke is the lower-ambiguity choice.

## Post-lock reconciliation

The current manifests and lock now align with the selected line:

| Area | Current manifest/lock evidence | Reconciliation status |
|---|---|---|
| Package manager/runtime | `packageManager: pnpm@11.19.0`; root engine `node >=24.0.0`; build host Node `24.19.0` | pnpm and observed build runtime recorded exactly |
| Electron / React | Electron `44.4.3`; React and React DOM `19.3.0` | Matches |
| TypeScript / test runner | TypeScript `7.0.2` throughout; Vitest `5.0.1` in packages that use it | Matches; earlier version splits removed |
| Vite / React plugin | desktop uses Vite `8.3.0` and plugin React `6.1.1` | Matches |
| MCP | server `2.0.0`, client `2.0.0`; no monolithic v1 SDK in the bridge manifest | Matches one SDK generation |
| Playwright | root `@playwright/test@1.63.0`; verifier, CLI, and e2e use `playwright@1.63.0` | Matches; browser execution remains a separate gate |
| SQLite | core uses `better-sqlite3@13.0.3`; installed npm artifact contains the Windows x64 Node-API 10 prebuild | Matches; Node and Electron load/query smokes PASS |

The earlier automatic reconciliation failure is retained below as chronology, not current status. Foundation explicitly governed dependency builds, including `electron: true`, `esbuild: true`, and `better-sqlite3: false`. The latter suppresses a known erroneous implicit gyp hook while retaining the package's bundled native binary. `pnpm install --force` then exited `0`. See [SQLite native-module diagnosis](evidence/sqlite-diagnosis.md) for the exact cause, binary hash, toolchain probe, and dual-runtime evidence.

## Actual host inventory

| Item | Observed result | Status |
|---|---|---|
| PowerShell | `7.6.5` | VERIFIED (local) |
| OS | Windows 11 Pro, version `10.0.26200`, build `26200`, x64 | VERIFIED (local) |
| Node | `v24.19.0`, win32 x64, module ABI `137`, N-API `10` | VERIFIED (local) |
| npm | `11.17.0` | VERIFIED (local) |
| pnpm | `11.19.0` | VERIFIED (local) |
| Corepack | `0.35.0` | VERIFIED (local) |
| Python | `python`: `3.11.9`; `py`: `3.12.10` | VERIFIED (local); auxiliary spec tooling only |
| Git | `2.55.0.windows.3` | VERIFIED (local) |
| Codex CLI | `0.155.0-alpha.9.2`; `codex mcp --help` exposes list/get/add/remove/login/logout | VERIFIED (local executable/help only) |
| OpenCode CLI | `1.18.32`; `opencode mcp --help` exposes add/list/auth/logout/debug | VERIFIED (local executable/help only) |
| Claude Code CLI | not found on PATH | UNVERIFIED |
| Gemini CLI | not found on PATH; outside required P1 client set | UNVERIFIED |
| Git repository | current directory is not a Git worktree (`git rev-parse` failed) | VERIFIED (local limitation) |
| Playwright cache | `%LOCALAPPDATA%\\ms-playwright` exists with `chromium-1234`, `chromium_headless_shell-1234`, `ffmpeg-1011`, and `winldd-1007` | Presence only; provenance and match to 1.63.0 NOT RUN |
| Chrome / Edge probed paths | no executable at the probed Program Files paths | Presence check only; branded browsers are not the P1 verification baseline |
| Workspace dependency install | targeted dependency build policy applied; foundation `pnpm install --force` completed | VERIFIED by foundation, exit `0` |

The installed Codex version contains an `alpha` suffix. Its executable/help evidence does not qualify it as the supported release client for P1. Client promotion requires an actual BoxSpec stdio handshake and tool call on a version explicitly recorded in the test evidence.

## MCP SDK and protocol decision

The selected generation is the stable **TypeScript SDK v2** split packages. The upstream v2 README says it implements MCP specification `2026-07-28` and replaces the monolithic `@modelcontextprotocol/sdk` v1 package. The current registry still publishes `@modelcontextprotocol/sdk@1.30.0`; that does not make it compatible to mix v1 imports with v2 code.

Required server surface:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function createServer(): McpServer {
  const server = new McpServer({ name: 'boxspec', version: '0.1.0' });
  server.registerTool('tool-name', {
    description: '...',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  }, async () => {
    const output = { ok: true };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  });
  return server;
}

void serveStdio(createServer);
```

For stdio, `serveStdio(() => buildServer())` is mandatory for BoxSpec. In v2, a hand-constructed `McpServer` connected directly to `StdioServerTransport` keeps the 2025 legacy handshake. `serveStdio` owns connection negotiation and serves older clients by default while permitting the modern `2026-07-28` era. The modern era uses `server/discover` and per-request metadata; the legacy era covers protocol revisions through `2025-11-25` and begins with `initialize`. BoxSpec code must use the SDK abstractions instead of manually encoding era-specific wire shapes.

Stdio rules are release gates: one newline-delimited JSON-RPC message per line, protocol output only on stdout, logs only on stderr, prompt exit on stdin EOF, and cancellation support. An ordinary `console.log` can corrupt the connection.

## Client/protocol matrix

Official client documentation confirms the configuration shape, but none of these rows has a real BoxSpec connection yet. The server therefore accepts both SDK v2 eras until each supported client is tested.

| Client | Local version/state | Official local stdio shape | Actual BoxSpec handshake/tool call | Status |
|---|---|---|---|---|
| Codex CLI | `0.155.0-alpha.9.2`, executable present; authentication not inspected | `[mcp_servers.boxspec]`, `command`, `args`, optional `cwd`, timeouts in `config.toml` | Not run; exact negotiated protocol unknown | NOT RUN; installed version is prerelease |
| Claude Code | executable absent | `.mcp.json`/CLI stdio entry; CLI command requires `--` before server command and arguments | Cannot run on this host | UNVERIFIED |
| OpenCode | `1.18.32`, executable present; authentication not inspected | `mcp.<name>.type = "local"` with command array, optional `cwd`, environment, enabled, timeout | Not run; exact negotiated protocol unknown | NOT RUN |
| MCP SDK v2 in-memory client | `@modelcontextprotocol/client@2.0.0` present in the installed workspace | `Client` and `InMemoryTransport` from `@modelcontextprotocol/client` | Foundation/bridge tests pending | Package present; conformance test NOT RUN by B00 |

Do not claim a client connected merely because configuration was generated or `--help` ran. A P1-compatible client row requires recorded `tools/list`, at least one real scoped context read, malformed-input rejection, cancellation/timeout behavior, and the negotiated protocol version/era.

## Browser/runtime/OS matrix

| Execution surface | Runtime/browser | OS/profile | Status and release requirement |
|---|---|---|---|
| Trusted desktop editor | Electron `44.4.3`; embedded Node `24.21.0`; Chromium `152.0.7977.130` | Windows 11 x64 observed | Upstream tuple VERIFIED; installed runtime and SQLite load/query smoke PASS; renderer sandbox, IME, DPI, packaging, and desktop launch NOT RUN |
| Untrusted candidate verification | Playwright `1.63.0` with its managed Chromium | Windows 11 x64; deterministic locale/timezone/fonts/viewport/DPR required | Package VERIFIED upstream; exact downloaded browser revision and a real render NOT RUN |
| Local MCP bridge (development) | system Node `24.19.0`, SDK server `2.0.0` | Windows 11 x64 stdio | Runtime present; BoxSpec bridge NOT RUN |
| Packaged MCP bridge | application-owned runtime, never an arbitrary user Node path | Signed Windows x64 package | Design requirement only; packaging NOT RUN |
| SQLite in desktop/core | better-sqlite3 `13.0.3`, bundled win32-x64 Node-API 10 binary | Windows 11 x64 | System Node 24.19 and Electron 44.4.3 / Node 24.21 load/query PASS; migration, transaction, reopen, packaging, and crash recovery remain separate gates |
| Windows arm64 | Electron 44 publishes arm64, but native modules need separate artifacts | Windows 10/11 arm64 | Out of the verified matrix; UNVERIFIED |

Playwright couples each library version to specific browser binaries. An unrelated existing browser cache is not evidence. Run the exact pinned Playwright CLI install, record the browser revision, then run real geometry and interaction tests. Electron's renderer Chromium and Playwright's managed Chromium are separate evidence surfaces even when their engine versions happen to be close.

## Commands and exit evidence

The B00 commands below were run from the package directory. B00 issued no intentional install command; the failed automatic reconciliation is retained as chronology. Foundation later repaired the installation and supplied the successful install and Electron smoke evidence recorded after it.

| Command | Exit | Material result |
|---|---:|---|
| `$PSVersionTable.PSVersion.ToString()` plus `Get-CimInstance Win32_OperatingSystem` | `0` | PowerShell and Windows version/build above |
| `node --version` | `0` | `v24.19.0` |
| `node -e "console.log(JSON.stringify({versions:process.versions,arch:process.arch,platform:process.platform},null,2))"` | `0` | win32/x64, ABI 137, N-API 10 |
| `npm --version` | `0` | `11.17.0` |
| `pnpm --version` | `0` | `11.19.0` |
| `corepack --version` | `0` | `0.35.0` |
| `python --version`; `py --version` | `0`; `0` | `3.11.9`; `3.12.10` |
| `git --version` | `0` | `2.55.0.windows.3` |
| `codex --version`; `codex mcp --help` | `0`; `0` | version/help above |
| `opencode --version`; `opencode mcp --help` | `0`; `0` | version/help above |
| `Get-Command claude` / `where.exe claude` | not found / `1` | Claude absent |
| `Get-Command gemini` | not found | Gemini absent |
| `git rev-parse --show-toplevel` | `1` (Git reported not a repository) | no repository metadata in this directory |
| `npm view <package> version engines license repository.url dist-tags --json` for all selected npm packages | `0` for each queried package | exact registry versions, engines, licenses, repositories |
| `Invoke-RestMethod https://releases.electronjs.org/releases.json` filtered to `44.4.3` | `0` | embedded Node/Chromium/V8 tuple |
| `Invoke-RestMethod https://nodejs.org/dist/index.json` filtered to `v24.19.0` | `0` | LTS codename, ABI and bundled npm/V8 data |
| `pnpm list -r --depth -1` | `0` before the later failure | listed nine workspace projects; this does not validate installed binaries |
| `pnpm --filter @boxspec/desktop exec electron --version` | `1` | wrapper attempted install; blocked by ignored esbuild build script and `.bin` link failures; Electron did not run |
| `pnpm --filter @boxspec/desktop exec vite --version` | `1` | same automatic reconciliation failure; Vite did not run |
| `pnpm --filter @boxspec/bridge exec tsc --version` | `1` | same automatic reconciliation failure; TypeScript did not run |
| `pnpm --filter @boxspec/verifier exec playwright --version` | `1` | same automatic reconciliation failure; Playwright did not run |
| `pnpm --filter @boxspec/bridge exec node --input-type=module -e <SDK import probe>` | `1` | same automatic reconciliation failure; MCP exports were not runtime-verified |
| Foundation: `pnpm install` with better-sqlite3 build allowed | `1` | package's implicit `node-gyp rebuild` reached node-gyp Visual Studio detection; no Visual C++ workload was available |
| Foundation: `pnpm install --force` after targeted `allowBuilds` policy | `0` | workspace installation recovered; bundled better-sqlite3 prebuild retained |
| Direct Node `createRequire()` from core, open `:memory:`, query SQLite version and `select 42` | `0` | Node `24.19.0`, ABI `137`, Node-API `10`; SQLite `3.53.4`; value `42` |
| Electron with `ELECTRON_RUN_AS_NODE=1`, require core better-sqlite3, open `:memory:`, `select 42` | `0` | Electron `44.4.3`, Node `24.21.0`, Node-API `10`; value `42` |

## Remaining release gates

1. Prove a frozen-lockfile install from a clean checkout/cache policy in release CI. The current repaired installation proves this host state, not clean-machine reproducibility.
2. Exercise SQLite create/migrate/transaction/close/reopen and crash recovery through core, then prove the native binary is correctly unpacked and loaded by the packaged executable.
3. Install the Chromium binary paired with Playwright 1.63.0 and record its revision, executable hash, and license notices.
4. Run the real BoxSpec stdio bridge with SDK v2 in-memory tests, then Codex, Claude Code, and OpenCode separately. Record the client version, negotiated era/version, tool capabilities, and failures.
5. Test Windows x64 installer, signing, update/rollback, Korean IME, keyboard access, and 100/125/150/200% display scaling. No such result exists yet.
6. Re-run a transitive dependency and binary license inventory from the frozen release lockfile and packaged artifact. The B00 license document reconciles selected direct components and the current lock, while the final artifact scan remains pending.

## Official sources

- Node release policy and current LTS: <https://nodejs.org/en/about/previous-releases>
- Node release index used for exact local-runtime metadata: <https://nodejs.org/dist/index.json>
- Node 24 `node:sqlite` stability: <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>
- pnpm install and Node compatibility matrix: <https://pnpm.io/installation>
- Electron 44.4.3 component tuple: <https://releases.electronjs.org/release/v44.4.3>
- Electron release support policy: <https://www.electronjs.org/docs/latest/tutorial/electron-timelines>
- Electron install/binary integrity behavior: <https://www.electronjs.org/docs/latest/tutorial/installation>
- Vite Node requirements: <https://vite.dev/guide/>
- Playwright browser coupling/install: <https://playwright.dev/docs/browsers>
- Playwright visual comparison environment caveats: <https://playwright.dev/docs/test-snapshots>
- MCP TypeScript SDK v2 root: <https://github.com/modelcontextprotocol/typescript-sdk>
- MCP v2 server package and TypeScript note: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md>
- MCP v2 first server/imports: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md>
- MCP v2 tools and structured output: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md>
- MCP v2 stdio entry point: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md>
- MCP SDK protocol-era behavior: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md>
- MCP `2026-07-28` stdio binding: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>
- Codex MCP configuration: <https://developers.openai.com/codex/mcp/>
- Claude Code MCP configuration: <https://code.claude.com/docs/en/mcp>
- OpenCode MCP configuration: <https://opencode.ai/docs/mcp-servers/>
- better-sqlite3 project: <https://github.com/WiseLibs/better-sqlite3>
- better-sqlite3 v13.0.3 Windows implicit-gyp issue: <https://github.com/WiseLibs/better-sqlite3/issues/1516>
- npm implicit `node-gyp rebuild` lifecycle rule: <https://docs.npmjs.com/cli/v11/using-npm/scripts/#npm-install>
- pnpm dependency build policy: <https://pnpm.io/settings/build#allowbuilds>
- Node-API ABI/version matrix: <https://nodejs.org/api/n-api.html#node-api-version-matrix>
- node-gyp Windows prerequisites and Electron header targeting: <https://github.com/nodejs/node-gyp#on-windows>
- npm registry metadata used for exact version/engine/license checks: <https://registry.npmjs.org/>
