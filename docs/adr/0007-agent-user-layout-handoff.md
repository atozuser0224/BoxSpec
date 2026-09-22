# ADR 0007: Agent-first live layout draft and user implementation handoff

- Status: Proposed
- Date: 2026-09-22
- Scope: P1 agent-authored layout draft, desktop editing, layout publication, and implementation handoff

## Context

The default authoring loop starts when an external coding agent decides that layout help is useful. The agent first builds a complete box layout from its own judgment, using named UI pieces and stable node IDs. BoxSpec immediately shows that result as an editable canvas. The user can move, resize, group, reparent, rename, create, duplicate, or delete boxes, then clicks **이 배치로 구현**. The agent reads the published revision and implements it. Later changes repeat against the same surviving node IDs.

This is an agent-first workflow. It must not require the user to arrange an empty canvas, import the proposal, or approve the draft before seeing and editing it. An inbox can recover interrupted or competing drafts, but it is not the main entry point.

The current external path already carries a complete draft. `boxspec_propose_contract_change` accepts `requestId`, `projectId`, `screenId`, `expectedRevision`, `reason`, and a `proposedContractJson` string of at most 262,144 bytes ([tool contract, lines 2140-2179](../../packages/bridge/contracts/mcp-tools.json)). The runtime checks that the referenced approved screen is at `expectedRevision`, parses the proposed layout contract, and persists an `AWAITING_USER` proposal ([runtime, lines 918-943](../../packages/runtime/src/runtime.ts); [state record, lines 26-36](../../packages/runtime/src/state-store.ts)). It does not currently expose that record through the desktop API or publish it.

The contract already models the required named pieces: each node has an ID, parent, sibling order, name, role, layout, placement, content, slot, locks, responsive rules, and optional sketch bounds ([shared contract, lines 46-69](../../packages/shared/src/contracts.ts)). A full proposed contract can therefore represent the agent's first visual answer without adding another MCP tool.

## Decision

### 1. Keep the 15 safe MCP tools and use proposals as an isolated live draft

The agent sends the complete proposed layout through the existing `boxspec_propose_contract_change` payload. `proposedContractJson` contains the full target `LayoutContract`, including every box the agent wants the user to see. It is not a patch and it is not an automatic code-to-layout extraction claim.

For an existing screen, the agent first reads the current selection and approved context, preserves IDs for surviving concepts, adds IDs only for new concepts, and submits a target contract for `baseRevision + 1`. For a newly paired project, BoxSpec internally prepares a screen revision 1 and selects its root during project setup or pairing. The user does not need to create or arrange a placeholder screen. This is required because the current MCP surface has no create-screen operation, while the current runtime proposal path requires an existing screen.

On receipt, the desktop automatically opens the newest valid proposal as a live draft canvas when no dirty draft is active. If the user is already editing a draft, BoxSpec shows the incoming proposal as queued and never overwrites the active draft. The proposal list is used for recovery and explicit switching.

The approved contract remains unchanged while the draft is edited. Existing editor transforms can be reused, but current `executeEditorCommand` cannot be the draft persistence path because it executes a trusted `replace-contract` directly against the approved contract ([runtime, lines 317-346](../../packages/runtime/src/runtime.ts)). The renderer currently calls it for each editor command and advances the approved screen immediately ([desktop renderer, lines 67-73](../../apps/desktop/src/renderer/App.tsx)).

### 2. Bind every draft to an immutable base and a separate draft revision

A persisted layout draft contains at least:

- `proposalId`, `projectId`, `screenId`, `principalId`, `reason`, and timestamps;
- `baseRevision` and `baseContractHash` from the approved contract;
- `draftRevision`, beginning at 1 and incrementing on each saved draft edit;
- the full `draftContract`, its hash, and status;
- `AWAITING_USER`, `USER_EDITING_DRAFT`, `STALE`, `PUBLISHED`, or `DISMISSED` status.

The draft contract's `revision` remains `baseRevision + 1` throughout draft editing. `draftRevision` provides optimistic concurrency for draft edits. Any change to the approved base revision or hash makes an unpublished draft `STALE`. BoxSpec does not silently merge or publish a stale draft. Rebase is an explicit user action that produces a new base binding and a reviewable conflict result.

Proposal ingestion must add checks that are absent today: the inner contract `projectId` and `screenId` must equal the outer payload, its revision must equal `expectedRevision + 1`, and its target must match the project. Schema parsing alone is insufficient. Publishing repeats these checks against the current approved base.

### 3. Publish only through the trusted desktop action

The **이 배치로 구현** button calls a desktop-only publish operation. Publishing performs one core `replace-contract` command with actor `{ kind: "user", id: "desktop" }`, the exact base revision, and the final draft contract. Core already enforces screen identity and a one-revision increment for replacement contracts ([repository, lines 111-124](../../packages/core/src/repository.ts)). Core also refuses an agent-created approved screen ([repository, lines 80-84](../../packages/core/src/repository.ts)). Those protections remain in force.

The button does not approve or apply source code. `boxspec_request_review` remains limited to a verified candidate/report pair and only queues it for trusted code review ([tool contract, lines 2285-2314](../../packages/bridge/contracts/mcp-tools.json)). Source approval still occurs after `start_task`, candidate submission, trusted verification, and a separate review action.

### 4. Add desktop-only draft ports

Foundation owns the shared types. Runtime and desktop add equivalent operations to the `DesktopUseCases`/IPC surface:

```ts
listLayoutDrafts({ projectId }): Promise<LayoutDraftSummary[]>
openLayoutDraft({ projectId, proposalId }): Promise<LayoutDraftDetail>
updateLayoutDraft({ requestId, projectId, proposalId, expectedDraftRevision, contract }): Promise<LayoutDraftDetail>
publishLayoutDraft({
  requestId,
  projectId,
  proposalId,
  expectedDraftRevision,
  expectedBaseRevision,
  expectedBaseHash
}): Promise<LayoutImplementationHandoff>
```

The current `DesktopUseCases` and `DESKTOP_OPERATION_NAMES` contain editor and code-review operations but no proposal operation ([shared runtime, lines 85-109 and 123-148](../../packages/shared/src/runtime.ts)). The new ports are trusted desktop ports, not MCP tools. `updateLayoutDraft` validates a complete contract and changes only draft state. `publishLayoutDraft` is idempotent by `requestId`, publishes exactly once, and returns the prior result on an exact replay.

### 5. Preserve identity and return a revision handoff

Moving, resizing, renaming, regrouping, or reparenting a box preserves its node ID. A duplicate, a newly drawn box, and a newly created group receive a new collision-resistant ID once. Grouping creates one new container ID and reparents the selected nodes without regenerating their IDs. Deleted IDs are reported as deleted and are not silently rebound to another concept in the same screen lineage.

The current renderer uses time-derived IDs for new and duplicated regions ([desktop renderer, lines 150-173](../../apps/desktop/src/renderer/App.tsx)); the draft workflow replaces that behavior with runtime- or UUID-generated IDs and collision validation. The complete contract is still validated for duplicate IDs, missing parents, cycles, leaf children, and sibling order before every draft save and publish.

Successful publication returns an implementation handoff with:

```ts
interface LayoutImplementationHandoff {
  projectId: ProjectId;
  screenId: ScreenId;
  proposalId: string;
  baseRevision: number;
  baseContractHash: Sha256;
  newRevision: number;
  newContractHash: Sha256;
  addedNodeIds: NodeId[];
  changedNodeIds: NodeId[];
  removedNodeIds: NodeId[];
  affectedNodeIds: NodeId[];
}
```

The external agent then calls `boxspec_get_context` with `newRevision` and the surviving affected IDs, and calls `boxspec_start_task` only after that exact read. The existing context implementation rejects a revision mismatch and returns a canonical context hash and bounded contract slice ([runtime, lines 984-997](../../packages/runtime/src/runtime.ts)). The existing task start path binds the approved contract hash and revision ([runtime, lines 1001-1023](../../packages/runtime/src/runtime.ts)).

The current MCP protocol is request/response and has no operation that wakes a particular external agent session after the user clicks the button. P1 must therefore surface a ready handoff in the desktop and generate a copyable/resumable prompt for the same agent session. Automatic client-session wake-up requires an explicit client transport and must not be claimed until implemented. This delivery limitation does not weaken the canonical revision/diff handoff.

### 6. Keep the two human decisions separate

The layout decision publishes what the implementation should target. The later code decision applies verified source bytes. Their states, buttons, nonces, and audit records remain separate:

```text
approved rN
  -> agent proposal bound to rN/hash
  -> live user-editable draft
  -> "이 배치로 구현"
  -> approved rN+1 + layout handoff
  -> agent get_context(rN+1, affected stable IDs)
  -> start_task -> candidate -> trusted verification
  -> request_review -> separate code approve/apply
```

The agent guidance currently presents `boxspec_propose_contract_change` only as a response to hard-constraint conflict and presents `boxspec_request_review` as the final candidate step ([agent prompt, lines 11-21](../../agent/USE_BOXSPEC_PROMPT.md)). It must add the agent-first draft loop while retaining the existing code-approval rules.

## Implementation work units

| Owner | Additive work | Acceptance boundary |
|---|---|---|
| Foundation/shared | Draft summary/detail, state, and handoff types; four desktop operations; IPC payload/result declarations | Types distinguish approved revision, target contract revision, and draft revision; no MCP tool count change |
| Runtime | Bind proposal identity/base hash/target revision; persist draft edits; stale detection; one-shot trusted publish; stable-ID diff; auto-provision/select the initial screen anchor | Proposal cannot mutate approved state; stale or mismatched identity cannot publish; exact replay is idempotent |
| Desktop | Detect and auto-open a new valid agent draft; draft-mode canvas; queued-draft banner; group/reparent; **이 배치로 구현**; handoff display/copy | Agent layout appears without import/approval; dirty draft is never overwritten; button never calls code apply |
| Core | Reuse trusted `replace-contract` publication and history; provide or host deterministic contract diff/stable-ID validation if runtime should not own it | Publication is exactly `rN -> rN+1`; full validation and undo/history remain intact |
| Bridge | Keep all 15 tools; strengthen proposal identity/revision tests and prove revised context can be read after desktop publication | Agent cannot publish, approve, apply, grant, revoke, or unlock through MCP |
| Documentation | Update the agent prompt and user guide for agent-first draft, user editing, handoff resume, and separate code review | No claim of automatic source extraction or automatic external-session wake-up |

## Acceptance criteria

1. Given a paired project with no user-created screen, the external agent can obtain an internally prepared selected screen/base revision and submit a complete named-box contract.
2. A valid proposal appears directly on the canvas without a user import or pre-approval step; the approved contract/hash/revision remain unchanged.
3. A second incoming proposal never overwrites an active dirty draft.
4. The user can move, resize, rename, create, duplicate, delete, group, and reparent in draft mode; every save uses `expectedDraftRevision`.
5. Surviving nodes retain their IDs across agent submission, user editing, publication, implementation, and the next loop.
6. Outer/inner identity mismatch, target mismatch, invalid contract, wrong target revision, base revision/hash drift, or draft revision conflict blocks publication with no partial change.
7. **이 배치로 구현** performs exactly one trusted layout publication and returns the new approved revision/hash plus added, changed, removed, and affected IDs.
8. The agent reads the exact new revision through `boxspec_get_context` before starting implementation.
9. The button and layout publication do not create a candidate approval, call `approveAndApply`, change grants, alter locks beyond the exact user-edited draft, or write source files.
10. Code implementation still requires candidate freezing, trusted PASS verification, `boxspec_request_review`, and a separate user code-apply decision.

## Consequences and non-goals

The proposal becomes immediately useful visual work while remaining isolated from the approved contract. The user can reshape an agent's complete idea instead of preparing a layout for the agent. Stable IDs make later context reads and repeated implementation cycles refer to the same UI concepts.

This ADR does not promise automatic extraction of an existing application into boxes, semantic recognition of every component, unattended source implementation, or automatic wake-up of an arbitrary external client session. It does not merge layout publication with code approval. Large proposed contracts still respect the current 262,144-byte MCP input limit; exceeding it is a visible resource error rather than a partial draft.
