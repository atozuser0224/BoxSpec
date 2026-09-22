import type { ContentAddressedFile, JsonValue, Sha256 } from "./domain.js";

/** Fixed UTF-16 code-unit ordering. Never substitute localeCompare for hashed data. */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON cannot contain a non-finite number");
  }
  if (Object.is(value, -0)) return 0;
  return Number(value.toFixed(3));
}

/**
 * BoxSpec canonical JSON v1: keys use ordinal ordering, numbers use at most three
 * decimal places, array order is preserved, and strings are not locale-normalized.
 */
export function canonicalizeJson(value: JsonValue): JsonValue {
  if (typeof value === "number") return normalizeNumber(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));

  const source = value as Readonly<Record<string, JsonValue>>;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(source).sort(compareOrdinal)) {
    const entry = source[key];
    if (entry === undefined) {
      throw new TypeError(`Canonical JSON cannot contain undefined at key ${key}`);
    }
    result[key] = canonicalizeJson(entry);
  }
  return result;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Sha256> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256;
}

export async function hashCanonicalJson(value: JsonValue): Promise<Sha256> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

/** Hashes a complete source manifest. The caller must validate and normalize paths first. */
export async function hashSourceManifest(files: readonly ContentAddressedFile[]): Promise<Sha256> {
  const sorted = [...files].sort((left, right) => compareOrdinal(left.path, right.path));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.path === sorted[index]?.path) {
      throw new TypeError(`Duplicate manifest path: ${sorted[index]?.path}`);
    }
  }
  return hashCanonicalJson(sorted as unknown as JsonValue);
}
