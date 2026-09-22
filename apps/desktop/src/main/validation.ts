import type { DesktopResult } from "../common/ipc";

type Shape = Record<string, "string" | "number" | "object">;
type ValueFor<Kind> = Kind extends "string" ? string : Kind extends "number" ? number : Record<string, unknown>;
type InputFor<Definition extends Shape> = { [Key in keyof Definition]: ValueFor<Definition[Key]> };

export function validateInput<Definition extends Shape>(value: unknown, shape: Definition): DesktopResult<InputFor<Definition>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("Request must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(Object.keys(shape));
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) return invalid(`Unknown field: ${unknown}`);
  for (const [key, expected] of Object.entries(shape)) {
    const actual = record[key];
    if (typeof actual !== expected) return invalid(`${key} must be ${expected}.`);
    if (expected === "string" && ((actual as string).length === 0 || (actual as string).length > 4096)) {
      return invalid(`${key} has an invalid length.`);
    }
    if (expected === "number" && !Number.isFinite(actual)) return invalid(`${key} must be finite.`);
  }
  return { ok: true, data: record as InputFor<Definition> };
}

export interface RecoveryIpcInput {
  projectId: string;
  recovery: {
    transactionId: string;
    recoveryNonce: string;
    strategy: "finish-after" | "restore-before";
    unknownPathDecisions: Array<{ path: string; action: "preserve-current" | "finish-after" | "restore-before" }>;
  };
}

export function validateRecoveryInput(value: unknown): DesktopResult<RecoveryIpcInput> {
  if (!isExactRecord(value, ["projectId", "recovery"]) || !boundedString(value.projectId, 1, 128) || !isExactRecord(value.recovery, ["transactionId", "recoveryNonce", "strategy", "unknownPathDecisions"])) return invalid("Invalid recovery request shape.");
  const recovery = value.recovery;
  if (!boundedString(recovery.transactionId, 1, 128) || !boundedString(recovery.recoveryNonce, 1, 128) || !["finish-after", "restore-before"].includes(String(recovery.strategy)) || !Array.isArray(recovery.unknownPathDecisions) || recovery.unknownPathDecisions.length > 512) return invalid("Invalid recovery binding or strategy.");
  const paths = new Set<string>();
  const decisions: RecoveryIpcInput["recovery"]["unknownPathDecisions"] = [];
  let aggregatePathLength = 0;
  for (const item of recovery.unknownPathDecisions) {
    if (!isExactRecord(item, ["path", "action"]) || !boundedString(item.path, 1, 1024) || !["preserve-current", "finish-after", "restore-before"].includes(String(item.action)) || paths.has(item.path)) return invalid("Recovery decisions must have unique paths and known actions.");
    aggregatePathLength += item.path.length;
    if (aggregatePathLength > 65_536) return invalid("Recovery decision paths exceed the request limit.");
    paths.add(item.path);
    decisions.push({ path: item.path, action: item.action as RecoveryIpcInput["recovery"]["unknownPathDecisions"][number]["action"] });
  }
  return { ok: true, data: { projectId: value.projectId, recovery: { transactionId: recovery.transactionId, recoveryNonce: recovery.recoveryNonce, strategy: recovery.strategy as RecoveryIpcInput["recovery"]["strategy"], unknownPathDecisions: decisions } } };
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function invalid<T>(message: string): DesktopResult<T> {
  return { ok: false, error: { code: "INVALID_REQUEST", message, recoverable: true } };
}
