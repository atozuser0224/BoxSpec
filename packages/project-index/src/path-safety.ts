import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ProjectIndexError } from "./errors.js";

const CONTROL_OR_NUL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/u;

export function normalizeProjectRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 512 || CONTROL_OR_NUL.test(input)) {
    throw new ProjectIndexError("INVALID_PATH", "Invalid project-relative path", { path: input });
  }
  const slash = input.replaceAll("\\", "/");
  if (slash.startsWith("/") || /^[A-Za-z]:/u.test(slash) || slash.startsWith("//")) {
    throw new ProjectIndexError("OUT_OF_SCOPE", "Absolute and UNC paths are not allowed", { path: input });
  }
  const parts = slash.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ProjectIndexError("OUT_OF_SCOPE", "Traversal and ambiguous path segments are not allowed", { path: input });
  }
  if (parts.some((part) => WINDOWS_FORBIDDEN.test(part) || part.endsWith(".") || part.endsWith(" ") || WINDOWS_RESERVED.test(part))) {
    throw new ProjectIndexError("ALIAS_REJECTED", "Windows alias-prone, device, or ADS paths are not allowed", { path: input });
  }
  return parts.join("/").normalize("NFC");
}

export function windowsPathKey(relativePath: string): string {
  return normalizeProjectRelativePath(relativePath).toLocaleLowerCase("en-US");
}

export async function canonicalApprovedRoot(rootPath: string): Promise<string> {
  if (!path.isAbsolute(rootPath)) throw new ProjectIndexError("INVALID_CONFIG", "Approved project root must be absolute");
  const resolved = path.resolve(rootPath);
  await assertNoAliasChain(resolved);
  const canonical = await realpath(resolved);
  if (comparable(canonical) !== comparable(resolved)) {
    throw new ProjectIndexError("ALIAS_REJECTED", "Approved project root resolves through an alias", { rootPath, canonical });
  }
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) throw new ProjectIndexError("INVALID_CONFIG", "Approved project root must be a directory");
  return canonical;
}

export async function resolveExistingApprovedPath(root: string, relativePath: string): Promise<string> {
  const normalized = normalizeProjectRelativePath(relativePath);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (!isWithin(root, absolute)) throw new ProjectIndexError("OUT_OF_SCOPE", "Path escaped the approved project root", { relativePath });
  await assertNoAliasChain(absolute, root);
  const canonical = await realpath(absolute);
  if (!isWithin(root, canonical) || comparable(canonical) !== comparable(absolute)) {
    throw new ProjectIndexError("ALIAS_REJECTED", "Path resolves through an alias or outside the approved root", { relativePath });
  }
  return canonical;
}

export function relativePathWithin(relativePath: string, approvedFolder: string): boolean {
  const candidate = windowsPathKey(relativePath);
  const folder = windowsPathKey(approvedFolder);
  return candidate === folder || candidate.startsWith(`${folder}/`);
}

function comparable(input: string): string {
  const resolved = path.resolve(input).normalize("NFC");
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isWithin(root: string, target: string): boolean {
  const rootValue = comparable(root);
  const targetValue = comparable(target);
  return targetValue === rootValue || targetValue.startsWith(`${rootValue}${path.sep}`);
}

async function assertNoAliasChain(absolutePath: string, stopAt?: string): Promise<void> {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) {
      throw new ProjectIndexError("ALIAS_REJECTED", "Symlink, junction, or reparse traversal is not allowed", { path: cursor });
    }
    if (stopAt !== undefined && comparable(cursor) === comparable(stopAt)) continue;
  }
}
