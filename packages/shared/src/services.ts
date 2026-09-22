import type { LayoutContract, Target } from "./contracts.js";
import type {
  ApprovalBinding,
  ApplyConfirmationToken,
  ApprovedExecutionProfile,
  ApprovedRootHandle,
  CandidateId,
  CandidateIdentity,
  ContentAddressedFile,
  ProjectId,
  GrantId,
  RelativePath,
  RecoveryNonce,
  ReportId,
  Result,
  Sha256,
  TransactionId,
  VerificationProfileId,
  VerificationStatus,
} from "./domain.js";
import type { BoxSpecError } from "./errors.js";

export interface Diagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
}

export interface TargetCapabilities {
  readonly target: Target;
  readonly status: "available" | "experimental" | "unavailable";
  readonly supportedLayoutModes: readonly LayoutContract["nodes"][number]["layout"]["mode"][];
  readonly reason?: string;
}

export interface CompileInput {
  readonly contract: LayoutContract;
  readonly contractHash: Sha256;
  readonly effectiveContractHash: Sha256;
  readonly generatorVersion: string;
}

export interface GeneratedManifest {
  readonly manifestHash: Sha256;
  readonly files: readonly ContentAddressedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface LayoutCompiler {
  capabilities(): TargetCapabilities;
  validate(contract: LayoutContract): readonly Diagnostic[];
  compile(input: CompileInput, signal?: AbortSignal): Promise<Result<GeneratedManifest, BoxSpecError>>;
}

export interface FrozenCandidateInput {
  readonly candidate: CandidateIdentity;
  readonly snapshotRoot: string;
  readonly contract: LayoutContract;
  readonly profileId: VerificationProfileId;
  readonly profileHash: Sha256;
  readonly policyRevision: number;
  readonly policyHash: Sha256;
  readonly trustedPolicyRoot: string;
  readonly fixturesRoot: string;
  readonly fixturesHash: Sha256;
  readonly dependencyLockPath: RelativePath;
  readonly dependencyLockHash: Sha256;
  readonly generatorVersion: string;
  readonly evidenceRoot: string;
  readonly executionProfiles: Readonly<Partial<Record<
    "types" | "build" | "preview" | "interactions" | "accessibility" | "visual",
    ApprovedExecutionProfile
  >>>;
}

export interface VerificationCheck {
  readonly checkId: string;
  readonly status: VerificationStatus;
  readonly nodeId: string | null;
  readonly code: string;
  readonly message: string;
  readonly artifactIds: readonly string[];
}

export interface VerificationReport {
  readonly reportId: ReportId;
  readonly candidateId: CandidateId;
  readonly treeHash: Sha256;
  readonly contractHash: Sha256;
  readonly effectiveContractHash: Sha256;
  readonly layoutOverridesHash: Sha256;
  readonly evidenceHash: Sha256;
  readonly status: VerificationStatus;
  readonly checks: readonly VerificationCheck[];
  readonly artifactIds: readonly string[];
}

export interface RenderVerifier {
  verify(input: FrozenCandidateInput, signal?: AbortSignal): Promise<Result<VerificationReport, BoxSpecError>>;
}

export interface ApprovedProjectRoot {
  readonly projectId: ProjectId;
  readonly grantId: GrantId;
  readonly canonicalPath: string;
  readonly grantRevision: number;
  readonly approvedRootHandle: ApprovedRootHandle;
  readonly identity: {
    readonly volumeSerial: string;
    readonly fileId: string;
  };
}
export interface DetectionResult { readonly detected: boolean; readonly target: Target | null; readonly diagnostics: readonly Diagnostic[] }
export interface InspectionInput { readonly root: ApprovedProjectRoot }
export interface ProjectInventory { readonly manifestHash: Sha256; readonly files: readonly ContentAddressedFile[] }
export interface ApprovedTaskInput { readonly project: ApprovedProjectRoot; readonly contract: LayoutContract; readonly executionProfile: ApprovedExecutionProfile }
export interface WorkspaceHandle { readonly taskId: string; readonly canonicalRoot: string; readonly baseCommitHash: Sha256 }
export interface CollectCandidateInput { readonly workspace: WorkspaceHandle; readonly allowedPaths: readonly RelativePath[] }
export interface CandidateManifest { readonly treeHash: Sha256; readonly files: readonly ContentAddressedFile[] }

export interface ProjectAdapter {
  detect(root: ApprovedProjectRoot, signal?: AbortSignal): Promise<Result<DetectionResult, BoxSpecError>>;
  inspect(input: InspectionInput, signal?: AbortSignal): Promise<Result<ProjectInventory, BoxSpecError>>;
  prepare(input: ApprovedTaskInput, signal?: AbortSignal): Promise<Result<WorkspaceHandle, BoxSpecError>>;
  collect(input: CollectCandidateInput, signal?: AbortSignal): Promise<Result<CandidateManifest, BoxSpecError>>;
}

export interface ApprovedCandidateInput { readonly approval: ApprovalBinding }
export interface ApplyPlan { readonly transactionId: TransactionId; readonly approval: ApprovalBinding; readonly files: readonly ContentAddressedFile[] }
export interface ConfirmedApplyPlan { readonly transactionId: TransactionId; readonly confirmationToken: ApplyConfirmationToken }
export interface ApplyResult { readonly transactionId: TransactionId; readonly status: "APPLIED"; readonly appliedTreeHash: Sha256 }
export interface RecoveryPathState {
  readonly path: RelativePath;
  readonly state: "BEFORE" | "AFTER" | "UNKNOWN";
  readonly currentHash: Sha256 | null;
  readonly beforeHash: Sha256 | null;
  readonly afterHash: Sha256 | null;
}
export interface RecoveryInspection {
  readonly transactionId: TransactionId;
  readonly journalHash: Sha256;
  readonly recoveryNonce: RecoveryNonce;
  readonly paths: readonly RecoveryPathState[];
}
export interface RecoveryInput {
  readonly transactionId: TransactionId;
  readonly recoveryNonce: RecoveryNonce;
  readonly strategy: "finish-after" | "restore-before";
  readonly unknownPathDecisions: readonly {
    readonly path: RelativePath;
    readonly action: "preserve-current" | "finish-after" | "restore-before";
  }[];
}
export interface RecoveryResult { readonly transactionId: TransactionId; readonly status: "RECOVERED" | "BLOCKED"; readonly unknownPaths: readonly RelativePath[] }

export interface ChangeManager {
  prepareApply(input: ApprovedCandidateInput, signal?: AbortSignal): Promise<Result<ApplyPlan, BoxSpecError>>;
  apply(input: ConfirmedApplyPlan, signal?: AbortSignal): Promise<Result<ApplyResult, BoxSpecError>>;
  inspectRecovery(transactionId: TransactionId, signal?: AbortSignal): Promise<Result<RecoveryInspection, BoxSpecError>>;
  recover(input: RecoveryInput, signal?: AbortSignal): Promise<Result<RecoveryResult, BoxSpecError>>;
}
