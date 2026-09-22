import { RuntimeError } from "./errors.js";

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

export function objectInput(value: unknown, label = "input"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; pattern?: RegExp; optional?: boolean } = {},
): string | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  if (value.length < (options.min ?? 0) || value.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw invalid(`${key} has an invalid length`);
  }
  if (options.pattern && !options.pattern.test(value)) throw invalid(`${key} has an invalid format`);
  return value;
}

export function idField(record: Record<string, unknown>, key: string): string {
  return stringField(record, key, { min: 1, max: 96, pattern: ID_PATTERN })!;
}

export function shaField(record: Record<string, unknown>, key: string): string {
  return stringField(record, key, { min: 64, max: 64, pattern: SHA_PATTERN })!;
}

export function integerField(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (!Number.isSafeInteger(value)) throw invalid(`${key} must be an integer`);
  const number = value as number;
  if (number < (options.min ?? Number.MIN_SAFE_INTEGER) || number > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw invalid(`${key} is out of range`);
  }
  return number;
}

export function stringArrayField(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; id?: boolean } = {},
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`${key} must be a string array`);
  }
  if (value.length < (options.min ?? 0) || value.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw invalid(`${key} has an invalid item count`);
  }
  if (options.id && value.some((item) => !ID_PATTERN.test(item))) throw invalid(`${key} contains an invalid ID`);
  return value;
}

export function enumField<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: Values,
): Values[number] {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) throw invalid(`${key} has an unsupported value`);
  return value as Values[number];
}

export function assertNoExtraFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(record).find((key) => !allowedSet.has(key));
  if (extra) throw invalid(`Unexpected field: ${extra}`);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RuntimeError("CANCELLED", "The request was cancelled", { recoverable: true });
}

function invalid(message: string): RuntimeError {
  return new RuntimeError("INVALID_REQUEST", message, { recoverable: false });
}
