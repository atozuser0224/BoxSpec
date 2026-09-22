import type { ContextSlice, LayoutContract, Target } from "./contracts.js";
import type {
  ApprovalBinding,
  ArtifactId,
  CandidateId,
  GrantId,
  JsonObject,
  LayoutDraftId,
  NodeId,
  Principal,
  ProjectId,
  ReportId,
  RequestId,
  ScreenId,
  Sha256,
  TaskId,
  TaskState,
  ThemeId,
  TransactionId,
  VerificationProfileId,
} from "./domain.js";
import type { ToolResult } from "./errors.js";
import type { ApplyResult, RecoveryInput, RecoveryInspection, RecoveryResult, VerificationReport } from "./services.js";

export const SAFE_MCP_TOOL_NAMES = [
  "boxspec_get_capabilities",
  "boxspec_list_projects",
  "boxspec_get_selection",
  "boxspec_get_context",
  "boxspec_search_assets",
  "boxspec_start_task",
  "boxspec_get_task",
  "boxspec_propose_patch",
  "boxspec_submit_candidate",
  "boxspec_verify_candidate",
  "boxspec_get_report",
  "boxspec_get_artifact",
  "boxspec_propose_contract_change",
  "boxspec_request_review",
  "boxspec_cancel_task",
] as const;
export type SafeMcpToolName = (typeof SAFE_MCP_TOOL_NAMES)[number];

export interface CoreUseCases {
  invoke(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    tool: SafeMcpToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult<unknown>>;
}

export interface DesktopProjectSummary { readonly projectId: ProjectId; readonly name: string; readonly rootPath: string; readonly target: Target }
export interface DesktopScreenSummary { readonly screenId: ScreenId; readonly name: string; readonly revision: number }
export interface EditorState { readonly contract: LayoutContract; readonly contractHash: Sha256; readonly selectedNodeIds: readonly NodeId[] }
export interface LayoutDraftSummary {
  readonly proposalId: LayoutDraftId;
  readonly projectId: ProjectId;
  readonly screenId: ScreenId;
  /** Approved contract revision from which this isolated draft was created. */
  readonly baseRevision: number;
  readonly baseContractHash: Sha256;
  /** Contract revision that will be published; always baseRevision + 1. */
  readonly targetRevision: number;
  /** Monotonic revision for user edits within the isolated draft. */
  readonly draftRevision: number;
  readonly reason: string;
  readonly principalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "AWAITING_USER" | "USER_EDITING_DRAFT" | "STALE" | "PUBLISHED" | "DISMISSED";
}
export interface LayoutDraftDetail {
  readonly summary: LayoutDraftSummary;
  /** Complete live canvas contract. Nodes retain the stable IDs and names authored by the agent. */
  readonly contract: LayoutContract;
  readonly draftContractHash: Sha256;
  readonly selectedNodeIds: readonly NodeId[];
}
export interface LayoutImplementationHandoff {
  readonly handoffId: string;
  readonly projectId: ProjectId;
  readonly screenId: ScreenId;
  readonly proposalId: LayoutDraftId;
  readonly baseRevision: number;
  readonly baseContractHash: Sha256;
  /** Newly published contract revision available through boxspec_get_context. */
  readonly newRevision: number;
  readonly newContractHash: Sha256;
  readonly addedNodeIds: readonly NodeId[];
  readonly changedNodeIds: readonly NodeId[];
  readonly removedNodeIds: readonly NodeId[];
  readonly affectedNodeIds: readonly NodeId[];
  readonly status: "AWAITING_AGENT";
}
export interface ThemeGalleryItem {
  readonly id: ThemeId;
  readonly name: string;
  readonly description: string;
  readonly mode: "light" | "dark" | "mixed";
  readonly style: string;
  readonly tags: readonly string[];
  readonly source: { readonly name: string; readonly url: string; readonly license?: string };
  readonly preview: { readonly kind: "local" | "remote-fallback"; readonly src: string; readonly alt: string; readonly credit: string };
  readonly palette: readonly { readonly hex: string; readonly role: string }[];
  readonly typography: { readonly body: string; readonly display: string };
  readonly tokens: {
    readonly colors: { readonly background: string; readonly surface: string; readonly text: string; readonly accent: string; readonly border?: string };
    readonly fontFamily: string;
    readonly headingFontFamily?: string;
    readonly radius: number;
  };
}
export interface ReviewSummary { readonly candidateId: CandidateId; readonly reportId: ReportId; readonly status: "PENDING_APPROVAL" | "STALE" }
export interface DesktopReview {
  readonly summary: ReviewSummary;
  readonly candidate: ApprovalBinding["candidate"];
  readonly verification: ApprovalBinding["verification"];
  readonly report: VerificationReport;
  readonly reviewNonce: string;
}
export interface ClientSetup { readonly client: "codex" | "claude-code" | "opencode"; readonly configured: boolean; readonly diagnostic: string }
export interface ClientConfigPlan {
  readonly planId: string;
  readonly client: ClientSetup["client"];
  readonly targetPath: string;
  readonly expectedExistingHash: Sha256 | null;
  readonly renderedText: string;
  readonly unifiedDiff: string;
}
export interface ProjectGrant {
  readonly grantId: GrantId;
  readonly projectId: ProjectId;
  readonly principalId: string;
  readonly permissions: readonly ("read" | "candidate-write" | "verify")[];
  readonly expiresAt: string;
}
export interface SourceDrift {
  readonly driftId: string;
  readonly projectId: ProjectId;
  readonly paths: readonly string[];
  readonly detectedTreeHash: Sha256;
}

export interface DesktopUseCases {
  listProjects(signal?: AbortSignal): Promise<readonly DesktopProjectSummary[]>;
  createProject(input: { readonly name: string; readonly rootPath: string; readonly target: "web-react" }, signal?: AbortSignal): Promise<DesktopProjectSummary>;
  openProject(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<DesktopProjectSummary>;
  listScreens(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly DesktopScreenSummary[]>;
  createScreen(input: { readonly projectId: ProjectId; readonly name: string; readonly width: number; readonly height: number }, signal?: AbortSignal): Promise<DesktopScreenSummary>;
  getEditorState(input: { readonly projectId: ProjectId; readonly screenId: ScreenId }, signal?: AbortSignal): Promise<EditorState>;
  listLayoutDrafts(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly LayoutDraftSummary[]>;
  openLayoutDraft(input: { readonly projectId: ProjectId; readonly proposalId: LayoutDraftId }, signal?: AbortSignal): Promise<LayoutDraftDetail>;
  updateLayoutDraft(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly expectedDraftRevision: number; readonly contract: LayoutContract }, signal?: AbortSignal): Promise<LayoutDraftDetail>;
  /** User action behind “implement this layout”; publishes the layout context but does not approve code. */
  publishLayoutDraft(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly expectedDraftRevision: number; readonly expectedBaseRevision: number; readonly expectedBaseHash: Sha256 }, signal?: AbortSignal): Promise<LayoutImplementationHandoff>;
  listThemeGallery(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly ThemeGalleryItem[]>;
  applyThemeToLayoutDraft(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly themeId: ThemeId; readonly expectedDraftRevision: number }, signal?: AbortSignal): Promise<LayoutDraftDetail>;
  applyThemeToScreen(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly themeId: ThemeId; readonly expectedRevision: number }, signal?: AbortSignal): Promise<EditorState>;
  executeEditorCommand(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly expectedRevision: number; readonly command: JsonObject }, signal?: AbortSignal): Promise<EditorState>;
  undo(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly expectedRevision: number }, signal?: AbortSignal): Promise<EditorState>;
  redo(input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly expectedRevision: number }, signal?: AbortSignal): Promise<EditorState>;
  saveProject(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<{ readonly saved: true }>;
  listReviewQueue(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly ReviewSummary[]>;
  inspectReview(input: { readonly projectId: ProjectId; readonly candidateId: CandidateId }, signal?: AbortSignal): Promise<DesktopReview>;
  approveAndApply(input: { readonly projectId: ProjectId; readonly candidateId: CandidateId; readonly reportId: ReportId; readonly reviewNonce: string }, signal?: AbortSignal): Promise<ApplyResult>;
  listRecovery(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly TransactionId[]>;
  inspectRecovery(input: { readonly projectId: ProjectId; readonly transactionId: TransactionId }, signal?: AbortSignal): Promise<RecoveryInspection>;
  recoverApply(input: { readonly projectId: ProjectId; readonly recovery: RecoveryInput }, signal?: AbortSignal): Promise<RecoveryResult>;
  inspectSourceDrift(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly SourceDrift[]>;
  resolveSourceDrift(input: { readonly projectId: ProjectId; readonly driftId: string; readonly resolution: "propose-contract" | "restore-contract" | "unmanage" }, signal?: AbortSignal): Promise<{ readonly resolved: true }>;
  pairMcpClient(input: { readonly projectId: ProjectId; readonly principalId: string; readonly permissions: readonly ("read" | "candidate-write" | "verify")[]; readonly expiresAt: string }, signal?: AbortSignal): Promise<ProjectGrant>;
  revokeMcpGrant(input: { readonly projectId: ProjectId; readonly grantId: GrantId }, signal?: AbortSignal): Promise<{ readonly revoked: true }>;
  getClientSetup(input: { readonly projectId: ProjectId }, signal?: AbortSignal): Promise<readonly ClientSetup[]>;
  prepareClientConfig(input: { readonly projectId: ProjectId; readonly client: ClientSetup["client"]; readonly scope: "project" | "user" }, signal?: AbortSignal): Promise<ClientConfigPlan>;
  applyClientConfig(input: { readonly projectId: ProjectId; readonly planId: string; readonly expectedExistingHash: Sha256 | null }, signal?: AbortSignal): Promise<ClientSetup>;
  diagnoseClient(input: { readonly projectId: ProjectId; readonly client: ClientSetup["client"] }, signal?: AbortSignal): Promise<ClientSetup>;
}

export interface RuntimeDependencies {
  readonly core: CoreUseCases;
  readonly desktop: DesktopUseCases;
}

export interface BoxSpecRuntime {
  readonly mcp: CoreUseCases;
  readonly desktop: DesktopUseCases;
  close(): Promise<void>;
}

export const DESKTOP_OPERATION_NAMES = [
  "listProjects",
  "createProject",
  "openProject",
  "listScreens",
  "createScreen",
  "getEditorState",
  "listLayoutDrafts",
  "openLayoutDraft",
  "updateLayoutDraft",
  "publishLayoutDraft",
  "listThemeGallery",
  "applyThemeToLayoutDraft",
  "applyThemeToScreen",
  "executeEditorCommand",
  "undo",
  "redo",
  "saveProject",
  "listReviewQueue",
  "inspectReview",
  "approveAndApply",
  "listRecovery",
  "inspectRecovery",
  "recoverApply",
  "inspectSourceDrift",
  "resolveSourceDrift",
  "pairMcpClient",
  "revokeMcpGrant",
  "getClientSetup",
  "prepareClientConfig",
  "applyClientConfig",
  "diagnoseClient",
] as const;
export type DesktopOperationName = (typeof DESKTOP_OPERATION_NAMES)[number];

export type CoreIpcRequest =
  | {
      readonly protocolVersion: "1.0.0";
      readonly channel: "mcp";
      readonly requestId: RequestId;
      readonly tool: SafeMcpToolName;
      readonly payload: unknown;
    }
  | {
      readonly protocolVersion: "1.0.0";
      readonly channel: "desktop";
      readonly requestId: RequestId;
      readonly operation: DesktopOperationName;
      readonly payload: unknown;
    };

export interface CoreIpcResponse {
  readonly protocolVersion: "1.0.0";
  readonly requestId: RequestId;
  readonly result: ToolResult<unknown>;
}

/** A client is created for one authenticated connection and role; identity is never read from a request payload. */
export interface CoreIpcClient {
  invoke(request: CoreIpcRequest, signal?: AbortSignal): Promise<CoreIpcResponse>;
  close(): Promise<void>;
}

export type RuntimeTaskSnapshot = {
  readonly taskId: TaskId;
  readonly state: TaskState;
  readonly context?: ContextSlice;
  readonly candidateId?: CandidateId;
  readonly report?: VerificationReport;
};

export type RuntimeVerificationRequest = {
  readonly requestId: RequestId;
  readonly taskId: TaskId;
  readonly candidateId: CandidateId;
  readonly verificationProfileId: VerificationProfileId;
};

export type RuntimeArtifact = {
  readonly artifactId: ArtifactId;
  readonly sha256: Sha256;
  readonly mimeType: string;
  readonly sizeBytes: number;
};
