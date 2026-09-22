import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseLayoutContract } from "../../packages/core/dist/index.js";
import {
  applyThemeToContract,
  applyThemeToDraft,
  loadThemeCatalog,
  parseThemePreset,
} from "../../packages/themes/dist/index.js";

const repoRoot = join(import.meta.dirname, "..", "..");

function preset() {
  return {
    schemaVersion: "1.0.0",
    id: "security_theme",
    name: "Security theme",
    summary: "A bounded presentation-only security fixture.",
    category: "security",
    styleTags: ["bounded"],
    mode: "dark",
    source: {
      collection: "Security fixtures",
      title: "Static reference",
      url: "https://example.invalid/reference",
      originalUrl: "https://example.invalid/original",
      retrievedAt: "2026-09-22T00:00:00.000Z",
      licenseNote: "Test fixture only.",
    },
    preview: { kind: "local", path: "catalog/previews/security.svg", alt: "Token study", credit: "Generated locally." },
    tokens: {
      "color.background": { type: "color", value: "#10131A" },
      "color.surface": { type: "color", value: "#1B202B" },
      "color.text": { type: "color", value: "#F5F7FA" },
      "color.accent": { type: "color", value: "#73E2A7" },
      "font.family.body": { type: "font-family", value: "Inter, system-ui, sans-serif" },
      "radius.medium": { type: "dimension", value: 10 },
    },
    palette: [{ hex: "#10131A", role: "background" }],
    typography: { displayHint: "Display sans", bodyHint: "UI sans" },
    interpretation: { density: "comfortable", radius: "moderate", shadow: "none", motion: "none", notes: [] },
  };
}

async function contract() {
  return parseLayoutContract(JSON.parse(await readFile(join(repoRoot, "examples", "dashboard.contract.json"), "utf8")));
}

function protectedProjection(value) {
  const { designSystem: _designSystem, revision: _revision, ...protectedValue } = value;
  return protectedValue;
}

test("theme application changes presentation tokens only and preserves geometry exactly", async () => {
  const before = await contract();
  const trusted = parseThemePreset(preset());
  const draft = applyThemeToDraft(before, trusted, { expectedContractRevision: before.revision });
  const approved = applyThemeToContract(before, trusted, { expectedRevision: before.revision });

  assert.deepEqual(protectedProjection(draft.contract), protectedProjection(before));
  assert.deepEqual(protectedProjection(approved.contract), protectedProjection(before));
  assert.equal(draft.contract.revision, before.revision);
  assert.equal(approved.contract.revision, before.revision + 1);
  assert.equal(before.designSystem.id, "ds_demo");
});

test("theme catalog rejects executable, remote-preview, traversal, layout, and CSS injection inputs", () => {
  const cases = [];
  const executableSource = structuredClone(preset()); executableSource.source.url = "javascript:alert(1)"; cases.push(executableSource);
  const credentialedSource = structuredClone(preset()); credentialedSource.source.url = "https://user:pass@example.invalid/"; cases.push(credentialedSource);
  const traversalPreview = structuredClone(preset()); traversalPreview.preview.path = "../outside.svg"; cases.push(traversalPreview);
  const htmlPreview = structuredClone(preset()); htmlPreview.preview.path = "catalog/previews/attack.html"; cases.push(htmlPreview);
  const layoutToken = structuredClone(preset()); layoutToken.tokens["spacing.page"] = { type: "dimension", value: 24 }; cases.push(layoutToken);
  const cssFont = structuredClone(preset()); cssFont.tokens["font.family.body"].value = "safe; background:url(javascript:alert(1))"; cases.push(cssFont);
  const unknownExecutableField = structuredClone(preset()); unknownExecutableField.source.html = "<script>alert(1)</script>"; cases.push(unknownExecutableField);

  for (const hostile of cases) assert.throws(() => parseThemePreset(hostile));
  assert.throws(() => loadThemeCatalog({ schemaVersion: "1.0.0", generatedAt: "2026-09-22T00:00:00.000Z", themes: [preset(), { ...preset(), id: "security_theme" }] }));
});
