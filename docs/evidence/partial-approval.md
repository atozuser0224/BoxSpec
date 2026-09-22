# B10 whole-file partial approval evidence

## Implemented change-manager boundary

`DesktopChangeManager.createSubsetCandidate` is an additive trusted-controller API. It accepts only a currently passing parent review binding:

```ts
createSubsetCandidate({
  parentCandidateId,
  parentReportId,
  reviewNonce,
  selectedPaths,
  closureHash,
}): Promise<FrozenCandidateDescriptor>
```

The change manager validates the one-time desktop nonce, PASS report identity, immutable parent snapshot, current task/candidate relation, source manifest/HEAD/branch, grant revision and expiry, execution-profile grant, policy/profile/fixture/dependency/generator bindings, canonical Windows path spelling, and an exact non-empty subset of the parent's changed paths. It then builds a new full snapshot from the Git base plus the selected whole-file after states. New files omitted from the subset remain absent, omitted deletions are restored from the base commit, and omitted modifications use base bytes and executable mode.

The child gets a new candidate ID and tree hash derived from its actual files. It records `subsetOrigin` with the parent candidate/report, canonical selected paths, and closure packet digest. No parent verification, report, nonce, or approval is inherited. The parent nonce and any unconsumed approvals are consumed, the child becomes the task's current candidate in `VERIFYING`, and only a new trusted verification can make it reviewable.

`closureHash` is an opaque trusted-runtime attestation whose lowercase SHA-256 shape is validated and immutably bound. The change manager cannot infer dependency closure from file paths and does not claim that a path-only digest proves semantic closure. The trusted integration contract is:

1. The renderer sends only server-issued `selectedChangeIds`.
2. Runtime resolves those IDs through the current trusted project index.
3. Project index emits sorted dependency-closed `selectedPaths` and a closure packet binding resolver version/model/algorithm, project and graph identities, source screen and selected nodes, affected nodes/screens/components/source paths, and reasons.
4. Runtime passes the trusted paths and `SHA-256(canonicalJson(packet))` to this desktop-only API, persists the returned child context, and runs the complete trusted verifier pipeline.
5. A fresh PASS report, desktop review nonce, approval, and apply confirmation are required for the child.

There is no intra-file hunk selection and this API must not be exposed over MCP or directly to renderer content.

## Verification

Direct local binaries were used; no install or package-manager reconciliation was run.

- `node_modules/.bin/tsc.cmd -p packages/change-manager/tsconfig.json --noEmit` — exit 0.
- `node_modules/.bin/tsc.cmd -p packages/change-manager/tsconfig.json` — exit 0.
- `packages/change-manager/node_modules/.bin/vitest.cmd run --config vitest.config.ts -t subset` — exit 0, 5 passed.
- `packages/change-manager/node_modules/.bin/vitest.cmd run --config vitest.config.ts -t dependency-expanded` — exit 0, 1 passed.
- `packages/change-manager/node_modules/.bin/vitest.cmd run --config vitest.config.ts` — exit 0, 37 passed in 2 files (72.03 s).

Coverage proves two independently changed files can yield a one-file child, omitted modified and added files return to base state, dependency-expanded whole-file selections remain atomic, child identity/tree hash changes, the child starts without verification, the task points at the child, parent approval and PASS cannot be reused, and only a freshly verified child applies. Negative cases cover empty/foreign/colliding/noncanonical paths, source drift, policy/profile binding changes, and revoked grants.

## Release status

The change-manager API and tests are implemented. Runtime, desktop UI, and end-to-end integration are separate work and are not claimed as completed by this evidence.
