# Trusted desktop verification profile

The verifier owns one production profile, `managed-react-vite-p1`. Desktop code obtains it through `loadPackagedVerificationProfile(process.resourcesPath, process.execPath)`. Development uses `loadDevelopmentVerificationProfile(app.getAppPath(), process.execPath)`, which resolves the fixed repository staging directory `build/verification-dev`. Neither loader discovers tools through `PATH`, environment variables, a project directory, or a Playwright browser cache.

## Resource contract

Production reads `resources/verification-tools.json`; development reads `build/verification-dev/verification-tools.json`. Both use the same relative tree:

```text
verification/
  runners/typecheck-runner.mjs
  runners/vite-build-runner.mjs
  toolchain/node_modules/...
  browser/...
  fixtures/{empty,loading,error,long-text,populated}.json
  manifests/{toolchain,browser}.json
```

The application executable is Electron's trusted `process.execPath`, with `ELECTRON_RUN_AS_NODE=1`. Typecheck argv is `[typecheck-runner.mjs, "{outputDir}"]`; build argv is `[vite-build-runner.mjs, "{outputDir}"]`. The factory validates the application executable, runners, fixtures, browser executable, and both complete toolchain/browser closures by size and SHA-256. It rejects missing, extra, special, reparse, symbolic-link, junction, hardlinked, and Windows case-fold duplicate entries. `verifyCandidate` rechecks both closures at verification start, immediately before browser launch, and at completion.

The build runner ignores candidate Vite configuration and lifecycle scripts. It imports only the sealed Vite/React toolchain and writes to the verifier-owned evidence directory. The typecheck runner uses fixed strict compiler options and the sealed TypeScript/React declarations. Chromium is launched only by its explicit sealed path; missing or altered resources raise `VerificationToolsUnavailableError`. Desktop must then omit the verification configuration and report the capability unavailable.

All five trusted fixture states are required. The interaction check uses `populated`, fills `[data-testid='project-search']` with `첫 번째`, and requires exactly one `[data-testid='project-item']` whose text includes `첫 번째 프로젝트`.

## Source verification evidence

Run from the repository root:

```powershell
pnpm --filter @boxspec/verifier typecheck
pnpm --filter @boxspec/verifier exec vitest run tests/packaged-profile.test.ts tests/security.test.ts
pnpm --filter @boxspec/verifier exec vitest run tests/verifier.integration.test.ts
pnpm --filter @boxspec/verifier build
```

Results on 2026-09-22:

- Typecheck: exit 0.
- Manifest, closure, environment, hardlink, junction, abort, deletion, and policy tests: 11/11 passed, exit 0.
- Real Playwright build/render/search and negative geometry/overlay/tamper tests: 5/5 passed, exit 0, 28.95 seconds.
- Package build: exit 0.

The real browser suite renders every contract fixture and viewport plus breakpoint boundaries. It records screenshots and measured node geometry, proves 64px header/260px sidebar/fill main PASS, proves an actual 320px sidebar FAIL, and proves an overlay-blocked search FAIL.

## Product integration state

The source factory and fixed development loader are complete. A packaged or development desktop is ready only after packaging has generated the two complete closure manifests and the top-level manifest from the staged bytes, and the Electron-owned lifecycle smoke has loaded that manifest and produced a real PASS report. Until that smoke succeeds, packaged default verification remains unavailable rather than inferred from method presence.

