export const IPC = {
  bootstrap: "boxspec:bootstrap",
  projectCreate: "boxspec:project:create",
  projectOpen: "boxspec:project:open",
  screenCreate: "boxspec:screen:create",
  screenOpen: "boxspec:screen:open",
  screenCommand: "boxspec:screen:command",
  screenUndo: "boxspec:screen:undo",
  screenRedo: "boxspec:screen:redo",
  screenSave: "boxspec:screen:save",
  draftList: "boxspec:draft:list",
  draftOpen: "boxspec:draft:open",
  draftCommand: "boxspec:draft:command",
  draftPublish: "boxspec:draft:publish",
  themeList: "boxspec:theme:list",
  themeApplyDraft: "boxspec:theme:apply-draft",
  themeApplyScreen: "boxspec:theme:apply-screen",
  themeOpenSource: "boxspec:theme:open-source",
  reviewList: "boxspec:review:list",
  reviewOpen: "boxspec:review:open",
  reviewApproveApply: "boxspec:review:approve-apply",
  recoveryResolve: "boxspec:recovery:resolve",
  recoveryInspect: "boxspec:recovery:inspect",
  driftInspect: "boxspec:drift:inspect",
  driftResolve: "boxspec:drift:resolve",
  clientStatus: "boxspec:client:status",
  clientGenerate: "boxspec:client:generate",
  clientApply: "boxspec:client:apply",
  clientDiagnose: "boxspec:client:diagnose",
  clientPair: "boxspec:client:pair",
  chooseDirectory: "boxspec:dialog:directory",
} as const;

export type ErrorCode =
  | "INVALID_REQUEST"
  | "BACKEND_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "VERIFY_FAILED"
  | "CANDIDATE_STALE"
  | "APPLY_CONFLICT"
  | "INTERNAL_ERROR";

export type DesktopResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode | string; message: string; recoverable: boolean; details?: unknown } };

export interface SizeRule {
  mode: "fixed" | "fill" | "hug";
  value?: number;
  weight?: number;
  min?: number;
  max?: number;
}

export interface CanvasNode {
  id: string;
  parentId: string | null;
  order: number;
  name: string;
  role: string;
  visible: boolean;
  layout: {
    mode: "row" | "column" | "grid" | "overlay" | "leaf";
    width: SizeRule;
    height: SizeRule;
    gap: number;
    padding: { top: number; right: number; bottom: number; left: number };
    align: "start" | "center" | "end" | "stretch";
    justify: "start" | "center" | "end" | "space-between";
    gridColumns?: number;
  };
  placement: { kind: "flow" } | { kind: "anchor"; anchorX: "left" | "center" | "right"; anchorY: "top" | "center" | "bottom"; offsetX: number; offsetY: number; zIndex: number };
  content: Record<string, unknown>;
  slot: { ownership: string; componentKey: string | null; sourcePath: string | null; exportName: string | null };
  locks: Array<{ path: string; policy: "hard" | "soft" | "free"; min?: number; max?: number }>;
  responsive: unknown[];
}

export interface EditorScreen {
  projectId: string;
  screenId: string;
  name: string;
  revision: number;
  persistedRevision?: number;
  target: "web-react";
  rootNodeId: string;
  nodes: CanvasNode[];
  defaultPolicy: { layout: "hard" | "free"; topology: "hard"; presentation: "hard" | "free"; content: "hard" | "free" };
  designSystem: { id: string; revision: number; tokens: Record<string, { type: "color" | "font-family"; value: string } | { type: "dimension"; value: number }> };
}

export interface ProjectSummary { projectId: string; name: string; rootPath?: string; }
export interface ScreenSummary { screenId: string; name: string; revision: number; }
export interface LayoutDraftSummary { proposalId: string; projectId: string; screenId: string; baseRevision: number; baseContractHash: string; targetRevision: number; draftRevision: number; reason: string; principalId: string; createdAt: string; updatedAt: string; status: "AWAITING_USER" | "USER_EDITING_DRAFT" | "STALE" | "PUBLISHED" | "DISMISSED"; }
export interface LayoutDraftState { summary: LayoutDraftSummary; contract: EditorScreen; draftContractHash: string; selectedNodeIds: string[]; }
export interface LayoutHandoff { handoffId: string; projectId: string; screenId: string; proposalId: string; baseRevision: number; baseContractHash: string; newRevision: number; newContractHash: string; addedNodeIds: string[]; changedNodeIds: string[]; removedNodeIds: string[]; affectedNodeIds: string[]; status: "AWAITING_AGENT"; }
export interface ThemeGalleryItem {
  id: string;
  name: string;
  description: string;
  mode: "light" | "dark" | "mixed";
  style: string;
  tags: string[];
  source: { name: string; url: string; license?: string };
  preview: { kind: "local" | "remote-fallback"; src: string; alt: string; credit: string };
  palette: Array<{ hex: string; role: string }>;
  typography: { body: string; display: string };
  tokens: { colors: { background: string; surface: string; text: string; accent: string; border?: string }; fontFamily: string; headingFontFamily?: string; radius: number };
}

export interface RuntimeCapabilities {
  editor: boolean;
  review: boolean;
  apply: boolean;
  recovery: boolean;
  drift: boolean;
  clients: boolean;
  verifier: boolean;
  reasons?: Partial<Record<"editor" | "review" | "apply" | "recovery" | "drift" | "clients" | "verifier", string>>;
}

export interface RecoveryItem {
  transactionId: string;
  projectId: string;
  status: "INTERRUPTED" | "NEEDS_DECISION" | "ROLLBACK_AVAILABLE";
  summary: string;
  files: Array<{ path: string; state: "BEFORE" | "AFTER" | "UNKNOWN" }>;
}
export interface RecoveryInspection { transactionId: string; journalHash: string; recoveryNonce: string; paths: Array<{ path: string; state: "BEFORE" | "AFTER" | "UNKNOWN"; currentHash: string | null; beforeHash: string | null; afterHash: string | null }> }

export interface BootstrapData {
  backend: { available: boolean; version?: string; message?: string };
  capabilities: RuntimeCapabilities;
  projects: ProjectSummary[];
  recovery: RecoveryItem[];
}

export type CheckStatus = "PASS" | "FAIL" | "UNVERIFIED" | "ERROR" | "STALE";
export interface ReviewCheck { checkId: string; status: CheckStatus; nodeId?: string | null; code: string; message: string; artifactIds: string[]; }
export interface SpatialDelta { nodeId: string; before?: { x: number; y: number; width: number; height: number }; after?: { x: number; y: number; width: number; height: number }; violation?: string; }
export interface ReviewSummary { candidateId: string; reportId: string; screenId?: string; status: "PENDING_APPROVAL" | "STALE"; createdAt?: string; }
export interface ReviewDetail extends Omit<ReviewSummary, "status" | "screenId"> {
  screenId: string;
  status: CheckStatus;
  reviewNonce: string;
  candidateHash: string;
  contractRevision: number;
  policyRevision: number;
  contractHash?: string;
  effectiveContractHash?: string;
  layoutOverridesHash?: string;
  changes: Array<{ kind: "structure" | "style" | "content" | "binding" | "code"; path?: string; nodeId?: string; summary: string }>;
  checks: ReviewCheck[];
  spatial: SpatialDelta[];
  screenshotPath?: string;
}

export type ClientKind = "codex" | "claude-code" | "opencode";
export interface ClientStatus { client: ClientKind; configured: boolean; diagnostic: string; }
export interface ClientConfigPlan { planId: string; client: ClientKind; targetPath: string; expectedExistingHash: string | null; renderedText: string; unifiedDiff: string; }

export interface DesktopApi {
  bootstrap(): Promise<DesktopResult<BootstrapData>>;
  chooseDirectory(): Promise<DesktopResult<{ path: string | null }>>;
  createProject(input: { name: string; rootPath: string }): Promise<DesktopResult<{ project: ProjectSummary; screens: ScreenSummary[] }>>;
  openProject(input: { projectId: string }): Promise<DesktopResult<{ project: ProjectSummary; screens: ScreenSummary[] }>>;
  createScreen(input: { projectId: string; name: string }): Promise<DesktopResult<EditorScreen>>;
  openScreen(input: { projectId: string; screenId: string }): Promise<DesktopResult<EditorScreen>>;
  executeCommand(input: { projectId: string; screenId: string; expectedRevision: number; command: { type: "replace-contract"; contract: unknown } | { type: "rename-screen"; name: string } }): Promise<DesktopResult<EditorScreen>>;
  undo(input: { projectId: string; screenId: string; expectedRevision: number }): Promise<DesktopResult<EditorScreen>>;
  redo(input: { projectId: string; screenId: string; expectedRevision: number }): Promise<DesktopResult<EditorScreen>>;
  saveScreen(input: { projectId: string; screenId: string; expectedRevision: number }): Promise<DesktopResult<EditorScreen>>;
  listLayoutDrafts(input: { projectId: string }): Promise<DesktopResult<LayoutDraftSummary[]>>;
  openLayoutDraft(input: { projectId: string; proposalId: string }): Promise<DesktopResult<LayoutDraftState>>;
  updateLayoutDraft(input: { projectId: string; proposalId: string; expectedDraftRevision: number; contract: unknown }): Promise<DesktopResult<LayoutDraftState>>;
  publishLayoutDraft(input: { projectId: string; proposalId: string; expectedDraftRevision: number; expectedBaseRevision: number; expectedBaseHash: string }): Promise<DesktopResult<{ handoff: LayoutHandoff; editor: EditorScreen }>>;
  listThemes(input: { projectId: string }): Promise<DesktopResult<ThemeGalleryItem[]>>;
  applyThemeToDraft(input: { projectId: string; proposalId: string; themeId: string; expectedDraftRevision: number }): Promise<DesktopResult<LayoutDraftState>>;
  applyThemeToScreen(input: { projectId: string; screenId: string; themeId: string; expectedRevision: number }): Promise<DesktopResult<EditorScreen>>;
  openThemeSource(input: { projectId: string; themeId: string }): Promise<DesktopResult<{ opened: true }>>;
  listReviews(input: { projectId: string }): Promise<DesktopResult<ReviewSummary[]>>;
  openReview(input: { projectId: string; candidateId: string }): Promise<DesktopResult<ReviewDetail>>;
  approveAndApply(input: { projectId: string; candidateId: string; reportId: string; reviewNonce: string }): Promise<DesktopResult<{ transactionId: string; status: string; appliedTreeHash?: string }>>;
  inspectRecovery(input: { projectId: string; transactionId: string }): Promise<DesktopResult<RecoveryInspection>>;
  resolveRecovery(input: { projectId: string; recovery: { transactionId: string; recoveryNonce: string; strategy: "finish-after" | "restore-before"; unknownPathDecisions: Array<{ path: string; action: "preserve-current" | "finish-after" | "restore-before" }> } }): Promise<DesktopResult<{ status: string; unknownPaths: string[] }>>;
  inspectDrift(input: { projectId: string }): Promise<DesktopResult<Array<{ driftId: string; projectId: string; paths: string[]; detectedTreeHash: string }>>>;
  resolveDrift(input: { projectId: string; driftId: string; resolution: "propose-contract" | "restore-contract" | "unmanage" }): Promise<DesktopResult<{ status: string }>>;
  clientStatus(input: { projectId: string }): Promise<DesktopResult<ClientStatus[]>>;
  generateClientConfig(input: { projectId: string; client: ClientKind; scope: "project" | "user" }): Promise<DesktopResult<ClientConfigPlan>>;
  applyClientConfig(input: { projectId: string; planId: string; expectedExistingHash: string | null }): Promise<DesktopResult<ClientStatus>>;
  diagnoseClient(input: { projectId: string; client: ClientKind }): Promise<DesktopResult<ClientStatus>>;
  pairClient(input: { projectId: string; client: ClientKind }): Promise<DesktopResult<{ profilePath: string; expiresAt: string }>>;
}

export type EditorCommand =
  | { type: "rename-node"; nodeId: string; name: string }
  | { type: "set-size"; nodeId: string; axis: "width" | "height"; rule: SizeRule }
  | { type: "set-layout"; nodeId: string; mode: CanvasNode["layout"]["mode"] }
  | { type: "set-policy"; nodeId: string; path: string; policy: "hard" | "soft" | "free"; min?: number; max?: number }
  | { type: "move-node"; nodeId: string; deltaX: number; deltaY: number }
  | { type: "create-region"; parentId: string; name: string; x: number; y: number; width: number; height: number }
  | { type: "delete-node"; nodeId: string }
  | { type: "duplicate-node"; nodeId: string }
  | { type: "resize-node"; nodeId: string; edge: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw"; deltaX: number; deltaY: number }
  | { type: "group-selected"; nodeIds: string[] }
  | { type: "ungroup-selected"; nodeIds: string[] }
  | { type: "align-selected"; nodeIds: string[]; alignment: "left" | "center-x" | "right" | "top" | "center-y" | "bottom" }
  | { type: "distribute-selected"; nodeIds: string[]; axis: "horizontal" | "vertical" }
  | { type: "reparent-node"; nodeId: string; parentId: string; order: number };
