import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../../contracts/mcp-tools.json");
const destination = resolve(here, "../contracts/mcp-tools.json");
const raw = await readFile(source, "utf8");
const parsed = JSON.parse(raw);

if (parsed.schemaVersion !== "1.0.0" || parsed.transport !== "stdio" || !Array.isArray(parsed.tools)) {
  throw new Error("contracts/mcp-tools.json is not a supported BoxSpec tool catalog");
}

const forbidden = new Set([
  "approve",
  "unlock",
  "apply_to_main",
  "run_shell",
  "delete_project",
  "read_secret"
]);
for (const tool of parsed.tools) {
  if (forbidden.has(tool?.name)) {
    throw new Error(`Unsafe MCP tool in source contract: ${tool.name}`);
  }
}

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, raw, "utf8");
