import { canonicalJson } from "@boxspec/shared/hashing";
import type { JsonValue } from "@boxspec/shared/domain";
import type { DesignToken } from "@boxspec/shared/contracts";
import { loadThemeCatalog, parseThemePreset } from "./validation.js";
import type { ThemeCatalog, ThemeContext, ThemeGalleryItem, ThemePreset } from "./types.js";

function stringToken(tokens: Readonly<Record<string, DesignToken>>, name: string): string {
  const token = tokens[name];
  if (!token || (token.type !== "color" && token.type !== "font-family")) throw new TypeError(`Theme token '${name}' is unavailable`);
  return token.value;
}
function dimensionToken(tokens: Readonly<Record<string, DesignToken>>, name: string): number {
  const token = tokens[name];
  if (!token || token.type !== "dimension") throw new TypeError(`Theme token '${name}' is unavailable`);
  return token.value;
}
export function toThemeGalleryItem(input: ThemePreset): ThemeGalleryItem {
  const preset = parseThemePreset(input), border = preset.tokens["color.border"], display = preset.tokens["font.family.display"];
  return {
    id: preset.id, name: preset.name, description: preset.summary, mode: preset.mode, style: preset.category, tags: preset.styleTags,
    source: { name: `${preset.source.collection}: ${preset.source.title}`, url: preset.source.url, license: preset.source.licenseNote },
    preview: { kind: preset.preview.kind, src: preset.preview.kind === "local" ? preset.preview.path : preset.preview.url, alt: preset.preview.alt, credit: preset.preview.credit },
    palette: preset.palette, typography: { body: preset.typography.bodyHint, display: preset.typography.displayHint },
    tokens: {
      colors: {
        background: stringToken(preset.tokens, "color.background"), surface: stringToken(preset.tokens, "color.surface"), text: stringToken(preset.tokens, "color.text"), accent: stringToken(preset.tokens, "color.accent"),
        ...(border?.type === "color" ? { border: border.value } : {}),
      },
      fontFamily: stringToken(preset.tokens, "font.family.body"), ...(display?.type === "font-family" ? { headingFontFamily: display.value } : {}), radius: dimensionToken(preset.tokens, "radius.medium"),
    },
  };
}
export function createThemeContext(input: ThemePreset): ThemeContext {
  const preset = parseThemePreset(input);
  return { schemaVersion: "1.0.0", themeId: preset.id, name: preset.name, mode: preset.mode, styleTags: preset.styleTags, sourceUrl: preset.source.url, tokens: preset.tokens, interpretation: preset.interpretation };
}
export function serializeThemeCatalog(input: ThemeCatalog): string { return `${canonicalJson(loadThemeCatalog(input) as unknown as JsonValue)}\n`; }
export function serializeThemeContext(input: ThemePreset): string { return canonicalJson(createThemeContext(input) as unknown as JsonValue); }
