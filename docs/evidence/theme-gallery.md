# Theme gallery evidence

Status: complete. The component, 17-item catalog, trusted desktop wiring, and real Electron interaction campaign are green.

## User-visible behavior

`ThemeGallery` is a modal browser for the trusted `ThemeGalleryItem[]` projection supplied by the desktop host. It provides:

- text search across the preset name, description, style, source, typography, and tags;
- explicit `light`, `dark`, and `mixed` mode filters plus a catalog-derived style filter;
- a keyboard-selectable card library and a separate selected-theme detail pane;
- palette, body/display type, radius, source, license, and preview credit summaries;
- one explicit `이 테마 적용` action that emits only the selected stable preset ID;
- Escape/backdrop/Close dismissal, focus restoration, trapped Tab navigation, and arrow/Home/End card navigation;
- responsive internal scrolling at narrow and short desktop window sizes.

Hover never applies a theme. Card activation changes only the preview selection. The host callback owns trusted resolution, persistence, and application. The gallery explains that applying a theme changes presentation tokens while keeping layout, node IDs, and geometry unchanged.

## Preview and source integrity

The renderer does not load `preview.src`, remote images, source HTML, scripts, or arbitrary catalog file paths. It renders a CSS token study from the validated palette, typography, and radius projection. Each selected preview is visibly labeled `Generated token study` and `This is a generated token study, not an original source screenshot.` The catalog credit is shown beside the preview.

Source buttons return the catalog URL through `onOpenSource`; they do not navigate from the renderer. Desktop maps that URL back to a trusted catalog item and invokes the host-owned open-source operation by theme ID.

`packages/themes/catalog/themes.json` contains 17 schema-version `1.0.0` presets backed by official design systems and curated public design collections. It is paired with 17 local SVG token studies and contains zero remote fallbacks. Every catalog entry explicitly identifies its preview as a BoxSpec-generated token study rather than a source screenshot. Per-source provenance and HTTP results are retained in `docs/evidence/theme-sources.md`.

The compatibility crawl reached 13 of 17 collection/source pages directly with HTTP 200. Four collection pages returned HTTP 403; three of their four linked original sites returned HTTP 200, while the Gusto original also returned HTTP 403. These access results are retained as crawl evidence rather than being rewritten as successful retrievals.

## Stable selectors

| Selector | Purpose |
| --- | --- |
| `theme-gallery-open` | Desktop-owned toolbar opener |
| `theme-gallery` | dialog root (`role="dialog"`, accessible name `Design themes`) |
| `theme-search` | search input |
| `theme-mode-filter` | mode control group |
| `theme-style-filter` | style select |
| `theme-card-${id}` | stable preset card control |
| `theme-source-${id}` | card source action |
| `theme-source-link` | selected preset source action |
| `theme-apply` | explicit apply action |
| `theme-close` | close action |

Cards expose `data-theme-id`, `data-selected="true|false"`, and `aria-pressed`. The selected theme is never inferred from hover state.

## Verification

Run from `apps/desktop`:

```text
node node_modules/typescript/bin/tsc --noEmit
```

Result on 2026-09-22: exit 0.

```text
npm run build
```

Result on 2026-09-22: exit 0; Vite 8.3.0 transformed 24 modules and produced the renderer bundle, then both Electron main and preload bundles completed through esbuild.

`git diff --check` for the component source and CSS: exit 0.

A focused source scan for image/iframe tags, `fetch`, `window.open`, `preview.src`, and `dangerouslySetInnerHTML` returned `NO_REMOTE_RENDERING_PRIMITIVES`.

Catalog/domain checks from `packages/themes`:

```text
npm run typecheck
npm test -- --run
```

Result on 2026-09-22 after final catalog wiring: both exit 0; 1 test file and 6 tests passed. An independent catalog audit found schema `1.0.0`, 17 items, 17 unique IDs, 17 resolvable local preview paths, zero missing generated-preview disclosures, and mode coverage of 12 light, 3 dark, and 2 mixed presets.

```text
node scripts/themes/validate-theme-catalog.mjs
```

Result on 2026-09-22: exit 0; the strict loader accepted 17 of 17 catalog entries, with 17 local previews, zero remote fallbacks, and 17 explicit source-screenshot disclaimers.

The final Playwright Electron campaign used:

```text
cd C:\Users\j\Downloads\BoxSpec_Production_Pack\BoxSpec_Production_Pack\tests\e2e
node node_modules/playwright/cli.js test --config playwright.config.ts
```

Result on 2026-09-22: exit 0, 7 of 7 tests passed in 76,983.18 ms; the gallery case passed in 16.7 seconds. The test proved Escape and reopen behavior, real text/mode/style filtering, card selection followed by explicit application, 1100 × 720 window containment, token and rendered computed-color changes, unchanged structure/geometry/locks, an external SDK context reread at revision 35, native save, and Electron relaunch persistence.

Artifacts under `tests/e2e/artifacts`:

| Artifact | SHA-256 |
| --- | --- |
| `screenshots/13-theme-gallery-filtered.png` | `0143CD0779E217C9F2413EC5C3DAC6E67DE3F9CADD97C254998A0F995CDE165D` |
| `screenshots/14-theme-applied.png` | `562F752FA2E1842BA5F9967A1BEB821B1BB46595A099D1EF055951EEF6CF6182` |
| `screenshots/15-theme-relaunch-persisted.png` | `7F45D07E3E6F3A2C70BAB5586D6B671FF27416EDBA475306CE47D3A7635AC6FB` |
| `mcp-theme-boxspec-get-context-result.json` | `967957893624183043B1941FEA134883CD62AFA27AE2C008C5CDB31B08A2E71B` |

The MCP result records context hash `2f061eafab39dca91d905d44aad8fc967519ae819bbc0f65e9bf0237a15af5c6` and persisted design system `theme_atlassian-teamwork` at design-system revision 2 with 11 tokens. The E2E owner produced and hashed these artifacts; this component task did not modify the artifact directory.
