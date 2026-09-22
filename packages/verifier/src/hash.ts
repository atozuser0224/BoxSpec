import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CandidateFileEntry, FrozenCandidateDescriptor } from "./types.js";

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : Number(value.toFixed(3)));
  }
  if (value === undefined) throw new TypeError("Canonical JSON cannot contain undefined");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareOrdinal)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function normalizeRelativePath(input: string): string {
  if (!input || isAbsolute(input) || input.includes("\0")) throw new Error(`Unsafe relative path: ${input}`);
  const normalized = input.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe relative path: ${input}`);
  }
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("//") || normalized.includes(":")) {
    throw new Error(`Unsafe Windows path: ${input}`);
  }
  return normalized;
}

export function resolveInside(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const resolved = resolve(root, ...normalized.split("/"));
  const rel = relative(resolve(root), resolved);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(`Path escapes root: ${relativePath}`);
  return resolved;
}

async function listFiles(root: string, current = ""): Promise<string[]> {
  const directory = current ? resolveInside(root, current) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries.sort((a, b) => compareOrdinal(a.name, b.name))) {
    const rel = current ? `${current}/${entry.name}` : entry.name;
    const full = resolveInside(root, rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Candidate contains a symbolic link or junction: ${rel}`);
    if (entry.isDirectory()) output.push(...(await listFiles(root, rel)));
    else if (entry.isFile()) output.push(rel);
    else throw new Error(`Candidate contains unsupported filesystem entry: ${rel}`);
  }
  return output;
}

export async function inspectCandidateFiles(root: string): Promise<CandidateFileEntry[]> {
  const paths = await listFiles(root);
  return Promise.all(
    paths.map(async (relativePath) => {
      const full = resolveInside(root, relativePath);
      const [bytes, metadata] = await Promise.all([readFile(full), stat(full)]);
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`Candidate file must be a non-hardlinked regular file: ${relativePath}`);
      return { relativePath, sha256: sha256Bytes(bytes), size: metadata.size, executable: (metadata.mode & 0o111) !== 0 };
    }),
  );
}

export function hashCandidateFileEntries(entries: readonly CandidateFileEntry[]): string {
  const hash = createHash("sha256");
  hash.update("boxspec-candidate-tree-v1\0", "utf8");
  for (const entry of [...entries].sort((left, right) => compareOrdinal(left.relativePath, right.relativePath))) {
    const normalized = normalizeRelativePath(entry.relativePath);
    const pathBytes = Buffer.from(normalized, "utf8");
    hash.update(String(pathBytes.byteLength));
    hash.update(":");
    hash.update(pathBytes);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
    hash.update(entry.executable ? "x" : "-");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function assertCandidateIntegrity(candidate: FrozenCandidateDescriptor): Promise<void> {
  if (!isAbsolute(candidate.snapshotRoot)) throw new Error("Candidate snapshotRoot must be absolute");
  const rootInfo = await lstat(candidate.snapshotRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Candidate snapshotRoot must be a real directory");
  const actual = await inspectCandidateFiles(candidate.snapshotRoot);
  const expected = [...candidate.files]
    .map((entry) => ({ ...entry, relativePath: normalizeRelativePath(entry.relativePath) }))
    .sort((a, b) => compareOrdinal(a.relativePath, b.relativePath));
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("Candidate file manifest does not match frozen files");
  if (hashCandidateFileEntries(actual) !== candidate.treeHash) throw new Error("Candidate tree hash does not match frozen files");
  const lockPath = normalizeRelativePath(candidate.dependencyLockPath);
  const lockEntry = actual.find((entry) => entry.relativePath === lockPath);
  if (!lockEntry || lockEntry.sha256 !== candidate.dependencyLockHash) {
    throw new Error("Candidate dependency lock hash does not match the frozen lock file");
  }
}

export async function assertEvidenceOutsideCandidate(snapshotRoot: string, evidenceRoot: string): Promise<void> {
  if (!isAbsolute(evidenceRoot)) throw new Error("evidenceRoot must be absolute");
  const candidateReal = await realpath(snapshotRoot);
  const evidenceResolved = resolve(evidenceRoot);
  let existingAncestor = evidenceResolved;
  for (;;) {
    try {
      await lstat(existingAncestor);
      break;
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error("Cannot resolve an existing evidence-root ancestor");
      existingAncestor = parent;
    }
  }
  const ancestorReal = await realpath(existingAncestor);
  const remaining = relative(existingAncestor, evidenceResolved);
  const evidenceReal = remaining ? resolve(ancestorReal, remaining) : ancestorReal;
  const candidateToEvidence = relative(candidateReal, evidenceReal);
  const evidenceToCandidate = relative(evidenceReal, candidateReal);
  const isInside = (value: string) => value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  if (isInside(candidateToEvidence) || isInside(evidenceToCandidate)) {
    throw new Error("Trusted evidence directory must be outside the candidate snapshot");
  }
  try {
    const evidenceInfo = await lstat(evidenceResolved);
    if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink()) throw new Error("evidenceRoot must be a real directory");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
