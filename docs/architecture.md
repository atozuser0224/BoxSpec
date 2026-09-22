# BoxSpec architecture

## Authority and process boundaries

Core is the only policy and persistence writer. The Electron renderer, preload API, desktop main process, and MCP bridge adapt requests to runtime use cases; they do not duplicate authorization, revision, candidate, verification, approval, or apply rules. Runtime composes the package implementations and exposes a desktop port and a safe MCP dispatch port.

```text
Electron renderer -> narrow preload IPC -> desktop adapter -> runtime -> core
external MCP client -> stdio bridge -> authenticated local IPC -> runtime -> core
                                                       |-> change manager
                                                       |-> trusted verifier
```

The renderer has no filesystem or child-process capability. The MCP bridge does protocol framing and authenticated dispatch only. Candidate worktrees are untrusted execution locations, not sandboxes. Frozen snapshots, verifier code, policy, fixtures, and baselines live outside candidate-writable roots.

## AI-authored live layout drafts

`boxspec_propose_contract_change` creates an isolated live draft containing the complete proposed contract, including stable node IDs and human-readable node names. The desktop lists and opens that draft directly on the canvas; there is no proposal-inbox or import-approval step before it becomes visible. If the user already has dirty canvas edits, the UI preserves them and shows a non-blocking new-draft notice instead of replacing the canvas.

User edits advance a draft-local revision. The active approved contract and `boxspec_get_context` remain unchanged until the user chooses **Implement this layout**. That desktop-only action atomically rechecks both the draft revision and its approved base revision, publishes a new contract revision, and creates an `AWAITING_AGENT` implementation handoff. It does not approve generated code. Candidate verification and the nonce-bound final code approval/apply flow remain separate.

## Trusted theme gallery

The desktop lists a curated, validated projection from `@boxspec/themes`. The renderer submits only a branded theme ID plus the expected draft or screen revision. Runtime resolves that ID against the trusted local catalog and applies the preset through the theme package. Theme application may update the design-system identity, presentation tokens, typography, colors, and radius; it preserves node IDs, parentage, sibling order, layout, placement, responsive geometry, locks, assertions, and verification rules. Applying to a draft increments only its draft revision. Applying directly to an approved screen advances the contract revision exactly once.

Catalog crawl scripts produce reviewable local records with source attribution and preview provenance. Remote preview URLs are fallback metadata rather than trusted executable content; the desktop does not accept arbitrary CSS or token objects from the renderer.

## Trusted packaged verifier

Production verification is available only when the desktop can load and validate `resources/verification-tools.json`. The manifest binds the packaged Electron executable identity, trusted typecheck and build wrapper scripts, the bundled Chromium executable, and exactly five managed fixture files by SHA-256 and byte size. Separately hashed, ordinal inventories seal every regular file in the toolchain and browser directories, including dynamically loaded JavaScript, native modules, DLLs, resources, and locales; the consumer rejects missing and extra files as well as identity mismatches. Its profile and execution IDs are fixed to `managed-react-vite-p1`; commands use argument arrays, a fixed working-directory policy, bounded timeouts, and only `ELECTRON_RUN_AS_NODE=1`.

Every manifest asset path is relative to `process.resourcesPath` and begins with `verification/`. The desktop resolves each path canonically beneath that root, rejects traversal and reparse escapes, and verifies size and hash before composition. It never discovers tools from a candidate, `PATH`, an environment override, or a Playwright cache. A missing or mismatched asset makes verification unavailable and therefore prevents code approval and apply; offline contract editing remains available.

## Workspace packages

| Package | Responsibility |
|---|---|
| `@boxspec/shared` | Schema-aligned data types, errors, immutable identity bindings, service ports, runtime envelopes |
| `@boxspec/core` | Contract validation, canonicalization, policies, commands, revisions, persistence, deterministic web compile for the first vertical slice |
| `@boxspec/runtime` | Composition root and orchestration; the only entry used by desktop and bridge adapters |
| `@boxspec/bridge` | MCP-to-runtime protocol adapter; no independent policy database |
| `@boxspec/local-ipc` | Authenticated per-profile named-pipe transport between MCP launchers and runtime |
| `@boxspec/change-manager` | Grants, worktrees, frozen candidate snapshots, apply journal, recovery |
| `@boxspec/verifier` | Trusted browser execution, measurements, checks, evidence sealing |
| `@boxspec/themes` | Trusted package-owned theme catalog and presentation-only application |
| `@boxspec/project-index` | Isolated component/asset graph and trusted affected-source closure; production composition is pending |
| `@boxspec/adopted-web` | Isolated conservative web-source analysis foundation; production composition and verification are pending |
| `@boxspec/updater` | Isolated signed update-state and rollback foundation; feed, signing, and desktop composition are pending |
| `@boxspec/desktop` | Electron main/preload/editor and trusted user approval UI |

Semantic validation and the web compiler start in core to complete the first vertical path. They may move to `layout-engine` and `compiler-web` packages when their boundaries stabilize. Such a move must preserve byte-stable compilation and the shared service contract.

## Dependency direction

`shared` has no runtime framework dependency. Domain packages may depend on `shared`; runtime depends on domain packages; apps depend on runtime and adapter packages. Core domain code does not import Electron, React, or MCP SDK code. All package imports use public export maps.

## Candidate and approval identity

A candidate identity is derived by trusted code from a frozen snapshot and binds the normalized file manifest, tree hash, base and effective contract hashes, layout override hash, base commit, and base manifest. Verification adds report/evidence, verification profile, policy, generator, dependency lock, and fixture hashes. The desktop receives a review nonce bound by runtime to that complete identity. Approval submits only the candidate ID, report ID, and nonce; runtime creates the approval record and change-manager rechecks every binding immediately before application.

## Build convention

The workspace uses pnpm with one exact lockfile. Packages are ESM, use TypeScript `NodeNext`, extend the strict root configuration, emit to `dist`, and expose package subpaths through `exports`. Every package supplies `build`, `typecheck`, and `test`; specialized tests use `test:unit`, `test:integration`, `test:e2e`, or `test:security` where applicable.
