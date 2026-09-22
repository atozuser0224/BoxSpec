import { readFileSync } from "node:fs";
import { SAFE_MCP_TOOL_NAMES } from "@boxspec/shared/runtime";
import type { ToolCatalog, ToolContract } from "./types.js";

export const SAFE_TOOL_NAMES = SAFE_MCP_TOOL_NAMES;

export const FORBIDDEN_TOOL_NAMES = [
  "approve",
  "unlock",
  "apply_to_main",
  "run_shell",
  "delete_project",
  "read_secret"
] as const;

const safeNames = new Set<string>(SAFE_TOOL_NAMES);
const forbiddenNames = new Set<string>(FORBIDDEN_TOOL_NAMES);

export function loadToolCatalog(url = new URL("../contracts/mcp-tools.json", import.meta.url)): ToolCatalog {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== "1.0.0" || parsed.transport !== "stdio") {
    throw new Error("Unsupported BoxSpec MCP tool catalog");
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.length !== SAFE_TOOL_NAMES.length) {
    throw new Error(`Expected exactly ${SAFE_TOOL_NAMES.length} safe MCP tools`);
  }

  const seen = new Set<string>();
  for (const candidate of parsed.tools) {
    if (!isToolContract(candidate)) {
      throw new Error("Malformed BoxSpec MCP tool contract");
    }
    if (!safeNames.has(candidate.name) || forbiddenNames.has(candidate.name) || seen.has(candidate.name)) {
      throw new Error(`Unexpected, forbidden, or duplicate MCP tool: ${candidate.name}`);
    }
    seen.add(candidate.name);
  }
  for (const name of SAFE_TOOL_NAMES) {
    if (!seen.has(name)) throw new Error(`Missing MCP tool contract: ${name}`);
  }
  return parsed as unknown as ToolCatalog;
}

function isToolContract(value: unknown): value is ToolContract {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    isRecord(value.annotations) &&
    typeof value.annotations.readOnlyHint === "boolean" &&
    typeof value.annotations.destructiveHint === "boolean" &&
    typeof value.annotations.idempotentHint === "boolean" &&
    typeof value.annotations.openWorldHint === "boolean"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
