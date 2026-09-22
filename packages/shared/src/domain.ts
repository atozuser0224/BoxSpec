declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type ProjectId = Brand<string, "ProjectId">;
export type ScreenId = Brand<string, "ScreenId">;
export type LayoutDraftId = Brand<string, "LayoutDraftId">;
export type ThemeId = Brand<string, "ThemeId">;
export type NodeId = Brand<string, "NodeId">;
export type TaskId = Brand<string, "TaskId">;
export type CandidateId = Brand<string, "CandidateId">;
export type ReportId = Brand<string, "ReportId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type RequestId = Brand<string, "RequestId">;
export type TransactionId = Brand<string, "TransactionId">;
export type GrantId = Brand<string, "GrantId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ExecutionProfileId = Brand<string, "ExecutionProfileId">;
export type VerificationProfileId = Brand<string, "VerificationProfileId">;
export type IpcSessionId = Brand<string, "IpcSessionId">;
export type ApplyConfirmationToken = Brand<string, "ApplyConfirmationToken">;
export type RecoveryNonce = Brand<string, "RecoveryNonce">;
export type ApprovedRootHandle = Brand<string, "ApprovedRootHandle">;
export type Sha256 = Brand<string, "Sha256">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type RelativePath = Brand<string, "RelativePath">;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Result<Value, Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error };

export type TaskState =
  | "CREATED"
  | "PREPARING"
  | "READY"
  | "IMPLEMENTING"
  | "SNAPSHOTTING"
  | "VERIFYING"
  | "NEEDS_REPAIR"
  | "PENDING_APPROVAL"
  | "APPLYING"
  | "APPLIED"
  | "CANCELLED"
  | "FAILED"
  | "STALE";

export type VerificationStatus =
  | "PASS"
  | "FAIL"
  | "UNVERIFIED"
  | "ERROR"
  | "STALE";

export type Principal =
  | { readonly kind: "desktop"; readonly principalId: string }
  | { readonly kind: "mcp-client"; readonly principalId: string; readonly grantId: GrantId }
  | { readonly kind: "verifier"; readonly principalId: string }
  | { readonly kind: "system"; readonly principalId: string };

export interface MutationContext {
  readonly principal: Principal;
  readonly requestId: RequestId;
  readonly canonicalPayloadHash: Sha256;
  readonly projectId: ProjectId;
  readonly taskId?: TaskId;
  readonly expectedRevision?: number;
}

export interface ContentAddressedFile {
  readonly path: RelativePath;
  readonly kind: "file";
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

export interface CandidateIdentity {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly candidateId: CandidateId;
  readonly baseContractRevision: number;
  /** Hash of the complete immutable source snapshot used by the verifier. */
  readonly treeHash: Sha256;
  readonly baseContractHash: Sha256;
  readonly effectiveContractHash: Sha256;
  readonly layoutOverridesHash: Sha256;
  readonly baseCommitHash: Sha256;
  readonly baseManifestHash: Sha256;
  /** Complete canonical source manifest represented by treeHash. */
  readonly files: readonly ContentAddressedFile[];
  readonly changedPaths: readonly RelativePath[];
}

export interface VerificationBinding {
  readonly reportId: ReportId;
  readonly status: VerificationStatus;
  readonly verificationProfileId: VerificationProfileId;
  readonly evidenceHash: Sha256;
  readonly verificationProfileHash: Sha256;
  readonly policyHash: Sha256;
  readonly policyRevision: number;
  readonly generatorVersion: string;
  readonly dependencyLockHash: Sha256;
  readonly fixturesHash: Sha256;
  readonly checkedAt: IsoTimestamp;
}

export interface ApprovalBinding {
  readonly approvalId: ApprovalId;
  readonly candidate: CandidateIdentity;
  readonly verification: VerificationBinding;
  readonly approvedBy: Extract<Principal, { readonly kind: "desktop" }>;
  readonly approvedAt: IsoTimestamp;
}

export interface ApprovedExecutionProfile {
  readonly profileId: ExecutionProfileId;
  readonly executablePath: string;
  readonly executableHash: Sha256;
  readonly args: readonly string[];
  readonly relativeWorkingDirectory: RelativePath;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly networkIntent: "none" | "loopback" | "external";
  readonly approvedAt: IsoTimestamp;
}
