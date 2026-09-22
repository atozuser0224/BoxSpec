export type VerificationStatus = "PASS" | "FAIL" | "UNVERIFIED" | "ERROR" | "STALE";
export type CheckStatus = "PASS" | "FAIL" | "ERROR" | "NOT_RUN" | "UNSUPPORTED";

export type VerificationCheckKind =
  | "integrity"
  | "schema"
  | "policy"
  | "layout"
  | "types"
  | "build"
  | "interactions"
  | "accessibility"
  | "visual";

export interface CandidateFileEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
}

export interface CandidateChange {
  readonly relativePath: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly beforeSize: number | null;
  readonly afterSize: number | null;
}

export interface CandidateIdentity {
  readonly projectId: string;
  readonly taskId: string;
  readonly treeHash: string;
  readonly contractHash: string;
  readonly effectiveContractHash: string;
  readonly layoutOverridesHash: string;
  readonly baseContractRevision: number;
  readonly baseCommitHash: string;
  readonly baseManifestHash: string;
  readonly generatorVersion: string;
  readonly policyHash: string;
  readonly policyRevision: number;
  readonly dependencyLockHash: string;
  readonly fixturesHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileHash: string;
}

export interface FrozenCandidateDescriptor {
  readonly projectId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly snapshotRoot: string;
  readonly dependencyLockPath: string;
  readonly treeHash: string;
  readonly baseContractHash: string;
  readonly effectiveContractHash: string;
  readonly layoutOverridesHash: string;
  readonly baseContractRevision: number;
  readonly baseCommitHash: string;
  readonly baseManifestHash: string;
  readonly generatorVersion: string;
  readonly policyHash: string;
  readonly policyRevision: number;
  readonly dependencyLockHash: string;
  readonly fixturesHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileHash: string;
  readonly files: readonly CandidateFileEntry[];
  readonly changedPaths: readonly string[];
  readonly changes: readonly CandidateChange[];
}

export interface ExplicitCommand {
  /** Absolute executable path. Shell strings and PATH lookup are intentionally rejected. */
  readonly executable: string;
  readonly executableSha256: string;
  readonly args: readonly string[];
  /** Candidate-relative working directory. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface VerificationPolicy {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly generatedFiles?: Readonly<Record<string, string>>;
}

export interface InteractionStep {
  readonly action: "click" | "fill" | "expect-count" | "expect-text" | "expect-visible";
  readonly selector: string;
  readonly value?: string;
  readonly count?: number;
  readonly text?: string;
}

export interface InteractionScenario {
  readonly id: string;
  readonly fixtureId: string;
  readonly viewportId: string;
  readonly steps: readonly InteractionStep[];
}

export interface VerificationProfile {
  readonly build: ExplicitCommand;
  readonly typecheck: ExplicitCommand;
  /** Build argv may use the exact token `{outputDir}`. */
  readonly route: string;
  readonly outputDirectoryName?: string;
  readonly fixtureQueryParameter?: string;
  readonly interactions: readonly InteractionScenario[];
  readonly browserExecutablePath?: string;
  readonly browserExecutableSha256?: string;
  /** Complete package-owned asset closures, rechecked during every verification invocation. */
  readonly trustedAssetClosures?: readonly TrustedAssetClosure[];
}

export interface TrustedAssetEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface TrustedAssetClosure {
  readonly rootPath: string;
  readonly resourcesRoot: string;
  readonly entries: readonly TrustedAssetEntry[];
}

export interface NodeMeasurement {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly overflowX: boolean;
  readonly overflowY: boolean;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly role: string | null;
  readonly label: string | null;
  readonly hitTarget: boolean;
}

export interface RenderMeasurement {
  readonly viewportId: string;
  readonly breakpointId: string | null;
  readonly fixtureId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly nodes: Readonly<Record<string, NodeMeasurement>>;
}

export interface SpatialComparison {
  readonly nodeId: string;
  readonly viewportId: string;
  readonly fixtureId: string;
  readonly before: NodeMeasurement;
  readonly after: NodeMeasurement;
  readonly delta: Readonly<{ left: number; top: number; width: number; height: number }>;
}

export interface VerificationCheck {
  readonly id: string;
  readonly kind: VerificationCheckKind;
  readonly status: CheckStatus;
  readonly blocking: boolean;
  readonly message: string;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
}

export interface Violation {
  readonly id: string;
  readonly checkId: string;
  readonly kind: string;
  readonly severity: "error" | "warning";
  readonly blocking: boolean;
  readonly message: string;
  readonly nodeId?: string;
  readonly otherNodeId?: string;
  readonly viewportId?: string;
  readonly fixtureId?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface EvidenceArtifact {
  readonly artifactId: string;
  readonly kind: "screenshot" | "metrics" | "build-log" | "interaction-log" | "report";
  /** Relative to the trusted evidence directory. Never a candidate-supplied path. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly viewportId?: string;
  readonly fixtureId?: string;
}

export interface VerificationReport {
  readonly reportId: string;
  readonly candidateId: string;
  readonly status: VerificationStatus;
  readonly identity: CandidateIdentity;
  readonly checks: readonly VerificationCheck[];
  readonly violations: readonly Violation[];
  readonly measurements: readonly RenderMeasurement[];
  readonly comparisons: readonly SpatialComparison[];
  readonly artifacts: readonly EvidenceArtifact[];
  readonly evidenceDigest: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface VerifyCandidateInput {
  readonly candidate: FrozenCandidateDescriptor;
  /** Trusted Core snapshot. The verifier never loads a contract or policy from candidate files. */
  readonly contract: unknown;
  readonly policy: VerificationPolicy;
  readonly profile: VerificationProfile;
  /** Trusted fixture values keyed by the contract fixture IDs. */
  readonly fixtures: Readonly<Record<string, unknown>>;
  /** Absolute directory outside the candidate snapshot. */
  readonly evidenceRoot: string;
  readonly baselineMeasurements?: readonly RenderMeasurement[];
  readonly signal?: AbortSignal;
}
