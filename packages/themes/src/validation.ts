import type { DesignToken } from "@boxspec/shared/contracts";
import type { ThemeId } from "@boxspec/shared/domain";
import { compareOrdinal } from "@boxspec/shared/hashing";
import { ThemeError } from "./errors.js";
import type { ThemeCatalog, ThemeMode, ThemePreset, ThemePreview, ThemeSource } from "./types.js";

function fail(path: string, code: string, message: string): never { throw new ThemeError("THEME_CATALOG_INVALID", "Theme catalog validation failed", [{ path, code, message }]); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "OBJECT_REQUIRED", "Expected an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of required) if (!(key in value)) fail(`${path}/${key}`, "REQUIRED", "Required field is missing");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}/${key}`, "UNKNOWN_FIELD", "Unknown field is not allowed");
}
function string(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) fail(path, "STRING_INVALID", `Expected a non-empty string no longer than ${maximum}`);
  return value;
}
function id(value: unknown, path: string): ThemeId {
  const result = string(value, path, 80);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(result)) fail(path, "ID_INVALID", "Theme id must start with a letter and contain only letters, numbers, underscore, or hyphen");
  return result as ThemeId;
}
function httpsUrl(value: unknown, path: string): string {
  const result = string(value, path, 2048);
  let parsed: URL;
  try { parsed = new URL(result); } catch { return fail(path, "URL_INVALID", "Expected an absolute HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail(path, "URL_INVALID", "Only credential-free HTTPS URLs are allowed");
  return parsed.toString();
}
function timestamp(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) fail(path, "TIMESTAMP_INVALID", "Expected an ISO timestamp");
  return result;
}
function strings(value: unknown, path: string, minimum: number, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(path, "ARRAY_INVALID", `Expected ${minimum} to ${maximum} entries`);
  const result = value.map((item, index) => string(item, `${path}/${index}`, 128));
  if (new Set(result).size !== result.length) fail(path, "ARRAY_DUPLICATE", "Duplicate values are not allowed");
  return result;
}
function mode(value: unknown, path: string): ThemeMode {
  if (value !== "light" && value !== "dark" && value !== "mixed") fail(path, "MODE_INVALID", "Mode must be light, dark, or mixed");
  return value;
}
function source(value: unknown, path: string): ThemeSource {
  const input = object(value, path);
  exact(input, ["collection", "title", "url", "originalUrl", "retrievedAt", "licenseNote"], ["previewUrl"], path);
  const previewUrl = input.previewUrl === undefined ? undefined : httpsUrl(input.previewUrl, `${path}/previewUrl`);
  return {
    collection: string(input.collection, `${path}/collection`, 128),
    title: string(input.title, `${path}/title`, 256),
    url: httpsUrl(input.url, `${path}/url`),
    originalUrl: httpsUrl(input.originalUrl, `${path}/originalUrl`),
    retrievedAt: timestamp(input.retrievedAt, `${path}/retrievedAt`),
    ...(previewUrl ? { previewUrl } : {}),
    licenseNote: string(input.licenseNote, `${path}/licenseNote`, 512),
  };
}
function localPath(value: unknown, path: string): string {
  const result = string(value, path, 512);
  if (result.includes("\\") || result.startsWith("/") || /^[A-Za-z]:/.test(result) || result.split("/").some((part) => part === "" || part === "." || part === "..")) fail(path, "PREVIEW_PATH_INVALID", "Preview path must be a normalized relative path");
  if (!/\.(?:svg|png|jpe?g|webp)$/i.test(result)) fail(path, "PREVIEW_PATH_INVALID", "Preview must use an approved image extension");
  return result;
}
function preview(value: unknown, path: string): ThemePreview {
  const input = object(value, path);
  if (input.kind === "local") {
    exact(input, ["kind", "path", "alt", "credit"], [], path);
    return { kind: "local", path: localPath(input.path, `${path}/path`), alt: string(input.alt, `${path}/alt`, 256), credit: string(input.credit, `${path}/credit`, 512) };
  }
  if (input.kind === "remote-fallback") {
    exact(input, ["kind", "url", "alt", "credit"], [], path);
    return { kind: "remote-fallback", url: httpsUrl(input.url, `${path}/url`), alt: string(input.alt, `${path}/alt`, 256), credit: string(input.credit, `${path}/credit`, 512) };
  }
  return fail(`${path}/kind`, "PREVIEW_KIND_INVALID", "Preview kind must be local or remote-fallback");
}
function token(value: unknown, path: string, tokenName: string): DesignToken {
  const input = object(value, path);
  exact(input, ["type", "value"], [], path);
  if (tokenName.startsWith("color.")) {
    if (input.type !== "color" || typeof input.value !== "string" || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(input.value)) fail(path, "COLOR_TOKEN_INVALID", "Color tokens require a 6 or 8 digit hex color");
    return { type: "color", value: input.value.toUpperCase() };
  }
  if (tokenName.startsWith("font.")) {
    if (input.type !== "font-family" || typeof input.value !== "string" || input.value.length === 0 || input.value.length > 256 || /[;{}<>\r\n]/.test(input.value)) fail(path, "FONT_TOKEN_INVALID", "Font tokens require a safe font-family hint");
    return { type: "font-family", value: input.value };
  }
  if (tokenName.startsWith("radius.") || tokenName.startsWith("border.")) {
    if (input.type !== "dimension" || typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0 || input.value > 64) fail(path, "DIMENSION_TOKEN_INVALID", "Radius and border tokens require a dimension between 0 and 64");
    return { type: "dimension", value: input.value };
  }
  return fail(path, "TOKEN_SCOPE_INVALID", "Only color.*, font.*, radius.*, and border.* presentation tokens are allowed");
}
function tokens(value: unknown, path: string): Readonly<Record<string, DesignToken>> {
  const input = object(value, path), names = Object.keys(input).sort(compareOrdinal);
  if (names.length === 0 || names.length > 64) fail(path, "TOKEN_COUNT_INVALID", "Expected 1 to 64 presentation tokens");
  const result: Record<string, DesignToken> = {};
  for (const name of names) {
    if (!/^(?:color|font|radius|border)\.[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(name)) fail(`${path}/${name}`, "TOKEN_NAME_INVALID", "Token name is outside the presentation namespace");
    result[name] = token(input[name], `${path}/${name}`, name);
  }
  for (const required of ["color.background", "color.surface", "color.text", "color.accent", "font.family.body", "radius.medium"]) if (!(required in result)) fail(`${path}/${required}`, "TOKEN_REQUIRED", "Required gallery/application token is missing");
  return result;
}
function palette(value: unknown, path: string): ThemePreset["palette"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) fail(path, "PALETTE_INVALID", "Palette must contain 1 to 16 entries");
  return value.map((item, index) => {
    const entry = object(item, `${path}/${index}`); exact(entry, ["hex", "role"], [], `${path}/${index}`);
    if (typeof entry.hex !== "string" || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(entry.hex)) fail(`${path}/${index}/hex`, "PALETTE_COLOR_INVALID", "Palette colors must be hex values");
    return { hex: entry.hex.toUpperCase(), role: string(entry.role, `${path}/${index}/role`, 128) };
  });
}
function preset(value: unknown, path: string): ThemePreset {
  const input = object(value, path);
  exact(input, ["schemaVersion", "id", "name", "summary", "category", "styleTags", "mode", "source", "preview", "tokens", "palette", "typography", "interpretation"], [], path);
  if (input.schemaVersion !== "1.0.0") fail(`${path}/schemaVersion`, "VERSION_UNSUPPORTED", "Theme preset schemaVersion must be 1.0.0");
  const type = object(input.typography, `${path}/typography`); exact(type, ["displayHint", "bodyHint"], [], `${path}/typography`);
  const interpretation = object(input.interpretation, `${path}/interpretation`); exact(interpretation, ["density", "radius", "shadow", "motion", "notes"], [], `${path}/interpretation`);
  return {
    schemaVersion: "1.0.0", id: id(input.id, `${path}/id`), name: string(input.name, `${path}/name`, 128), summary: string(input.summary, `${path}/summary`, 512),
    category: string(input.category, `${path}/category`, 128), styleTags: strings(input.styleTags, `${path}/styleTags`, 1, 16), mode: mode(input.mode, `${path}/mode`),
    source: source(input.source, `${path}/source`), preview: preview(input.preview, `${path}/preview`), tokens: tokens(input.tokens, `${path}/tokens`), palette: palette(input.palette, `${path}/palette`),
    typography: { displayHint: string(type.displayHint, `${path}/typography/displayHint`, 256), bodyHint: string(type.bodyHint, `${path}/typography/bodyHint`, 256) },
    interpretation: { density: string(interpretation.density, `${path}/interpretation/density`, 128), radius: string(interpretation.radius, `${path}/interpretation/radius`, 128), shadow: string(interpretation.shadow, `${path}/interpretation/shadow`, 128), motion: string(interpretation.motion, `${path}/interpretation/motion`, 128), notes: strings(interpretation.notes, `${path}/interpretation/notes`, 0, 16) },
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) freeze(item); Object.freeze(value); }
  return value;
}
export function parseThemePreset(input: unknown): ThemePreset { return freeze(preset(input, "/theme")); }
export function loadThemeCatalog(input: unknown): ThemeCatalog {
  const value = object(input, "/"); exact(value, ["schemaVersion", "generatedAt", "themes"], [], "/");
  if (value.schemaVersion !== "1.0.0") fail("/schemaVersion", "VERSION_UNSUPPORTED", "Theme catalog schemaVersion must be 1.0.0");
  if (!Array.isArray(value.themes) || value.themes.length === 0 || value.themes.length > 500) fail("/themes", "THEME_COUNT_INVALID", "Catalog must contain 1 to 500 themes");
  const themes = value.themes.map((item, index) => preset(item, `/themes/${index}`)).sort((a, b) => compareOrdinal(a.id, b.id));
  if (new Set(themes.map((theme) => theme.id)).size !== themes.length) fail("/themes", "THEME_ID_DUPLICATE", "Theme ids must be unique");
  return freeze({ schemaVersion: "1.0.0", generatedAt: timestamp(value.generatedAt, "/generatedAt"), themes });
}
export function findThemePreset(catalog: ThemeCatalog, themeId: ThemeId): ThemePreset {
  const found = catalog.themes.find((theme) => theme.id === themeId);
  if (!found) throw new ThemeError("THEME_NOT_FOUND", `Theme '${themeId}' is not in the trusted catalog`, [{ path: "/themeId", code: "NOT_FOUND", message: "Unknown theme id" }]);
  return found;
}
