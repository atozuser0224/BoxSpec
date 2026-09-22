# Local IPC and MCP pairing evidence

Status: implemented and exercised on Windows. The desktop integration uses the one desktop-owned `BoxSpecApplicationRuntime`; the stdio MCP subprocess is only a client and does not open a runtime or state database.

## Transport and authority

`@boxspec/local-ipc` hosts NDJSON over a Windows named pipe. The first frame must be the exact authentication frame `{type, protocolVersion, sessionToken}`. The host stores only SHA-256 token digests and binds a successful connection to its server-held `principalId`, `grantId`, `projectId`, permissions, and expiry. Request frames cannot supply a principal or role. Only the shared `SAFE_MCP_TOOL_NAMES` and the shared `CoreIpcRequest` MCP channel are accepted; a desktop channel, unknown/extra envelope fields, or identity fields in a payload are rejected.

Before every call the host checks expiry, required tool permission, and project binding, then invokes the runtime-owned `authorizeMcpSession` callback. The runtime re-reads the durable grant and validates the exact principal, grant, project, expiry, revocation state, and permission. It then performs the same checks again in the actual MCP use case. Cancellation frames abort the per-request `AbortController`.

An explicit desktop pairing action calls `runtime.desktop.pairMcpClient` first and only then calls `host.issuePairingProfile`. That call generates a random 256-bit token, enforces a maximum 15-minute session lifetime, and atomically writes `%LOCALAPPDATA%/BoxSpec/mcp-profiles/<safe-name>.json`. Profile names are limited to one safe filename, reject traversal, device syntax, and Windows reserved device names, and never become a caller-selected path. The profile contains only `protocolVersion`, `pipePath`, `sessionToken`, `principalId`, `grantId`, and `expiresAt`.

## Windows access control

The profile directory is protected with inheritance removed and full access granted only to the current user SID and SYSTEM. The temporary file is created exclusively, flushed, protected, renamed atomically, and the final file descriptor is protected again. A Windows test reads the resulting SDDL and rejects broad `Everyone`, `Authenticated Users`, or built-in Users access.

The initial probe of Node's default named-pipe descriptor found read ACEs for Everyone and Anonymous, so the implementation does not rely on the Node default. During `start()`, before the pipe path or a profile is exposed, the host connects with `ChangePermissions`, replaces the live pipe DACL with a deny rule for the Windows NETWORK SID and full access for the current user SID and SYSTEM, then opens a new pipe instance and reads its SDDL. Startup fails closed unless the descriptor is protected, contains the expected network deny and two allowed trustees, and has no allow ACE for Everyone, Anonymous, Authenticated Users, built-in Users, or Administrators. This check also proves that the restriction persists to the next server pipe instance rather than only the DACL-changing connection.

This is an account boundary, not a process sandbox. Another local process already running as the same Windows user can read that user's protected profile and use the short-lived token while its durable grant remains live. Remote network logon tokens are denied by SID in the pipe DACL because Node does not expose Windows' `PIPE_REJECT_REMOTE_CLIENTS` creation flag. The server-side project/permission binding, short expiry, per-call durable reauthorization, and revocation limit the residual local same-user risk; they do not eliminate it.

## Verification

Commands were run from the repository on Windows 10.0.26200 with Node 24.19.0.

| Command | Exit | Result |
|---|---:|---|
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` from `packages/local-ipc` | 0 | Strict package typecheck passed. |
| `node node_modules/typescript/bin/tsc -p tsconfig.json` from `packages/local-ipc` | 0 | `dist/index.js` and declarations built at the package export paths. |
| `node node_modules/vitest/vitest.mjs run` from `packages/local-ipc` | 0 | 1 file, 24 tests passed in 11.65 s. |
| `node --test apps/mcp/test/stdio-runtime.test.mjs` | 0 | 1 actual SDK subprocess test passed against the final DACL-hardened, network-denying, 15-minute-limited host and runtime-owned authorizer in 2.427 s (3.563 s total): official MCP v2 client → stdio launcher → authenticated named pipe → real app-owned runtime. The run covered context/resource reads, exact safe tool listing, foreign-project denial, stale-revision denial, invalid input denial, protocol-clean stdout, and token-free stderr. |
| `node apps/desktop/scripts/ipc-smoke.mjs` | 0 | Real desktop composition smoke created a temporary Git project and durable grant, started the restricted host with `runtime.authorizeMcpSession`, wrote a protected profile, authenticated through `createProfileCoreIpcClient`, and returned `ok: true` from `boxspec_get_capabilities` for the bound principal. |
| `node apps/mcp/scripts/codex-cli-compat.mjs` | 0 | Installed `codex-cli 0.155.0-alpha.9.2` completed the bounded read-only probe through the final pipe in 18.6 s and called only `boxspec_get_capabilities` and `boxspec_get_context`. |

The local suite uses real Windows named pipes and temporary protected profiles. It covers successful connection-bound identity, wrong token, expired token/profile, runtime callback denial after durable revocation, immediate host revocation, profile/token rotation, injected desktop role, desktop-channel injection, foreign project, client-side and raw host-side oversized requests, cancellation propagation, two concurrent bridge clients, app-down classification, safe-name traversal/device attacks, linked/junction profile roots, token-free diagnostics, profile DACL, and fail-closed pipe DACL verification.

## Source identities

| File | SHA-256 |
|---|---|
| `packages/local-ipc/src/client.ts` | `9034ef776a22fc6d925b5bf5f7801883b40f59fba91da20cae21979488a735e3` |
| `packages/local-ipc/src/host.ts` | `4c269415b729aeddda09e1e189c513ca956a48497773bc2ea6549f73be372749` |
| `packages/local-ipc/src/profile.ts` | `8068faeee28f7765f49c83980253cdb786f04b6f849be294219438f384d0f6ff` |
| `packages/local-ipc/src/protocol.ts` | `2082dc4f28bd78b2e1b6f1881d25e7eec28114260d34081aa5de50bb072c744b` |
| `packages/local-ipc/src/types.ts` | `b674a5dffb7953bfcae9ade9147259b5589f0bf3edda8507f0cb283abe8b2536` |
| `packages/local-ipc/test/local-ipc.test.ts` | `e759eb3e44223d83cdfae22194c90f12d947eb0c5c50027399de93a1676c20df` |

## Remaining release evidence

Codex is the only installed accepted external client on this host. Claude Code and OpenCode handshakes remain unrun. The Windows PowerShell/.NET pipe ACL path must also be exercised on the clean supported installer VM. Those gaps prevent claiming the complete three-client or clean-machine release campaign even though the authenticated local path and the actual Codex-compatible MCP SDK subprocess path are working here.
