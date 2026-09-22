# Review panel deferred design

Status: deferred on 2026-09-22 before implementation so the frozen desktop build can proceed. No ReviewPanel source or CSS change from this task was applied.

The existing detail contract can honestly render candidate/report identity, contract and policy revisions, tree and contract hashes, categorized `structure | style | content | binding | code` records, required checks, artifact identifiers, spatial before/after rectangles, movement deltas, violations, and the screenshot artifact path. It does not currently carry asset-specific records, stable server-issued change IDs, or per-change evidence bindings. The UI must label those fields unavailable rather than infer them from paths or summaries.

The proposed additive component integration is:

```ts
onPartialReview?: (selectedChangeIds: readonly string[]) => void;
partialReviewAvailable?: boolean;
```

Partial selection remains disabled until shared/runtime supply server-issued change IDs and an explicit host capability. The renderer groups changes by canonical display path and lets users select only a whole file; it submits IDs only. Runtime resolves IDs, computes dependency closure, and asks change-manager to create a new child candidate. That child must run full verification and receive a fresh report and review nonce. The parent candidate's PASS or nonce can never approve it.

Requested stable selectors for the future implementation are `review-row-${candidateId}`, `review-detail`, `review-candidate-id`, `review-report-id`, `review-tree-hash`, `review-approve-apply`, `review-create-partial`, `review-change-${changeId}`, and `review-evidence-${artifactId}`.
