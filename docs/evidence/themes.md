# Design themes evidence

## Result

`@boxspec/themes` provides a package-owned, read-only catalog of 17 source-grounded theme presets. The runtime resolves a renderer-supplied `ThemeId` with `getThemePreset`; the renderer cannot submit tokens or a catalog. `getThemeGallery` exposes the shared renderer projection, and `getThemeCatalog` exposes the frozen domain catalog for trusted main-process use.

Each preset records its collection page, original site, retrieval timestamp, license/provenance note, an original BoxSpec token interpretation, and a local generated token-study preview. The presets do not contain copied site CSS and do not claim exact third-party design-system fidelity.

## Safety properties

- Strict runtime parsing rejects unknown fields, non-HTTPS or credential-bearing sources, invalid IDs, unsafe preview paths, missing presentation tokens, and tokens outside `color.*`, `font.*`, `radius.*`, and `border.*`.
- The package-owned loader validates and freezes all entries and verifies each local preview exists before returning the catalog.
- `applyThemeToDraft` preserves the contract revision. `applyThemeToContract` checks the expected revision and advances it once.
- Both application paths replace only presentation tokens and design-system identity/revision. They validate the resulting layout contract and compare a canonical protected projection, covering node IDs, topology, geometry, breakpoints, policies, assertions, verification, fixtures, and other contract fields.
- Existing non-theme tokens, such as spacing, remain unchanged. Descriptive shadow and motion observations are not converted into unsupported tokens.
- Catalog and application ordering use the shared ordinal comparator and canonical JSON/hash implementation.

## Public API

```ts
getThemeCatalog(): ThemeCatalog
getThemePreset(themeId: ThemeId): ThemePreset
getThemeGallery(): readonly ThemeGalleryItem[]
applyThemeToDraft(contract, preset, { expectedContractRevision }): ThemeApplicationResult
applyThemeToContract(contract, preset, { expectedRevision }): ThemeApplicationResult
createThemeContext(preset): ThemeContext
```

The live-draft store must separately compare and increment its external `draftRevision`; the shared runtime port carries `expectedDraftRevision` for that guard.

## Verification

- `node packages/themes/node_modules/typescript/bin/tsc -p packages/themes/tsconfig.json --noEmit --composite false` — exit 0.
- `node packages/themes/node_modules/vitest/vitest.mjs run packages/themes/test` — exit 0, 1 file and 6/6 tests passed.
- `node packages/themes/node_modules/typescript/bin/tsc -p packages/themes/tsconfig.json` — exit 0.
- `node packages/runtime/node_modules/typescript/bin/tsc -p packages/runtime/tsconfig.json --noEmit --composite false` — exit 0 with the trusted catalog/list/apply imports.
- Dist-level Node smoke imported `@boxspec/themes` output, loaded 17 catalog/gallery entries, resolved `atlassian-teamwork`, applied it to `examples/dashboard.contract.json`, advanced revision 1 to 2, and confirmed nodes, default policy, and breakpoints were unchanged — exit 0.
- Catalog generation by the compatibility owner: `node scripts/themes/build-theme-catalog.mjs` — exit 0, 17 themes and 17 local SVG previews.

The tests cover deterministic catalog serialization and ordering, package-owned lookup, strict negative validation, geometry/policy preservation, draft versus approved revision behavior, stale revision rejection, deterministic output, and exclusion of unsupported shadow/motion tokens.

## Limits

Core persists these tokens in `LayoutContract.designSystem` and exposes them to trusted implementation context. The current deterministic React shell compiler does not turn all design tokens into finished product CSS, so visual implementation still depends on the implementation agent and application renderer. The gallery renders the token studies from validated token data and labels their provenance.
