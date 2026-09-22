# Verifier accessibility and visual checks

## Implemented engines

`packages/verifier/src/accessibility.ts` evaluates a trusted Playwright `Page` after navigation and stabilization. The audit uses actual sequential Tab input and DOM/computed-style measurements. It checks:

- keyboard reachability for visible focus targets and explicit interactive roles;
- accessible names for native and ARIA interactive controls;
- recognized ARIA roles, duplicate DOM IDs, and focusable descendants of `aria-hidden` regions;
- WCAG relative luminance contrast using 4.5:1 for normal text and 3:1 for large text.

The result binds the candidate tree, verification profile, viewport, fixture/state, and trusted contract node IDs into a digest. It records the rendered DOM SHA-256 and returns `STALE` when a supplied trusted DOM hash does not match or the DOM changes during the audit. A missing browser page, an empty surface, or text over a background the deterministic engine cannot resolve returns `UNSUPPORTED`; none can produce `PASS`.

This deterministic Web audit is not a native assistive-technology certification. It does not claim coverage for Windows Narrator, NVDA, VoiceOver, mobile accessibility services, iframe coordinate/accessibility trees, canvas semantics, or text rendered over gradients/images. Those require separate platform campaigns.

`packages/verifier/src/visual.ts` compares trusted PNG captures without reading a baseline from the candidate. An approved baseline descriptor contains its human approval identity/time, exact environment binding, PNG SHA-256, and a descriptor seal. The environment binding covers effective contract, verification profile, fixtures, viewport, and fixture/state. The engine verifies the seal, bytes, and binding before decoding pixels. Missing baselines return `UNSUPPORTED`; byte, descriptor, or environment changes return `STALE`.

The visual result records baseline and actual hashes, binding/options digests, compared and ignored pixels, changed-pixel ratio, maximum and mean channel delta, and the exact difference bounds. Trusted profile-owned ignore regions are supported. A mask excluding every pixel fails. The engine never creates, replaces, or approves a baseline.

## Verification

Environment: Windows, Node 24.19.0, Playwright 1.63.0 with real bundled Chromium.

| Command | Exit | Result |
|---|---:|---|
| `node_modules/.bin/tsc.cmd -p packages/verifier/tsconfig.json --noEmit` | 0 | Strict verifier typecheck passed with both modules. |
| direct Vitest 5.0.1 module: `vitest.mjs run --root packages/verifier tests/accessibility.test.ts tests/visual.test.ts` | 0 | 2 files, 8 tests passed in 2.17s. |

The accessibility tests exercise a real page that passes, deliberate missing-name/custom-keyboard/low-contrast failures, missing-engine and empty-surface `UNSUPPORTED`, and trusted DOM-hash `STALE`. The visual tests use real Chromium screenshots and exercise exact approved pixels, a deliberate color regression with measured bounds, missing-baseline `UNSUPPORTED`, baseline-byte tamper `STALE`, and environment-binding `STALE`.

## Integration contract

The verifier browser loop must call `evaluateAccessibility` for every trusted viewport/fixture after stabilization and before closing the page. It must persist the full result as trusted evidence and map statuses exactly; required `UNSUPPORTED`, `ERROR`, or `STALE` results cannot become report `PASS`.

For visual verification, the trusted application must resolve an approved baseline outside the candidate snapshot and pass its descriptor and bytes to `compareVisual` together with the current contract/profile/fixture/viewport binding. Baseline approval and replacement remain trusted UI/Core operations. The verifier must store the measurement and violations in the sealed report and recheck candidate integrity after browser work.

At this evidence point the engines and integration contract are complete, while wiring into `browser.ts`, `verify.ts`, shared profile types, and trusted baseline persistence remains with their respective owners. Until that wiring and approved baseline data exist, required accessibility or visual checks remain `UNSUPPORTED` and block overall `PASS`.
