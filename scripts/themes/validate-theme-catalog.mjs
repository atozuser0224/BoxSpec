import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = resolve(root, "packages/themes/catalog/themes.json");
const catalog = JSON.parse(await readFile(file, "utf8"));
if (catalog.schemaVersion !== "1.0.0" || !Array.isArray(catalog.themes)) throw new Error("Invalid catalog wrapper");
if (catalog.themes.length < 12 || catalog.themes.length > 20) throw new Error("Expected 12 to 20 curated themes");

const requiredTokens = ["color.background", "color.surface", "color.text", "color.accent", "font.family.body", "radius.medium"];
const ids = new Set();
for (const [index, theme] of catalog.themes.entries()) {
  if (theme.schemaVersion !== "1.0.0") throw new Error("Invalid preset version at " + index);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(theme.id) || ids.has(theme.id)) throw new Error("Invalid or duplicate id: " + theme.id);
  ids.add(theme.id);
  if (theme.source.url.startsWith("https://") === false || theme.source.originalUrl.startsWith("https://") === false) throw new Error("Non-HTTPS source: " + theme.id);
  if (theme.preview.kind !== "local" || !/^catalog\/previews\/[A-Za-z0-9_-]+\.svg$/.test(theme.preview.path)) throw new Error("Invalid local preview: " + theme.id);
  if (!theme.preview.alt.includes("not a source screenshot")) throw new Error("Preview disclosure missing: " + theme.id);
  for (const token of requiredTokens) if (!(token in theme.tokens)) throw new Error("Missing " + token + " in " + theme.id);
  for (const token of Object.keys(theme.tokens)) if (!/^(color|font|radius|border)\./.test(token)) throw new Error("Unsupported token namespace: " + token);
  await access(resolve(root, "packages/themes", theme.preview.path));
  const svg = await readFile(resolve(root, "packages/themes", theme.preview.path), "utf8");
  if (!svg.startsWith("<svg ") || !svg.includes("<title") || !svg.includes("<desc")) throw new Error("Preview is not an accessible SVG: " + theme.id);
}

const sorted = [...ids].sort((a, b) => a.localeCompare(b));
if (JSON.stringify([...ids]) !== JSON.stringify(sorted)) throw new Error("Catalog themes are not deterministically sorted");
console.log(JSON.stringify({ valid: true, themes: ids.size, previews: ids.size, sources: ids.size }));
