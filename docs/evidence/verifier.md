# Web verifier evidence

Date: 2026-09-22 (Asia/Seoul)  
Host: Windows, Node 24.19.0  
Browser: Playwright Chromium 153.0.8010.12, headless

## Commands and exit codes

```powershell
node node_modules/typescript/bin/tsc -p packages/verifier/tsconfig.json --noEmit --composite false
node node_modules/typescript/bin/tsc -p samples/react-dashboard/tsconfig.json --noEmit
```

Exit code: `0`.

```powershell
# cwd: samples/react-dashboard
node node_modules\vite\bin\vite.js build --outDir C:\Users\j\Downloads\BoxSpec_Production_Pack\BoxSpec_Production_Pack\packages\verifier\evidence\sample-standalone-build --emptyOutDir
```

Exit code: `0`. Vite 8.3.0 transformed 16 modules and wrote the production bundle in 696ms.

```powershell
node packages/verifier/node_modules/playwright/cli.js install chromium
```

Exit code: `0`. This installed Playwright Chromium revision 1243. Before installation, the verifier returned `ERROR` with build/type checks `PASS`, layout `ERROR`, and interactions `NOT_RUN`; it did not convert the missing browser into a pass.

```powershell
node packages/verifier/node_modules/vitest/vitest.mjs run packages/verifier/tests/security.test.ts packages/verifier/tests/verifier.integration.test.ts --reporter=verbose --maxWorkers=1
```

Exit code: `0`. Final post-integration rerun: 2 files passed, 11 tests passed. Duration: 31.53 seconds.

Earlier diagnostic runs were kept non-passing: the first browser integration run exited `1` because Chromium revision 1243 was absent, and both browser candidates reported `ERROR`; after the pinned browser install the rerun exited `0`. A standalone Vite attempt using the removed Vite 8 `--root` option also exited `1`; the supported invocation above uses the sample directory as `cwd` and exited `0`. Neither failed diagnostic was used as passing evidence.

## Real render results

Evidence root for the final post-integration run: `packages/verifier/evidence/sample-run/run-33412`.

| Candidate | Result | Real renders | Screenshots | Measured desktop sidebar | Search |
|---|---:|---:|---:|---:|---:|
| `candidate-passing-260` | PASS | 25 | 25 | 260px | PASS |
| `candidate-violating-320` | FAIL | 25 | 25 | 320px | PASS |
| `candidate-search-overlay` | FAIL | 25 | 25 | 260px | FAIL |

The 25-render matrix covers populated, empty, loading, error, and long-text fixtures at 1440×900, 390×844, and the 767/768/769 breakpoint boundaries. The passing desktop render also measured header height 64px and main left 260px. The 320 candidate produced 15 blocking `sidebar-width` violations: five fixtures at the declared desktop viewport and the two desktop-side boundary widths.

Reports and evidence digests:

- Passing report: `report_483bf8e666c3483598daab155e8914da/report.json`; digest `b1620bcb3a033a6311c4e98c8f2f5c10598a0ed53eebef611834e6d8cc06d4d3`.
- 320 failure: `report_6a5e0eb3354b46b38ecbe6087fd4f294/report.json`; digest `abb4383fd6e048eecbc0899b4aa71530362118628accb7fd0c19d8ea57ccef83`.
- Overlay interaction failure: `report_91f468d763ea4e0899d1fe1750ded47a/report.json`; digest `5f6ae068748389aedef378ef1880c079d79e1d4c831396efe6a2d9ca491436f7`.

Every report binds the complete candidate tree hash, base/effective/override contract identity, base revision/commit/manifest, generator, policy revision/hash, dependency lock, fixtures, verification profile, measured data, and evidence artifact hashes. The integration test independently recomputes the report evidence digest. Screenshots, metrics JSON, browser runtime metadata, interaction logs, typecheck log, production build log, and production build output are stored below each report directory.

## Negative security evidence

The test suite proves these cases do not pass:

- a file mutation after freeze returns `STALE` and does not build or render;
- a verification-profile hash mismatch returns `STALE` before build;
- a 320px sidebar returns `FAIL` from browser geometry;
- a transparent overlay that intercepts the real search click returns interaction `FAIL`;
- ambient secrets and `NODE_OPTIONS` are absent from the child process while an approved variable is present;
- an already-aborted run does not spawn;
- hardlinked candidate files and an evidence junction into the candidate are rejected;
- a bound deletion is accepted as a deletion, while an omitted upsert is rejected.
- change-manager directory grants such as `src/boxspec/` match descendants for allowed and protected scopes, without matching sibling prefixes such as `src/box/`.

## Scope and limitations

`verifyCandidate` supports the P1 managed React/Vite checks used here: schema/semantic identity, path and generated-file policy, explicit typecheck, production build, DOM geometry/visibility/overflow, screenshots, and trusted interaction scenarios. Required checks with `UNSUPPORTED`, `NOT_RUN`, or `ERROR` cannot aggregate to `PASS`.

Accessibility auditing and screenshot-baseline comparison are not implemented. A contract that requires either receives `UNSUPPORTED`, so it cannot pass. This run has no approved visual baseline and makes no pixel-regression claim.

The approved build executes project code. The process profile strips ambient environment values, hashes the explicit executable, bounds output, enforces a timeout, and terminates the Windows process tree, but it is not a filesystem or whole-process network sandbox. Browser request interception blocks candidate-page requests outside the local preview origin; it is not an OS network boundary. Approval, original-project apply, and crash recovery belong to the runtime/change-manager path and are outside this verifier evidence.
