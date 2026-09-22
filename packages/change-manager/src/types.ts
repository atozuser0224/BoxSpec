export type ChangeManagerErrorCode =
  | "PROJECT_NOT_GRANTED"
  | "REVISION_CONFLICT"
  | "OUT_OF_SCOPE"
  | "PROTECTED_PATH"
  | "UNSUPPORTED_CAPABILITY"
  | "EXECUTION_APPROVAL_REQUIRED"
  | "CANDIDATE_STALE"
  | "VERIFY_FAILED"
  | "DIRTY_BASELINE"
  | "APPLY_CONFLICT"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class ChangeManagerError extends Error {
  override readonly name = "ChangeManagerError";

  constructor(
    readonly code: ChangeManagerErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export type TaskState =
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

export interface ProjectGrant {
  readonly grantId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly approvedByPrincipalId: string;
  readonly permissions: readonly GrantPermission[];
  readonly sourceRoot: string;
  readonly canonicalSourceRoot: string;
  readonly allowedWritePaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly executionProfileIds: readonly string[];
  readonly grantRevision: number;
  readonly rootDeviceId: string;
  readonly rootFileId: string;
  readonly nativeRootCanonicalPath?: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface RegisterProjectGrantInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly permissions: readonly GrantPermission[];
  readonly sourceRoot: string;
  /** Exact project-relative paths or directory prefixes ending in `/`. */
  readonly allowedWritePaths: readonly string[];
  /** Exact project-relative paths or directory prefixes ending in `/`. */
  readonly protectedPaths: readonly string[];
  readonly executionProfileIds: readonly string[];
  readonly grantRevision: number;
  readonly approvedPrincipalId: string;
  readonly expiresAt: string;
}

export type GrantPermission = "read" | "candidate-write" | "verify";

export interface AgentAuthorization {
  readonly principalId: string;
  readonly grantId: string;
}

export interface AuthorizeGrantInput extends AgentAuthorization {
  readonly projectId: string;
  readonly permission: GrantPermission;
}

export interface StartTaskInput extends AgentAuthorization {
  readonly projectId: string;
  readonly screenId: string;
  readonly expectedRevision: number;
  readonly scopeNodeIds: readonly string[];
  readonly objective: string;
  readonly executionProfileId: string;
  readonly contractHash: string;
  readonly policyHash: string;
  readonly policyRevision: number;
  readonly generatorVersion: string;
  readonly dependencyLockHash: string;
  readonly fixturesHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileHash: string;
  readonly expectedBaseCommit?: string;
}

export interface TaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly ownerPrincipalId: string;
  readonly grantId: string;
  readonly screenId: string;
  readonly baseContractRevision: number;
  readonly contractHash: string;
  readonly baseManifestHash: string;
  readonly policyHash: string;
  readonly policyRevision: number;
  readonly generatorVersion: string;
  readonly dependencyLockHash: string;
  readonly fixturesHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileHash: string;
  readonly grantRevision: number;
  readonly scopeNodeIds: readonly string[];
  readonly executionProfileId: string;
  readonly objective: string;
  readonly baseCommit: string;
  readonly sourceBranch: string;
  readonly workspacePath: string;
  readonly state: TaskState;
  readonly revision: number;
  readonly createdAt: string;
  readonly candidateId?: string;
}

export interface CandidateFile {
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
  readonly baseContractHash: string;
  readonly contractHash: string;
  readonly effectiveContractHash: string;
  readonly layoutOverridesHash: string;
  readonly policyHash: string;
  readonly dependencyLockHash: string;
  readonly fixturesHash: string;
  readonly verificationProfileHash: string;
  readonly verificationProfileId: string;
  readonly generatorVersion: string;
  readonly baseCommitHash: string;
  readonly baseManifestHash: string;
  readonly baseContractRevision: number;
  readonly policyRevision: number;
}

export interface FrozenCandidateDescriptor extends CandidateIdentity {
  readonly candidateId: string;
  readonly snapshotRoot: string;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly files: readonly CandidateFile[];
  readonly changes: readonly CandidateChange[];
  readonly changedPaths: readonly string[];
  /** Present only for a whole-file subset derived by the trusted desktop/runtime path. */
  readonly subsetOrigin?: SubsetCandidateOrigin;
}

export interface SubsetCandidateOrigin {
  readonly parentCandidateId: string;
  readonly parentReportId: string;
  /** Opaque digest of the trusted project-index closure packet. */
  readonly closureHash: string;
  /** Canonical, dependency-closed whole-file paths copied from the parent candidate. */
  readonly selectedPaths: readonly string[];
}

export interface CreateSubsetCandidateInput {
  readonly parentCandidateId: string;
  readonly parentReportId: string;
  readonly reviewNonce: string;
  /** Trusted runtime output. Renderer and agent inputs must never supply this field directly. */
  readonly selectedPaths: readonly string[];
  /** Trusted project-index closure packet digest; validated and bound, not recomputed from paths. */
  readonly closureHash: string;
}

export interface FreezeCandidateInput extends AgentAuthorization {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly contractHash: string;
  readonly effectiveContractHash: string;
  readonly layoutOverridesHash: string;
  readonly policyHash: string;
  readonly policyRevision: number;
}

export interface ProposePatchFile {
  readonly relativePath: string;
  readonly operation: "upsert" | "delete";
  readonly contentUtf8?: string;
}

export interface ProposePatchInput extends AgentAuthorization {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly files: readonly ProposePatchFile[];
}

export interface ProposePatchResult {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly stagingManifestHash: string;
  readonly changedPaths: readonly string[];
}

export type VerificationStatus = "PASS" | "FAIL" | "UNVERIFIED" | "ERROR" | "STALE";

export interface TrustedVerificationInput extends CandidateIdentity {
  readonly candidateId: string;
  readonly status: VerificationStatus;
  readonly reportId: string;
  readonly evidenceDigest: string;
  readonly checkedAt: string;
}

export interface VerificationRecord extends TrustedVerificationInput {
  readonly verificationId: string;
  readonly recordedAt: string;
}

export interface ReviewBinding extends CandidateIdentity {
  readonly candidateId: string;
  readonly reportId: string;
  readonly evidenceDigest: string;
  readonly verificationId: string;
}

export interface ReviewDetails {
  readonly task: TaskRecord;
  readonly candidate: FrozenCandidateDescriptor;
  readonly verification: VerificationRecord;
  readonly binding: ReviewBinding;
  readonly sourceDriftPaths: readonly string[];
  readonly canApprove: boolean;
  readonly blockReasons: readonly string[];
  /** Present only on the desktop controller response. Never returned to an agent. */
  readonly reviewNonce?: string;
}

export interface ApproveCandidateInput {
  readonly candidateId: string;
  readonly reportId: string;
  readonly reviewNonce: string;
  readonly approvedAt: string;
}

export interface ApprovalRecord extends ReviewBinding {
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly approvedPrincipalId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly confirmationTokenHash: string;
  readonly consumedAt?: string;
}

export interface ApprovalReceipt extends ApprovalRecord {
  readonly applyConfirmationToken: string;
}

export interface ApplyApprovedCandidateInput {
  readonly candidateId: string;
  readonly approvalId: string;
  readonly applyConfirmationToken: string;
}

export type ApplyJournalPhase =
  | "PREPARED"
  | "BACKED_UP"
  | "REPLACING"
  | "VERIFYING"
  | "APPLIED"
  | "ROLLED_BACK"
  | "RECOVERY_REQUIRED"
  | "SOURCE_DRIFT";

export type ApplyFileStage = "PENDING" | "BACKED_UP" | "TARGET_MOVED" | "REPLACED" | "VERIFIED";

export interface ApplyJournalFile extends CandidateChange {
  readonly targetPath: string;
  readonly snapshotPath: string | null;
  readonly backupPath: string | null;
  readonly displacedPath: string;
  readonly tempPath: string;
  readonly nativePreparedId?: string;
  readonly stage: ApplyFileStage;
}

export interface ApplyJournal {
  readonly journalVersion: 1;
  readonly transactionId: string;
  readonly candidateId: string;
  readonly approvalId: string;
  readonly projectId: string;
  readonly sourceRoot: string;
  readonly rootDeviceId: string;
  readonly rootFileId: string;
  readonly nativeRootCanonicalPath?: string;
  readonly sealedApprovalHash: string;
  readonly integrityHash: string;
  readonly phase: ApplyJournalPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly directoryIntents: readonly string[];
  readonly files: readonly ApplyJournalFile[];
}

export interface ApplyResult {
  readonly transactionId: string;
  readonly candidateId: string;
  readonly phase: "APPLIED";
  readonly appliedPaths: readonly string[];
}

export type RecoveryFileState = "BEFORE" | "AFTER" | "UNKNOWN";

export interface RecoveryInspection {
  readonly transactionId: string;
  readonly projectId: string;
  readonly phase: ApplyJournalPhase;
  readonly fileStates: readonly { relativePath: string; state: RecoveryFileState }[];
  readonly needsUserDecision: boolean;
  readonly sourceDriftPaths: readonly string[];
}

export type RecoveryDecision = "restore-before" | "finish-after";

export interface RecoveryResult {
  readonly transactionId: string;
  readonly phase: "APPLIED" | "ROLLED_BACK";
  readonly affectedPaths: readonly string[];
}

export type FaultPoint =
  | "after-journal-prepared"
  | "after-backups-written"
  | "after-temp-files-written"
  | "after-target-moved"
  | "after-file-replaced"
  | "before-final-verification"
  | "after-final-verification"
  | "after-journal-applied";

export interface ChangeManagerOptions {
  readonly stateRoot: string;
  readonly gitBinary?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: (prefix: string) => string;
  readonly verificationMaxAgeMs?: number;
  readonly approvalMaxAgeMs?: number;
  readonly maxSnapshotBytes?: number;
  readonly nativeSafeFs?: {
    readonly binaryPath: string;
    readonly expectedSha256: string;
  };
  readonly faultInjector?: (point: FaultPoint, context: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

export interface AgentChangeManager {
  startTask(input: StartTaskInput): Promise<TaskRecord>;
  freezeCandidate(input: FreezeCandidateInput): Promise<FrozenCandidateDescriptor>;
  proposePatch(input: ProposePatchInput): Promise<ProposePatchResult>;
  requestReview(input: AgentAuthorization & { candidateId: string }): Promise<ReviewDetails>;
  cancelTask(input: AgentAuthorization & { taskId: string }): Promise<TaskRecord>;
  getTask(input: AgentAuthorization & { taskId: string }): Promise<TaskRecord>;
  listTasks(input: AgentAuthorization & { projectId: string }): Promise<readonly TaskRecord[]>;
  getCandidate(input: AgentAuthorization & { candidateId: string }): Promise<FrozenCandidateDescriptor>;
  authorizeGrant(input: AuthorizeGrantInput): Promise<ProjectGrant>;
}

export interface VerifierChangeManager {
  getFrozenCandidate(candidateId: string): Promise<FrozenCandidateDescriptor>;
  recordTrustedVerification(input: TrustedVerificationInput): Promise<VerificationRecord>;
  getVerification(candidateId: string): Promise<VerificationRecord | null>;
}

export interface DesktopChangeManager {
  registerProjectGrant(input: RegisterProjectGrantInput): Promise<ProjectGrant>;
  inspectReview(candidateId: string): Promise<ReviewDetails>;
  createSubsetCandidate(input: CreateSubsetCandidateInput): Promise<FrozenCandidateDescriptor>;
  approveCandidate(input: ApproveCandidateInput): Promise<ApprovalReceipt>;
  applyApprovedCandidate(input: ApplyApprovedCandidateInput): Promise<ApplyResult>;
  inspectRecoveries(): Promise<readonly RecoveryInspection[]>;
  recoverInterruptedApply(transactionId: string, decision: RecoveryDecision): Promise<RecoveryResult>;
  getProjectGrant(projectId: string): Promise<ProjectGrant | null>;
  listProjectGrants(): Promise<readonly ProjectGrant[]>;
  listReviews(projectId: string): Promise<readonly ReviewDetails[]>;
  revokeProjectGrant(input: { projectId: string; grantId: string }): Promise<ProjectGrant>;
}

export interface ChangeManagerControllers {
  readonly agent: AgentChangeManager;
  readonly verifier: VerifierChangeManager;
  readonly desktop: DesktopChangeManager;
  initialize(): Promise<readonly RecoveryInspection[]>;
}
