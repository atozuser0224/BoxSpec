import { createHash } from "node:crypto";
import { hashContract, parseLayoutContract, type LayoutContract } from "@boxspec/core";
import { hashCanonical } from "./canonical.js";

export type ManagedSourceKind = "contract-export" | "generated";
export type ManagedSourceResolution = "propose-contract" | "restore-contract" | "unmanage";

export interface ManagedOutputIntent {
  readonly path: string;
  readonly kind: ManagedSourceKind;
  readonly desiredContent: string;
  readonly desiredHash: string;
  readonly screenId: string;
  readonly baseContractRevision?: number;
  readonly baseContractHash?: string;
}

export interface ManagedOwnershipRecord {
  readonly path: string;
  readonly kind: ManagedSourceKind;
  readonly screenId: string;
  readonly contentHash: string;
}

export interface ManagedFileObservation {
  readonly path: string;
  readonly kind: ManagedSourceKind;
  readonly screenId: string;
  readonly exists: boolean;
  readonly contentHash: string | null;
  /** Required for an existing contract export so an import draft can be validated. */
  readonly content?: string | null;
}

export interface SafeManagedWrite {
  readonly path: string;
  readonly kind: ManagedSourceKind;
  readonly expectedBeforeHash: string | null;
  readonly content: string;
  readonly contentHash: string;
}

export interface ManagedSourceDrift {
  readonly driftId: string;
  readonly projectId: string;
  readonly path: string;
  readonly kind: ManagedSourceKind;
  readonly reason: "content-changed" | "managed-file-missing" | "unowned-file-conflict" | "no-longer-generated";
  readonly expectedHash: string | null;
  readonly observedHash: string | null;
  readonly desiredHash: string | null;
  readonly screenId: string;
  readonly baseContractRevision?: number;
  readonly baseContractHash?: string;
  readonly allowedResolutions: readonly ManagedSourceResolution[];
  readonly contractImportStatus?: "valid" | "invalid" | "missing";
  /** Internal resolution evidence; callers should not expose these bytes as authority. */
  readonly observedContent?: string;
  readonly desiredContent?: string;
  readonly unitSnapshots: readonly ManagedPathSnapshot[];
}

export interface ManagedPathSnapshot {
  readonly path: string;
  readonly expectedHash: string | null;
  readonly observedHash: string | null;
  readonly desiredHash: string | null;
  readonly desiredContent?: string;
}

export interface ManagedSourceDriftInspection {
  readonly inspectionId: string;
  readonly projectId: string;
  readonly manifestHash: string | null;
  readonly unmanagedGeneratedScreenIds: readonly string[];
  readonly drifts: readonly ManagedSourceDrift[];
  readonly safeWrites: readonly SafeManagedWrite[];
}

export interface InspectManagedSourceDriftInput {
  readonly projectId: string;
  readonly manifestHash: string | null;
  readonly intents: readonly ManagedOutputIntent[];
  readonly ownership: readonly ManagedOwnershipRecord[];
  readonly observations: readonly ManagedFileObservation[];
  readonly unmanagedGeneratedScreenIds?: readonly string[];
}

export type ManagedSourceResolutionPlan =
  | {
      readonly action: "restore-managed";
      readonly inspectionId: string;
      readonly driftId: string;
      readonly projectId: string;
      readonly screenId: string;
      readonly writes: readonly SafeManagedWrite[];
    }
  | {
      readonly action: "import-contract-draft";
      readonly inspectionId: string;
      readonly driftId: string;
      readonly projectId: string;
      readonly path: string;
      readonly screenId: string;
      readonly expectedObservedHash: string;
      readonly sourceHash: string;
      readonly baseContractRevision: number;
      readonly baseContractHash: string;
      readonly contract: LayoutContract;
      /** Authoritative export restoration performed only after the import draft is durable. */
      readonly restore: SafeManagedWrite;
    }
  | {
      readonly action: "unmanage-generated";
      readonly inspectionId: string;
      readonly driftId: string;
      readonly projectId: string;
      readonly path: string;
      readonly screenId: string;
      readonly expectedObservedHash: string | null;
    };

export class ManagedSourceDriftError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "STALE_INSPECTION" | "UNSUPPORTED_RESOLUTION",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ManagedSourceDriftError";
  }
}

export function inspectManagedSourceDrift(input: InspectManagedSourceDriftInput): ManagedSourceDriftInspection {
  assertToken(input.projectId, "projectId");
  assertNullableHash(input.manifestHash, "manifestHash");
  const unmanagedGeneratedScreenIds = [...new Set(input.unmanagedGeneratedScreenIds ?? [])].sort();
  for (const screenId of unmanagedGeneratedScreenIds) assertToken(screenId, "unmanaged screenId");
  const unmanaged = new Set(unmanagedGeneratedScreenIds);
  const intents = uniqueByPath(input.intents, "intent");
  const ownership = uniqueByPath(input.ownership, "ownership");
  const observations = uniqueByPath(input.observations, "observation");

  for (const record of ownership.values()) {
    assertManagedKindPath(record.kind, record.path);
    assertToken(record.screenId, "ownership screenId");
    assertHash(record.contentHash, "ownership contentHash");
  }
  for (const observation of observations.values()) validateObservation(observation);
  const drifts: ManagedSourceDrift[] = [];
  const safeWrites: SafeManagedWrite[] = [];
  const generatedUnits = generatedUnitSnapshots(intents, ownership, observations);
  for (const rawIntent of intents.values()) {
    const intent = validateIntent(rawIntent);
    if (intent.kind === "generated" && unmanaged.has(intent.screenId)) continue;
    const observed = observations.get(intent.path);
    if (!observed) throw new ManagedSourceDriftError("INVALID_INPUT", "Every managed intent requires an observation", { path: intent.path });
    if (observed.kind !== intent.kind || observed.screenId !== intent.screenId) throw new ManagedSourceDriftError("INVALID_INPUT", "Observation binding does not match intent", { path: intent.path });
    const owned = ownership.get(intent.path);
    if (owned && (owned.kind !== intent.kind || owned.screenId !== intent.screenId)) throw new ManagedSourceDriftError("INVALID_INPUT", "Ownership binding does not match intent", { path: intent.path });

    const expectedHash = owned?.contentHash ?? null;
    let externalConflict = owned
      ? observed.contentHash !== owned.contentHash
      : observed.exists && observed.contentHash !== intent.desiredHash;
    if (intent.kind === "contract-export" && observedContractEqualsApproved(observed, input.projectId, intent)) externalConflict = false;
    if (externalConflict) {
      const unitSnapshots = intent.kind === "generated" ? generatedUnits.get(intent.screenId)! : [snapshot(intent, expectedHash, observed)];
      drifts.push(makeDrift(input.projectId, input.manifestHash, intent, observed, expectedHash, unitSnapshots));
    } else if (observed.contentHash !== intent.desiredHash) {
      safeWrites.push({
        path: intent.path,
        kind: intent.kind,
        expectedBeforeHash: observed.contentHash,
        content: intent.desiredContent,
        contentHash: intent.desiredHash,
      });
    }
  }

  for (const owned of ownership.values()) {
    if (intents.has(owned.path) || unmanaged.has(owned.screenId)) continue;
    if (owned.kind === "contract-export") {
      throw new ManagedSourceDriftError("INVALID_INPUT", "A managed contract export has no approved contract intent", { path: owned.path });
    }
    const observed = observations.get(owned.path);
    if (!observed) throw new ManagedSourceDriftError("INVALID_INPUT", "Owned generated path requires an observation", { path: owned.path });
    drifts.push(makeOrphanDrift(input.projectId, input.manifestHash, owned, observed, generatedUnits.get(owned.screenId) ?? [snapshotOrphan(owned, observed)]));
  }

  drifts.sort((left, right) => ordinal(left.path, right.path));
  safeWrites.sort((left, right) => ordinal(left.path, right.path));
  const inspectionId = hashCanonical({
    version: 1,
    projectId: input.projectId,
    manifestHash: input.manifestHash,
    unmanagedGeneratedScreenIds,
    drifts: drifts.map(publicDriftBinding),
    safeWrites: safeWrites.map(({ path, kind, expectedBeforeHash, contentHash }) => ({ path, kind, expectedBeforeHash, contentHash })),
  });
  return { inspectionId, projectId: input.projectId, manifestHash: input.manifestHash, unmanagedGeneratedScreenIds, drifts, safeWrites };
}

export function planManagedSourceDriftResolution(input: {
  readonly inspection: ManagedSourceDriftInspection;
  readonly driftId: string;
  readonly resolution: ManagedSourceResolution;
  /** Hash of the manifest observed immediately before planning the resolution. */
  readonly currentManifestHash: string | null;
  readonly currentObservations: readonly ManagedFileObservation[];
}): ManagedSourceResolutionPlan {
  assertNullableHash(input.currentManifestHash, "currentManifestHash");
  if (input.currentManifestHash !== input.inspection.manifestHash) {
    throw new ManagedSourceDriftError("STALE_INSPECTION", "Managed ownership changed after drift inspection", {
      expectedManifestHash: input.inspection.manifestHash,
      currentManifestHash: input.currentManifestHash,
    });
  }
  const drift = input.inspection.drifts.find((entry) => entry.driftId === input.driftId);
  if (!drift) throw new ManagedSourceDriftError("INVALID_INPUT", "Drift does not belong to this inspection", { driftId: input.driftId });
  const current = uniqueByPath(input.currentObservations, "current observation");
  for (const expected of drift.unitSnapshots) {
    const observed = current.get(expected.path);
    if (!observed) throw new ManagedSourceDriftError("STALE_INSPECTION", "Managed unit observation is incomplete", { path: expected.path });
    validateObservation(observed);
    if (observed.screenId !== drift.screenId || observed.kind !== drift.kind || observed.contentHash !== expected.observedHash) {
      throw new ManagedSourceDriftError("STALE_INSPECTION", "Managed file changed after drift inspection", { path: expected.path });
    }
  }
  if (!drift.allowedResolutions.includes(input.resolution)) {
    throw new ManagedSourceDriftError("UNSUPPORTED_RESOLUTION", "Resolution is not supported for this drift", {
      path: drift.path,
      resolution: input.resolution,
      allowedResolutions: drift.allowedResolutions,
    });
  }

  if (input.resolution === "restore-contract") {
    if (drift.unitSnapshots.some((item) => item.desiredContent === undefined || item.desiredHash === null)) {
      throw new ManagedSourceDriftError("UNSUPPORTED_RESOLUTION", "No deterministic managed bytes exist for restore", { path: drift.path });
    }
    return {
      action: "restore-managed",
      inspectionId: input.inspection.inspectionId,
      driftId: drift.driftId,
      projectId: drift.projectId,
      screenId: drift.screenId,
      writes: drift.unitSnapshots.map((item) => ({
        path: item.path,
        kind: drift.kind,
        expectedBeforeHash: item.observedHash,
        content: item.desiredContent!,
        contentHash: item.desiredHash!,
      })),
    };
  }
  if (input.resolution === "unmanage") {
    return {
      action: "unmanage-generated",
      inspectionId: input.inspection.inspectionId,
      driftId: drift.driftId,
      projectId: drift.projectId,
      path: drift.path,
      screenId: drift.screenId,
      expectedObservedHash: drift.observedHash,
    };
  }

  if (
    drift.kind !== "contract-export" || drift.observedContent === undefined || drift.observedHash === null ||
    drift.screenId === undefined || drift.baseContractRevision === undefined || drift.baseContractHash === undefined
  ) {
    throw new ManagedSourceDriftError("UNSUPPORTED_RESOLUTION", "Contract proposal lacks validated inspection evidence", { path: drift.path });
  }
  let parsed: LayoutContract;
  try { parsed = parseLayoutContract(JSON.parse(drift.observedContent) as unknown); }
  catch (error) {
    throw new ManagedSourceDriftError("UNSUPPORTED_RESOLUTION", "External contract is not valid for import", {
      path: drift.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed.projectId !== drift.projectId || parsed.screenId !== drift.screenId) {
    throw new ManagedSourceDriftError("UNSUPPORTED_RESOLUTION", "External contract identity does not match the managed export", { path: drift.path });
  }
  return {
    action: "import-contract-draft",
    inspectionId: input.inspection.inspectionId,
    driftId: drift.driftId,
    projectId: drift.projectId,
    path: drift.path,
    screenId: drift.screenId,
    expectedObservedHash: drift.observedHash,
    sourceHash: drift.observedHash,
    baseContractRevision: drift.baseContractRevision,
    baseContractHash: drift.baseContractHash,
    contract: parsed,
    restore: {
      path: drift.path,
      kind: "contract-export",
      expectedBeforeHash: drift.observedHash,
      content: drift.desiredContent!,
      contentHash: drift.desiredHash!,
    },
  };
}

export interface ManagedSourceResolutionPorts {
  readonly trustedWrite: (plan: Extract<ManagedSourceResolutionPlan, { action: "restore-managed" }>) => Promise<void>;
  readonly createImportDraft: (plan: Extract<ManagedSourceResolutionPlan, { action: "import-contract-draft" }>) => Promise<void>;
  readonly persistUnmanaged: (plan: Extract<ManagedSourceResolutionPlan, { action: "unmanage-generated" }>) => Promise<void>;
}

export async function executeManagedSourceDriftResolution(
  plan: ManagedSourceResolutionPlan,
  ports: ManagedSourceResolutionPorts,
): Promise<void> {
  if (plan.action === "restore-managed") return ports.trustedWrite(plan);
  if (plan.action === "import-contract-draft") {
    await ports.createImportDraft(plan);
    return ports.trustedWrite({
      action: "restore-managed",
      inspectionId: plan.inspectionId,
      driftId: plan.driftId,
      projectId: plan.projectId,
      screenId: plan.screenId,
      writes: [plan.restore],
    });
  }
  return ports.persistUnmanaged(plan);
}

function makeDrift(
  projectId: string,
  manifestHash: string | null,
  intent: ManagedOutputIntent,
  observed: ManagedFileObservation,
  expectedHash: string | null,
  unitSnapshots: readonly ManagedPathSnapshot[],
): ManagedSourceDrift {
  const reason = observed.exists ? (expectedHash === null ? "unowned-file-conflict" : "content-changed") : "managed-file-missing";
  let allowedResolutions: readonly ManagedSourceResolution[];
  let contractImportStatus: ManagedSourceDrift["contractImportStatus"];
  if (intent.kind === "generated") {
    allowedResolutions = ["restore-contract", "unmanage"];
  } else if (!observed.exists) {
    allowedResolutions = ["restore-contract"];
    contractImportStatus = "missing";
  } else {
    contractImportStatus = validateImportableContract(observed, projectId, intent.screenId, intent.baseContractRevision!) ? "valid" : "invalid";
    allowedResolutions = contractImportStatus === "valid" ? ["propose-contract", "restore-contract"] : ["restore-contract"];
  }
  const binding = {
    version: 1,
    projectId,
    manifestHash,
    path: intent.path,
    kind: intent.kind,
    expectedHash,
    observedHash: observed.contentHash,
    desiredHash: intent.desiredHash,
    screenId: intent.screenId,
    baseContractRevision: intent.baseContractRevision ?? null,
    baseContractHash: intent.baseContractHash ?? null,
  };
  return {
    driftId: hashCanonical(binding),
    projectId,
    path: intent.path,
    kind: intent.kind,
    reason,
    expectedHash,
    observedHash: observed.contentHash,
    desiredHash: intent.desiredHash,
    screenId: intent.screenId,
    ...(intent.baseContractRevision === undefined ? {} : { baseContractRevision: intent.baseContractRevision }),
    ...(intent.baseContractHash === undefined ? {} : { baseContractHash: intent.baseContractHash }),
    allowedResolutions,
    ...(contractImportStatus === undefined ? {} : { contractImportStatus }),
    ...(observed.content === undefined || observed.content === null ? {} : { observedContent: observed.content }),
    desiredContent: intent.desiredContent,
    unitSnapshots,
  };
}

function makeOrphanDrift(
  projectId: string,
  manifestHash: string | null,
  owned: ManagedOwnershipRecord,
  observed: ManagedFileObservation,
  unitSnapshots: readonly ManagedPathSnapshot[],
): ManagedSourceDrift {
  const binding = {
    version: 1,
    projectId,
    manifestHash,
    path: owned.path,
    kind: owned.kind,
    expectedHash: owned.contentHash,
    observedHash: observed.contentHash,
    desiredHash: null,
  };
  return {
    driftId: hashCanonical(binding),
    projectId,
    path: owned.path,
    kind: "generated",
    reason: "no-longer-generated",
    expectedHash: owned.contentHash,
    observedHash: observed.contentHash,
    desiredHash: null,
    screenId: owned.screenId,
    allowedResolutions: ["unmanage"],
    ...(observed.content === undefined || observed.content === null ? {} : { observedContent: observed.content }),
    unitSnapshots,
  };
}

function validateIntent(intent: ManagedOutputIntent): ManagedOutputIntent {
  const path = normalizeManagedPath(intent.path);
  assertManagedKindPath(intent.kind, path);
  assertHash(intent.desiredHash, "desiredHash");
  if (sha256(intent.desiredContent) !== intent.desiredHash) {
    throw new ManagedSourceDriftError("INVALID_INPUT", "Desired content does not match desiredHash", { path });
  }
  assertToken(intent.screenId, "screenId");
  if (intent.kind === "contract-export") {
    if (intent.baseContractRevision === undefined || intent.baseContractHash === undefined) {
      throw new ManagedSourceDriftError("INVALID_INPUT", "Contract intent requires screen and approved base binding", { path });
    }
    assertHash(intent.baseContractHash, "baseContractHash");
    if (!Number.isSafeInteger(intent.baseContractRevision) || intent.baseContractRevision < 1) {
      throw new ManagedSourceDriftError("INVALID_INPUT", "baseContractRevision must be a positive integer", { path });
    }
    if (path !== `.boxspec/screens/${intent.screenId}.contract.json`) {
      throw new ManagedSourceDriftError("INVALID_INPUT", "Contract intent path does not match screen identity", { path });
    }
  } else if (intent.baseContractRevision !== undefined || intent.baseContractHash !== undefined) {
    throw new ManagedSourceDriftError("INVALID_INPUT", "Generated intent cannot carry contract authority fields", { path });
  }
  return path === intent.path ? intent : { ...intent, path };
}

function validateObservation(observation: ManagedFileObservation): void {
  const path = normalizeManagedPath(observation.path);
  if (path !== observation.path) throw new ManagedSourceDriftError("INVALID_INPUT", "Observation path is not normalized", { path: observation.path });
  assertManagedKindPath(observation.kind, path);
  assertToken(observation.screenId, "observation screenId");
  if (!observation.exists) {
    if (observation.contentHash !== null || (observation.content !== undefined && observation.content !== null)) {
      throw new ManagedSourceDriftError("INVALID_INPUT", "Missing observation cannot carry content", { path });
    }
    return;
  }
  if (observation.contentHash === null) throw new ManagedSourceDriftError("INVALID_INPUT", "Existing observation requires contentHash", { path });
  assertHash(observation.contentHash, "observation contentHash");
  if (observation.kind === "contract-export" && typeof observation.content !== "string") {
    throw new ManagedSourceDriftError("INVALID_INPUT", "Existing contract observation requires content", { path });
  }
  if (typeof observation.content === "string" && sha256(observation.content) !== observation.contentHash) {
    throw new ManagedSourceDriftError("INVALID_INPUT", "Observed content does not match contentHash", { path });
  }
}

function validateImportableContract(observation: ManagedFileObservation, projectId: string, screenId: string, baseRevision: number): boolean {
  if (typeof observation.content !== "string") return false;
  try {
    const parsed = parseLayoutContract(JSON.parse(observation.content) as unknown);
    return parsed.projectId === projectId && parsed.screenId === screenId && parsed.revision === baseRevision;
  } catch { return false; }
}

function observedContractEqualsApproved(
  observation: ManagedFileObservation,
  projectId: string,
  intent: ManagedOutputIntent,
): boolean {
  if (intent.kind !== "contract-export" || typeof observation.content !== "string" || intent.baseContractHash === undefined) return false;
  try {
    const parsed = parseLayoutContract(JSON.parse(observation.content) as unknown);
    return parsed.projectId === projectId && parsed.screenId === intent.screenId && hashContract(parsed) === intent.baseContractHash;
  } catch { return false; }
}

function snapshot(intent: ManagedOutputIntent, expectedHash: string | null, observed: ManagedFileObservation): ManagedPathSnapshot {
  return {
    path: intent.path,
    expectedHash,
    observedHash: observed.contentHash,
    desiredHash: intent.desiredHash,
    desiredContent: intent.desiredContent,
  };
}

function snapshotOrphan(owned: ManagedOwnershipRecord, observed: ManagedFileObservation): ManagedPathSnapshot {
  return { path: owned.path, expectedHash: owned.contentHash, observedHash: observed.contentHash, desiredHash: null };
}

function generatedUnitSnapshots(
  intents: ReadonlyMap<string, ManagedOutputIntent>,
  ownership: ReadonlyMap<string, ManagedOwnershipRecord>,
  observations: ReadonlyMap<string, ManagedFileObservation>,
): Map<string, readonly ManagedPathSnapshot[]> {
  const units = new Map<string, ManagedPathSnapshot[]>();
  for (const intent of intents.values()) {
    if (intent.kind !== "generated") continue;
    const observed = observations.get(intent.path);
    if (!observed) continue;
    const items = units.get(intent.screenId) ?? [];
    items.push(snapshot(intent, ownership.get(intent.path)?.contentHash ?? null, observed));
    units.set(intent.screenId, items);
  }
  for (const owned of ownership.values()) {
    if (owned.kind !== "generated" || intents.has(owned.path)) continue;
    const observed = observations.get(owned.path);
    if (!observed) continue;
    const items = units.get(owned.screenId) ?? [];
    items.push(snapshotOrphan(owned, observed));
    units.set(owned.screenId, items);
  }
  for (const [screenId, items] of units) items.sort((left, right) => ordinal(left.path, right.path));
  return units;
}

function publicDriftBinding(drift: ManagedSourceDrift): unknown {
  const { observedContent: _observedContent, desiredContent: _desiredContent, ...binding } = drift;
  return {
    ...binding,
    unitSnapshots: drift.unitSnapshots.map(({ desiredContent: _content, ...snapshotBinding }) => snapshotBinding),
  };
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueByPath<T extends { readonly path: string }>(values: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const path = normalizeManagedPath(value.path);
    if (path !== value.path) throw new ManagedSourceDriftError("INVALID_INPUT", `${label} path is not normalized`, { path: value.path });
    if (result.has(path)) throw new ManagedSourceDriftError("INVALID_INPUT", `Duplicate ${label} path`, { path });
    result.set(path, value);
  }
  return result;
}

function normalizeManagedPath(value: string): string {
  const parts = value.split("/");
  if (
    value.length === 0 || value.length > 512 || value !== value.normalize("NFC") || value.includes("\\") || value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) || parts.some((part) => {
      const deviceBase = part.split(".", 1)[0]!;
      return part.length === 0 || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") ||
        /[:*?"<>|\u0000-\u001f\u007f-\u009f]/.test(part) || WINDOWS_DEVICES.has(deviceBase.toUpperCase());
    })
  ) throw new ManagedSourceDriftError("INVALID_INPUT", "Managed path must be a bounded normalized project-relative path", { path: value });
  return value;
}

const WINDOWS_DEVICES = new Set([
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
]);

function assertManagedKindPath(kind: ManagedSourceKind, path: string): void {
  if (kind === "contract-export") {
    if (!/^\.boxspec\/screens\/[A-Za-z][A-Za-z0-9_-]{0,95}\.contract\.json$/.test(path)) {
      throw new ManagedSourceDriftError("INVALID_INPUT", "Contract export path is outside the managed screens directory", { path });
    }
    return;
  }
  if (!path.startsWith("src/boxspec/generated/") || path === "src/boxspec/generated/") {
    throw new ManagedSourceDriftError("INVALID_INPUT", "Generated path is outside the compiler-owned directory", { path });
  }
}

function assertToken(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value)) throw new ManagedSourceDriftError("INVALID_INPUT", `${label} is invalid`, { value });
}

function assertNullableHash(value: string | null, label: string): void {
  if (value !== null) assertHash(value, label);
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ManagedSourceDriftError("INVALID_INPUT", `${label} must be lowercase SHA-256`, { value });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
