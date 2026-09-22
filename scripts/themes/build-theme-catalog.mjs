import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const catalogDir = resolve(root, "packages/themes/catalog");
const previewsDir = resolve(catalogDir, "previews");
const sources = JSON.parse(await readFile(resolve(catalogDir, "sources.json"), "utf8"));
const crawl = JSON.parse(await readFile(resolve(catalogDir, "source-snapshots.json"), "utf8"));

const curated = [
  ["atlassian-teamwork", "Atlassian Teamwork", "A clear collaboration workspace with familiar enterprise blue and strong information hierarchy.", "collaboration", ["enterprise", "dashboard", "collaboration", "light"], "light", "Atlassian Design", "#F7F8F9", "#FFFFFF", "#172B4D", "#0C66E4", "#B6C2CF", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 8, "comfortable", "layered cards", "brief easing"],
  ["bausola-visible-grid", "Bausola Visible Grid", "A high-contrast product showcase with an exposed grid and sharp industrial geometry.", "product showcase", ["dark", "industrial", "visible-grid", "product"], "dark", "Bausola Banch", "#11110F", "#1B1A17", "#F4F0E8", "#C8FF45", "#4A4941", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 0, "spacious", "flat grid", "scroll-led"],
  ["carbon-productive", "Carbon Productive", "A dense, disciplined workspace for data-heavy enterprise tools.", "data workspace", ["enterprise", "data", "productive", "light"], "light", "Carbon Design System", "#F4F4F4", "#FFFFFF", "#161616", "#0F62FE", "#C6C6C6", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 0, "compact", "flat panels", "direct"],
  ["darusim-beige-pixel", "Daru Beige Pixel", "A warm portfolio study with restrained pixel accents and tactile editorial color.", "portfolio", ["beige", "pixel", "minimal", "playful"], "light", "Daru Sim", "#F1E7D6", "#FFF8EC", "#25231F", "#D85D3A", "#3F3B34", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 4, "comfortable", "outlined cards", "playful reveal"],
  ["decimals-pastel-editorial", "Decimals Pastel Editorial", "A soft hiring marketplace direction combining pastel surfaces with an editorial display voice.", "marketplace", ["pastel", "editorial", "serif", "saas"], "light", "Decimals", "#F9F4FF", "#FFFFFF", "#28223A", "#8D63FF", "#D8C9F3", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 18, "comfortable", "soft cards", "gentle"],
  ["fluent-calm-productivity", "Fluent Calm Productivity", "A calm, polished productivity shell shaped for cross-platform work.", "productivity", ["enterprise", "calm", "productivity", "light"], "light", "Fluent 2 Design System", "#F5F5F5", "#FFFFFF", "#242424", "#0F6CBD", "#D1D1D1", "'Segoe UI', system-ui, sans-serif", 8, "comfortable", "subtle elevation", "fluid"],
  ["govuk-service-clarity", "GOV.UK Service Clarity", "A direct, accessible service interface for forms, guidance, and high-trust tasks.", "public service", ["accessible", "forms", "public-service", "light"], "light", "GOV.UK Design System", "#F3F2F1", "#FFFFFF", "#0B0C0C", "#1D70B8", "#B1B4B6", "Arial, system-ui, sans-serif", 0, "compact", "flat sections", "minimal"],
  ["gusto-warm-people", "Gusto Warm People", "A friendly business-product direction with warm neutrals, red accents, and generous curves.", "people operations", ["warm", "friendly", "business", "saas"], "light", "Gusto", "#FBF7F2", "#FFFFFF", "#2F2A27", "#F45D48", "#E5D8CD", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 16, "comfortable", "soft cards", "friendly"],
  ["mainframe-dark-bento", "Mainframe Dark Bento", "A compact dark SaaS presentation with luminous accents and modular bento panels.", "saas", ["dark", "bento", "minimal", "saas"], "dark", "Mainframe", "#0B0D10", "#12151A", "#F6F7F9", "#8DE9FF", "#2C323B", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 12, "compact", "dark elevation", "recap reveal"],
  ["material-expressive", "Material Expressive", "A rounded, high-energy consumer interface with clear tonal surfaces.", "consumer app", ["expressive", "rounded", "consumer", "light"], "light", "Material Design 3", "#FFFBFE", "#F3EDF7", "#1D1B20", "#6750A4", "#CAC4D0", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 16, "comfortable", "tonal elevation", "expressive"],
  ["notanotherbill-photo-shop", "Not Another Bill Photo Shop", "A photo-first commerce study using editorial whitespace and a restrained blue accent.", "commerce", ["ecommerce", "photography", "editorial", "minimal"], "light", "Not Another Bill", "#F6F7F8", "#FFFFFF", "#1B1B1B", "#2779A7", "#9C9C9C", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 2, "spacious", "flat imagery", "gallery fade"],
  ["polaris-merchant-utility", "Polaris Merchant Utility", "A practical merchant admin surface with compact controls and clear action emphasis.", "commerce admin", ["commerce", "admin", "utility", "light"], "light", "Polaris References", "#F7F7F7", "#FFFFFF", "#303030", "#005BD3", "#E3E3E3", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 8, "compact", "subtle cards", "direct"],
  ["primer-developer-workbench", "Primer Developer Workbench", "A developer-focused workspace with crisp borders, dense tables, and familiar link blue.", "developer tools", ["developer", "workbench", "data", "light"], "light", "Primer", "#F6F8FA", "#FFFFFF", "#1F2328", "#0969DA", "#D0D7DE", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 6, "compact", "bordered panels", "brief"],
  ["selfaware-playful-brutal", "Self Aware Playful Brutal", "A bold studio portfolio direction with cream canvas, black rules, and playful scale shifts.", "studio portfolio", ["brutalist", "playful", "studio", "high-contrast"], "mixed", "Self Aware", "#FAF6EB", "#FFFDF7", "#000000", "#000000", "#000000", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 0, "spacious", "hard outlines", "microinteraction-led"],
  ["spectrum-creative-neutral", "Spectrum Creative Neutral", "A neutral creative-tool surface designed to keep content and controls legible.", "creative tools", ["creative", "neutral", "professional", "light"], "light", "Adobe Spectrum", "#F8F8F8", "#FFFFFF", "#2C2C2C", "#1473E6", "#D5D5D5", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 6, "compact", "subtle elevation", "responsive"],
  ["voidzero-mono-spectrum", "VoidZero Mono Spectrum", "A developer-tool direction with near-black surfaces, monospaced rhythm, and a hot orange signal.", "developer tools", ["developer", "monospace", "dark", "spectrum"], "mixed", "void(0)", "#060606", "#111111", "#F4F4F4", "#FF5D01", "#343434", "ui-monospace, 'Cascadia Code', Consolas, monospace", 4, "compact", "outlined panels", "fast"],
  ["weave-data-intelligence", "Weave Data Intelligence", "A dark data-intelligence dashboard with precise metrics and a luminous success accent.", "data dashboard", ["dark", "data", "ai", "dashboard"], "dark", "Weave", "#0E1117", "#161B22", "#F0F6FC", "#7CFFB2", "#30363D", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 10, "compact", "layered panels", "metric reveal"]
];

const sourceById = new Map(sources.sources.map((item) => [item.id, item]));
const snapshotById = new Map(crawl.snapshots.map((item) => [item.id, item]));
const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function previewUrl(snapshot) {
  const item = snapshot.source.ok ? snapshot.source : snapshot.original;
  if (!item || !item.ok || !item.ogImage) return undefined;
  try { return new URL(item.ogImage, item.finalUrl).href; } catch { return undefined; }
}

function previewSvg(theme) {
  const p = theme.palette.map((item) => item.hex);
  const dark = theme.mode === "dark" || theme.mode === "mixed";
  const muted = dark ? "#A8B0BC" : "#667085";
  const panel = p[1];
  const line = p[4];
  const accent = p[3];
  const radius = theme.tokens["radius.medium"].value;
  const title = escapeXml(theme.name);
  const tags = escapeXml(theme.styleTags.slice(0, 3).join(" · "));
  const isEditorial = theme.category === "commerce" || theme.category === "portfolio" || theme.category === "studio portfolio" || theme.category === "marketplace" || theme.category === "product showcase";
  const content = isEditorial
    ? '<rect x="34" y="106" width="242" height="158" rx="' + radius + '" fill="' + accent + '" opacity="0.18"/><rect x="294" y="106" width="232" height="72" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><rect x="294" y="192" width="232" height="72" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><path d="M54 232 L120 146 L170 207 L220 135 L256 232 Z" fill="' + accent + '" opacity="0.82"/>'
    : '<rect x="34" y="106" width="150" height="158" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><rect x="198" y="106" width="328" height="74" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><rect x="198" y="194" width="154" height="70" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><rect x="366" y="194" width="160" height="70" rx="' + radius + '" fill="' + panel + '" stroke="' + line + '"/><path d="M222 156 L258 138 L296 148 L334 123 L376 142 L418 119 L496 151" fill="none" stroke="' + accent + '" stroke-width="5"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320" viewBox="0 0 560 320" role="img" aria-labelledby="title desc"><title id="title">' + title + ' token study</title><desc id="desc">BoxSpec-generated preview, not a source screenshot.</desc><rect width="560" height="320" rx="20" fill="' + p[0] + '"/><rect x="20" y="20" width="520" height="280" rx="16" fill="' + p[0] + '" stroke="' + line + '"/><circle cx="42" cy="44" r="6" fill="' + accent + '"/><text x="58" y="50" fill="' + p[2] + '" font-family="system-ui, sans-serif" font-size="16" font-weight="700">' + title + '</text><text x="34" y="87" fill="' + muted + '" font-family="system-ui, sans-serif" font-size="12">' + tags + '</text>' + content + '<rect x="34" y="282" width="46" height="6" rx="3" fill="' + p[2] + '"/><rect x="88" y="282" width="46" height="6" rx="3" fill="' + accent + '"/><text x="526" y="288" text-anchor="end" fill="' + muted + '" font-family="system-ui, sans-serif" font-size="10">GENERATED STUDY</text></svg>';
}

const themes = curated.map((row) => {
  const [id, name, summary, category, styleTags, mode, title, background, surface, text, accent, border, font, radius, density, shadow, motion] = row;
  const source = sourceById.get(id);
  const snapshot = snapshotById.get(id);
  if (!source || !snapshot) throw new Error("Missing source evidence for " + id);
  const image = previewUrl(snapshot);
  const licenseNote = source.collection === "Official design system"
    ? "Official reference documentation terms apply. This is an original reduced BoxSpec token interpretation; no components, source code, fonts, or brand assets are copied."
    : "Reference only. Source screenshots and brand assets remain copyright of their respective owners. This is an original BoxSpec token interpretation, not the source design system.";
  return {
    schemaVersion: "1.0.0",
    id,
    name,
    summary,
    category,
    styleTags,
    mode,
    source: {
      collection: source.collection,
      title,
      url: source.sourceUrl,
      originalUrl: source.originalUrl,
      retrievedAt: crawl.capturedAt,
      ...(image ? { previewUrl: image } : {}),
      licenseNote
    },
    preview: {
      kind: "local",
      path: "catalog/previews/" + id + ".svg",
      alt: "BoxSpec-generated token study for " + name + "; not a source screenshot.",
      credit: "Original BoxSpec token study derived from public metadata; source linked separately."
    },
    tokens: {
      "color.background": { type: "color", value: background },
      "color.surface": { type: "color", value: surface },
      "color.text": { type: "color", value: text },
      "color.accent": { type: "color", value: accent },
      "color.border": { type: "color", value: border },
      "font.family.body": { type: "font-family", value: font },
      "font.family.display": { type: "font-family", value: font },
      "radius.medium": { type: "dimension", value: radius },
      "border.width": { type: "dimension", value: 1 }
    },
    palette: [
      { hex: background, role: "background" },
      { hex: surface, role: "surface" },
      { hex: text, role: "text" },
      { hex: accent, role: "accent" },
      { hex: border, role: "border" }
    ],
    typography: {
      displayHint: id.includes("decimals") ? "Editorial serif contrast" : id.includes("voidzero") ? "Monospaced technical display" : "System-safe display hierarchy",
      bodyHint: "System-safe UI text; source font names are descriptive hints only"
    },
    interpretation: {
      density,
      radius: radius === 0 ? "square" : radius >= 16 ? "generously rounded" : radius >= 8 ? "moderately rounded" : "subtle",
      shadow,
      motion,
      notes: [
        "Inspired by a public reference; this is not an exact copy, endorsement, or claim of source-system fidelity.",
        "Palette and radius are BoxSpec-authored interpretations for a safe local token demo.",
        "Spacing, layout, shadows, and motion remain descriptive and are not applied as design tokens."
      ]
    }
  };
}).sort((a, b) => a.id.localeCompare(b.id));

const ids = new Set();
for (const theme of themes) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(theme.id)) throw new Error("Invalid theme id: " + theme.id);
  if (ids.has(theme.id)) throw new Error("Duplicate theme id: " + theme.id);
  ids.add(theme.id);
  for (const key of Object.keys(theme.tokens)) {
    if (!/^(color|font|radius|border)\./.test(key)) throw new Error("Unsupported token: " + key);
  }
}
if (ids.size !== sources.sources.length) throw new Error("Curated/source count mismatch");

await mkdir(previewsDir, { recursive: true });
for (const theme of themes) await writeFile(resolve(previewsDir, theme.id + ".svg"), previewSvg(theme) + "\n", "utf8");
const catalog = { schemaVersion: "1.0.0", generatedAt: crawl.capturedAt, themes };
await writeFile(resolve(catalogDir, "themes.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ themes: themes.length, previews: themes.length, generatedAt: catalog.generatedAt }));
