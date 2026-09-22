import { CoreError } from "./errors.js";
import type { Actor, CoreCommand, LayoutOverride } from "./model.js";
import { parseLayoutContract } from "./validation.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CoreError("SCHEMA_INVALID", `${label} must be an object`, {});
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new CoreError("SCHEMA_INVALID", `${label} contains unknown fields`, { fields: unknown });
}
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new CoreError("SCHEMA_INVALID", `${label} must be a non-empty string no longer than ${max}`, {});
  return value;
}
function id(value: unknown, label: string): string {
  const parsed = text(value, label, 96);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(parsed)) throw new CoreError("SCHEMA_INVALID", `${label} is not a valid BoxSpec id`, {});
  return parsed;
}
function actor(value: unknown): Actor {
  const input = record(value, "actor"); exactKeys(input, ["kind", "id"], "actor");
  if (input.kind !== "user" && input.kind !== "agent" && input.kind !== "system") throw new CoreError("SCHEMA_INVALID", "actor.kind is invalid", {});
  return { kind: input.kind, id: text(input.id, "actor.id", 256) };
}
function metadata(input: Record<string, unknown>) {
  const expectedRevision = input.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) throw new CoreError("SCHEMA_INVALID", "expectedRevision must be a positive safe integer", {});
  const timestamp = text(input.timestamp, "timestamp", 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new CoreError("SCHEMA_INVALID", "timestamp must be ISO-compatible", {});
  return { commandId: text(input.commandId, "commandId", 256), projectId: id(input.projectId, "projectId"), screenId: id(input.screenId, "screenId"), expectedRevision: expectedRevision as number, actor: actor(input.actor), timestamp };
}
function override(value: unknown): LayoutOverride {
  const input = record(value, "layout override"); exactKeys(input, ["nodeId", "path", "value"], "layout override");
  const path = text(input.path, "layout override path", 256);
  if (!path.startsWith("/layout/")) throw new CoreError("SCHEMA_INVALID", "layout override path must begin with /layout/", { path });
  if (input.value !== null && typeof input.value !== "string" && typeof input.value !== "number" && typeof input.value !== "boolean") throw new CoreError("SCHEMA_INVALID", "layout override value must be scalar", { path });
  if (typeof input.value === "number" && !Number.isFinite(input.value)) throw new CoreError("SCHEMA_INVALID", "layout override number must be finite", { path });
  return { nodeId: id(input.nodeId, "layout override nodeId"), path: path as `/layout/${string}`, value: input.value };
}
export function parseCoreCommand(value: unknown): CoreCommand {
  const input = record(value, "command");
  const common = ["type", "commandId", "projectId", "screenId", "expectedRevision", "actor", "timestamp"];
  const base = metadata(input);
  if (input.type === "replace-contract") {
    exactKeys(input, [...common, "contract"], "replace-contract command");
    return { type: "replace-contract", ...base, contract: parseLayoutContract(input.contract) };
  }
  if (input.type === "apply-layout-overrides") {
    exactKeys(input, [...common, "overrides"], "apply-layout-overrides command");
    if (!Array.isArray(input.overrides) || input.overrides.length === 0 || input.overrides.length > 1_000) throw new CoreError("SCHEMA_INVALID", "overrides must contain 1 to 1000 entries", {});
    return { type: "apply-layout-overrides", ...base, overrides: input.overrides.map(override) };
  }
  if (input.type === "rename-screen") {
    exactKeys(input, [...common, "name"], "rename-screen command");
    return { type: "rename-screen", ...base, name: text(input.name, "name", 256) };
  }
  throw new CoreError("SCHEMA_INVALID", "Unknown command type", { type: input.type });
}
