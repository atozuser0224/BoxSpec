import type { KeyObject } from "node:crypto";

export type UpdateChannel = "stable" | "beta";
export type ArtifactRole =
  | "application-executable"
  | "application-archive"
  | "native-safe-fs"
  | "verification-manifest"
  | "browser-executable"
  | "verification-asset"
  | "portable-archive"
  | "installer";
export type ArtifactScope = "installation" | "package";

export interface ReleaseArtifact {
  readonly relativePath: string;
  readonly role: ArtifactRole;
  readonly scope: ArtifactScope;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly publisherId: string | null;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly product: "BoxSpec";
  readonly releaseId: string;
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly sequence: number;
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly artifactSetSha256: string;
  readonly dataSchema: {
    readonly minimumReadable: number;
    readonly maximumReadable: number;
    readonly target: number;
    readonly backupRequired: true;
  };
  readonly artifacts: readonly ReleaseArtifact[];
}

export interface VerifiedRelease {
  readonly manifest: ReleaseManifest;
  readonly manifestDigest: string;
  readonly keyId: string;
}

export interface TrustedReleaseKey { readonly keyId: string; readonly publicKey: KeyObject | string | Buffer }
export interface TrustedPublisher {
  readonly publisherId: string;
  readonly subject: string;
  readonly certificateSha256: string;
  readonly allowedRoles: readonly ArtifactRole[];
}

export interface UpdaterTrust {
  readonly keys: readonly TrustedReleaseKey[];
  readonly publishers: readonly TrustedPublisher[];
}

export interface InstalledState {
  readonly channel: UpdateChannel;
  readonly version: string;
  readonly dataSchemaVersion: number;
}

export interface ActiveSelection { readonly selectionRef: string; readonly version: string }
export type UpdatePhase =
  | "PREPARING"
  | "STAGING"
  | "STAGED_VERIFIED"
  | "ACTIVATING"
  | "HEALTH_PENDING"
  | "ROLLBACK_REQUIRED"
  | "COMMITTED"
  | "ROLLED_BACK";

export interface UpdateJournalData {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly phase: UpdatePhase;
  readonly manifestDigest: string;
  readonly releaseId: string;
  readonly channel: UpdateChannel;
  readonly sequence: number;
  readonly version: string;
  readonly previousSelection: ActiveSelection;
  readonly nextSelection: ActiveSelection | null;
  readonly previousDataSchema: number;
  readonly targetDataSchema: number;
  readonly backupRef: string | null;
}

export interface UpdateJournal extends UpdateJournalData { readonly checksum: string }

export interface JournalPort {
  load(): Promise<unknown | null>;
  write(journal: UpdateJournal): Promise<void>;
}
export interface ReleaseHistoryPort {
  reserve(input: { channel: UpdateChannel; sequence: number; releaseId: string; manifestDigest: string }): Promise<"reserved" | "replay" | "conflict">;
}
export interface StagingPort {
  prepare(input: { transactionId: string; manifest: ReleaseManifest }): Promise<ActiveSelection>;
  inspectArtifact(input: { transactionId: string; artifact: ReleaseArtifact }): Promise<{ sha256: string; sizeBytes: number }>;
  discard(transactionId: string): Promise<void>;
}
export interface PublisherVerificationPort {
  verifyAuthenticode(input: { transactionId: string; artifact: ReleaseArtifact }): Promise<{ valid: boolean; subject: string; certificateSha256: string }>;
}
export interface SelectionPort {
  current(): Promise<ActiveSelection>;
  atomicSwitch(input: { expected: ActiveSelection; next: ActiveSelection }): Promise<void>;
}
export interface HealthCheckPort {
  check(input: { selection: ActiveSelection; manifestDigest: string; executableRelativePath: "BoxSpec.exe" }): Promise<{ ok: boolean; detail?: string }>;
}
export interface SchemaBackupPort {
  create(input: { transactionId: string; currentSchema: number; targetSchema: number }): Promise<string>;
  restore(input: { backupRef: string; expectedSchema: number }): Promise<void>;
}

export interface UpdaterPorts {
  readonly journal: JournalPort;
  readonly history: ReleaseHistoryPort;
  readonly staging: StagingPort;
  readonly publisher: PublisherVerificationPort;
  readonly selection: SelectionPort;
  readonly health: HealthCheckPort;
  readonly schemaBackup: SchemaBackupPort;
  readonly now: () => Date;
  readonly transactionId: () => string;
  readonly fault?: (point: "after-preparing" | "after-staging" | "after-verified" | "after-selection") => void | Promise<void>;
}

export type UpdateResult =
  | { readonly status: "COMMITTED"; readonly version: string; readonly transactionId: string }
  | { readonly status: "ROLLED_BACK"; readonly version: string; readonly transactionId: string; readonly reason: string };
