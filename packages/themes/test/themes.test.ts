import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLayoutContract } from "@boxspec/core";
import {
  ThemeError,
  applyThemeToContract,
  applyThemeToDraft,
  createThemeContext,
  getThemeCatalog,
  getThemeGallery,
  getThemePreset,
  loadThemeCatalog,
  parseThemePreset,
  serializeThemeCatalog,
  toThemeGalleryItem,
  type ThemePreset,
} from "../src/index.js";

function preset(id = "aurora_dark"): ThemePreset {
  return parseThemePreset({
    schemaVersion: "1.0.0", id, name: "Aurora Dark", summary: "High-contrast editorial dashboard interpretation.", category: "editorial-saas", styleTags: ["editorial", "high-contrast"], mode: "dark",
    source: { collection: "Curated Web", title: "Aurora reference", url: "https://example.com/collection/aurora", originalUrl: "https://example.org/aurora", retrievedAt: "2026-09-22T00:00:00.000Z", previewUrl: "https://example.com/preview.png", licenseNote: "Visual reference only; tokens are an original interpretation." },
    preview: { kind: "local", path: "catalog/previews/aurora.svg", alt: "Dark editorial dashboard token study", credit: "Original BoxSpec token study derived from the cited visual reference." },
    tokens: {
      "color.background": { type: "color", value: "#10131A" }, "color.surface": { type: "color", value: "#1B202B" }, "color.text": { type: "color", value: "#F5F7FA" }, "color.accent": { type: "color", value: "#73E2A7" }, "color.border": { type: "color", value: "#303847" },
      "font.family.body": { type: "font-family", value: "Inter, system-ui, sans-serif" }, "font.family.display": { type: "font-family", value: "Manrope, system-ui, sans-serif" }, "radius.medium": { type: "dimension", value: 10 }, "border.width": { type: "dimension", value: 1 },
    },
    palette: [{ hex: "#10131A", role: "background" }, { hex: "#73E2A7", role: "accent" }],
    typography: { displayHint: "Geometric display sans", bodyHint: "Neutral UI sans" },
    interpretation: { density: "comfortable", radius: "moderately rounded", shadow: "subtle layered", motion: "restrained", notes: ["Use borders before shadows."] },
  });
}
function contract() { return parseLayoutContract(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../examples/dashboard.contract.json"), "utf8"))); }
function catalog() { return { schemaVersion: "1.0.0", generatedAt: "2026-09-22T01:00:00.000Z", themes: [preset("z_theme"), preset("a_theme")] } as const; }

describe("theme catalog validation and gallery projection", () => {
  it("loads only the package-owned sourced catalog and resolves stable ids", () => {
    const trusted = getThemeCatalog();
    const gallery = getThemeGallery();
    expect(trusted.themes).toHaveLength(17);
    expect(gallery).toHaveLength(17);
    expect(trusted.themes.map((theme) => theme.id)).toEqual([...trusted.themes.map((theme) => theme.id)].sort());
    expect(getThemePreset(trusted.themes[0]!.id)).toBe(trusted.themes[0]);
    expect(new Set(trusted.themes.map((theme) => theme.source.originalUrl)).size).toBe(17);
    expect(trusted.themes.every((theme) => theme.preview.kind === "local")).toBe(true);
  });
  it("loads, sorts and serializes a sourced catalog deterministically", () => {
    const loaded = loadThemeCatalog(catalog());
    expect(loaded.themes.map((theme) => theme.id)).toEqual(["a_theme", "z_theme"]);
    expect(serializeThemeCatalog(loaded)).toBe(serializeThemeCatalog(loadThemeCatalog(JSON.parse(serializeThemeCatalog(loaded)))));
    const item = toThemeGalleryItem(loaded.themes[0]!);
    expect(item).toMatchObject({ id: "a_theme", mode: "dark", tokens: { colors: { background: "#10131A", accent: "#73E2A7" }, radius: 10 } });
    expect(item.preview.src).toBe("catalog/previews/aurora.svg");
    expect(createThemeContext(loaded.themes[0]!).sourceUrl).toBe("https://example.com/collection/aurora");
  });
  it("rejects layout tokens, unsafe sources, missing required tokens and unknown fields", () => {
    const base = structuredClone(preset()) as unknown as Record<string, unknown>;
    (base.tokens as Record<string, unknown>)["spacing.page"] = { type: "dimension", value: 24 };
    expect(() => parseThemePreset(base)).toThrowError(ThemeError);
    const unsafe = structuredClone(preset()) as unknown as Record<string, unknown>;
    (unsafe.source as Record<string, unknown>).url = "http://example.com";
    expect(() => parseThemePreset(unsafe)).toThrowError(ThemeError);
    const missing = structuredClone(preset()) as unknown as Record<string, unknown>;
    delete (missing.tokens as Record<string, unknown>)["color.accent"];
    expect(() => parseThemePreset(missing)).toThrowError(ThemeError);
    const extra = structuredClone(preset()) as unknown as Record<string, unknown>; extra.copiedCss = "*{}";
    expect(() => parseThemePreset(extra)).toThrowError(ThemeError);
  });
});

describe("safe theme application", () => {
  it("applies presentation tokens to a draft without changing contract revision or geometry", () => {
    const before = contract(), theme = preset();
    const result = applyThemeToDraft(before, theme, { expectedContractRevision: 1 });
    expect(result.contract.revision).toBe(1);
    expect(result.contract.designSystem).toMatchObject({ id: "theme_aurora_dark", revision: 2, tokens: { "color.background": { value: "#10131A" }, "spacing.page": { value: 24 } } });
    expect(result.contract.nodes).toEqual(before.nodes);
    expect(result.contract.breakpoints).toEqual(before.breakpoints);
    expect(result.contract.assertions).toEqual(before.assertions);
    expect(result.contract.defaultPolicy).toEqual(before.defaultPolicy);
    expect(result.beforeContractHash).not.toBe(result.afterContractHash);
    expect(before.designSystem.id).toBe("ds_demo");
  });
  it("increments an approved contract exactly once and rejects revision drift", () => {
    const before = contract(), theme = preset();
    const result = applyThemeToContract(before, theme, { expectedRevision: 1 });
    expect(result.contract.revision).toBe(2);
    expect(result.contractRevisionMode).toBe("incremented-contract");
    expect(() => applyThemeToContract(before, theme, { expectedRevision: 2 })).toThrowError(ThemeError);
    expect(() => applyThemeToDraft(before, theme, { expectedContractRevision: 2 })).toThrowError(ThemeError);
  });
  it("is deterministic and does not turn descriptive shadow or motion hints into tokens", () => {
    const before = contract(), theme = preset();
    const first = applyThemeToContract(before, theme, { expectedRevision: 1 });
    const second = applyThemeToContract(before, theme, { expectedRevision: 1 });
    expect(first).toEqual(second);
    expect(Object.keys(first.contract.designSystem.tokens).some((name) => name.startsWith("shadow.") || name.startsWith("motion."))).toBe(false);
  });
});
