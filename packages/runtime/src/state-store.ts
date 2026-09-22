import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ManagedSourceDriftInspection } from "./source-drift-recovery.js";

export interface RuntimeProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly rootDeviceId: string;
  readonly rootFileId: string;
  readonly nativeCanonicalRootPath?: string;
  readonly nativeRootVolumeId?: string;
  readonly nativeRootFileId?: string;
  readonly databasePath: string;
  readonly exportRoot: string;
  readonly target: "web-react";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeSelection {
  readonly projectId: string;
  readonly screenId: string | null;
  readonly nodeIds: readonly string[];
  readonly revision: number | null;
}

export interface PersistedLayoutHandoff {
  readonly handoffId: string;
  readonly projectId: string;
  readonly screenId: string;
  readonly proposalId: string;
  readonly baseRevision: number;
  readonly baseContractHash: string;
  readonly newRevision: number;
  readonly newContractHash: string;
  readonly addedNodeIds: readonly string[];
  readonly changedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly affectedNodeIds: readonly string[];
  readonly status: "AWAITING_AGENT";
}

export interface RuntimeProposal {
  readonly proposalId: string;
  readonly projectId: string;
  readonly screenId: string;
  readonly baseRevision: number;
  readonly baseContractHash?: string;
  readonly reason: string;
  readonly proposedContractJson: string;
  readonly principalId: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly draftRevision?: number;
  readonly selectedNodeIds?: readonly string[];
  readonly status: "AWAITING_USER" | "USER_EDITING_DRAFT" | "LIVE" | "STALE" | "PUBLISHED" | "DISMISSED";
  readonly publishRequestId?: string;
  readonly publishIntent?: {
    readonly requestId: string;
    readonly handoff: PersistedLayoutHandoff;
  };
  readonly publishedHandoff?: PersistedLayoutHandoff;
}

export interface PersistedVerificationReport {
  readonly reportId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly report: unknown;
  readonly createdAt: string;
}

export interface PersistedCandidateContext {
  readonly candidateId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly effectiveContract: unknown;
  readonly verificationProfileId: string;
  readonly createdAt: string;
}

export interface PersistedArtifact {
  readonly artifactId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PersistedIdempotencyRecord {
  readonly principalId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export interface PersistedManagedWrite {
  readonly transactionId: string;
  readonly projectId: string;
  readonly relativePath: string;
  readonly preparedId: string;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly createdAt: string;
}

export interface PersistedManagedSaveBatch {
  readonly batchId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly outputs: readonly {
    readonly relativePath: string;
    readonly content: string;
    readonly beforeHash: string | null;
    readonly afterHash: string;
  }[];
}

export interface RuntimeState {
  readonly version: 1;
  readonly projects: Record<string, RuntimeProjectRecord>;
  readonly selections: Record<string, RuntimeSelection>;
  readonly proposals: Record<string, RuntimeProposal>;
  readonly reports: Record<string, PersistedVerificationReport>;
  readonly candidates: Record<string, PersistedCandidateContext>;
  readonly artifacts: Record<string, PersistedArtifact>;
  readonly idempotency: Record<string, PersistedIdempotencyRecord>;
  readonly managedWrites: Record<string, PersistedManagedWrite>;
  readonly managedSaveBatches: Record<string, PersistedManagedSaveBatch>;
  readonly sourceDriftInspections: Record<string, ManagedSourceDriftInspection>;
  readonly unmanagedGeneratedScreens: Record<string, readonly string[]>;
}

const EMPTY_STATE: RuntimeState = {
  version: 1,
  projects: {},
  selections: {},
  proposals: {},
  reports: {},
  candidates: {},
  artifacts: {},
  idempotency: {},
  managedWrites: {},
  managedSaveBatches: {},
  sourceDriftInspections: {},
  unmanagedGeneratedScreens: {},
};

export class RuntimeStateStore {
  readonly #path: string;
  #state: RuntimeState = EMPTY_STATE;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      this.#state = parseState(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.#persist(EMPTY_STATE);
        return;
      }
      throw error;
    }
  }

  snapshot(): RuntimeState {
    return structuredClone(this.#state);
  }

  async update(mutator: (draft: RuntimeState) => RuntimeState): Promise<RuntimeState> {
    let result!: RuntimeState;
    const operation = this.#writeQueue.then(async () => {
      const next = mutator(structuredClone(this.#state));
      result = parseState(next);
      await this.#persist(result);
      this.#state = result;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return structuredClone(result);
  }

  async close(): Promise<void> {
    await this.#writeQueue;
  }

  async #persist(state: RuntimeState): Promise<void> {
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function parseState(value: unknown): RuntimeState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported or corrupt BoxSpec runtime state");
  }
  const migratedWrites = isRecord(value["managedWrites"]) ? value : { ...value, managedWrites: {} };
  const migratedBatches = isRecord(migratedWrites["managedSaveBatches"]) ? migratedWrites : { ...migratedWrites, managedSaveBatches: {} };
  const migratedInspections = isRecord(migratedBatches["sourceDriftInspections"]) ? migratedBatches : { ...migratedBatches, sourceDriftInspections: {} };
  const migrated = isRecord(migratedInspections["unmanagedGeneratedScreens"]) ? migratedInspections : { ...migratedInspections, unmanagedGeneratedScreens: {} };
  for (const key of ["projects", "selections", "proposals", "reports", "candidates", "artifacts", "idempotency", "managedWrites", "managedSaveBatches", "sourceDriftInspections", "unmanagedGeneratedScreens"] as const) {
    if (!isRecord(migrated[key])) {
      throw new Error(`Corrupt BoxSpec runtime state field: ${key}`);
    }
  }
  return migrated as unknown as RuntimeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
