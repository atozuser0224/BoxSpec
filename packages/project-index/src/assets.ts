import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@boxspec/shared/domain";
import { hashProjectIndexProjection } from "./canonical.js";
import { ProjectIndexError, throwIfAborted } from "./errors.js";
import {
  canonicalApprovedRoot,
  normalizeProjectRelativePath,
  relativePathWithin,
  resolveExistingApprovedPath,
  windowsPathKey
} from "./path-safety.js";

export interface AssetLicenseRecord {
  readonly status: "declared" | "unknown";
  readonly spdxId: string | null;
  readonly notice: string | null;
  readonly source: "project-manifest" | "unresolved";
}

export interface AssetMetadata {
  readonly license?: {
    readonly spdxId?: string | null;
    readonly notice?: string | null;
  };
  readonly thumbnailArtifactId?: string | null;
}

export interface ApprovedAssetFolder {
  readonly relativePath: string;
  readonly metadata?: Readonly<Record<string, AssetMetadata>>;
}

export interface AssetRecord {
  readonly assetId: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly source: {
    readonly kind: "project-file";
    readonly approvedFolder: string;
  };
  readonly license: AssetLicenseRecord;
  readonly thumbnailArtifactId: string | null;
  readonly nameCollision: boolean;
}

export interface ProjectAssetIndexOptions {
  readonly rootPath: string;
  readonly indexRevision: number;
  readonly approvedFolders: readonly ApprovedAssetFolder[];
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxAssetBytes?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

export interface ContentBoundAsset {
  readonly record: AssetRecord;
  readonly bytes: Uint8Array;
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;

export class ProjectAssetIndex {
  readonly rootPath: string;
  readonly indexRevision: number;
  readonly indexHash: string;
  readonly records: readonly AssetRecord[];
  readonly indexedBytes: number;
  readonly skippedUnsupportedFiles: number;
  readonly #byId: ReadonlyMap<string, AssetRecord>;

  private constructor(rootPath: string, indexRevision: number, records: readonly AssetRecord[], indexedBytes: number, skippedUnsupportedFiles: number) {
    this.rootPath = rootPath;
    this.indexRevision = indexRevision;
    this.records = Object.freeze([...records]);
    this.indexHash = hashProjectIndexProjection({
      schemaVersion: "1.0.0",
      indexRevision,
      records: records.map((record) => ({
        assetId: record.assetId,
        license: record.license,
        mimeType: record.mimeType,
        relativePath: record.relativePath,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
        source: record.source,
        thumbnailArtifactId: record.thumbnailArtifactId
      }))
    } as unknown as JsonValue);
    this.indexedBytes = indexedBytes;
    this.skippedUnsupportedFiles = skippedUnsupportedFiles;
    this.#byId = new Map(records.map((record) => [record.assetId, record]));
  }

  static async build(options: ProjectAssetIndexOptions): Promise<ProjectAssetIndex> {
    validateLimits(options);
    throwIfAborted(options.signal);
    const root = await canonicalApprovedRoot(options.rootPath);
    if (options.approvedFolders.length === 0 || options.approvedFolders.length > 64) {
      throw new ProjectIndexError("INVALID_CONFIG", "One to 64 approved asset folders are required");
    }
    const folders = options.approvedFolders.map((folder) => ({
      config: folder,
      relativePath: normalizeProjectRelativePath(folder.relativePath)
    }));
    assertNoOverlappingFolders(folders.map((folder) => folder.relativePath));

    const mutable: Array<Omit<AssetRecord, "nameCollision">> = [];
    const seenPaths = new Set<string>();
    let indexedBytes = 0;
    let skippedUnsupportedFiles = 0;
    for (const folder of folders) {
      throwIfAborted(options.signal);
      const absoluteFolder = await resolveExistingApprovedPath(root, folder.relativePath);
      const folderStats = await lstat(absoluteFolder);
      if (!folderStats.isDirectory()) throw new ProjectIndexError("INVALID_CONFIG", "Approved asset entry must be a directory", { relativePath: folder.relativePath });
      const discovered = await walkApprovedDirectory(absoluteFolder, options.maxDepth ?? DEFAULT_MAX_DEPTH, options.signal);
      for (const absolutePath of discovered) {
        throwIfAborted(options.signal);
        const relativePath = normalizeProjectRelativePath(path.relative(root, absolutePath));
        if (!relativePathWithin(relativePath, folder.relativePath)) throw new ProjectIndexError("OUT_OF_SCOPE", "Discovered asset left its approved folder", { relativePath });
        const collisionKey = windowsPathKey(relativePath);
        if (seenPaths.has(collisionKey)) throw new ProjectIndexError("ALIAS_REJECTED", "Ambiguous Windows path collision", { relativePath });
        seenPaths.add(collisionKey);
        const bytes = await readStableFile(root, relativePath, options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES, options.signal);
        const mimeType = detectMime(relativePath, bytes);
        if (mimeType === null) {
          skippedUnsupportedFiles += 1;
          continue;
        }
        indexedBytes += bytes.byteLength;
        if (indexedBytes > (options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)) throw new ProjectIndexError("RESOURCE_LIMIT", "Asset index exceeds its total-byte limit");
        if (mutable.length >= (options.maxFiles ?? DEFAULT_MAX_FILES)) throw new ProjectIndexError("RESOURCE_LIMIT", "Asset index exceeds its file-count limit");
        const hash = sha256(bytes);
        const metadata = metadataFor(folder.config.metadata, relativePath, folder.relativePath);
        mutable.push(Object.freeze({
          assetId: `asset_${sha256(Buffer.from(`${relativePath}\0${hash}`, "utf8")).slice(0, 48)}`,
          name: path.posix.basename(relativePath),
          relativePath,
          sha256: hash,
          sizeBytes: bytes.byteLength,
          mimeType,
          source: Object.freeze({ kind: "project-file" as const, approvedFolder: folder.relativePath }),
          license: licenseRecord(metadata?.license),
          thumbnailArtifactId: validateThumbnail(metadata?.thumbnailArtifactId)
        }));
      }
      assertMetadataBound(folder.config.metadata, folder.relativePath, mutable);
    }
    const nameCounts = new Map<string, number>();
    for (const record of mutable) {
      const key = record.name.normalize("NFC").toLocaleLowerCase("en-US");
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const records = mutable
      .map((record): AssetRecord => Object.freeze({
        ...record,
        nameCollision: (nameCounts.get(record.name.normalize("NFC").toLocaleLowerCase("en-US")) ?? 0) > 1
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en-US"));
    return new ProjectAssetIndex(root, options.indexRevision, records, indexedBytes, skippedUnsupportedFiles);
  }

  search(query: string, limit = 50): readonly AssetRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ProjectIndexError("INVALID_CONFIG", "Asset search limit must be from 1 through 50");
    if (query.length > 512) throw new ProjectIndexError("INVALID_CONFIG", "Asset search query is too long");
    const terms = query.normalize("NFC").toLocaleLowerCase("en-US").trim().split(/\s+/u).filter(Boolean);
    return this.records.filter((record) => {
      const haystack = `${record.name}\n${record.relativePath}\n${record.mimeType}\n${record.license.spdxId ?? ""}`.toLocaleLowerCase("en-US");
      return terms.every((term) => haystack.includes(term));
    }).slice(0, limit);
  }

  async read(input: { readonly assetId: string; readonly expectedSha256: string; readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<ContentBoundAsset> {
    throwIfAborted(input.signal);
    const record = this.#byId.get(input.assetId);
    if (record === undefined) throw new ProjectIndexError("ASSET_NOT_FOUND", "Unknown content-bound asset ID");
    if (input.expectedSha256 !== record.sha256) throw new ProjectIndexError("ASSET_CHANGED", "Requested asset hash does not match the indexed identity");
    const maximum = input.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || record.sizeBytes > maximum) throw new ProjectIndexError("RESOURCE_LIMIT", "Asset exceeds the requested read limit");
    const bytes = await readStableFile(this.rootPath, record.relativePath, maximum, input.signal);
    const hash = sha256(bytes);
    if (hash !== record.sha256 || bytes.byteLength !== record.sizeBytes) {
      throw new ProjectIndexError("ASSET_CHANGED", "Asset content changed after it was indexed", { assetId: record.assetId, expectedSha256: record.sha256, actualSha256: hash });
    }
    return { record, bytes: new Uint8Array(bytes) };
  }
}

async function walkApprovedDirectory(root: string, maxDepth: number, signal?: AbortSignal): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(signal);
    if (depth > maxDepth) throw new ProjectIndexError("RESOURCE_LIMIT", "Approved asset folder exceeds the traversal-depth limit");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      throwIfAborted(signal);
      const absolute = path.join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new ProjectIndexError("ALIAS_REJECTED", "Symlink or junction found inside approved asset folder", { path: absolute });
      if (stats.isDirectory()) await visit(absolute, depth + 1);
      else if (stats.isFile()) files.push(absolute);
    }
  };
  await visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right, "en-US"));
}

async function readStableFile(root: string, relativePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal);
  const absolute = await resolveExistingApprovedPath(root, relativePath);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new ProjectIndexError("ALIAS_REJECTED", "Indexed asset is not a regular file", { relativePath });
  if (before.size > BigInt(maxBytes)) throw new ProjectIndexError("RESOURCE_LIMIT", "Asset exceeds the per-file byte limit", { relativePath, sizeBytes: String(before.size) });
  const bytes = await readFile(absolute);
  throwIfAborted(signal);
  const after = await lstat(absolute, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== after.size) {
    throw new ProjectIndexError("ASSET_CHANGED", "Asset changed while it was being read", { relativePath });
  }
  return bytes;
}

function detectMime(relativePath: string, bytes: Buffer): string | null {
  const extension = path.extname(relativePath).toLocaleLowerCase("en-US");
  if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if ((extension === ".jpg" || extension === ".jpeg") && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (extension === ".gif" && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (extension === ".webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (extension === ".woff" && bytes.subarray(0, 4).toString("ascii") === "wOFF") return "font/woff";
  if (extension === ".woff2" && bytes.subarray(0, 4).toString("ascii") === "wOF2") return "font/woff2";
  if (extension === ".ttf" && bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) return "font/ttf";
  if (extension === ".otf" && bytes.subarray(0, 4).toString("ascii") === "OTTO") return "font/otf";
  if (extension === ".svg") {
    const head = bytes.subarray(0, Math.min(bytes.byteLength, 4096)).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(head)) return "image/svg+xml";
  }
  return null;
}

function metadataFor(metadata: Readonly<Record<string, AssetMetadata>> | undefined, relativePath: string, folder: string): AssetMetadata | undefined {
  if (metadata === undefined) return undefined;
  return metadata[relativePath] ?? metadata[relativePath.slice(folder.length + 1)];
}

function assertMetadataBound(metadata: Readonly<Record<string, AssetMetadata>> | undefined, folder: string, records: readonly Omit<AssetRecord, "nameCollision">[]): void {
  if (metadata === undefined) return;
  const indexed = new Set(records.filter((record) => record.source.approvedFolder === folder).flatMap((record) => [windowsPathKey(record.relativePath), windowsPathKey(record.relativePath.slice(folder.length + 1))]));
  for (const key of Object.keys(metadata)) {
    const normalized = normalizeProjectRelativePath(key);
    if (!indexed.has(windowsPathKey(normalized))) throw new ProjectIndexError("INVALID_CONFIG", "Asset metadata is not bound to an indexed file", { folder, relativePath: key });
  }
}

function licenseRecord(value: AssetMetadata["license"]): AssetLicenseRecord {
  if (value === undefined || (value.spdxId == null && value.notice == null)) return Object.freeze({ status: "unknown", spdxId: null, notice: null, source: "unresolved" });
  const spdxId = value.spdxId?.trim() || null;
  const notice = value.notice?.trim() || null;
  if (spdxId !== null && (spdxId.length > 128 || !/^[A-Za-z0-9-.+]+$/u.test(spdxId))) throw new ProjectIndexError("INVALID_CONFIG", "Asset SPDX identifier is invalid");
  if (notice !== null && notice.length > 4096) throw new ProjectIndexError("INVALID_CONFIG", "Asset license notice is too long");
  return Object.freeze({ status: "declared", spdxId, notice, source: "project-manifest" });
}

function validateThumbnail(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(value)) throw new ProjectIndexError("INVALID_CONFIG", "Thumbnail artifact ID is invalid");
  return value;
}

function assertNoOverlappingFolders(folders: readonly string[]): void {
  const seen = new Set<string>();
  for (const folder of folders) {
    const key = windowsPathKey(folder);
    if (seen.has(key)) throw new ProjectIndexError("INVALID_CONFIG", "Approved asset folders contain a duplicate", { folder });
    for (const other of seen) {
      if (key.startsWith(`${other}/`) || other.startsWith(`${key}/`)) throw new ProjectIndexError("INVALID_CONFIG", "Approved asset folders may not overlap", { folder });
    }
    seen.add(key);
  }
}

function validateLimits(options: ProjectAssetIndexOptions): void {
  if (!Number.isSafeInteger(options.indexRevision) || options.indexRevision < 1) throw new ProjectIndexError("INVALID_CONFIG", "indexRevision must be a positive integer");
  for (const [name, value, minimum, maximum] of [
    ["maxFiles", options.maxFiles, 1, 100_000],
    ["maxTotalBytes", options.maxTotalBytes, 1, 4 * 1024 * 1024 * 1024],
    ["maxAssetBytes", options.maxAssetBytes, 1, 256 * 1024 * 1024],
    ["maxDepth", options.maxDepth, 0, 64]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw new ProjectIndexError("INVALID_CONFIG", `${name} is outside its supported range`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
