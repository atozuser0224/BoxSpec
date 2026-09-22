# B06 — stdio MCP bridge evidence

Evidence captured on 2026-09-22 on Windows with Node.js and the exact workspace dependency lock. The production bridge uses the split MCP TypeScript SDK generation (`@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0`).

## Shipped path and trust boundary

- Runnable entry: `apps/mcp/dist/index.js`
- Source entry: `apps/mcp/src/index.ts`
- Invocation: `node apps/mcp/dist/index.js [--profile NAME]`
- Default profile: `default`
- Optional packaged/test profile root override: `BOXSPEC_MCP_PROFILE_ROOT`
- Default profile storage is owned by `@boxspec/local-ipc` under the current user's `%LOCALAPPDATA%/BoxSpec/mcp-profiles` directory.

The launcher opens an authenticated named-pipe session through `createProfileCoreIpcClient`. The profile's random session token is sent only in the pipe authentication frame. The host resolves that token to a server-side principal/grant/project binding. Tool payloads and IPC request frames cannot select a principal, role, grant, project authority, or arbitrary operation. The adapter sends only the `channel: "mcp"` request union and a `SafeMcpToolName` to the desktop-owned Core use cases. The bridge never starts a second runtime.

The stdio server is started by the official SDK's `serveStdio` compatibility wrapper. Protocol frames are the only stdout writes. Diagnostics go to stderr. The catalog loader fails closed unless its names exactly equal the shared 15-tool allowlist and rejects the privileged names `approve`, `unlock`, `apply_to_main`, `run_shell`, `delete_project`, and `read_secret`.

The checked-in bridge catalog is a mechanical copy of the active root contract. At evidence time both files had SHA-256 `A474E9C2B113FDC524625BB35F707FD01E5D5554C94B2ABF504B55A7F0B9FE1A`.

## Build and adapter contract test

Commands:

```text
node packages/bridge/node_modules/typescript/bin/tsc -p packages/bridge/tsconfig.json --pretty false
node packages/bridge/node_modules/vitest/vitest.mjs run packages/bridge/test/server.test.ts --reporter=verbose
node apps/mcp/node_modules/typescript/bin/tsc -p apps/mcp/tsconfig.json --pretty false
```

All three commands exited 0. The final Vitest 5.0.1 run reported 1 file and 10 tests passed. The tests cover:

- exact checked-in input/output schemas and annotations from `tools/list`;
- absence of privileged tools;
- all 15 advertised tool names dispatch through their exact input and output contracts;
- launcher-bound principal propagation without accepting identity in payloads;
- malformed payload rejection before Core invocation;
- a hard bridge timeout when Core ignores its abort signal;
- a pre-cancelled protocol request never reaching Core;
- aggregate request-byte and result-byte limits;
- invalid Core output replacement with a schema-valid `INTERNAL_ERROR` result;
- scoped context resource routing through the same principal and Core path;
- fail-closed catalog/shared-allowlist drift detection.

## External SDK client to running application runtime

Command:

```text
node --test apps/mcp/test/stdio-runtime.test.mjs
```

Exit code: 0. The final rerun against the restricted-DACL Windows named-pipe host and `runtime.authorizeMcpSession` production authority callback reported 1 test passed and 0 failed in 3.555 seconds; the test body completed in 2.638 seconds.

This is a separate-process transport test, not an in-memory server test. It creates the real `BoxSpecApplicationRuntime`, creates a project and screen through the desktop API, pairs an MCP read grant through the desktop API, starts the real local IPC host, writes a short-lived pairing profile, and launches `apps/mcp/dist/index.js` as a child process. An official `@modelcontextprotocol/client@2.0.0` `StdioClientTransport` pins protocol `2026-07-28` and performs initialization before the calls below.

The client then verifies:

- `tools/list` returns exactly 15 tools and none of the privileged names;
- `boxspec_get_context` returns a real revision-pinned context slice for the granted project/screen;
- the returned `contractSliceJson` parses as JSON;
- `resources/read` on the BoxSpec context URI returns the same grant-scoped data through Core;
- a foreign project returns `PROJECT_NOT_GRANTED`;
- an incorrect expected revision returns `REVISION_CONFLICT`;
- an unexpected input property is rejected as `INVALID_REQUEST` before runtime dispatch;
- captured stderr does not contain the session-token field name;
- successful SDK parsing across initialization, listing, calls, and resource reading demonstrates that stdout contains only MCP protocol frames.

The external-process test is implemented in `apps/mcp/test/stdio-runtime.test.mjs`. It does not trust an agent's pass/fail claim, a screenshot path, or a mocked success adapter.

## Resource and cancellation behavior

The adapter caps requests and responses at 1 MiB by default and concurrent requests at 32. Each call races Core work against client cancellation and the 60-second default deadline. It aborts the Core signal and returns a schema-valid `CANCELLED` result even when a faulty Core implementation ignores cancellation; late rejection is absorbed by the attached settlement handler. IPC cancellation frames are handled by `@boxspec/local-ipc` and map the same request ID to the host-side abort controller.

## Codex CLI compatibility probe

Command:

```text
node apps/mcp/scripts/codex-cli-compat.mjs
```

The final bounded probe exited 0 using the installed `codex-cli 0.155.0-alpha.9.2`, its existing saved authentication path, model `gpt-5.6-sol`, high reasoning, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and a read-only sandbox. The MCP server was supplied only through command-line `-c` overrides, so no global Codex configuration was written. Its five-minute profile granted read permission to a temporary project and the Codex server configuration enabled only `boxspec_get_capabilities` and `boxspec_get_context`. This final rerun also used `runtime.authorizeMcpSession`, the application runtime's production session-binding callback.

The JSONL event stream contained successful calls to both allowed tools, the expected project ID, and revision 1. The harness reported 9 Codex events and deleted the temporary project, runtime data, and pairing profile afterward. It did not inspect, copy, or print login/token files.

This Codex CLI proof is separate from the official SDK conformance test above.

The installed `opencode 1.18.32` advertised `opencode/gpt-5.6-sol` with a `high` variant. A single actual run used that exact model/variant, `--pure`, a temporary project-only MCP configuration, a five-minute read grant, and deny-all permissions except `boxspec_get_capabilities` and `boxspec_get_context`. The client exited 1 after about 78 seconds and emitted no stderr, so OpenCode remains unverified; no model fallback or repeated client run was attempted. The reproducible bounded harness is `apps/mcp/scripts/opencode-cli-compat.mjs`. Claude Code was not installed and remains unverified.

## Remaining release integration

Packaging must invoke `apps/mcp/dist/index.js` with its bundled Node-compatible runtime (for Electron, `ELECTRON_RUN_AS_NODE=1`) and supply the selected profile name. Pairing/profile issuance remains a desktop-only action. Installer-level Codex/OpenCode/Claude configuration and a packaged-binary smoke are outside this bridge evidence.
