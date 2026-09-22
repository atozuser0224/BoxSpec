import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ChangeManagerError } from "./types.js";

const CONTROL_OR_NUL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/u;

export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 512 || CONTROL_OR_NUL.test(input)) {
    throw new ChangeManagerError("INVALID_REQUEST", "Invalid project-relative path", false, { path: input });
  }
  const slash = input.replaceAll("\\", "/");
  if (slash.startsWith("/") || slash.startsWith("\\") || /^[A-Za-z]:/u.test(slash) || slash.startsWith("//")) {
    throw new ChangeManagerError("OUT_OF_SCOPE", "Absolute and UNC paths are not allowed", false, { path: input });
  }
  const parts = slash.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ChangeManagerError("OUT_OF_SCOPE", "Path traversal or ambiguous segments are not allowed", false, { path: input });
  }
  if (
    parts.some(
      (part) =>
        WINDOWS_FORBIDDEN.test(part) ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        WINDOWS_RESERVED.test(part),
    )
  ) {
    throw new ChangeManagerError("PROTECTED_PATH", "Windows device, ADS, or alias-prone paths are not allowed", false, {
      path: input,
    });
  }
  return parts.join("/");
}

export function windowsCollisionKey(relativePath: string): string {
  return normalizeRelativePath(relativePath).normalize("NFC").toLocaleLowerCase("en-US");
}

export function normalizeScopeEntry(input: string): string {
  const directory = input.endsWith("/") || input.endsWith("\\");
  const normalized = normalizeRelativePath(input.replace(/[\\/]$/u, ""));
  return directory ? `${normalized}/` : normalized;
}

export function pathMatchesScope(relativePath: string, scope: readonly string[]): boolean {
  const candidate = normalizeRelativePath(relativePath);
  return scope.some((entry) => {
    const normalized = normalizeScopeEntry(entry);
    return normalized.endsWith("/") ? candidate.startsWith(normalized) : candidate === normalized;
  });
}

function comparable(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isWithin(root: string, target: string): boolean {
  const rootValue = comparable(root);
  const targetValue = comparable(target);
  return targetValue === rootValue || targetValue.startsWith(`${rootValue}${path.sep}`);
}

async function assertNoLinksInExistingChain(absolutePath: string): Promise<void> {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const remainder = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of remainder) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new ChangeManagerError("PROTECTED_PATH", "Symlink or junction traversal is not allowed", false, {
          path: cursor,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function canonicalizeGrantedRoot(sourceRoot: string): Promise<string> {
  if (!path.isAbsolute(sourceRoot)) {
    throw new ChangeManagerError("INVALID_REQUEST", "Project root must be absolute", false);
  }
  await assertNoLinksInExistingChain(sourceRoot);
  const canonical = await realpath(sourceRoot);
  if (comparable(canonical) !== comparable(sourceRoot)) {
    throw new ChangeManagerError("PROTECTED_PATH", "Project root resolves through an alias or reparse point", false, {
      sourceRoot,
      canonical,
    });
  }
  return canonical;
}

export async function resolveSafeProjectPath(root: string, relativePath: string): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(root, ...normalized.split("/"));
  if (!isWithin(root, target)) {
    throw new ChangeManagerError("OUT_OF_SCOPE", "Resolved path escaped the project root", false, { relativePath });
  }
  await assertNoLinksInExistingChain(target);
  let existing = target;
  for (;;) {
    try {
      const canonicalExisting = await realpath(existing);
      if (!isWithin(root, canonicalExisting)) {
        throw new ChangeManagerError("OUT_OF_SCOPE", "Existing path resolves outside the project root", false, {
          relativePath,
        });
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return target;
}
