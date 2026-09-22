# Runtime composition evidence

## Composition

`createBoxSpecRuntime({ dataDir, ...trustedOptions })` is the only runtime factory. It constructs one shared Core database registry, change manager, verifier port, durable runtime state store, and native managed-file writer. Electron uses `runtime.desktop`; the authenticated local IPC host uses the same instance through `runtime.mcp` and `runtime.authorizeMcpSession`.

The factory creates a fresh `dataDir` before taking its exclusive lease. A second process using the same directory fails instead of opening a stale in-memory registry. Project contracts and revisions live in per-project SQLite files under `dataDir`; grants, tasks, candidates, approvals, apply journals, evidence bindings, layout drafts, selections, idempotency records, managed-save batches, and source-drift inspections are durable.

MCP identity is supplied by the authenticated connection. Runtime reauthorizes the exact principal, grant, project, permission, expiry, and grant revision before idempotency lookup. Desktop-only pairing, approval, apply, recovery, layout publication, themes, and source-drift resolution are absent from the MCP tool set.

## Proven lifecycle

The runtime integration suite executes a real temporary Git project through:

1. project and screen creation;
2. native handle-relative contract and generated-source save;
3. durable grant creation and authenticated task start;
4. isolated worktree patch and frozen candidate;
5. trusted typecheck, build, browser fixtures, layout and interaction verification;
6. agent review request;
7. desktop nonce-bound approval and opaque apply token;
8. native source apply; and
9. rejection of reused review authority.

The same suite covers restart persistence, grant revocation before idempotent replay, agent-first isolated layout drafts, stable-ID publication handoff, trusted 17-theme application, native multi-file save crash completion, and managed source-drift resolution.

## Managed authoring and drift

`saveProject` preflights every contract export and generated output before the first source write. It persists a complete batch containing exact BEFORE and AFTER hashes plus the manifest-last replacement. Restart accepts only exact BEFORE or AFTER states; any other bytes remain untouched and block the batch.

Contract exports compare parsed Core semantics as well as byte ownership. Pretty-printed or whitespace-only equivalent JSON is canonicalized safely. A meaningful external contract edit becomes an isolated `AWAITING_USER` draft at revision `N+1`; the approved export is restored through the durable native batch and the approved Core revision remains unchanged. Generated drift can restore the complete screen output unit or persistently unmanage that unit. Unmanaged generated files remain untouched across later saves and restart. Generated TypeScript cannot be inferred into a contract. Invalid or missing contract exports can only be restored. Change-manager `UNKNOWN` apply states remain in the separate recovery workflow.

## Verification composition

Production verification is all-or-none. Runtime rejects partial configuration and requires a resolvable default profile, the five trusted fixtures (`empty`, `loading`, `error`, `long-text`, `populated`), and at least one approved execution profile ID. `@boxspec/runtime` re-exports `loadPackagedVerificationProfile` from the verifier so Electron can validate packaged executable, runner, browser and fixture identities through one trust implementation. Missing or invalid packaged assets leave verification unavailable; there is no fallback command or browser.

## Commands

From the repository root:

```powershell
node node_modules/typescript/bin/tsc -p packages/runtime/tsconfig.json --pretty false
node packages/runtime/node_modules/vitest/vitest.mjs run packages/runtime/test --pool=forks --maxWorkers=1
```

Latest pre-freeze results on Windows:

- strict TypeScript build: exit `0`;
- runtime tests: `13/13` passed across two files in `49.76s`, including the real verifier/browser/native-apply lifecycle;
- targeted runtime source-drift flow after the final restart/unmanage, semantic-contract, and Core import-audit additions: `1/1` passed in `25.50s`.

## Remaining limits

- Arbitrary application source changes cannot be converted into contract edits without a trusted adapter. The runtime rejects that resolution.
- Recovery with any `UNKNOWN` file remains blocked; it never overwrites the file automatically.
- External-agent session wakeup after a published layout handoff is not a runtime transport feature; the durable handoff remains available for reread.
- The final packaged Electron verification/apply campaign and installer asset/signature checks are owned by the E2E and packaging gates.
