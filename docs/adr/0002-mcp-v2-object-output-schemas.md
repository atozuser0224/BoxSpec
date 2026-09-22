# ADR 0002: Declare MCP tool output envelopes as objects

- Status: Accepted
- Date: 2026-09-22

## Context

All 15 supplied MCP tool output schemas use a root `oneOf`; each branch is an object representing either `{ ok: true, data }` or `{ ok: false, ...error }`. The MCP TypeScript SDK v2 requires the root schema itself to be classified as an object. Without a root `type: "object"`, it projects the advertised schema and structured content through a generated `{ result: ... }` wrapper. That changes the specified wire envelope even though every `oneOf` branch is already an object.

The byte-preserved source package remains under `spec/`. The active implementation contract at `contracts/mcp-tools.json` adds `type: "object"` to every output schema. This is a semantic clarification: it accepts the same instances because both branches already require objects.

## Decision

Every active MCP `outputSchema` declares `type: "object"` at the root alongside its existing `oneOf`. Bridge contract synchronization and tests compare against the active contract. External tool responses retain the exact success/error envelopes defined by the specification; no SDK-generated `result` wrapper becomes part of the BoxSpec API.

## Consequences

Static schema validation, MCP SDK v2 advertisement, structured content, and client tests must all use the active contract. Future schema generation must preserve the root object declaration. A future public schema version may fold this clarification back into a new immutable source-package release.
