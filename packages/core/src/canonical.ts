import { createHash } from "node:crypto";
import { canonicalJson as sharedCanonicalJson, canonicalizeJson, compareOrdinal } from "@boxspec/shared/hashing";
import type { JsonValue } from "@boxspec/shared/domain";
import type { LayoutContract } from "./model.js";

export const ordinalCompare = compareOrdinal;
export function canonicalize<T>(value: T): T { return canonicalizeJson(value as unknown as JsonValue) as unknown as T; }
export function canonicalJson(value: unknown): string { return sharedCanonicalJson(value as JsonValue); }
export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function hashContract(contract: LayoutContract): string { return sha256(canonicalJson(contract)); }
export function cloneContract(contract: LayoutContract): LayoutContract { return JSON.parse(canonicalJson(contract)) as LayoutContract; }
