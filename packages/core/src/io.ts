import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import { canonicalJson, hashContract, sha256 } from "./canonical.js";
import type { LayoutContract } from "./model.js";
import { parseLayoutContract } from "./validation.js";

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value)) throw new CoreError("SCHEMA_INVALID", `${label} is not a valid BoxSpec id`, { value });
}
export function contractExportPath(root: string, projectId: string, screenId: string): string {
  assertId(projectId, "projectId"); assertId(screenId, "screenId");
  const base = resolve(root, projectId, ".boxspec", "screens");
  const target = resolve(base, `${screenId}.contract.json`);
  if (dirname(target) !== base) throw new CoreError("PERSISTENCE_ERROR", "Resolved export path escaped the screens directory", { target });
  return target;
}
export function atomicExportContract(path: string, contract: LayoutContract): { path: string; hash: string } {
  const valid = parseLayoutContract(contract);
  const content = `${canonicalJson(valid)}\n`;
  atomicWriteBytes(path, Buffer.from(content, "utf8"));
  return { path, hash: hashContract(valid) };
}
export function atomicWriteBytes(path: string, content: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new CoreError("PERSISTENCE_ERROR", "Atomic file replacement failed", { path, cause: String(error) });
  }
}
export function readContractFile(path: string): { contract: LayoutContract; sourceHash: string } {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) { throw new CoreError("NOT_FOUND", "Contract file could not be read", { path, cause: String(error) }); }
  let input: unknown;
  try { input = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new CoreError("IMPORT_INVALID", "Contract file is not valid JSON", { path, cause: String(error) }); }
  try { return { contract: parseLayoutContract(input), sourceHash: sha256(bytes) }; }
  catch (error) { throw new CoreError("IMPORT_INVALID", "Imported contract is invalid", { path, cause: error instanceof CoreError ? error.toJSON() : String(error) }); }
}
