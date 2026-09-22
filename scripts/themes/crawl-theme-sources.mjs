import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const inputPath = resolve(root, process.argv[2] || "packages/themes/catalog/sources.json");
const outputPath = resolve(root, process.argv[3] || "packages/themes/catalog/source-snapshots.json");
const MAX_SOURCES = 24;
const MAX_BYTES = 600000;
const TIMEOUT_MS = 12000;
const CONCURRENCY = 3;
const USER_AGENT = "BoxSpecThemeCatalog/1.0 (+public metadata research; no authentication)";

const decode = (value) => value
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/\s+/g, " ")
  .trim();

function attr(tag, name) {
  const pattern = "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))";
  const match = tag.match(new RegExp(pattern, "i"));
  return decode((match && (match[1] || match[2] || match[3])) || "");
}

function meta(html, key, property) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const discriminator = attr(tag, property ? "property" : "name").toLowerCase();
    if (discriminator === key.toLowerCase()) return attr(tag, "content");
  }
  return "";
}

function metadata(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = decode(titleMatch ? titleMatch[1] : "");
  const description = meta(html, "description", false) || meta(html, "og:description", true);
  const ogTitle = meta(html, "og:title", true);
  const ogImage = meta(html, "og:image", true);
  return {
    title: (ogTitle || title).slice(0, 240),
    description: description.slice(0, 500),
    ogImage: ogImage.slice(0, 2048)
  };
}

async function readBoundedBody(response) {
  if (!response.body) return { html: "", truncated: false, bytesRead: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const value = result.value;
    const remaining = MAX_BYTES - bytesRead;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const chunk = value.subarray(0, remaining);
    chunks.push(chunk);
    bytesRead += chunk.byteLength;
    if (value.byteLength > remaining || bytesRead === MAX_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { html: new TextDecoder("utf-8", { fatal: false }).decode(all), truncated, bytesRead };
}

async function fetchMetadata(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol: " + parsed.protocol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(parsed, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9" }
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
      ? await readBoundedBody(response)
      : { html: "", truncated: false, bytesRead: 0 };
    return {
      requestedUrl: url,
      finalUrl: response.url,
      status: response.status,
      ok: response.ok,
      contentType,
      durationMs: Date.now() - started,
      bytesRead: body.bytesRead,
      truncated: body.truncated,
      ...metadata(body.html)
    };
  } catch (error) {
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 0,
      ok: false,
      contentType: "",
      durationMs: Date.now() - started,
      bytesRead: 0,
      truncated: false,
      title: "",
      description: "",
      ogImage: "",
      error: error instanceof Error ? error.name + ": " + error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

const config = JSON.parse(await readFile(inputPath, "utf8"));
if (!config || config.schemaVersion !== "1.0.0" || !Array.isArray(config.sources)) throw new Error("Unsupported source config");
if (config.sources.length === 0 || config.sources.length > MAX_SOURCES) throw new Error("Source count must be 1-" + MAX_SOURCES);
const ids = new Set();
for (const source of config.sources) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(source.id)) throw new Error("Invalid source id: " + source.id);
  if (ids.has(source.id)) throw new Error("Duplicate source id: " + source.id);
  ids.add(source.id);
  new URL(source.sourceUrl);
  new URL(source.originalUrl);
}

const capturedAt = new Date().toISOString();
const ordered = [...config.sources].sort((a, b) => a.id.localeCompare(b.id));
const snapshots = await mapLimited(ordered, CONCURRENCY, async (source) => ({
  id: source.id,
  collection: source.collection,
  source: await fetchMetadata(source.sourceUrl),
  original: source.originalUrl === source.sourceUrl
    ? { sameAsSource: true }
    : await fetchMetadata(source.originalUrl)
}));

const output = {
  schemaVersion: "1.0.0",
  capturedAt,
  limits: { maxSources: MAX_SOURCES, maxBytesPerResponse: MAX_BYTES, timeoutMs: TIMEOUT_MS, concurrency: CONCURRENCY },
  snapshots
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
for (const item of snapshots) {
  const originalStatus = item.original.sameAsSource ? "same" : item.original.status;
  console.log(item.id + "\tsource=" + item.source.status + "\toriginal=" + originalStatus);
}
console.log("wrote " + snapshots.length + " source records to " + outputPath);
