# BoxSpec repository instructions

These rules govern development of BoxSpec itself. They preserve the authoritative rules from `agent/AGENTS.md`; the production plan and schemas under `spec/` remain the source package.

## Product contract

BoxSpec is a local-first visual layout contract editor and verification tool for coding agents. The supported first release is Windows + managed React/TypeScript/Vite UI + external local MCP clients. Unity uGUI and React Native Android are subsequent adapters, not pretend P1 support.

The full Korean production specification and schemas are authoritative. Preserve security and human approval invariants over convenience examples. Record conflicts and decisions in an ADR.

## Architecture

Keep domain code independent of Electron, React, and MCP SDK imports. Core is the single policy and persistence writer. UI IPC and MCP invoke the same use cases. No duplicated permission logic. Use strict TypeScript, unknown at input boundaries, runtime validation, exhaustive domain errors, and cancellation.

Generated layout shells belong to the compiler. Agents implement scoped slots or submit approved contract-change proposals. Repeatable compile output must be byte-stable for identical inputs and compiler versions.

## Safety and integrity

Never auto-reset, auto-clean, stash, overwrite user changes, extract agent credentials, or silently elevate permissions. A worktree is not a security sandbox. Candidate snapshots and validation evidence must be immutable by identity and checked by hash before approval and application.

Human approval, contract unlock, baseline replacement, and original-project application are trusted UI operations, never unrestricted MCP tools. No generic run_shell/read_secret/apply_to_main tool. Validate paths including symlink/junction/reparse points, Windows aliases, and newly created paths.

Trusted verifier code, policies, and golden baselines cannot be changed by a candidate. A missing, failing, unsupported or unexecuted check cannot become PASS. AI review cannot override deterministic blocking checks.

## UI

Use the specified editor tokens and three-pane workspace. Avoid decorative cards, gradients, excessive rounding, oversized headings and unlabelled icon-only actions. Preserve Korean IME, keyboard operations, DPI scaling and visible failure reasons. Editor styling and target-product styling are different systems.

## Development workflow

Inspect the repository before scaffolding. Pin tested versions; do not guess current SDK imports or CLI flags. Use official upstream documentation for external APIs. Keep a compatibility matrix and dependency license record.

Parallelize independent packages with one writer per file. Interface changes require coordination. Do not claim tools, agents, platforms or tests were used unless actually executed. Keep progress, commands, exit codes and release blockers in `docs/progress.md`.

## Completion

A static mock is not a working product. Real MCP tool calls, real browser rendering, real constraint failures, real original-project apply and crash recovery are required for the corresponding features. Test doubles are permitted in unit tests, not as substituted end-to-end evidence.

Before declaring P1 ready, run the full release checklist in the production specification and clearly separate implemented, tested, unsupported and unverified items.
