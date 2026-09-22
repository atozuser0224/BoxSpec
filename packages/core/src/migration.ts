import { existsSync, readFileSync } from "node:fs";
import { canonicalJson, hashContract, ordinalCompare, sha256 } from "./canonical.js";
import { CoreError } from "./errors.js";
import { atomicWriteBytes, readContractFile } from "./io.js";
import type { LayoutContract } from "./model.js";
import { parseLayoutContract } from "./validation.js";

export const SUPPORTED_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export interface ReadOnlyContractDocument {
  readonly status: "read-only";
  readonly schemaVersion: string;
  readonly reason: "unsupported-schema-version";
  readonly document: Readonly<Record<string, unknown>>;
}
export type InspectedContractDocument = { readonly status: "supported"; readonly contract: LayoutContract } | ReadOnlyContractDocument;
export interface ContractMigration {
  readonly from: string;
  readonly to: string;
  migrate(document: Readonly<Record<string, unknown>>): unknown;
}
export interface MigrationFileResult { readonly path: string; readonly backupPath: string; readonly fromVersion: string; readonly toVersion: "1.0.0"; readonly contract: LayoutContract; readonly contractHash: string }

function jsonDocument(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CoreError("SCHEMA_INVALID", "Contract document must be a JSON object", {});
  const version = (value as Record<string, unknown>).schemaVersion;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new CoreError("SCHEMA_INVALID", "Contract schemaVersion must be a semantic version string", { schemaVersion: version });
  return value as Readonly<Record<string, unknown>>;
}
function cloneExactJsonValue(value: unknown, path: string, seen: WeakSet<object>, sortKeys: boolean): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CoreError("SCHEMA_INVALID", "JSON document contains a non-finite number", { path });
    return value;
  }
  if (typeof value !== "object") throw new CoreError("SCHEMA_INVALID", "JSON document contains a non-JSON value", { path, type: typeof value });
  if (seen.has(value)) throw new CoreError("SCHEMA_INVALID", "JSON document contains a cycle or repeated object reference", { path });
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry, index) => cloneExactJsonValue(entry, `${path}/${index}`, seen, sortKeys));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CoreError("SCHEMA_INVALID", "JSON document contains a non-plain object", { path });
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new CoreError("SCHEMA_INVALID", "JSON document contains symbol keys", { path });
  const keys = Object.getOwnPropertyNames(value);
  if (sortKeys) keys.sort(ordinalCompare);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new CoreError("SCHEMA_INVALID", "JSON document contains an accessor or non-enumerable property", { path: `${path}/${key}` });
    Object.defineProperty(result, key, { value: cloneExactJsonValue(descriptor.value, `${path}/${key}`, seen, sortKeys), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function cloneDocument(value: unknown): Readonly<Record<string, unknown>> {
  return jsonDocument(cloneExactJsonValue(value, "", new WeakSet<object>(), false));
}
function exactStableJson(value: unknown): string {
  return JSON.stringify(cloneExactJsonValue(value, "", new WeakSet<object>(), true));
}
function compareVersions(left: string, right: string): number {
  if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) throw new CoreError("MIGRATION_FAILED", "Migration versions must use major.minor.patch numeric form", { left, right });
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) { const difference = a[index]! - b[index]!; if (difference !== 0) return difference; }
  return 0;
}

export function inspectContractDocument(input: unknown): InspectedContractDocument {
  const document = cloneDocument(input);
  const schemaVersion = document.schemaVersion as string;
  if (schemaVersion === SUPPORTED_CONTRACT_SCHEMA_VERSION) return { status: "supported", contract: parseLayoutContract(document) };
  return { status: "read-only", schemaVersion, reason: "unsupported-schema-version", document };
}
export function readVersionedContractFile(path: string): InspectedContractDocument & { readonly path: string; readonly sourceHash: string } {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (error) { throw new CoreError("NOT_FOUND", "Contract file could not be read", { path, cause: String(error) }); }
  let input: unknown;
  try { input = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new CoreError("IMPORT_INVALID", "Contract file is not valid JSON", { path, cause: String(error) }); }
  return { ...inspectContractDocument(input), path, sourceHash: sha256(bytes) };
}
export function migrateContractDocument(input: unknown, migrations: readonly ContractMigration[]): LayoutContract {
  let current = cloneDocument(input);
  if (compareVersions(current.schemaVersion as string, SUPPORTED_CONTRACT_SCHEMA_VERSION) > 0) throw new CoreError("READ_ONLY", "A newer contract schema cannot be downgraded", { schemaVersion: current.schemaVersion, supportedVersion: SUPPORTED_CONTRACT_SCHEMA_VERSION });
  const visited = new Set<string>();
  for (let step = 0; step < 32 && current.schemaVersion !== SUPPORTED_CONTRACT_SCHEMA_VERSION; step += 1) {
    const version = current.schemaVersion as string;
    if (visited.has(version)) throw new CoreError("MIGRATION_FAILED", "Contract migration cycle detected", { schemaVersion: version });
    visited.add(version);
    const candidates = migrations.filter((migration) => migration.from === version);
    if (candidates.length !== 1) throw new CoreError("UNSUPPORTED_SCHEMA_VERSION", candidates.length === 0 ? `No migration is registered from '${version}'` : `Multiple migrations are registered from '${version}'`, { schemaVersion: version, count: candidates.length });
    const migration = candidates[0]!;
    if (compareVersions(migration.to, version) <= 0 || compareVersions(migration.to, SUPPORTED_CONTRACT_SCHEMA_VERSION) > 0) throw new CoreError("MIGRATION_FAILED", "Migration must advance monotonically without crossing the supported version", { from: version, to: migration.to, supportedVersion: SUPPORTED_CONTRACT_SCHEMA_VERSION });
    let first: unknown, second: unknown;
    try { first = migration.migrate(cloneDocument(current)); second = migration.migrate(cloneDocument(current)); }
    catch (error) { throw new CoreError("MIGRATION_FAILED", "Contract migration threw an error", { from: version, to: migration.to, cause: String(error) }); }
    let firstJson: string, secondJson: string;
    try { firstJson = exactStableJson(first); secondJson = exactStableJson(second); }
    catch (error) { throw new CoreError("MIGRATION_FAILED", "Contract migration returned a non-JSON value", { from: version, to: migration.to, cause: String(error) }); }
    if (firstJson !== secondJson) throw new CoreError("MIGRATION_FAILED", "Contract migration is not deterministic", { from: version, to: migration.to });
    current = jsonDocument(JSON.parse(firstJson) as unknown);
    if (current.schemaVersion !== migration.to) throw new CoreError("MIGRATION_FAILED", "Migration output schemaVersion does not match its declared target", { declared: migration.to, actual: current.schemaVersion });
  }
  if (current.schemaVersion !== SUPPORTED_CONTRACT_SCHEMA_VERSION) throw new CoreError("MIGRATION_FAILED", "Contract migration exceeded the maximum chain length", { schemaVersion: current.schemaVersion });
  return parseLayoutContract(current);
}
export function migrateContractFile(input: { path: string; backupPath: string; migrations: readonly ContractMigration[] }): MigrationFileResult {
  if (existsSync(input.backupPath)) throw new CoreError("MIGRATION_FAILED", "Migration backup path already exists", { backupPath: input.backupPath });
  let original: Buffer, document: unknown;
  try { original = readFileSync(input.path); document = JSON.parse(original.toString("utf8")); }
  catch (error) { throw new CoreError("IMPORT_INVALID", "Migration source is not readable JSON", { path: input.path, cause: String(error) }); }
  const fromVersion = jsonDocument(document).schemaVersion as string;
  if (fromVersion === SUPPORTED_CONTRACT_SCHEMA_VERSION) throw new CoreError("MIGRATION_FAILED", "Contract is already at the supported schema version", { schemaVersion: fromVersion });
  atomicWriteBytes(input.backupPath, original);
  try {
    const contract = migrateContractDocument(document, input.migrations);
    atomicWriteBytes(input.path, Buffer.from(`${canonicalJson(contract)}\n`, "utf8"));
    const verified = readContractFile(input.path).contract;
    return { path: input.path, backupPath: input.backupPath, fromVersion, toVersion: SUPPORTED_CONTRACT_SCHEMA_VERSION, contract: verified, contractHash: hashContract(verified) };
  } catch (error) {
    try { atomicWriteBytes(input.path, original); }
    catch (restoreError) { throw new CoreError("MIGRATION_FAILED", "Migration failed and original contract restoration also failed", { path: input.path, backupPath: input.backupPath, migrationError: String(error), restoreError: String(restoreError) }); }
    if (error instanceof CoreError) throw error;
    throw new CoreError("MIGRATION_FAILED", "Contract migration failed; original bytes were restored", { path: input.path, backupPath: input.backupPath, cause: String(error) });
  }
}
