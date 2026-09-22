# BoxSpec doctor diagnostics evidence

Checked: **2026-09-22** on Windows 11 x64 with Node `24.19.0`, pnpm `11.19.0`, TypeScript `7.0.2`, MCP client SDK `2.0.0`, and Playwright `1.63.0`.

This evidence covers the P1 diagnostic CLI. It does not claim that the desktop runtime, pairing profile, external-client integration, or packaged bridge is healthy when those probes did not run. The captured machine report is [`apps/cli/doctor-output.json`](../../apps/cli/doctor-output.json).

## Commands and exit codes

| Command | Exit | Result |
|---|---:|---|
| `node node_modules/typescript/bin/tsc -p apps/cli/tsconfig.json --noEmit` | `0` | Strict TS 7 typecheck passed. |
| `node node_modules/typescript/bin/tsc -p apps/cli/tsconfig.json` | `0` | Built the executable, declarations, source maps, and tests in `apps/cli/dist`. |
| `node --test apps/cli/dist/*.test.js` | `0` | 6/6 tests passed: non-PASS aggregation, exit-code mapping, missing executable, nested secret keys, string/path/token redaction, and cyclic values. |
| `node apps/cli/dist/bin.js doctor --json --timeout-ms 8000` | `2` | Produced the final captured redacted JSON. The result was `DEGRADED`, not `PASS`: the real bridge handshake/list succeeded, while the capability call returned `PAIRING_REQUIRED`; config/adapter evidence was unknown and Claude Code was unavailable. |
| `pnpm --filter @boxspec/cli run doctor --json --timeout-ms 3000` | `2` | Package script reached the same CLI and preserved the degraded exit. |
| `pnpm run doctor --json --timeout-ms 3000` | `2` | Root script reached the BoxSpec CLI; it did not invoke pnpm's unrelated built-in doctor. |
| `pnpm --filter @boxspec/cli run doctor --help` | `0` | Printed the documented options and exit-code meanings. |
| `node apps/cli/dist/bin.js doctor --definitely-invalid` | `64` | Rejected invalid usage without running diagnostics. |

The first host run occurred while dependencies were being normalized and truthfully returned `FAIL` because the Chromium launch and OpenCode `.cmd` version probe failed. After the canonical frozen install and a Windows `.cmd` invocation correction, both real probes passed. No failing result was rewritten or promoted to `PASS`.

## Actual host observations

The final captured report records these actual checks:

- Installation and selected Node 24 line: `PASS`.
- Playwright-managed Chromium: `PASS`; package `1.63.0`, executable present, real headless launch succeeded, browser version `153.0.8010.12`.
- Git: `PASS`; `2.55.0.windows.3`, current directory is a worktree.
- Codex executable: `PASS`; `0.155.0-alpha.9.2` detected. This remains a prerelease client and executable presence is not an MCP compatibility result.
- OpenCode executable: `PASS`; `1.18.32` detected through its Windows `.cmd` launcher.
- Claude Code executable: `UNAVAILABLE`.
- Runtime module and `createBoxSpecRuntime` factory: `PASS`.
- Bridge launcher: process start, official SDK negotiation, MCP initialization, and `tools/list` all succeeded; modern protocol `2026-07-28`, BoxSpec server `0.1.0`, and all 15 tools were observed.
- Capability call: rejected with stable `PAIRING_REQUIRED`, so the bridge aggregate remains `UNAVAILABLE`, Core remains `UNKNOWN`, grant status is `UNAVAILABLE/required`, and the React adapter remains `UNKNOWN`.
- Codex, Claude Code, and OpenCode configuration-write state: `UNKNOWN`; actual calls from those clients: `not-run`.

These states aggregate to `DEGRADED` with process exit `2`. An unavailable, unknown, or unexecuted required observation cannot aggregate to `PASS`.

## Probe behavior and JSON fields

`boxspec doctor` runs bounded direct probes; it does not expose a generic command runner.

| Report field | Evidence source |
|---|---|
| `installation` | Running CLI entry, Node version, platform, architecture, and redacted install path. |
| `runtime` | Dynamic load of `@boxspec/runtime` plus the required `createBoxSpecRuntime` export. It does not open or mutate a project. |
| `bridge` | Official MCP client SDK over a spawned stdio launcher. It negotiates the protocol era, performs initialization, calls `tools/list`, requires `boxspec_get_capabilities`, and calls that tool. Process start, handshake, listing, and tool-call success are separate booleans. |
| `core` | Derived only from the actual capability response or its stable `APP_NOT_RUNNING` result. |
| `grants` | `active` only after the capability call is accepted; `PAIRING_REQUIRED` and `PROJECT_NOT_GRANTED` remain unavailable states. No grant identifier or session token is printed. |
| `browser` | Dynamic Playwright load, exact package metadata, executable file check, real Chromium launch, and returned browser version. |
| `git` | Direct `git --version` and `git rev-parse --is-inside-work-tree`, with no shell interpolation. |
| `adapter` | The `web-react` row returned by the real capability call. Absence remains `UNKNOWN`. |
| `agents` | PATH resolution and bounded `--version` calls for Codex, Claude Code, and OpenCode. Executable presence does not imply MCP connectivity. |
| `clientConfiguration` | A strict, BoxSpec-owned state file containing booleans only. It is distinct from `bridge.handshakeSucceeded` and `bridge.capabilityCallSucceeded`; each client also states that its own actual call was `not-run` by this command. |

The optional state file shape is:

```json
{
  "schemaVersion": "1.0.0",
  "clients": {
    "codex": true,
    "claude-code": false,
    "opencode": true
  }
}
```

An absent state file yields `UNKNOWN`; malformed or oversized input yields `FAIL`. The CLI never reads Codex, Claude Code, or OpenCode login, token, credential, or general configuration files.

## CLI surface

Use the root script as `pnpm run doctor`; `pnpm doctor` is pnpm's unrelated built-in diagnostic. The package-local form is `pnpm --filter @boxspec/cli run doctor`.

Options:

- `--json`: print the redacted machine report.
- `--output <path>`: save the same redacted JSON with restrictive creation mode where the platform supports it.
- `--timeout-ms <500-60000>`: set the bounded probe timeout; default `8000`.
- `--bridge-command <path>` and repeatable `--bridge-arg <value>`: select a BoxSpec MCP launcher for the stdio probe.
- `--state <path>`: select a BoxSpec-owned diagnostic state file.
- `--help`: print usage.

Exit codes are `0` when every required probe passes, `1` when at least one probe actively fails, `2` when no active failure exists but evidence remains unavailable/unknown/not-run, and `64` for invalid usage.

## Redaction and limits

Before JSON or human output, the report is recursively redacted. Secret-named keys are replaced, home and temporary paths are pseudonymized, embedded URL credentials are removed, bearer/basic values and common token shapes are removed, cycles are replaced, command output is bounded, and raw bridge stderr/tool payloads are never emitted. The generated report contains status summaries and allowlisted capability metadata only; it contains no source-file content.

The current captured artifact contains a successful official-SDK MCP handshake and complete tool listing. It does not contain a successful capability response because the default pairing grant was absent; `PAIRING_REQUIRED` remains visible and prevents `PASS`. The probe classifies launcher failure, handshake failure, pairing required, project grant denied, app/Core unavailable, missing capability tool, and successful capability response separately. Per-client `actualClientCall` remains `not-run` because doctor does not drive Codex, Claude Code, or OpenCode themselves; those clients require their separate B06 compatibility runs.
