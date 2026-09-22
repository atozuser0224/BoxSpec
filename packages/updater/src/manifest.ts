import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, parseStrictJson, sha256, type JsonValue } from "./canonical.js";
import { UpdaterError } from "./errors.js";
import type { ArtifactRole, InstalledState, ReleaseArtifact, ReleaseManifest, UpdaterTrust, VerifiedRelease } from "./types.js";

const roles = new Set<ArtifactRole>(["application-executable", "application-archive", "native-safe-fs", "verification-manifest", "browser-executable", "verification-asset", "portable-archive", "installer"]);
const executableRoles = new Set<ArtifactRole>(["application-executable", "native-safe-fs", "browser-executable", "installer"]);
const hex = /^[0-9a-f]{64}$/u;
const token = /^[A-Za-z0-9._-]{1,128}$/u;
const reserved = /^(?:con|prn|aux|nul|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;

export function verifyReleaseEnvelope(raw: string, trust: UpdaterTrust, now: Date): VerifiedRelease {
  if (trust.keys.length === 0 || trust.publishers.length === 0) throw new UpdaterError("MISSING_TRUST", "production release keys and publishers are required");
  const envelope = record(parseStrictJson(raw), "envelope");
  exact(envelope, ["schemaVersion", "keyId", "manifest", "signature"], "envelope");
  integer(envelope.schemaVersion, 1, 1, "envelope.schemaVersion");
  const keyId = string(envelope.keyId, "keyId", token);
  const signature = record(envelope.signature, "signature");
  exact(signature, ["algorithm", "valueBase64"], "signature");
  if (signature.algorithm !== "ed25519") invalid("signature algorithm must be ed25519");
  const encoded = string(signature.valueBase64, "signature.valueBase64", /^[A-Za-z0-9+/]+={0,2}$/u);
  const signatureBytes = Buffer.from(encoded, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== encoded) invalid("signature must be canonical base64 for 64 bytes");
  const trusted = trust.keys.find((entry) => entry.keyId === keyId);
  if (!trusted) throw new UpdaterError("MISSING_TRUST", `release key is not trusted: ${keyId}`);
  const key = typeof trusted.publicKey === "object" && "type" in trusted.publicKey && trusted.publicKey.type === "public"
    ? trusted.publicKey
    : createPublicKey(trusted.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new UpdaterError("MISSING_TRUST", "trusted release key is not Ed25519");
  const manifestValue = envelope.manifest;
  if (manifestValue === undefined) invalid("manifest is missing");
  const payload = Buffer.from(`BoxSpec Release Manifest v1\n${canonicalJson(manifestValue)}`, "utf8");
  if (!verify(null, payload, key, signatureBytes)) throw new UpdaterError("SIGNATURE_INVALID", "release manifest signature is invalid");
  const manifest = parseManifest(manifestValue, trust);
  const published = Date.parse(manifest.publishedAt);
  const expires = Date.parse(manifest.expiresAt);
  if (published > now.getTime() + 300_000 || expires <= published || now.getTime() >= expires) invalid("release time window is invalid or expired");
  return { manifest, manifestDigest: sha256(canonicalJson(manifestValue)), keyId };
}

export function assessRelease(release: VerifiedRelease, installed: InstalledState): void {
  const candidate = release.manifest;
  if (candidate.channel !== installed.channel) throw new UpdaterError("CHANNEL_MISMATCH", `expected ${installed.channel}, received ${candidate.channel}`);
  const parsed = semver(candidate.version);
  if (candidate.channel === "stable" && parsed.beta !== null) throw new UpdaterError("CHANNEL_MISMATCH", "stable channel cannot contain prereleases");
  if (candidate.channel === "beta" && parsed.beta === null) throw new UpdaterError("CHANNEL_MISMATCH", "beta channel requires a -beta.N version");
  if (compare(candidate.version, installed.version) <= 0) throw new UpdaterError("VERSION_REJECTED", "candidate must be newer than the installed version");
  const schema = candidate.dataSchema;
  if (installed.dataSchemaVersion < schema.minimumReadable || installed.dataSchemaVersion > schema.maximumReadable || schema.target < installed.dataSchemaVersion)
    throw new UpdaterError("SCHEMA_INCOMPATIBLE", "installed data schema is outside the signed compatibility window");
}

function parseManifest(value: JsonValue, trust: UpdaterTrust): ReleaseManifest {
  const m = record(value, "manifest");
  exact(m, ["schemaVersion", "product", "releaseId", "version", "channel", "sequence", "publishedAt", "expiresAt", "artifactSetSha256", "dataSchema", "artifacts"], "manifest");
  integer(m.schemaVersion, 1, 1, "schemaVersion");
  if (m.product !== "BoxSpec") invalid("product must be BoxSpec");
  const channel = m.channel === "stable" || m.channel === "beta" ? m.channel : invalid("invalid channel");
  const ds = record(m.dataSchema, "dataSchema");
  exact(ds, ["minimumReadable", "maximumReadable", "target", "backupRequired"], "dataSchema");
  if (ds.backupRequired !== true) invalid("schema migration backup cannot be disabled");
  const artifactValues = m.artifacts;
  if (!Array.isArray(artifactValues) || artifactValues.length < 6 || artifactValues.length > 4096) invalid("artifacts count is outside bounds");
  const artifacts = artifactValues.map((item, index) => artifact(item, index, trust));
  validateClosure(artifacts);
  const artifactSetSha256 = string(m.artifactSetSha256, "artifactSetSha256", hex);
  const sorted = [...artifacts].sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en-US"));
  if (sha256(canonicalJson(sorted as unknown as JsonValue)) !== artifactSetSha256) invalid("artifact set digest mismatch");
  const publishedAt = date(m.publishedAt, "publishedAt");
  const expiresAt = date(m.expiresAt, "expiresAt");
  return Object.freeze({ schemaVersion: 1, product: "BoxSpec", releaseId: string(m.releaseId, "releaseId", token), version: string(m.version, "version", /^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u), channel, sequence: integer(m.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence"), publishedAt, expiresAt, artifactSetSha256, dataSchema: Object.freeze({ minimumReadable: integer(ds.minimumReadable, 0, 1_000_000, "minimumReadable"), maximumReadable: integer(ds.maximumReadable, 0, 1_000_000, "maximumReadable"), target: integer(ds.target, 0, 1_000_000, "target"), backupRequired: true }), artifacts: Object.freeze(artifacts) });
}

function artifact(value: JsonValue, index: number, trust: UpdaterTrust): ReleaseArtifact {
  const a = record(value, `artifacts[${index}]`);
  exact(a, ["relativePath", "role", "scope", "sha256", "sizeBytes", "publisherId"], `artifacts[${index}]`);
  const role = typeof a.role === "string" && roles.has(a.role as ArtifactRole) ? a.role as ArtifactRole : invalid("invalid artifact role");
  const scope = a.scope === "installation" || a.scope === "package" ? a.scope : invalid("invalid artifact scope");
  const relativePath = path(string(a.relativePath, "relativePath"));
  const publisherId = a.publisherId === null ? null : string(a.publisherId, "publisherId", token);
  if (executableRoles.has(role) !== (publisherId !== null)) invalid(`publisher binding mismatch for ${relativePath}`);
  if (publisherId !== null) {
    const publisher = trust.publishers.find((entry) => entry.publisherId === publisherId);
    if (!publisher || !publisher.allowedRoles.includes(role) || !hex.test(publisher.certificateSha256)) throw new UpdaterError("MISSING_TRUST", `publisher is not trusted for ${role}`);
  }
  return Object.freeze({ relativePath, role, scope, sha256: string(a.sha256, "sha256", hex), sizeBytes: integer(a.sizeBytes, 0, 8 * 1024 * 1024 * 1024, "sizeBytes"), publisherId });
}

function validateClosure(artifacts: readonly ReleaseArtifact[]): void {
  const seen = new Set<string>();
  for (const a of artifacts) { const folded = a.relativePath.normalize("NFC").toUpperCase(); if (seen.has(folded)) invalid("duplicate or case-colliding artifact path"); seen.add(folded); }
  const required: [string, ArtifactRole][] = [["BoxSpec.exe", "application-executable"], ["resources/app.asar", "application-archive"], ["resources/native/boxspec-safe-fs.exe", "native-safe-fs"], ["resources/verification-tools.json", "verification-manifest"]];
  for (const [p, role] of required) if (!artifacts.some((a) => a.scope === "installation" && a.relativePath === p && a.role === role)) invalid(`required artifact missing: ${p}`);
  if (!artifacts.some((a) => a.scope === "installation" && a.role === "browser-executable" && a.relativePath.startsWith("resources/verification/"))) invalid("verified browser executable is missing");
  if (!artifacts.some((a) => a.scope === "package" && a.role === "portable-archive") || !artifacts.some((a) => a.scope === "package" && a.role === "installer")) invalid("installer and portable package artifacts are required");
}

function path(value: string): string {
  if (value.length > 512 || value !== value.normalize("NFC") || value.includes("\\") || value.includes(":") || /[\u0000-\u001f*?"<>|]/u.test(value)) invalid("unsafe artifact path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || reserved.test(part))) invalid("unsafe artifact path component");
  return value;
}

function semver(value: string): { core: readonly number[]; beta: number | null } { const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.(0|[1-9][0-9]*))?$/u.exec(value); if (!match) throw new UpdaterError("VERSION_REJECTED", "version must be strict semver with optional beta.N"); return { core: [Number(match[1]), Number(match[2]), Number(match[3])], beta: match[4] === undefined ? null : Number(match[4]) }; }
function compare(a: string, b: string): number { const x = semver(a), y = semver(b); for (let i=0;i<3;i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!; if (x.beta === y.beta) return 0; if (x.beta === null) return 1; if (y.beta === null) return -1; return x.beta-y.beta; }
function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> { if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`); return value as Record<string, JsonValue>; }
function exact(value: Record<string, JsonValue>, names: readonly string[], label: string): void { const actual=Object.keys(value).sort(); const expected=[...names].sort(); if (actual.length!==expected.length || actual.some((v,i)=>v!==expected[i])) invalid(`${label} has unknown or missing fields`); }
function string(value: JsonValue | undefined, label: string, pattern?: RegExp): string { if (typeof value!=="string" || value.length===0 || value.length>1024 || (pattern && !pattern.test(value))) invalid(`invalid ${label}`); return value; }
function integer(value: JsonValue | undefined, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || (value as number)<min || (value as number)>max) invalid(`invalid ${label}`); return value as number; }
function date(value: JsonValue | undefined, label: string): string { const v=string(value,label); const d=new Date(v); if (!Number.isFinite(d.getTime()) || d.toISOString()!==v) invalid(`invalid ${label}`); return v; }
function invalid(message: string): never { throw new UpdaterError("INVALID_MANIFEST", message); }
