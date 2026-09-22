import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BoxSpecCore,
  applyLayoutOverrides,
  compileReactShell,
  hashContract,
  parseLayoutContract,
} from "@boxspec/core";
import type { CoreCommand, LayoutOverride } from "@boxspec/core";
import type {
  AgentChangeManager,
  ChangeManagerControllers,
  DesktopChangeManager,
  FrozenCandidateDescriptor,
  ReviewDetails,
  TaskRecord,
  VerifierChangeManager,
} from "@boxspec/change-manager";
import { NativeSafeFsClient } from "@boxspec/change-manager";
import type { LayoutContract } from "@boxspec/shared/contracts";
import type {
  CandidateId,
  GrantId,
  JsonObject,
  LayoutDraftId,
  NodeId,
  Principal,
  ProjectId,
  RelativePath,
  ReportId,
  RequestId,
  ScreenId,
  Sha256,
  TransactionId,
  ThemeId,
  VerificationStatus,
} from "@boxspec/shared/domain";
import type { ToolResult } from "@boxspec/shared/errors";
import type {
  ApplyResult as SharedApplyResult,
  RecoveryInput,
  RecoveryInspection as SharedRecoveryInspection,
  RecoveryResult as SharedRecoveryResult,
  VerificationCheck as SharedVerificationCheck,
  VerificationReport as SharedVerificationReport,
} from "@boxspec/shared/services";
import type {
  BoxSpecRuntime,
  ClientConfigPlan,
  ClientSetup,
  CoreUseCases,
  DesktopProjectSummary,
  DesktopReview,
  DesktopScreenSummary,
  DesktopUseCases,
  EditorState,
  LayoutDraftDetail,
  LayoutDraftSummary,
  LayoutImplementationHandoff,
  ProjectGrant,
  ReviewSummary,
  SafeMcpToolName,
  SourceDrift,
  ThemeGalleryItem,
} from "@boxspec/shared/runtime";
import type {
  EvidenceArtifact,
  FrozenCandidateDescriptor as VerifierFrozenCandidateDescriptor,
  VerificationProfile,
  VerificationReport as TrustedVerificationReport,
  VerifyCandidateInput,
} from "@boxspec/verifier";
import {
  applyThemeToContract,
  applyThemeToDraft,
  getThemeGallery,
  getThemePreset,
} from "@boxspec/themes";
import { canonicalize, hashCanonical } from "./canonical.js";
import { createDashboardContract } from "./dashboard-template.js";
import { RuntimeError, mapRuntimeError } from "./errors.js";
import { atomicWriteUtf8, pathExists, sha256File, sha256Text } from "./files.js";
import {
  assertNoExtraFields,
  enumField,
  idField,
  integerField,
  objectInput,
  stringArrayField,
  stringField,
  throwIfAborted,
} from "./input.js";
import { RuntimeLease } from "./runtime-lease.js";
import { RuntimeStateStore, type RuntimeProjectRecord, type RuntimeProposal } from "./state-store.js";
import {
  inspectManagedSourceDrift,
  planManagedSourceDriftResolution,
  ManagedSourceDriftError,
  type ManagedFileObservation,
  type ManagedOutputIntent,
  type ManagedOwnershipRecord,
  type ManagedSourceDriftInspection,
  type SafeManagedWrite,
} from "./source-drift-recovery.js";

const execFileAsync = promisify(execFile);
const WRITE_TOOLS = new Set<SafeMcpToolName>([
  "boxspec_start_task",
  "boxspec_propose_patch",
  "boxspec_submit_candidate",
  "boxspec_verify_candidate",
  "boxspec_propose_contract_change",
  "boxspec_request_review",
  "boxspec_cancel_task",
]);

export interface RuntimeOptions {
  readonly dataDir: string;
  readonly changeManager: ChangeManagerControllers;
  readonly verifyCandidate: (input: VerifyCandidateInput) => Promise<TrustedVerificationReport>;
  readonly verificationProfiles?: Readonly<Record<string, VerificationProfile>>;
  readonly defaultVerificationProfileId?: string;
  readonly fixtures?: Readonly<Record<string, unknown>>;
  readonly allowedWritePaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly approvedExecutionProfileIds?: readonly string[];
  readonly mcpLauncherPath?: string;
  readonly mcpLauncherArgs?: readonly string[];
  readonly nativeSafeFs?: { readonly binaryPath: string; readonly expectedSha256: string };
  readonly clock?: () => Date;
  readonly idGenerator?: (prefix: string) => string;
  readonly lease?: RuntimeLease;
}

export interface McpSessionBinding {
  readonly principalId: string;
  readonly grantId: GrantId;
  readonly projectId: ProjectId;
  readonly permissions: readonly ("read" | "candidate-write" | "verify")[];
  readonly expiresAt: string;
}

interface ReviewNonceRecord {
  readonly projectId: string;
  readonly candidateId: string;
  readonly reportId: string;
  readonly bindingHash: string;
  readonly expiresAt: number;
}

interface RecoveryNonceRecord {
  readonly projectId: string;
  readonly transactionId: string;
  readonly inspectionHash: string;
  readonly expiresAt: number;
}

interface ClientPlanRecord extends ClientConfigPlan {
  readonly projectId: string;
}

export class BoxSpecApplicationRuntime implements BoxSpecRuntime {
  readonly mcp: CoreUseCases;
  readonly desktop: DesktopUseCases;
  readonly #options: RuntimeOptions;
  readonly #state: RuntimeStateStore;
  readonly #core = new Map<string, BoxSpecCore>();
  readonly #inflight = new Map<string, { requestHash: string; promise: Promise<ToolResult<unknown>> }>();
  readonly #reviewNonces = new Map<string, ReviewNonceRecord>();
  readonly #recoveryNonces = new Map<string, RecoveryNonceRecord>();
  readonly #clientPlans = new Map<string, ClientPlanRecord>();
  readonly #nativeSafeFs: NativeSafeFsClient | null;
  #closed = false;

  private constructor(options: RuntimeOptions, state: RuntimeStateStore) {
    this.#options = options;
    this.#state = state;
    this.#nativeSafeFs = options.nativeSafeFs ? new NativeSafeFsClient(options.nativeSafeFs.binaryPath, options.nativeSafeFs.expectedSha256) : null;
    this.mcp = { invoke: this.#invoke.bind(this) };
    this.desktop = this.#createDesktopUseCases();
  }

  static async open(options: RuntimeOptions): Promise<BoxSpecApplicationRuntime> {
    if (!isAbsolute(options.dataDir)) throw new RuntimeError("INVALID_REQUEST", "dataDir must be absolute");
    assertVerificationComposition(options);
    await mkdir(options.dataDir, { recursive: true });
    const state = new RuntimeStateStore(join(options.dataDir, "runtime-state.json"));
    await state.initialize();
    await options.changeManager.initialize();
    const runtime = new BoxSpecApplicationRuntime(options, state);
    await runtime.#reconcileManagedWrites();
    await runtime.#reconcileManagedSaveBatches();
    await runtime.#reconcileDraftPublications();
    return runtime;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#inflight.values()].map((entry) => entry.promise));
    for (const core of this.#core.values()) core.close();
    this.#core.clear();
    await this.#state.close();
    await this.#options.lease?.release();
  }

  async authorizeMcpSession(binding: McpSessionBinding, tool: SafeMcpToolName, payload: unknown, signal?: AbortSignal): Promise<void> {
    this.#assertOpen(); throwIfAborted(signal);
    const principal = { kind: "mcp-client" as const, principalId: binding.principalId, grantId: binding.grantId };
    const grant = await this.#authorizeAny(principal);
    if (grant.projectId !== binding.projectId || grant.expiresAt !== binding.expiresAt || hashCanonical(grant.permissions) !== hashCanonical(binding.permissions)) {
      throw new RuntimeError("PAIRING_REQUIRED", "IPC session binding no longer matches the durable grant", { recoverable: true });
    }
    const permission = permissionForTool(tool);
    if (permission) await this.#authorize(principal, binding.projectId, permission);
    if (isRecord(payload) && typeof payload["projectId"] === "string" && payload["projectId"] !== binding.projectId) {
      throw new RuntimeError("PROJECT_NOT_GRANTED", "Request project differs from the authenticated session");
    }
  }

  #createDesktopUseCases(): DesktopUseCases {
    return {
      listProjects: async (signal) => {
        this.#assertOpen(); throwIfAborted(signal);
        return Object.values(this.#state.snapshot().projects).map(toProjectSummary);
      },
      createProject: async (input, signal) => this.#createProject(input, signal),
      openProject: async (input, signal) => {
        this.#assertOpen(); throwIfAborted(signal);
        const project = this.#project(input.projectId);
        this.#coreFor(project);
        return toProjectSummary(project);
      },
      listScreens: async (input, signal) => {
        this.#assertOpen(); throwIfAborted(signal);
        return this.#coreFor(this.#project(input.projectId)).listScreens(input.projectId).map((screen) => ({
          screenId: screen.screenId as ScreenId,
          name: screen.name,
          revision: screen.revision,
        }));
      },
      createScreen: async (input, signal) => this.#createScreen(input, signal),
      getEditorState: async (input, signal) => this.#getEditorState(input.projectId, input.screenId, signal),
      listLayoutDrafts: async (input, signal) => this.#listLayoutDrafts(input.projectId, signal),
      openLayoutDraft: async (input, signal) => this.#openLayoutDraft(input.projectId, input.proposalId, signal),
      updateLayoutDraft: async (input, signal) => this.#updateLayoutDraft(input, signal),
      publishLayoutDraft: async (input, signal) => this.#publishLayoutDraft(input, signal),
      listThemeGallery: async (input, signal) => this.#listThemeGallery(input.projectId, signal),
      applyThemeToLayoutDraft: async (input, signal) => this.#applyThemeToLayoutDraft(input, signal),
      applyThemeToScreen: async (input, signal) => this.#applyThemeToScreen(input, signal),
      executeEditorCommand: async (input, signal) => this.#executeEditorCommand(input, signal),
      undo: async (input, signal) => this.#undoRedo("undo", input, signal),
      redo: async (input, signal) => this.#undoRedo("redo", input, signal),
      saveProject: async (input, signal) => this.#saveProject(input.projectId, signal),
      listReviewQueue: async (input, signal) => this.#listReviewQueue(input.projectId, signal),
      inspectReview: async (input, signal) => this.#inspectReview(input.projectId, input.candidateId, signal),
      approveAndApply: async (input, signal) => this.#approveAndApply(input, signal),
      listRecovery: async (input, signal) => this.#listRecovery(input.projectId, signal),
      inspectRecovery: async (input, signal) => this.#inspectRecovery(input.projectId, input.transactionId, signal),
      recoverApply: async (input, signal) => this.#recoverApply(input.projectId, input.recovery, signal),
      inspectSourceDrift: async (input, signal) => this.#inspectSourceDrift(input.projectId, signal),
      resolveSourceDrift: async (input, signal) => this.#resolveSourceDrift(input.projectId, input.driftId, input.resolution, signal),
      pairMcpClient: async (input, signal) => this.#pairMcpClient(input, signal),
      revokeMcpGrant: async (input, signal) => this.#revokeMcpGrant(input.projectId, input.grantId, signal),
      getClientSetup: async (input, signal) => this.#getClientSetup(input.projectId, signal),
      prepareClientConfig: async (input, signal) => this.#prepareClientConfig(input, signal),
      applyClientConfig: async (input, signal) => this.#applyClientConfig(input, signal),
      diagnoseClient: async (input, signal) => this.#diagnoseClient(input, signal),
    };
  }

  async #listThemeGallery(projectId: ProjectId, signal?: AbortSignal): Promise<readonly ThemeGalleryItem[]> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    try {
      return getThemeGallery();
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async #applyThemeToLayoutDraft(
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly themeId: ThemeId; readonly expectedDraftRevision: number },
    signal?: AbortSignal,
  ): Promise<LayoutDraftDetail> {
    this.#assertOpen(); throwIfAborted(signal);
    const draft = await this.#openLayoutDraft(input.projectId, input.proposalId, signal);
    if (draft.summary.draftRevision !== input.expectedDraftRevision) {
      throw new RuntimeError("REVISION_CONFLICT", "Layout draft revision changed", { recoverable: true });
    }
    try {
      const themed = applyThemeToDraft(draft.contract, getThemePreset(input.themeId), {
        expectedContractRevision: draft.contract.revision,
      });
      return await this.#updateLayoutDraft({
        requestId: input.requestId,
        projectId: input.projectId,
        proposalId: input.proposalId,
        expectedDraftRevision: input.expectedDraftRevision,
        contract: themed.contract,
      }, signal);
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async #applyThemeToScreen(
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly themeId: ThemeId; readonly expectedRevision: number },
    signal?: AbortSignal,
  ): Promise<EditorState> {
    this.#assertOpen(); throwIfAborted(signal);
    const core = this.#coreFor(this.#project(input.projectId));
    const before = core.getScreen(input.projectId, input.screenId);
    try {
      const themed = applyThemeToContract(before, getThemePreset(input.themeId), { expectedRevision: input.expectedRevision });
      const result = core.execute({
        type: "replace-contract",
        projectId: input.projectId,
        screenId: input.screenId,
        commandId: input.requestId,
        expectedRevision: input.expectedRevision,
        actor: { kind: "user", id: "desktop" },
        timestamp: this.#now(),
        contract: themed.contract,
      });
      const selection = this.#state.snapshot().selections[input.projectId];
      if (selection?.screenId === input.screenId) {
        await this.#state.update((state) => ({
          ...state,
          selections: {
            ...state.selections,
            [input.projectId]: { ...selection, revision: result.revision },
          },
        }));
      }
      return {
        contract: result.contract,
        contractHash: result.contractHash as Sha256,
        selectedNodeIds: selection?.screenId === input.screenId ? selection.nodeIds as readonly NodeId[] : [],
      };
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async #createProject(
    input: { readonly name: string; readonly rootPath: string; readonly target: "web-react" },
    signal?: AbortSignal,
  ): Promise<DesktopProjectSummary> {
    this.#assertOpen(); throwIfAborted(signal);
    if (!input.name.trim() || input.name.length > 256) throw new RuntimeError("INVALID_REQUEST", "Project name is required");
    const rootPath = resolve(input.rootPath);
    const rootStat = await stat(rootPath).catch((error: unknown) => {
      throw new RuntimeError("NOT_FOUND", "Project root does not exist", { cause: error });
    });
    if (!rootStat.isDirectory()) throw new RuntimeError("INVALID_REQUEST", "Project root must be a directory");
    const duplicate = Object.values(this.#state.snapshot().projects).find((item) => item.rootPath.toLowerCase() === rootPath.toLowerCase());
    if (duplicate) return toProjectSummary(duplicate);
    const projectId = this.#id("prj");
    const now = this.#now();
    const nativeRootIdentity = this.#nativeSafeFs ? await this.#nativeSafeFs.inspectRoot(rootPath) : null;
    const record: RuntimeProjectRecord = {
      projectId,
      name: input.name.trim(),
      rootPath,
      canonicalRootPath: await realpath(rootPath),
      rootDeviceId: String((await stat(rootPath, { bigint: true })).dev),
      rootFileId: String((await stat(rootPath, { bigint: true })).ino),
      ...(nativeRootIdentity ? {
        nativeCanonicalRootPath: nativeRootIdentity.canonicalPath,
        nativeRootVolumeId: nativeRootIdentity.volumeId,
        nativeRootFileId: nativeRootIdentity.fileId,
      } : {}),
      databasePath: join(this.#options.dataDir, "projects", projectId, "state.sqlite"),
      exportRoot: rootPath,
      target: input.target,
      createdAt: now,
      updatedAt: now,
    };
    const core = this.#coreFor(record);
    core.createProject({ projectId, name: record.name, createdAt: now });
    await this.#state.update((state) => ({ ...state, projects: { ...state.projects, [projectId]: record } }));
    return toProjectSummary(record);
  }

  async #createScreen(
    input: { readonly projectId: ProjectId; readonly name: string; readonly width: number; readonly height: number },
    signal?: AbortSignal,
  ): Promise<DesktopScreenSummary> {
    this.#assertOpen(); throwIfAborted(signal);
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 240 || input.height < 240) {
      throw new RuntimeError("INVALID_REQUEST", "Screen width and height must be integers of at least 240");
    }
    const project = this.#project(input.projectId);
    const screenId = this.#id("screen");
    const contract = parseLayoutContract(createDashboardContract({
      projectId: project.projectId,
      screenId,
      name: input.name,
      width: input.width,
      height: input.height,
    }));
    const result = this.#coreFor(project).createScreen({
      contract,
      commandId: this.#id("cmd"),
      actor: { kind: "user", id: "desktop" },
      timestamp: this.#now(),
    });
    await this.#state.update((state) => ({
      ...state,
      selections: {
        ...state.selections,
        [project.projectId]: { projectId: project.projectId, screenId, nodeIds: [], revision: result.revision },
      },
    }));
    return { screenId: screenId as ScreenId, name: contract.name, revision: result.revision };
  }

  async #getEditorState(projectId: ProjectId, screenId: ScreenId, signal?: AbortSignal): Promise<EditorState> {
    this.#assertOpen(); throwIfAborted(signal);
    const contract = this.#coreFor(this.#project(projectId)).getScreen(projectId, screenId);
    const selection = this.#state.snapshot().selections[projectId];
    return {
      contract,
      contractHash: hashContract(contract) as Sha256,
      selectedNodeIds: (selection?.screenId === screenId ? selection.nodeIds : []) as readonly NodeId[],
    };
  }

  async #listLayoutDrafts(projectId: ProjectId, signal?: AbortSignal): Promise<readonly LayoutDraftSummary[]> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const core = this.#coreFor(this.#project(projectId));
    const drafts: LayoutDraftSummary[] = [];
    for (const proposal of Object.values(this.#state.snapshot().proposals)) {
      if (proposal.projectId !== projectId) continue;
      const summary = proposalSummary(proposal);
      if (summary.status === "AWAITING_USER" || summary.status === "USER_EDITING_DRAFT") try {
        const approved = core.getScreen(proposal.projectId, proposal.screenId);
        const baseHash = proposal.baseContractHash ?? hashContract(approved);
        if (approved.revision !== proposal.baseRevision || hashContract(approved) !== baseHash) {
          drafts.push({ ...summary, status: "STALE" });
          continue;
        }
      } catch {
        drafts.push({ ...summary, status: "STALE" });
        continue;
      }
      drafts.push(summary);
    }
    return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async #openLayoutDraft(projectId: ProjectId, proposalId: LayoutDraftId, signal?: AbortSignal): Promise<LayoutDraftDetail> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const proposal = this.#state.snapshot().proposals[proposalId];
    if (!proposal || proposal.projectId !== projectId) throw new RuntimeError("NOT_FOUND", "Layout draft does not exist");
    const contract = parseLayoutContract(JSON.parse(proposal.proposedContractJson) as unknown);
    const summary = proposalSummary(proposal);
    const approved = this.#coreFor(this.#project(projectId)).getScreen(projectId, proposal.screenId);
    const baseHash = proposal.baseContractHash ?? hashContract(approved);
    const stale = approved.revision !== proposal.baseRevision || hashContract(approved) !== baseHash;
    return {
      summary: stale && (summary.status === "AWAITING_USER" || summary.status === "USER_EDITING_DRAFT") ? { ...summary, status: "STALE" } : summary,
      contract,
      draftContractHash: hashContract(contract) as Sha256,
      selectedNodeIds: (proposal.selectedNodeIds ?? []) as readonly NodeId[],
    };
  }

  async #updateLayoutDraft(
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly expectedDraftRevision: number; readonly contract: LayoutContract },
    signal?: AbortSignal,
  ): Promise<LayoutDraftDetail> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(input.projectId);
    const current = this.#state.snapshot().proposals[input.proposalId];
    if (!current || current.projectId !== input.projectId) throw new RuntimeError("NOT_FOUND", "Layout draft does not exist");
    const summary = proposalSummary(current);
    if (current.publishIntent) throw new RuntimeError("REVISION_CONFLICT", "Layout publication is already in progress", { recoverable: true });
    if (summary.status !== "AWAITING_USER" && summary.status !== "USER_EDITING_DRAFT") throw new RuntimeError("REVISION_CONFLICT", "Layout draft is no longer editable", { recoverable: true });
    if (summary.draftRevision !== input.expectedDraftRevision) {
      throw new RuntimeError("REVISION_CONFLICT", "Layout draft revision changed", { recoverable: true, details: { expectedRevision: input.expectedDraftRevision, actualRevision: summary.draftRevision } });
    }
    const approved = this.#coreFor(this.#project(input.projectId)).getScreen(input.projectId, current.screenId);
    const baseHash = current.baseContractHash ?? hashContract(approved);
    if (approved.revision !== current.baseRevision || hashContract(approved) !== baseHash) {
      throw new RuntimeError("REVISION_CONFLICT", "Approved layout changed after this draft was created", { recoverable: true });
    }
    const after = parseLayoutContract(input.contract);
    assertDraftIdentity(after, current.projectId, current.screenId, current.baseRevision);
    const updatedAt = this.#now();
    await this.#state.update((state) => {
      const latest = state.proposals[input.proposalId];
      const latestStatus = latest ? proposalSummary(latest).status : null;
      if (!latest || proposalSummary(latest).draftRevision !== input.expectedDraftRevision || (latestStatus !== "AWAITING_USER" && latestStatus !== "USER_EDITING_DRAFT")) {
        throw new RuntimeError("REVISION_CONFLICT", "Layout draft changed concurrently", { recoverable: true });
      }
      return {
        ...state,
        proposals: {
          ...state.proposals,
          [input.proposalId]: {
            ...latest,
            proposedContractJson: canonicalize(after),
            baseContractHash: baseHash,
            draftRevision: input.expectedDraftRevision + 1,
            updatedAt,
            status: "USER_EDITING_DRAFT",
          },
        },
      };
    });
    return this.#openLayoutDraft(input.projectId, input.proposalId, signal);
  }

  async #publishLayoutDraft(
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly proposalId: LayoutDraftId; readonly expectedDraftRevision: number; readonly expectedBaseRevision: number; readonly expectedBaseHash: Sha256 },
    signal?: AbortSignal,
  ): Promise<LayoutImplementationHandoff> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(input.projectId);
    const proposal = this.#state.snapshot().proposals[input.proposalId];
    if (!proposal || proposal.projectId !== input.projectId) throw new RuntimeError("NOT_FOUND", "Layout draft does not exist");
    const summary = proposalSummary(proposal);
    if (summary.status === "PUBLISHED" && proposal.publishRequestId === input.requestId && proposal.publishedHandoff) {
      return toLayoutHandoff(proposal.publishedHandoff);
    }
    if (proposal.publishIntent && proposal.publishIntent.requestId !== input.requestId) {
      throw new RuntimeError("REVISION_CONFLICT", "A different layout publication is already in progress", { recoverable: true });
    }
    if (summary.status !== "AWAITING_USER" && summary.status !== "USER_EDITING_DRAFT") throw new RuntimeError("REVISION_CONFLICT", "Layout draft was already published or became stale", { recoverable: true });
    if (summary.draftRevision !== input.expectedDraftRevision || proposal.baseRevision !== input.expectedBaseRevision || proposal.baseContractHash !== input.expectedBaseHash) {
      throw new RuntimeError("REVISION_CONFLICT", "Layout draft or approved base revision changed", { recoverable: true });
    }
    const core = this.#coreFor(project);
    const before = core.getScreen(input.projectId, proposal.screenId);
    const baseHash = proposal.baseContractHash ?? hashContract(before);
    if (before.revision !== proposal.baseRevision || hashContract(before) !== baseHash || baseHash !== input.expectedBaseHash) {
      throw new RuntimeError("REVISION_CONFLICT", "Approved layout changed after this draft was created", { recoverable: true });
    }
    const contract = parseLayoutContract(JSON.parse(proposal.proposedContractJson) as unknown);
    assertDraftIdentity(contract, proposal.projectId, proposal.screenId, proposal.baseRevision);
    const handoff: LayoutImplementationHandoff = proposal.publishIntent
      ? toLayoutHandoff(proposal.publishIntent.handoff)
      : {
          handoffId: this.#id("handoff"),
          projectId: input.projectId,
          screenId: proposal.screenId as ScreenId,
          proposalId: input.proposalId,
          baseRevision: proposal.baseRevision,
          baseContractHash: baseHash as Sha256,
          newRevision: contract.revision,
          newContractHash: hashContract(contract) as Sha256,
          ...diffContractNodes(before, contract),
          status: "AWAITING_AGENT",
        };
    if (!proposal.publishIntent) {
      await this.#state.update((state) => {
        const latest = state.proposals[input.proposalId];
        if (!latest || latest.publishIntent || proposalSummary(latest).draftRevision !== input.expectedDraftRevision) {
          throw new RuntimeError("REVISION_CONFLICT", "Layout draft changed while publication was prepared", { recoverable: true });
        }
        return {
          ...state,
          proposals: {
            ...state.proposals,
            [input.proposalId]: { ...latest, publishIntent: { requestId: input.requestId, handoff } },
          },
        };
      });
    }
    let result;
    try {
      result = core.execute({
        type: "replace-contract",
        projectId: input.projectId,
        screenId: proposal.screenId,
        commandId: input.requestId,
        expectedRevision: proposal.baseRevision,
        actor: { kind: "user", id: "desktop" },
        timestamp: this.#now(),
        contract,
      });
    } catch (error) {
      throw mapRuntimeError(error);
    }
    const publishedAt = this.#now();
    if (result.revision !== handoff.newRevision || result.contractHash !== handoff.newContractHash) {
      throw new RuntimeError("REVISION_CONFLICT", "Published layout differs from its durable handoff intent", { recoverable: true });
    }
    await this.#state.update((state) => ({
      ...state,
      proposals: Object.fromEntries(Object.entries(state.proposals).map(([draftId, item]) => {
        if (draftId === input.proposalId) return [draftId, { ...withoutPublishIntent(item), status: "PUBLISHED" as const, updatedAt: publishedAt, publishRequestId: input.requestId, publishedHandoff: handoff }];
        const itemStatus = proposalSummary(item).status;
        if (item.projectId === input.projectId && item.screenId === proposal.screenId && (itemStatus === "AWAITING_USER" || itemStatus === "USER_EDITING_DRAFT")) {
          return [draftId, { ...item, status: "STALE" as const, updatedAt: publishedAt }];
        }
        return [draftId, item];
      })),
      selections: {
        ...state.selections,
        [input.projectId]: { projectId: input.projectId, screenId: proposal.screenId, nodeIds: proposal.selectedNodeIds ?? [], revision: result.revision },
      },
    }));
    return handoff;
  }

  async #executeEditorCommand(
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly expectedRevision: number; readonly command: JsonObject },
    signal?: AbortSignal,
  ): Promise<EditorState> {
    this.#assertOpen(); throwIfAborted(signal);
    const payload = objectInput(input.command, "command");
    const type = enumField(payload, "type", ["replace-contract", "apply-layout-overrides", "rename-screen"] as const);
    const metadata = {
      commandId: input.requestId,
      expectedRevision: input.expectedRevision,
      actor: { kind: "user" as const, id: "desktop" },
      timestamp: this.#now(),
      projectId: input.projectId,
      screenId: input.screenId,
    };
    let command: CoreCommand;
    if (type === "rename-screen") {
      command = { ...metadata, type, name: stringField(payload, "name", { min: 1, max: 256 })! };
    } else if (type === "replace-contract") {
      command = { ...metadata, type, contract: parseLayoutContract(payload["contract"]) };
    } else {
      if (!Array.isArray(payload["overrides"])) throw new RuntimeError("INVALID_REQUEST", "overrides must be an array");
      command = { ...metadata, type, overrides: payload["overrides"] as unknown as LayoutOverride[] };
    }
    try {
      const result = this.#coreFor(this.#project(input.projectId)).execute(command);
      return { contract: result.contract, contractHash: result.contractHash as Sha256, selectedNodeIds: [] };
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async #undoRedo(
    operation: "undo" | "redo",
    input: { readonly requestId: RequestId; readonly projectId: ProjectId; readonly screenId: ScreenId; readonly expectedRevision: number },
    signal?: AbortSignal,
  ): Promise<EditorState> {
    this.#assertOpen(); throwIfAborted(signal);
    const core = this.#coreFor(this.#project(input.projectId));
    try {
      const result = core[operation]({
        projectId: input.projectId,
        screenId: input.screenId,
        commandId: input.requestId,
        expectedRevision: input.expectedRevision,
        actor: { kind: "user", id: "desktop" },
        timestamp: this.#now(),
      });
      return { contract: result.contract, contractHash: result.contractHash as Sha256, selectedNodeIds: [] };
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async #saveProject(projectId: ProjectId, signal?: AbortSignal): Promise<{ readonly saved: true }> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(projectId);
    for (const batch of Object.values(this.#state.snapshot().managedSaveBatches).filter((item) => item.projectId === projectId)) {
      await this.#resumeManagedSaveBatch(batch.batchId, signal);
    }
    const core = this.#coreFor(project);
    const manifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
    const previous = await readGeneratedManifest(manifestPath);
    const planned: Array<{ relativePath: string; content: string; contentHash: string; beforeHash: string | null }> = [];
    const nextFiles: Record<string, string> = {};
    const unmanagedGeneratedScreens = new Set(this.#state.snapshot().unmanagedGeneratedScreens[projectId] ?? []);
    for (const screen of core.listScreens(project.projectId)) {
      throwIfAborted(signal);
      const contract = core.getScreen(project.projectId, screen.screenId);
      const contractRelativePath = `.boxspec/screens/${screen.screenId}.contract.json`;
      const contractContent = `${canonicalize(contract)}\n`;
      planned.push(await preflightContractOutput(project, contractRelativePath, contractContent, contract, previous));
      nextFiles[contractRelativePath] = sha256Text(contractContent);
      if (unmanagedGeneratedScreens.has(screen.screenId)) continue;
      const output = compileReactShell(contract);
      for (const file of output.files) {
        const relativePath = normalizeRelative(`src/boxspec/generated/${file.path}`);
        planned.push(await preflightManagedOutput(project, relativePath, file.content, previous));
        nextFiles[relativePath] = file.sha256;
      }
    }
    const manifestContent = `${canonicalize({ version: 1, files: nextFiles })}\n`;
    const manifestBeforeHash = await pathExists(manifestPath) ? await sha256File(manifestPath) : null;
    planned.push({
      relativePath: ".boxspec/generated-manifest.json",
      content: manifestContent,
      contentHash: sha256Text(manifestContent),
      beforeHash: manifestBeforeHash,
    });
    // Persist the complete batch before the first replacement. A restart can now
    // accept only exact BEFORE/AFTER bytes and finish the manifest-last save.
    const batchId = this.#id("managed-save");
    await this.#state.update((state) => {
      if (Object.values(state.managedSaveBatches).some((batch) => batch.projectId === projectId)) {
        throw new RuntimeError("APPLY_CONFLICT", "Another managed save is already in progress", { recoverable: true });
      }
      return {
        ...state,
        managedSaveBatches: {
          ...state.managedSaveBatches,
          [batchId]: {
            batchId,
            projectId,
            createdAt: this.#now(),
            outputs: planned.map((output) => ({
              relativePath: output.relativePath,
              content: output.content,
              beforeHash: output.beforeHash,
              afterHash: output.contentHash,
            })),
          },
        },
      };
    });
    await this.#resumeManagedSaveBatch(batchId, signal);
    return { saved: true };
  }

  async #listReviewQueue(projectId: ProjectId, signal?: AbortSignal): Promise<readonly ReviewSummary[]> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const reviews = await this.#options.changeManager.desktop.listReviews(projectId);
    return reviews.map((review) => ({
      candidateId: review.candidate.candidateId as CandidateId,
      reportId: review.binding.reportId as ReportId,
      status: review.canApprove ? "PENDING_APPROVAL" : "STALE",
    }));
  }

  async #inspectReview(projectId: ProjectId, candidateId: CandidateId, signal?: AbortSignal): Promise<DesktopReview> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const review = await this.#options.changeManager.desktop.inspectReview(candidateId);
    if (review.task.projectId !== projectId) throw new RuntimeError("NOT_FOUND", "Review does not belong to the project");
    const stored = this.#findReport(review.binding.reportId);
    const trustedReport = stored.report as TrustedVerificationReport;
    if (stored.projectId !== projectId || stored.taskId !== review.task.taskId || stored.candidateId !== candidateId || trustedReport.status !== "PASS") {
      throw new RuntimeError("CANDIDATE_STALE", "Persisted report is not bound to this review candidate");
    }
    assertReportIdentity(review.candidate, trustedReport);
    const report = toSharedReport(trustedReport);
    const nonce = review.reviewNonce;
    if (!nonce) throw new RuntimeError("CANDIDATE_STALE", "Change manager did not issue a review nonce");
    const bindingHash = hashCanonical(review.binding);
    this.#reviewNonces.set(nonce, { projectId, candidateId, reportId: review.binding.reportId, bindingHash, expiresAt: this.#clock().getTime() + 5 * 60_000 });
    return {
      summary: {
        candidateId,
        reportId: review.binding.reportId as ReportId,
        status: review.canApprove ? "PENDING_APPROVAL" : "STALE",
      },
      candidate: toSharedCandidate(review),
      verification: toSharedVerification(review),
      report,
      reviewNonce: nonce,
    };
  }

  async #approveAndApply(
    input: { readonly projectId: ProjectId; readonly candidateId: CandidateId; readonly reportId: ReportId; readonly reviewNonce: string },
    signal?: AbortSignal,
  ): Promise<SharedApplyResult> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(input.projectId);
    const nonce = this.#reviewNonces.get(input.reviewNonce);
    if (!nonce || nonce.expiresAt < this.#clock().getTime() || nonce.projectId !== input.projectId || nonce.candidateId !== input.candidateId || nonce.reportId !== input.reportId) {
      throw new RuntimeError("CANDIDATE_STALE", "Review confirmation is missing, expired, or bound to another candidate");
    }
    this.#reviewNonces.delete(input.reviewNonce);
    const review = (await this.#options.changeManager.desktop.listReviews(input.projectId)).find((item) => item.candidate.candidateId === input.candidateId);
    if (!review) throw new RuntimeError("CANDIDATE_STALE", "Candidate is no longer in the review queue", { recoverable: true });
    if (!review.canApprove || review.binding.reportId !== input.reportId || hashCanonical(review.binding) !== nonce.bindingHash) {
      throw new RuntimeError("CANDIDATE_STALE", "The candidate changed after review", {
        recoverable: true,
        details: { blockReasons: review.blockReasons },
      });
    }
    const approval = await this.#options.changeManager.desktop.approveCandidate({ candidateId: input.candidateId, reportId: input.reportId, reviewNonce: input.reviewNonce, approvedAt: this.#now() });
    throwIfAborted(signal);
    const applied = await this.#options.changeManager.desktop.applyApprovedCandidate({
      candidateId: input.candidateId,
      approvalId: approval.approvalId,
      applyConfirmationToken: approval.applyConfirmationToken,
    });
    return {
      transactionId: applied.transactionId as TransactionId,
      status: "APPLIED",
      appliedTreeHash: review.candidate.treeHash as Sha256,
    };
  }

  async #listRecovery(projectId: ProjectId, signal?: AbortSignal): Promise<readonly TransactionId[]> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const recoveries = await this.#options.changeManager.desktop.inspectRecoveries();
    return recoveries
      .filter((entry) => recoveryProjectId(entry) === projectId && entry.needsUserDecision)
      .map((entry) => entry.transactionId as TransactionId);
  }

  async #inspectRecovery(projectId: ProjectId, transactionId: TransactionId, signal?: AbortSignal): Promise<SharedRecoveryInspection> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const inspection = (await this.#options.changeManager.desktop.inspectRecoveries())
      .find((item) => item.transactionId === transactionId && recoveryProjectId(item) === projectId);
    if (!inspection) throw new RuntimeError("NOT_FOUND", "Recovery transaction does not exist");
    const journalHash = hashCanonical(inspection);
    const recoveryNonce = this.#id("recovery");
    this.#recoveryNonces.set(recoveryNonce, { projectId, transactionId, inspectionHash: journalHash, expiresAt: this.#clock().getTime() + 5 * 60_000 });
    return {
      transactionId,
      journalHash: journalHash as Sha256,
      recoveryNonce: recoveryNonce as import("@boxspec/shared/domain").RecoveryNonce,
      paths: inspection.fileStates.map((file) => ({
        path: file.relativePath as RelativePath,
        state: file.state,
        currentHash: null,
        beforeHash: null,
        afterHash: null,
      })),
    };
  }

  async #recoverApply(projectId: ProjectId, recovery: RecoveryInput, signal?: AbortSignal): Promise<SharedRecoveryResult> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const parsedRecovery = parseRecoveryInput(recovery);
    const nonce = this.#recoveryNonces.get(parsedRecovery.recoveryNonce);
    this.#recoveryNonces.delete(parsedRecovery.recoveryNonce);
    if (!nonce || nonce.projectId !== projectId || nonce.transactionId !== parsedRecovery.transactionId || nonce.expiresAt < this.#clock().getTime()) {
      throw new RuntimeError("APPLY_CONFLICT", "Recovery inspection is missing, stale, or belongs to another project", { recoverable: true });
    }
    const inspection = (await this.#options.changeManager.desktop.inspectRecoveries())
      .find((item) => item.transactionId === parsedRecovery.transactionId && recoveryProjectId(item) === projectId);
    if (!inspection || hashCanonical(inspection) !== nonce.inspectionHash) throw new RuntimeError("APPLY_CONFLICT", "Recovery state changed after inspection", { recoverable: true });
    const unknownPaths = inspection.fileStates.filter((file) => file.state === "UNKNOWN").map((file) => file.relativePath);
    const unknownPathSet = new Set(unknownPaths);
    for (const decision of parsedRecovery.unknownPathDecisions) {
      if (!unknownPathSet.has(decision.path)) {
        throw new RuntimeError("INVALID_REQUEST", "Recovery decision names a path that is not UNKNOWN", { details: { path: decision.path } });
      }
    }
    for (const path of unknownPaths) {
      if (!parsedRecovery.unknownPathDecisions.some((decision) => decision.path === path)) {
        throw new RuntimeError("APPLY_CONFLICT", "Every unknown path requires an explicit decision", { recoverable: true, details: { path } });
      }
    }
    if (parsedRecovery.unknownPathDecisions.some((decision) => decision.action === "preserve-current" || decision.action !== parsedRecovery.strategy)) {
      return { transactionId: parsedRecovery.transactionId, status: "BLOCKED", unknownPaths: unknownPaths as unknown as readonly RelativePath[] };
    }
    await this.#options.changeManager.desktop.recoverInterruptedApply(parsedRecovery.transactionId, parsedRecovery.strategy);
    return { transactionId: parsedRecovery.transactionId, status: "RECOVERED", unknownPaths: [] };
  }

  async #inspectSourceDrift(projectId: ProjectId, signal?: AbortSignal): Promise<readonly SourceDrift[]> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(projectId);
    let inspection: ManagedSourceDriftInspection;
    try {
      inspection = await this.#buildManagedSourceDriftInspection(project, signal);
    } catch (error) {
      throw mapManagedDriftError(error);
    }
    await this.#state.update((state) => ({
      ...state,
      sourceDriftInspections: { ...state.sourceDriftInspections, [projectId]: inspection },
    }));
    return inspection.drifts.map((drift) => ({
      driftId: drift.driftId,
      projectId,
      paths: drift.unitSnapshots.map((item) => item.path),
      detectedTreeHash: inspection.inspectionId as Sha256,
    }));
  }

  async #resolveSourceDrift(
    projectId: ProjectId,
    driftId: string,
    resolution: "propose-contract" | "restore-contract" | "unmanage",
    signal?: AbortSignal,
  ): Promise<{ readonly resolved: true }> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(projectId);
    const inspection = this.#state.snapshot().sourceDriftInspections[projectId];
    if (!inspection) throw new RuntimeError("APPLY_CONFLICT", "Source drift must be inspected before it can be resolved", { recoverable: true });
    const drift = inspection.drifts.find((item) => item.driftId === driftId);
    if (!drift) throw new RuntimeError("NOT_FOUND", "Source drift does not belong to this project inspection");
    const currentObservations = await Promise.all(drift.unitSnapshots.map((item) => this.#observeManagedPath(project, item.path, drift.kind, drift.screenId)));
    const currentManifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
    const currentManifestHash = await pathExists(currentManifestPath) ? await sha256File(currentManifestPath) : null;
    let plan;
    try {
      plan = planManagedSourceDriftResolution({ inspection, driftId, resolution, currentManifestHash, currentObservations });
    } catch (error) {
      throw mapManagedDriftError(error);
    }
    if (plan.action === "import-contract-draft") {
      const core = this.#coreFor(project);
      const current = core.getScreen(projectId, plan.screenId);
      if (current.revision !== plan.baseContractRevision || hashContract(current) !== plan.baseContractHash) {
        throw new RuntimeError("REVISION_CONFLICT", "Approved contract changed after source drift inspection", { recoverable: true });
      }
      const proposalId = this.#id("source-drift") as LayoutDraftId;
      const now = this.#now();
      const importPath = await safeManagedTarget(project, plan.path);
      let imported;
      try {
        imported = core.importScreenDraft({ path: importPath, draftId: proposalId, importedAt: now });
      } catch (error) {
        throw mapRuntimeError(error);
      }
      if (
        imported.sourceHash !== plan.sourceHash ||
        imported.contract.projectId !== projectId ||
        imported.contract.screenId !== plan.screenId ||
        imported.contract.revision !== plan.baseContractRevision
      ) {
        throw new RuntimeError("APPLY_CONFLICT", "External contract changed after source drift inspection", { recoverable: true });
      }
      const contract = parseLayoutContract({ ...imported.contract, revision: current.revision + 1 });
      assertDraftIdentity(contract, projectId, plan.screenId, current.revision);
      const manifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
      const ownership = await readGeneratedManifest(manifestPath);
      ownership[plan.restore.path] = plan.restore.contentHash;
      const manifestContent = `${canonicalize({ version: 1, files: ownership })}\n`;
      const manifestBeforeHash = await pathExists(manifestPath) ? await sha256File(manifestPath) : null;
      const batchId = this.#id("managed-contract-restore");
      await this.#state.update((state) => {
        if (Object.values(state.managedSaveBatches).some((batch) => batch.projectId === projectId)) {
          throw new RuntimeError("APPLY_CONFLICT", "Another managed save is already in progress", { recoverable: true });
        }
        return {
        ...state,
        proposals: {
          ...state.proposals,
          [proposalId]: {
            proposalId,
            projectId,
            screenId: plan.screenId,
            baseRevision: current.revision,
            baseContractHash: hashContract(current),
            reason: `Source drift proposal from ${plan.path}`,
            proposedContractJson: canonicalize(contract),
            principalId: "desktop",
            createdAt: now,
            updatedAt: now,
            draftRevision: 1,
            selectedNodeIds: [contract.rootNodeId],
            status: "AWAITING_USER",
          },
        },
        managedSaveBatches: {
          ...state.managedSaveBatches,
          [batchId]: {
            batchId,
            projectId,
            createdAt: now,
            outputs: [
              { relativePath: plan.restore.path, content: plan.restore.content, beforeHash: plan.restore.expectedBeforeHash, afterHash: plan.restore.contentHash },
              { relativePath: ".boxspec/generated-manifest.json", content: manifestContent, beforeHash: manifestBeforeHash, afterHash: sha256Text(manifestContent) },
            ],
          },
        },
      };
      });
      await this.#resumeManagedSaveBatch(batchId, signal);
      return { resolved: true };
    }
    if (plan.action === "restore-managed") {
      await this.#persistManagedResolutionBatch(project, plan.writes, signal);
      return { resolved: true };
    }
    const manifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
    const ownership = await readGeneratedManifest(manifestPath);
    const retained = Object.fromEntries(Object.entries(ownership).filter(([path]) => managedPathScreenId(path) !== plan.screenId));
    const manifestContent = `${canonicalize({ version: 1, files: retained })}\n`;
    const manifestBeforeHash = await pathExists(manifestPath) ? await sha256File(manifestPath) : null;
    const batchId = this.#id("managed-unmanage");
    await this.#state.update((state) => {
      if (Object.values(state.managedSaveBatches).some((batch) => batch.projectId === projectId)) {
        throw new RuntimeError("APPLY_CONFLICT", "Another managed save is already in progress", { recoverable: true });
      }
      return {
      ...state,
      unmanagedGeneratedScreens: {
        ...state.unmanagedGeneratedScreens,
        [projectId]: [...new Set([...(state.unmanagedGeneratedScreens[projectId] ?? []), plan.screenId])],
      },
      managedSaveBatches: {
        ...state.managedSaveBatches,
        [batchId]: {
          batchId,
          projectId,
          createdAt: this.#now(),
          outputs: [{ relativePath: ".boxspec/generated-manifest.json", content: manifestContent, beforeHash: manifestBeforeHash, afterHash: sha256Text(manifestContent) }],
        },
      },
    };
    });
    await this.#resumeManagedSaveBatch(batchId, signal);
    return { resolved: true };
  }

  async #buildManagedSourceDriftInspection(project: RuntimeProjectRecord, signal?: AbortSignal): Promise<ManagedSourceDriftInspection> {
    const core = this.#coreFor(project);
    const manifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
    const manifestHash = await pathExists(manifestPath) ? await sha256File(manifestPath) : null;
    const recorded = await readGeneratedManifest(manifestPath);
    const intents: ManagedOutputIntent[] = [];
    const intentScreens = new Map<string, string>();
    for (const screen of core.listScreens(project.projectId)) {
      throwIfAborted(signal);
      const contract = core.getScreen(project.projectId, screen.screenId);
      const contractPath = `.boxspec/screens/${screen.screenId}.contract.json`;
      const contractContent = `${canonicalize(contract)}\n`;
      intents.push({
        path: contractPath,
        kind: "contract-export",
        desiredContent: contractContent,
        desiredHash: sha256Text(contractContent),
        screenId: screen.screenId,
        baseContractRevision: contract.revision,
        baseContractHash: hashContract(contract),
      });
      intentScreens.set(contractPath, screen.screenId);
      for (const file of compileReactShell(contract).files) {
        const path = normalizeRelative(`src/boxspec/generated/${file.path}`);
        intents.push({ path, kind: "generated", desiredContent: file.content, desiredHash: file.sha256, screenId: screen.screenId });
        intentScreens.set(path, screen.screenId);
      }
    }
    const ownership: ManagedOwnershipRecord[] = Object.entries(recorded).map(([path, contentHash]) => {
      const kind = path.startsWith(".boxspec/screens/") ? "contract-export" as const : path.startsWith("src/boxspec/generated/") ? "generated" as const : null;
      const screenId = intentScreens.get(path) ?? managedPathScreenId(path);
      if (!kind || !screenId) throw new RuntimeError("APPLY_CONFLICT", "Generated manifest contains an unsupported managed path", { recoverable: true, details: { path } });
      return { path, kind, screenId, contentHash };
    });
    const all = new Map<string, { kind: "contract-export" | "generated"; screenId: string }>();
    for (const intent of intents) all.set(intent.path, { kind: intent.kind, screenId: intent.screenId });
    for (const item of ownership) all.set(item.path, { kind: item.kind, screenId: item.screenId });
    const observations = await Promise.all([...all].map(([path, binding]) => this.#observeManagedPath(project, path, binding.kind, binding.screenId)));
    return inspectManagedSourceDrift({
      projectId: project.projectId,
      manifestHash,
      intents,
      ownership,
      observations,
      unmanagedGeneratedScreenIds: this.#state.snapshot().unmanagedGeneratedScreens[project.projectId] ?? [],
    });
  }

  async #observeManagedPath(
    project: RuntimeProjectRecord,
    path: string,
    kind: "contract-export" | "generated",
    screenId: string,
  ): Promise<ManagedFileObservation> {
    const target = await safeManagedTarget(project, path);
    if (!await pathExists(target)) return { path, kind, screenId, exists: false, contentHash: null };
    if (kind === "contract-export") {
      const bytes = await readFile(target);
      return {
        path,
        kind,
        screenId,
        exists: true,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        content: bytes.toString("utf8"),
      };
    }
    return { path, kind, screenId, exists: true, contentHash: await sha256File(target) };
  }

  async #persistManagedResolutionBatch(project: RuntimeProjectRecord, writes: readonly SafeManagedWrite[], signal?: AbortSignal): Promise<void> {
    const manifestPath = await safeManagedTarget(project, ".boxspec/generated-manifest.json");
    const ownership = await readGeneratedManifest(manifestPath);
    for (const write of writes) ownership[write.path] = write.contentHash;
    const manifestContent = `${canonicalize({ version: 1, files: ownership })}\n`;
    const manifestBeforeHash = await pathExists(manifestPath) ? await sha256File(manifestPath) : null;
    const batchId = this.#id("managed-restore");
    await this.#state.update((state) => {
      if (Object.values(state.managedSaveBatches).some((batch) => batch.projectId === project.projectId)) {
        throw new RuntimeError("APPLY_CONFLICT", "Another managed save is already in progress", { recoverable: true });
      }
      return {
        ...state,
        managedSaveBatches: {
          ...state.managedSaveBatches,
          [batchId]: {
            batchId,
            projectId: project.projectId,
            createdAt: this.#now(),
            outputs: [
              ...writes.map((write) => ({ relativePath: write.path, content: write.content, beforeHash: write.expectedBeforeHash, afterHash: write.contentHash })),
              { relativePath: ".boxspec/generated-manifest.json", content: manifestContent, beforeHash: manifestBeforeHash, afterHash: sha256Text(manifestContent) },
            ],
          },
        },
      };
    });
    await this.#resumeManagedSaveBatch(batchId, signal);
  }

  async #pairMcpClient(
    input: { readonly projectId: ProjectId; readonly principalId: string; readonly permissions: readonly ("read" | "candidate-write" | "verify")[]; readonly expiresAt: string },
    signal?: AbortSignal,
  ): Promise<ProjectGrant> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(input.projectId);
    if (!input.principalId || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= this.#clock().getTime()) {
      throw new RuntimeError("INVALID_REQUEST", "Pairing requires a principal and a future expiry");
    }
    if (this.#coreFor(project).listScreens(project.projectId).length === 0) {
      const anchor = await this.#createScreen({ projectId: input.projectId, name: "Agent Layout", width: 1440, height: 900 }, signal);
      const anchorContract = this.#coreFor(project).getScreen(project.projectId, anchor.screenId);
      await this.#state.update((state) => ({
        ...state,
        selections: {
          ...state.selections,
          [project.projectId]: {
            projectId: project.projectId,
            screenId: anchor.screenId,
            nodeIds: [anchorContract.rootNodeId],
            revision: anchor.revision,
          },
        },
      }));
    }
    const existing = await this.#options.changeManager.desktop.listProjectGrants();
    const grantRevision = Math.max(0, ...existing.filter((grant) => grant.projectId === project.projectId).map((grant) => grant.grantRevision)) + 1;
    const grant = await this.#options.changeManager.desktop.registerProjectGrant({
      projectId: project.projectId,
      principalId: input.principalId,
      permissions: [...new Set(input.permissions)],
      sourceRoot: project.rootPath,
      allowedWritePaths: this.#options.allowedWritePaths ?? ["src/boxspec/"],
      protectedPaths: this.#options.protectedPaths ?? [".boxspec/", ".git/", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
      executionProfileIds: this.#options.approvedExecutionProfileIds ?? [],
      grantRevision,
      approvedPrincipalId: "desktop",
      expiresAt: input.expiresAt,
    });
    return {
      grantId: grant.grantId as GrantId,
      projectId: grant.projectId as ProjectId,
      principalId: grant.principalId,
      permissions: grant.permissions,
      expiresAt: grant.expiresAt,
    };
  }

  async #revokeMcpGrant(projectId: ProjectId, grantId: GrantId, signal?: AbortSignal): Promise<{ readonly revoked: true }> {
    this.#assertOpen(); throwIfAborted(signal); this.#project(projectId);
    const desktop = this.#options.changeManager.desktop as DesktopChangeManager & {
      revokeProjectGrant(input: { projectId: string; grantId: string }): Promise<void>;
    };
    if (typeof desktop.revokeProjectGrant !== "function") {
      throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Durable grant revocation is unavailable", { recoverable: true });
    }
    await desktop.revokeProjectGrant({ projectId, grantId });
    return { revoked: true };
  }

  async #getClientSetup(projectId: ProjectId, signal?: AbortSignal): Promise<readonly ClientSetup[]> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(projectId);
    const launcher = this.#options.mcpLauncherPath;
    return Promise.all((["codex", "claude-code", "opencode"] as const).map(async (client) => {
      const targetPath = clientConfigPath(project.rootPath, client);
      const configured = await inspectClientConfig(targetPath, client);
      const diagnostic = configured
        ? "Configuration written; a live MCP handshake has not yet been observed."
        : launcher
          ? "Configuration can be prepared; connection is confirmed only after a successful MCP capabilities call."
          : "MCP launcher path is not configured in this runtime.";
      return { client, configured, diagnostic };
    }));
  }

  async #prepareClientConfig(
    input: { readonly projectId: ProjectId; readonly client: ClientSetup["client"]; readonly scope: "project" | "user" },
    signal?: AbortSignal,
  ): Promise<ClientConfigPlan> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(input.projectId);
    if (input.scope !== "project") {
      throw new RuntimeError("UNSUPPORTED_CAPABILITY", "User-level client config paths are intentionally not inferred", { recoverable: true });
    }
    const launcher = this.#options.mcpLauncherPath;
    if (!launcher || !isAbsolute(launcher)) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "An absolute MCP launcher path is required");
    const targetPath = clientConfigPath(project.rootPath, input.client);
    const existing = await readFile(targetPath, "utf8").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return "";
      throw error;
    });
    let renderedText: string;
    const launcherArgs = [...(this.#options.mcpLauncherArgs ?? []), "--profile", input.projectId];
    if (input.client === "codex") {
      if (/\[mcp_servers\.boxspec\]/.test(existing)) {
        throw new RuntimeError("APPLY_CONFLICT", "Codex config already contains a boxspec server; automatic replacement is disabled", { recoverable: true });
      }
      const block = `[mcp_servers.boxspec]\ncommand = ${JSON.stringify(launcher.replaceAll("\\", "/"))}\nargs = [${launcherArgs.map((argument) => JSON.stringify(argument)).join(", ")}]\n`;
      renderedText = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;
    } else {
      let parsed: Record<string, unknown> = {};
      if (existing.trim()) {
        try { parsed = objectInput(JSON.parse(existing) as unknown, "client config"); }
        catch (error) { throw new RuntimeError("APPLY_CONFLICT", "Existing client config is not valid JSON", { recoverable: true, cause: error }); }
      }
      if (input.client === "claude-code") {
        const servers = isRecord(parsed["mcpServers"]) ? parsed["mcpServers"] : {};
        parsed = { ...parsed, mcpServers: { ...servers, boxspec: { type: "stdio", command: launcher, args: launcherArgs } } };
      } else {
        const servers = isRecord(parsed["mcp"]) ? parsed["mcp"] : {};
        parsed = { ...parsed, mcp: { ...servers, boxspec: { type: "local", command: [launcher, ...launcherArgs], enabled: true } } };
      }
      renderedText = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    const expectedExistingHash = existing ? sha256Text(existing) as Sha256 : null;
    const plan: ClientPlanRecord = {
      planId: this.#id("config"),
      projectId: input.projectId,
      client: input.client,
      targetPath,
      expectedExistingHash,
      renderedText,
      unifiedDiff: `--- ${targetPath}\n+++ ${targetPath}\n@@ BoxSpec proposal @@\n-${existing}\n+${renderedText}`,
    };
    this.#clientPlans.set(plan.planId, plan);
    return plan;
  }

  async #applyClientConfig(
    input: { readonly projectId: ProjectId; readonly planId: string; readonly expectedExistingHash: Sha256 | null },
    signal?: AbortSignal,
  ): Promise<ClientSetup> {
    this.#assertOpen(); throwIfAborted(signal);
    const project = this.#project(input.projectId);
    const plan = this.#clientPlans.get(input.planId);
    if (!plan || plan.projectId !== input.projectId || plan.expectedExistingHash !== input.expectedExistingHash) {
      throw new RuntimeError("APPLY_CONFLICT", "Client config plan is missing or stale", { recoverable: true });
    }
    const exists = await pathExists(plan.targetPath);
    const currentHash = exists ? await sha256File(plan.targetPath) as Sha256 : null;
    if (currentHash !== input.expectedExistingHash) {
      this.#clientPlans.delete(input.planId);
      throw new RuntimeError("APPLY_CONFLICT", "Client config changed after the diff was reviewed", {
        recoverable: true,
        details: { expectedHash: input.expectedExistingHash, currentHash },
      });
    }
    const relativePath = normalizeRelative(relative(project.rootPath, plan.targetPath));
    await this.#writeManagedFile(project, relativePath, plan.renderedText);
    this.#clientPlans.delete(input.planId);
    return { client: plan.client, configured: true, diagnostic: "Configuration written; connection has not yet been proven." };
  }

  async #diagnoseClient(
    input: { readonly projectId: ProjectId; readonly client: ClientSetup["client"] },
    signal?: AbortSignal,
  ): Promise<ClientSetup> {
    this.#assertOpen(); throwIfAborted(signal);
    const setup = (await this.#getClientSetup(input.projectId, signal)).find((item) => item.client === input.client)!;
    return {
      client: input.client,
      configured: setup.configured,
      diagnostic: setup.configured
        ? "Configuration is present, but no live MCP handshake has been observed for this client and grant."
        : setup.diagnostic,
    };
  }

  async #invoke(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    tool: SafeMcpToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult<unknown>> {
    this.#assertOpen();
    const requestId = extractRequestId(input) ?? (`read-${tool}` as RequestId);
    let activeGrant: Awaited<ReturnType<AgentChangeManager["authorizeGrant"]>>;
    try { activeGrant = await this.#authorizeAny(principal); }
    catch (error) { return failure(mapRuntimeError(error), requestId); }
    if (!WRITE_TOOLS.has(tool)) return this.#invokeOnce(principal, tool, input, requestId, signal);
    if (!extractRequestId(input)) return failure(new RuntimeError("INVALID_REQUEST", "requestId is required"), requestId);
    const key = `${principal.principalId}\0${principal.grantId}\0${activeGrant.grantRevision}\0${requestId}`;
    const requestHash = hashCanonical({ tool, input });
    const stored = this.#state.snapshot().idempotency[key];
    if (stored) {
      return stored.requestHash === requestHash
        ? stored.result as ToolResult<unknown>
        : failure(new RuntimeError("IDEMPOTENCY_CONFLICT", "requestId was reused with a different payload"), requestId);
    }
    const inflight = this.#inflight.get(key);
    if (inflight) {
      return inflight.requestHash === requestHash
        ? inflight.promise
        : failure(new RuntimeError("IDEMPOTENCY_CONFLICT", "requestId is already in flight with a different payload"), requestId);
    }
    const promise = this.#invokeOnce(principal, tool, input, requestId, signal).then(async (result) => {
      await this.#state.update((state) => ({
        ...state,
        idempotency: {
          ...state.idempotency,
          [key]: { principalId: principal.principalId, requestId, requestHash, result, createdAt: this.#now() },
        },
      }));
      return result;
    }).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, { requestHash, promise });
    return promise;
  }

  async #invokeOnce(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    tool: SafeMcpToolName,
    input: unknown,
    requestId: RequestId,
    signal?: AbortSignal,
  ): Promise<ToolResult<unknown>> {
    try {
      throwIfAborted(signal);
      await this.#authorizeAny(principal);
      return { ok: true, data: await this.#dispatchMcp(principal, tool, input, signal) };
    } catch (error) {
      return failure(mapRuntimeError(error), requestId);
    }
  }

  async #submitCandidate(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertNoExtraFields(value, ["requestId", "taskId", "expectedRevision", "summary", "layoutOverrides"]);
    const authorization = { principalId: principal.principalId, grantId: principal.grantId };
    const taskId = idField(value, "taskId");
    const task = await this.#options.changeManager.agent.getTask({ ...authorization, taskId });
    const expectedRevision = integerField(value, "expectedRevision", { min: 1 })!;
    if (expectedRevision !== task.baseContractRevision) throw new RuntimeError("REVISION_CONFLICT", "Candidate contract revision differs from task base", { recoverable: true });
    stringField(value, "summary", { max: 8_000 });
    const project = this.#project(task.projectId);
    const approvedContract = this.#coreFor(project).getScreen(task.projectId, task.screenId);
    if (approvedContract.revision !== task.baseContractRevision || hashContract(approvedContract) !== task.contractHash) {
      throw new RuntimeError("CANDIDATE_STALE", "Approved contract changed after task start", { recoverable: true });
    }
    const overrides = parseLayoutOverrides(value["layoutOverrides"]);
    const effectiveContract = overrides.length
      ? applyLayoutOverrides(approvedContract, overrides, { kind: "agent", id: principal.principalId }).contract
      : approvedContract;
    const output = compileReactShell(effectiveContract);
    const generatedFiles = output.files.map((file) => ({
      relativePath: `src/boxspec/generated/${file.path}`,
      operation: "upsert" as const,
      contentUtf8: file.content,
    }));
    let taskRevision = task.revision;
    if (generatedFiles.length > 0) {
      const staged = await this.#options.changeManager.agent.proposePatch({ ...authorization, taskId, expectedRevision: taskRevision, files: generatedFiles });
      taskRevision = staged.taskRevision;
    }
    throwIfAborted(signal);
    const defaultProfileId = task.verificationProfileId;
    const boundProfile = this.#options.verificationProfiles?.[defaultProfileId];
    if (!boundProfile || hashCanonical(boundProfile) !== task.verificationProfileHash) {
      throw new RuntimeError("UNSUPPORTED_CAPABILITY", "No approved default verification profile is configured", { recoverable: true });
    }
    const candidate = await this.#options.changeManager.agent.freezeCandidate({
      ...authorization,
      taskId,
      expectedRevision: taskRevision,
      contractHash: hashContract(approvedContract),
      effectiveContractHash: hashContract(effectiveContract),
      layoutOverridesHash: hashCanonical(overrides),
      policyHash: task.policyHash,
      policyRevision: task.policyRevision,
    });
    await this.#state.update((state) => ({
      ...state,
      candidates: {
        ...state.candidates,
        [candidate.candidateId]: {
          candidateId: candidate.candidateId,
          projectId: task.projectId,
          taskId,
          effectiveContract,
          verificationProfileId: defaultProfileId,
          createdAt: this.#now(),
        },
      },
    }));
    return {
      taskId,
      candidateId: candidate.candidateId,
      treeHash: candidate.treeHash,
      contractHash: candidate.contractHash,
      effectiveContractHash: candidate.effectiveContractHash,
      layoutOverridesHash: candidate.layoutOverridesHash,
      changedPaths: candidate.changedPaths,
    };
  }

  async #verifyCandidate(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertNoExtraFields(value, ["requestId", "taskId", "candidateId", "verificationProfileId"]);
    const authorization = { principalId: principal.principalId, grantId: principal.grantId };
    const taskId = idField(value, "taskId"), candidateId = idField(value, "candidateId");
    const verificationProfileId = idField(value, "verificationProfileId");
    const task = await this.#options.changeManager.agent.getTask({ ...authorization, taskId });
    await this.#authorize(principal, task.projectId, "verify");
    const context = this.#state.snapshot().candidates[candidateId];
    if (!context || context.taskId !== taskId) throw new RuntimeError("NOT_FOUND", "Candidate context does not exist");
    if (context.verificationProfileId !== verificationProfileId) {
      throw new RuntimeError("CANDIDATE_STALE", "Candidate is bound to a different verification profile");
    }
    const profile = this.#options.verificationProfiles?.[verificationProfileId];
    if (!profile) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Verification profile is unavailable", { recoverable: true });
    const candidate = await this.#options.changeManager.verifier.getFrozenCandidate(candidateId);
    if (candidate.taskId !== taskId) throw new RuntimeError("OUT_OF_SCOPE", "Candidate does not belong to the task");
    const grant = await this.#authorize(principal, task.projectId, "verify");
    const evidenceRoot = join(this.#options.dataDir, "projects", task.projectId, "evidence", candidateId);
    const report = await this.#options.verifyCandidate({
      candidate: toVerifierCandidate(candidate),
      contract: parseLayoutContract(context.effectiveContract),
      policy: { allowedPaths: grant.allowedWritePaths, protectedPaths: grant.protectedPaths },
      profile,
      fixtures: this.#options.fixtures ?? {},
      evidenceRoot,
      ...(signal ? { signal } : {}),
    });
    // The verifier result remains untrusted until every identity field matches the
    // frozen server-side candidate. The change manager repeats this check.
    assertReportIdentity(candidate, report);
    await this.#options.changeManager.verifier.recordTrustedVerification({
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      candidateId,
      treeHash: candidate.treeHash,
      baseContractHash: candidate.baseContractHash,
      contractHash: candidate.contractHash,
      effectiveContractHash: candidate.effectiveContractHash,
      layoutOverridesHash: candidate.layoutOverridesHash,
      policyHash: candidate.policyHash,
      dependencyLockHash: candidate.dependencyLockHash,
      fixturesHash: candidate.fixturesHash,
      verificationProfileHash: candidate.verificationProfileHash,
      verificationProfileId: candidate.verificationProfileId,
      generatorVersion: candidate.generatorVersion,
      baseCommitHash: candidate.baseCommitHash,
      baseManifestHash: candidate.baseManifestHash,
      baseContractRevision: candidate.baseContractRevision,
      policyRevision: candidate.policyRevision,
      status: report.status,
      reportId: report.reportId,
      evidenceDigest: report.evidenceDigest,
      checkedAt: report.completedAt,
    });
    const artifactRecords = await indexArtifacts(task.projectId, candidateId, evidenceRoot, report.artifacts);
    await this.#state.update((state) => ({
      ...state,
      reports: {
        ...state.reports,
        [report.reportId]: { reportId: report.reportId, projectId: task.projectId, taskId, candidateId, report, createdAt: this.#now() },
      },
      artifacts: { ...state.artifacts, ...artifactRecords },
    }));
    return { taskId, candidateId, state: report.status === "PASS" ? "VERIFYING" : "NEEDS_REPAIR" };
  }

  async #getArtifact(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    value: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoExtraFields(value, ["artifactId", "representation"]);
    const artifactId = idField(value, "artifactId");
    const representation = enumField(value, "representation", ["metadata", "text", "image"] as const);
    const artifact = this.#state.snapshot().artifacts[artifactId];
    if (!artifact) throw new RuntimeError("NOT_FOUND", "Artifact does not exist");
    await this.#authorize(principal, artifact.projectId, "read");
    const actualHash = await sha256File(artifact.absolutePath);
    if (actualHash !== artifact.sha256) throw new RuntimeError("CANDIDATE_STALE", "Trusted evidence artifact hash changed");
    let text: string | undefined;
    if (representation === "text") {
      if (!artifact.mimeType.startsWith("text/") && artifact.mimeType !== "application/json") throw new RuntimeError("INVALID_REQUEST", "Artifact is not textual");
      if (artifact.sizeBytes > 262_144) throw new RuntimeError("RESOURCE_LIMIT", "Artifact is too large for inline text");
      text = await readFile(artifact.absolutePath, "utf8");
    }
    return {
      artifactId,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      ...(text === undefined ? {} : { text }),
      imageContentIncluded: representation === "image" && artifact.mimeType.startsWith("image/"),
    };
  }

  async #proposeContractChange(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    value: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoExtraFields(value, ["requestId", "projectId", "screenId", "expectedRevision", "reason", "proposedContractJson"]);
    const projectId = idField(value, "projectId"), screenId = idField(value, "screenId");
    await this.#authorize(principal, projectId, "candidate-write");
    const contract = this.#coreFor(this.#project(projectId)).getScreen(projectId, screenId);
    const expectedRevision = integerField(value, "expectedRevision", { min: 1 })!;
    if (contract.revision !== expectedRevision) throw new RuntimeError("REVISION_CONFLICT", "Screen revision changed", { recoverable: true });
    const proposedContractJson = stringField(value, "proposedContractJson", { max: 262_144 })!;
    let proposedContract: LayoutContract;
    try { proposedContract = parseLayoutContract(JSON.parse(proposedContractJson) as unknown); }
    catch (error) { throw new RuntimeError("INVALID_REQUEST", "Proposed contract is invalid", { cause: error }); }
    assertDraftIdentity(proposedContract, projectId, screenId, expectedRevision);
    if (proposedContract.target !== this.#project(projectId).target) {
      throw new RuntimeError("OUT_OF_SCOPE", "Proposed contract target differs from the project target");
    }
    const proposalId = this.#id("proposal");
    const now = this.#now();
    await this.#state.update((state) => ({
      ...state,
      proposals: {
        ...state.proposals,
        [proposalId]: {
          proposalId, projectId, screenId, baseRevision: expectedRevision,
          baseContractHash: hashContract(contract),
          reason: stringField(value, "reason", { max: 8_000 })!, proposedContractJson: canonicalize(proposedContract),
          principalId: principal.principalId, createdAt: now, updatedAt: now, draftRevision: 1, selectedNodeIds: [proposedContract.rootNodeId], status: "AWAITING_USER",
        },
      },
    }));
    return { proposalId, status: "AWAITING_USER", baseRevision: expectedRevision };
  }

  async #requestReview(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    value: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoExtraFields(value, ["requestId", "taskId", "candidateId", "reportId"]);
    const authorization = { principalId: principal.principalId, grantId: principal.grantId };
    const taskId = idField(value, "taskId"), candidateId = idField(value, "candidateId"), reportId = idField(value, "reportId");
    const stored = this.#findReport(reportId);
    if (stored.taskId !== taskId || stored.candidateId !== candidateId) throw new RuntimeError("OUT_OF_SCOPE", "Report is not bound to this task and candidate");
    const report = stored.report as TrustedVerificationReport;
    if (report.status !== "PASS") throw new RuntimeError("VERIFY_FAILED", "Only a fully passing trusted report can be reviewed", { recoverable: true });
    const review = await this.#options.changeManager.agent.requestReview({ ...authorization, candidateId });
    if (!review.canApprove) throw new RuntimeError("CANDIDATE_STALE", "Candidate is no longer reviewable", { recoverable: true, details: { blockReasons: review.blockReasons } });
    return { taskId, candidateId, state: "PENDING_APPROVAL" };
  }

  async #dispatchMcp(principal: Extract<Principal, { readonly kind: "mcp-client" }>, tool: SafeMcpToolName, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = objectInput(input);
    const authorization = { principalId: principal.principalId, grantId: principal.grantId };
    switch (tool) {
      case "boxspec_get_capabilities":
        assertNoExtraFields(value, []);
        return { serverVersion: "0.1.0", toolSchemaVersion: "1.0.0", contractVersions: ["1.0.0"], protocolVersion: "1.0.0", appRunning: true, adapters: [{ target: "web-react", status: "available" }], maxPatchBytes: 1_048_576 };
      case "boxspec_list_projects": {
        assertNoExtraFields(value, ["cursor", "limit"]);
        const grants = await this.#options.changeManager.desktop.listProjectGrants();
        const granted = grants.filter((grant) => grant.grantId === principal.grantId && grant.principalId === principal.principalId && Date.parse(grant.expiresAt) > this.#clock().getTime());
        const offset = parseCursor(stringField(value, "cursor", { optional: true, max: 256 }));
        const limit = integerField(value, "limit", { optional: true, min: 1, max: 50 }) ?? 50;
        const projects = granted.map((grant) => this.#state.snapshot().projects[grant.projectId]).filter((item): item is RuntimeProjectRecord => item !== undefined);
        return { projects: projects.slice(offset, offset + limit).map((project) => ({ projectId: project.projectId, name: project.name, target: project.target })), nextCursor: offset + limit < projects.length ? String(offset + limit) : null };
      }
      case "boxspec_get_selection": {
        assertNoExtraFields(value, ["projectId"]);
        const projectId = idField(value, "projectId");
        await this.#authorize(principal, projectId, "read");
        return this.#state.snapshot().selections[projectId] ?? { projectId, screenId: null, nodeIds: [], revision: null };
      }
      case "boxspec_get_context": {
        assertNoExtraFields(value, ["projectId", "screenId", "expectedRevision", "nodeIds", "cursor"]);
        const projectId = idField(value, "projectId"), screenId = idField(value, "screenId");
        const expectedRevision = integerField(value, "expectedRevision", { min: 1 })!;
        const nodeIds = stringArrayField(value, "nodeIds", { min: 1, max: 1000, id: true });
        const grant = await this.#authorize(principal, projectId, "read");
        const contract = this.#coreFor(this.#project(projectId)).getScreen(projectId, screenId);
        if (contract.revision !== expectedRevision) throw new RuntimeError("REVISION_CONFLICT", "Screen revision changed", { recoverable: true, details: { expectedRevision, actualRevision: contract.revision } });
        const slice = createContextSlice(contract, nodeIds);
        return { projectId, screenId, revision: contract.revision, contextHash: hashCanonical(slice), schemaVersion: "1.0.0", contractSliceJson: canonicalize(slice), designSystemJson: canonicalize(contract.designSystem), bindingsJson: "{}", scopeNodeIds: nodeIds, affectedNodeIds: slice.includedNodes.map((node) => node.id), protectedPaths: grant.protectedPaths, nextCursor: null };
      }
      case "boxspec_search_assets":
        throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Approved asset indexing is not configured", { recoverable: true });
      case "boxspec_start_task": {
        assertNoExtraFields(value, ["requestId", "projectId", "screenId", "expectedRevision", "scopeNodeIds", "objective", "executionProfileId"]);
        const projectId = idField(value, "projectId"), screenId = idField(value, "screenId");
        const grant = await this.#authorize(principal, projectId, "candidate-write");
        const contract = this.#coreFor(this.#project(projectId)).getScreen(projectId, screenId);
        const expectedRevision = integerField(value, "expectedRevision", { min: 1 })!;
        if (contract.revision !== expectedRevision) throw new RuntimeError("REVISION_CONFLICT", "Screen revision changed", { recoverable: true });
        const scopeNodeIds = stringArrayField(value, "scopeNodeIds", { min: 1, max: 1000, id: true });
        for (const nodeId of scopeNodeIds) if (!contract.nodes.some((node) => node.id === nodeId)) throw new RuntimeError("OUT_OF_SCOPE", `Unknown scope node: ${nodeId}`);
        const project = this.#project(projectId);
        const baseCommit = await gitHead(project.rootPath);
        const verificationProfileId = this.#options.defaultVerificationProfileId;
        const profile = verificationProfileId ? this.#options.verificationProfiles?.[verificationProfileId] : undefined;
        if (!verificationProfileId || !profile) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "No approved default verification profile is configured", { recoverable: true });
        const task = await this.#options.changeManager.agent.startTask({
          ...authorization, projectId, screenId, expectedRevision, scopeNodeIds,
          objective: stringField(value, "objective", { max: 20_000 })!,
          executionProfileId: idField(value, "executionProfileId"),
          contractHash: hashContract(contract),
          policyHash: hashCanonical({ allowedPaths: grant.allowedWritePaths, protectedPaths: grant.protectedPaths }),
          policyRevision: grant.grantRevision,
          generatorVersion: compileReactShell(contract).generatorVersion,
          dependencyLockHash: await dependencyLockHash(project.rootPath),
          fixturesHash: hashCanonical(this.#options.fixtures ?? {}),
          verificationProfileId,
          verificationProfileHash: hashCanonical(profile),
          expectedBaseCommit: baseCommit,
        });
        return { taskId: task.taskId, state: task.state, handoffArtifactId: `handoff_${task.taskId}`, workspacePath: task.workspacePath, baseContractRevision: task.baseContractRevision };
      }
      case "boxspec_get_task": {
        assertNoExtraFields(value, ["taskId", "afterSequence"]);
        const task = await this.#options.changeManager.agent.getTask({ ...authorization, taskId: idField(value, "taskId") });
        return taskOutput(task, integerField(value, "afterSequence", { optional: true, min: 0 }) ?? 0, this.#reportForTask(task.taskId));
      }
      case "boxspec_propose_patch": {
        assertNoExtraFields(value, ["requestId", "taskId", "expectedRevision", "files"]);
        const taskId = idField(value, "taskId");
        const task = await this.#options.changeManager.agent.getTask({ ...authorization, taskId });
        if (integerField(value, "expectedRevision", { min: 1 }) !== task.baseContractRevision) throw new RuntimeError("REVISION_CONFLICT", "Patch contract revision differs from task base", { recoverable: true });
        if (!Array.isArray(value["files"]) || value["files"].length > 200) throw new RuntimeError("INVALID_REQUEST", "files must be an array of at most 200 entries");
        let bytes = 0;
        const files = value["files"].map((entry, index) => {
          const file = objectInput(entry, `files[${index}]`); assertNoExtraFields(file, ["path", "operation", "content"]);
          const operation = enumField(file, "operation", ["upsert", "delete"] as const);
          const contentUtf8 = stringField(file, "content", { optional: operation === "delete", max: 1_048_576 }); bytes += Buffer.byteLength(contentUtf8 ?? "", "utf8");
          return { relativePath: stringField(file, "path", { min: 1, max: 512 })!, operation, ...(contentUtf8 === undefined ? {} : { contentUtf8 }) };
        });
        if (bytes > 1_048_576) throw new RuntimeError("RESOURCE_LIMIT", "Patch exceeds the 1 MiB limit");
        const result = await this.#options.changeManager.agent.proposePatch({ ...authorization, taskId, expectedRevision: task.revision, files });
        return { taskId, stagingManifestHash: result.stagingManifestHash, changedPaths: result.changedPaths };
      }
      case "boxspec_submit_candidate": return this.#submitCandidate(principal, value, signal);
      case "boxspec_verify_candidate": return this.#verifyCandidate(principal, value, signal);
      case "boxspec_get_report": {
        assertNoExtraFields(value, ["reportId"]);
        const stored = this.#findReport(idField(value, "reportId"));
        const task = await this.#options.changeManager.agent.getTask({ ...authorization, taskId: stored.taskId });
        await this.#authorize(principal, task.projectId, "read");
        return toMcpReport(stored.report as TrustedVerificationReport);
      }
      case "boxspec_get_artifact": return this.#getArtifact(principal, value);
      case "boxspec_propose_contract_change": return this.#proposeContractChange(principal, value);
      case "boxspec_request_review": return this.#requestReview(principal, value);
      case "boxspec_cancel_task": {
        assertNoExtraFields(value, ["requestId", "taskId", "reason"]);
        const task = await this.#options.changeManager.agent.cancelTask({ ...authorization, taskId: idField(value, "taskId") });
        return { taskId: task.taskId, cancelRequested: true, state: task.state };
      }
    }
  }

  async #authorizeAny(principal: Extract<Principal, { readonly kind: "mcp-client" }>) {
    const grants = await this.#options.changeManager.desktop.listProjectGrants();
    const grant = grants.find((item) => item.grantId === principal.grantId && item.principalId === principal.principalId);
    if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= this.#clock().getTime()) {
      throw new RuntimeError("PAIRING_REQUIRED", "The MCP grant is missing, revoked, or expired", { recoverable: true });
    }
    return grant;
  }

  async #authorize(
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    projectId: string,
    permission: "read" | "candidate-write" | "verify",
  ) {
    return this.#options.changeManager.agent.authorizeGrant({
      principalId: principal.principalId,
      grantId: principal.grantId,
      projectId,
      permission,
    });
  }

  #project(projectId: string): RuntimeProjectRecord {
    const project = this.#state.snapshot().projects[projectId];
    if (!project) throw new RuntimeError("NOT_FOUND", "Project does not exist", { details: { projectId } });
    return project;
  }

  #coreFor(project: RuntimeProjectRecord): BoxSpecCore {
    let core = this.#core.get(project.projectId);
    if (!core) {
      core = BoxSpecCore.open({ databasePath: project.databasePath });
      this.#core.set(project.projectId, core);
    }
    return core;
  }

  #findReport(reportId: string) {
    const report = this.#state.snapshot().reports[reportId];
    if (!report) throw new RuntimeError("NOT_FOUND", "Verification report does not exist");
    return report;
  }

  #reportForTask(taskId: string): string | null {
    return Object.values(this.#state.snapshot().reports).find((report) => report.taskId === taskId)?.reportId ?? null;
  }

  async #reconcileDraftPublications(): Promise<void> {
    for (const proposal of Object.values(this.#state.snapshot().proposals)) {
      const intent = proposal.publishIntent;
      if (!intent) continue;
      const project = this.#state.snapshot().projects[proposal.projectId];
      if (!project) continue;
      let approved: LayoutContract;
      try { approved = this.#coreFor(project).getScreen(proposal.projectId, proposal.screenId); }
      catch { continue; }
      const handoff = intent.handoff;
      const approvedHash = hashContract(approved);
      if (approved.revision === handoff.newRevision && approvedHash === handoff.newContractHash) {
        const now = this.#now();
        await this.#state.update((state) => ({
          ...state,
          proposals: Object.fromEntries(Object.entries(state.proposals).map(([proposalId, item]) => {
            if (proposalId === proposal.proposalId) return [proposalId, { ...withoutPublishIntent(item), status: "PUBLISHED" as const, updatedAt: now, publishRequestId: intent.requestId, publishedHandoff: handoff }];
            const itemStatus = proposalSummary(item).status;
            if (item.projectId === proposal.projectId && item.screenId === proposal.screenId && (itemStatus === "AWAITING_USER" || itemStatus === "USER_EDITING_DRAFT")) {
              return [proposalId, { ...item, status: "STALE" as const, updatedAt: now }];
            }
            return [proposalId, item];
          })),
          selections: {
            ...state.selections,
            [proposal.projectId]: { projectId: proposal.projectId, screenId: proposal.screenId, nodeIds: proposal.selectedNodeIds ?? [], revision: approved.revision },
          },
        }));
      } else if (approved.revision !== proposal.baseRevision || approvedHash !== proposal.baseContractHash) {
        await this.#state.update((state) => ({
          ...state,
          proposals: {
            ...state.proposals,
            [proposal.proposalId]: { ...withoutPublishIntent(state.proposals[proposal.proposalId]!), status: "STALE", updatedAt: this.#now() },
          },
        }));
      }
    }
  }

  async #reconcileManagedWrites(): Promise<void> {
    const entries = Object.values(this.#state.snapshot().managedWrites);
    if (entries.length === 0) return;
    if (this.#nativeSafeFs === null) return;
    for (const entry of entries) {
      const project = this.#state.snapshot().projects[entry.projectId];
      if (!project) continue;
      const rootIdentity = await this.#nativeSafeFs.inspectRoot(project.rootPath);
      if (
        rootIdentity.canonicalPath.toLowerCase() !== project.nativeCanonicalRootPath?.toLowerCase() ||
        rootIdentity.volumeId !== project.nativeRootVolumeId ||
        rootIdentity.fileId !== project.nativeRootFileId
      ) continue;
      const bound = {
        transactionId: entry.transactionId,
        root: project.rootPath,
        rootIdentity,
        relativePath: entry.relativePath,
        preparedId: entry.preparedId,
      };
      const classification = await this.#nativeSafeFs.classifyRecovery({ ...bound, beforeHash: entry.beforeHash, afterHash: entry.afterHash });
      if (classification.state === "UNKNOWN") continue;
      await this.#nativeSafeFs.recoverReplace({ ...bound, decision: classification.state === "AFTER" ? "finish_after" : "restore_before" });
      await this.#nativeSafeFs.finalizeReplace(bound);
      await this.#state.update((state) => {
        const { [entry.transactionId]: _completed, ...managedWrites } = state.managedWrites;
        return { ...state, managedWrites };
      });
    }
  }

  async #reconcileManagedSaveBatches(): Promise<void> {
    for (const batch of Object.values(this.#state.snapshot().managedSaveBatches)) {
      try {
        await this.#resumeManagedSaveBatch(batch.batchId);
      } catch (error) {
        // Exact non-BEFORE/non-AFTER content is preserved for explicit drift
        // resolution. Startup remains usable for in-database canvas editing.
        if (!(error instanceof RuntimeError) || error.code !== "APPLY_CONFLICT") throw error;
      }
    }
  }

  async #resumeManagedSaveBatch(batchId: string, signal?: AbortSignal): Promise<void> {
    const batch = this.#state.snapshot().managedSaveBatches[batchId];
    if (!batch) return;
    const project = this.#state.snapshot().projects[batch.projectId];
    if (!project) throw new RuntimeError("NOT_FOUND", "Managed save project no longer exists");
    for (const output of batch.outputs) {
      throwIfAborted(signal);
      if (sha256Text(output.content) !== output.afterHash) {
        throw new RuntimeError("APPLY_CONFLICT", "Managed save journal content hash is invalid", {
          recoverable: true,
          details: { relativePath: output.relativePath },
        });
      }
      const target = await safeManagedTarget(project, output.relativePath);
      const currentHash = await pathExists(target) ? await sha256File(target) : null;
      if (currentHash === output.afterHash) continue;
      if (currentHash !== output.beforeHash) {
        throw new RuntimeError("APPLY_CONFLICT", "Managed save encountered content outside its durable BEFORE/AFTER set", {
          recoverable: true,
          details: { relativePath: output.relativePath, expectedHash: output.beforeHash, currentHash, desiredHash: output.afterHash },
        });
      }
      await this.#writeManagedFile(project, output.relativePath, output.content, output.beforeHash);
    }
    await this.#state.update((state) => {
      const { [batchId]: _completed, ...managedSaveBatches } = state.managedSaveBatches;
      return { ...state, managedSaveBatches };
    });
  }

  async #writeManagedFile(project: RuntimeProjectRecord, relativePath: string, contents: string, preflightBeforeHash?: string | null): Promise<void> {
    const normalized = normalizeRelative(relativePath);
    if (process.platform === "win32" && this.#nativeSafeFs === null) {
      throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Trusted Windows managed-file writes require the pinned native safe-filesystem helper", { recoverable: true });
    }
    if (process.platform === "win32" && this.#nativeSafeFs !== null) {
      if (Object.values(this.#state.snapshot().managedWrites).some((entry) => entry.projectId === project.projectId && entry.relativePath === normalized)) {
        throw new RuntimeError("APPLY_CONFLICT", "A prior managed write requires recovery before this path can be changed", { recoverable: true, details: { relativePath: normalized } });
      }
      const rootIdentity = await this.#nativeSafeFs.inspectRoot(project.rootPath);
      if (
        project.nativeCanonicalRootPath === undefined ||
        project.nativeRootVolumeId === undefined ||
        project.nativeRootFileId === undefined ||
        rootIdentity.canonicalPath.toLowerCase() !== project.nativeCanonicalRootPath.toLowerCase() ||
        rootIdentity.volumeId !== project.nativeRootVolumeId ||
        rootIdentity.fileId !== project.nativeRootFileId
      ) {
        throw new RuntimeError("PROJECT_NOT_GRANTED", "Project root identity changed after approval", { recoverable: true });
      }
      const target = resolve(project.rootPath, ...normalized.split("/"));
      const observedBeforeHash = await pathExists(target) ? await sha256File(target) : null;
      if (preflightBeforeHash !== undefined && observedBeforeHash !== preflightBeforeHash) {
        throw new RuntimeError("APPLY_CONFLICT", "Managed output changed after preflight", {
          recoverable: true,
          details: { relativePath: normalized, expectedHash: preflightBeforeHash, currentHash: observedBeforeHash },
        });
      }
      const expectedBeforeHash = preflightBeforeHash === undefined ? observedBeforeHash : preflightBeforeHash;
      const transactionId = this.#id("managed-write");
      const parentPath = normalized.split("/").slice(0, -1).join("/");
      if (parentPath) {
        await this.#nativeSafeFs.ensureDirectory({
          root: project.rootPath,
          rootIdentity,
          relativePath: parentPath,
        });
      }
      const prepared = await this.#nativeSafeFs.prepareReplace({
        transactionId,
        root: project.rootPath,
        rootIdentity,
        relativePath: normalized,
        expectedBeforeHash,
        afterBytes: Buffer.from(contents, "utf8"),
      });
      await this.#state.update((state) => ({
        ...state,
        managedWrites: {
          ...state.managedWrites,
          [transactionId]: {
            transactionId,
            projectId: project.projectId,
            relativePath: normalized,
            preparedId: prepared.preparedId,
            beforeHash: prepared.beforeHash,
            afterHash: prepared.afterHash ?? sha256Text(contents),
            createdAt: this.#now(),
          },
        },
      }));
      const committed = await this.#nativeSafeFs.commitReplace({
        transactionId,
        root: project.rootPath,
        rootIdentity,
        relativePath: normalized,
        preparedId: prepared.preparedId,
      });
      const expectedAfterHash = sha256Text(contents);
      if (committed.afterHash !== expectedAfterHash) {
        throw new RuntimeError("APPLY_CONFLICT", "Native managed write returned an unexpected content hash", { details: { relativePath: normalized } });
      }
      await this.#nativeSafeFs.finalizeReplace({
        transactionId,
        root: project.rootPath,
        rootIdentity,
        relativePath: normalized,
        preparedId: prepared.preparedId,
      });
      await this.#state.update((state) => {
        const { [transactionId]: _completed, ...managedWrites } = state.managedWrites;
        return { ...state, managedWrites };
      });
      return;
    }
    const target = await safeManagedTarget(project, normalized);
    if (preflightBeforeHash !== undefined) {
      const currentHash = await pathExists(target) ? await sha256File(target) : null;
      if (currentHash !== preflightBeforeHash) {
        throw new RuntimeError("APPLY_CONFLICT", "Managed output changed after preflight", {
          recoverable: true,
          details: { relativePath: normalized, expectedHash: preflightBeforeHash, currentHash },
        });
      }
    }
    await atomicWriteUtf8(target, contents);
  }

  #clock(): Date { return this.#options.clock?.() ?? new Date(); }
  #now(): string { return this.#clock().toISOString(); }
  #id(prefix: string): string { return this.#options.idGenerator?.(prefix) ?? `${prefix}_${randomUUID().replaceAll("-", "")}`; }
  #assertOpen(): void { if (this.#closed) throw new RuntimeError("APP_NOT_RUNNING", "BoxSpec runtime is closed", { recoverable: true }); }
}

function toProjectSummary(project: RuntimeProjectRecord): DesktopProjectSummary {
  return { projectId: project.projectId as ProjectId, name: project.name, rootPath: project.rootPath, target: project.target };
}

function failure(error: RuntimeError, requestId: RequestId): ToolResult<never> {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    requestId,
    ...(error.details ? { details: error.details as JsonObject } : {}),
  };
}

function extractRequestId(input: unknown): RequestId | undefined {
  if (!isRecord(input) || typeof input["requestId"] !== "string") return undefined;
  return input["requestId"] as RequestId;
}

function createContextSlice(contract: LayoutContract, scopeNodeIds: readonly string[]) {
  const byId = new Map(contract.nodes.map((node) => [node.id as string, node]));
  const included = new Set<string>();
  const visitAncestors = (nodeId: string) => {
    let current = byId.get(nodeId);
    while (current && !included.has(current.id)) {
      included.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  };
  for (const nodeId of scopeNodeIds) {
    if (!byId.has(nodeId)) throw new RuntimeError("OUT_OF_SCOPE", `Unknown node: ${nodeId}`);
    visitAncestors(nodeId);
  }
  const assertions = contract.assertions.filter((assertion) => included.has(assertion.nodeId) || ("otherNodeId" in assertion && included.has(assertion.otherNodeId)));
  for (const assertion of assertions) {
    included.add(assertion.nodeId);
    if ("otherNodeId" in assertion) included.add(assertion.otherNodeId);
  }
  return {
    schemaVersion: "1.0.0" as const,
    kind: "context-slice" as const,
    projectId: contract.projectId,
    screenId: contract.screenId,
    revision: contract.revision,
    contractHash: hashContract(contract),
    rootNodeId: contract.rootNodeId,
    coordinateSpace: contract.coordinateSpace,
    breakpoints: contract.breakpoints,
    defaultPolicy: contract.defaultPolicy,
    scopeNodeIds,
    includedNodes: contract.nodes.filter((node) => included.has(node.id)),
    assertions,
    totalNodeCount: contract.nodes.length,
    nextCursor: null,
  };
}

function taskOutput(task: TaskRecord, afterSequence: number, reportId: string | null) {
  return {
    taskId: task.taskId,
    state: task.state,
    workspacePath: task.workspacePath,
    events: afterSequence < task.revision ? [{ sequence: task.revision, type: "state", message: task.state, artifactId: null }] : [],
    nextSequence: task.revision,
    candidateId: task.candidateId ?? null,
    reportId,
    allowedNextActions: allowedNextActions(task.state),
  };
}

function allowedNextActions(state: TaskRecord["state"]): readonly string[] {
  switch (state) {
    case "READY": case "IMPLEMENTING": case "NEEDS_REPAIR": return ["propose_patch", "submit_candidate", "cancel"];
    case "SNAPSHOTTING": case "VERIFYING": return ["cancel"];
    case "PENDING_APPROVAL": return [];
    case "APPLYING": return [];
    case "APPLIED": case "CANCELLED": case "FAILED": case "STALE": return [];
  }
}

function parseLayoutOverrides(value: unknown): LayoutOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new RuntimeError("INVALID_REQUEST", "layoutOverrides must be an array");
  return value.map((entry, index) => {
    const item = objectInput(entry, `layoutOverrides[${index}]`);
    assertNoExtraFields(item, ["nodeId", "path", "value"]);
    const path = stringField(item, "path", { min: 8, max: 256, pattern: /^\/layout\// })! as `/layout/${string}`;
    const scalar = item["value"];
    if (typeof scalar !== "string" && typeof scalar !== "number" && typeof scalar !== "boolean") {
      throw new RuntimeError("INVALID_REQUEST", `layoutOverrides[${index}].value must be scalar`);
    }
    return { nodeId: idField(item, "nodeId"), path, value: scalar };
  });
}

function toMcpReport(report: TrustedVerificationReport) {
  return {
    reportId: report.reportId,
    candidateId: report.candidateId,
    treeHash: report.identity.treeHash,
    contractHash: report.identity.contractHash,
    effectiveContractHash: report.identity.effectiveContractHash,
    layoutOverridesHash: report.identity.layoutOverridesHash,
    status: report.status,
    checks: report.checks.map((check) => ({
      checkId: check.id,
      status: normalizeVerificationCheckStatus(check.status),
      nodeId: null,
      code: check.status === "NOT_RUN" || check.status === "UNSUPPORTED" ? check.status : check.kind,
      message: check.message,
      artifactIds: [],
    })),
    artifactIds: report.artifacts.map((artifact) => artifact.artifactId),
  };
}

function toSharedReport(report: TrustedVerificationReport): SharedVerificationReport {
  const mcp = toMcpReport(report);
  return {
    reportId: mcp.reportId as ReportId,
    candidateId: mcp.candidateId as CandidateId,
    treeHash: mcp.treeHash as Sha256,
    contractHash: mcp.contractHash as Sha256,
    effectiveContractHash: mcp.effectiveContractHash as Sha256,
    layoutOverridesHash: mcp.layoutOverridesHash as Sha256,
    evidenceHash: report.evidenceDigest as Sha256,
    status: report.status as VerificationStatus,
    checks: mcp.checks as readonly SharedVerificationCheck[],
    artifactIds: mcp.artifactIds,
  };
}

export function normalizeVerificationCheckStatus(status: "PASS" | "FAIL" | "ERROR" | "NOT_RUN" | "UNSUPPORTED"): VerificationStatus {
  if (status === "NOT_RUN" || status === "UNSUPPORTED") return "UNVERIFIED";
  return status;
}

function permissionForTool(tool: SafeMcpToolName): "read" | "candidate-write" | "verify" | null {
  switch (tool) {
    case "boxspec_get_capabilities": case "boxspec_list_projects": return null;
    case "boxspec_get_selection": case "boxspec_get_context": case "boxspec_search_assets": case "boxspec_get_task": case "boxspec_get_report": case "boxspec_get_artifact": return "read";
    case "boxspec_verify_candidate": return "verify";
    case "boxspec_start_task": case "boxspec_propose_patch": case "boxspec_submit_candidate": case "boxspec_propose_contract_change": case "boxspec_request_review": case "boxspec_cancel_task": return "candidate-write";
  }
}

function assertVerificationComposition(options: RuntimeOptions): void {
  const hasAny = options.verificationProfiles !== undefined || options.defaultVerificationProfileId !== undefined || options.fixtures !== undefined || options.approvedExecutionProfileIds !== undefined;
  if (!hasAny) return;
  const defaultId = options.defaultVerificationProfileId;
  if (!defaultId || !options.verificationProfiles?.[defaultId] || !options.fixtures || !options.approvedExecutionProfileIds?.length) {
    throw new RuntimeError("INVALID_REQUEST", "Trusted verification composition is incomplete");
  }
  for (const fixtureId of ["empty", "loading", "error", "long-text", "populated"]) {
    if (!(fixtureId in options.fixtures)) throw new RuntimeError("INVALID_REQUEST", `Trusted verification fixture is missing: ${fixtureId}`);
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new RuntimeError("INVALID_REQUEST", "cursor is invalid");
  return value;
}

async function readGeneratedManifest(path: string): Promise<Record<string, string>> {
  try {
    const value = objectInput(JSON.parse(await readFile(path, "utf8")) as unknown, "generated manifest");
    return isRecord(value["files"]) ? Object.fromEntries(Object.entries(value["files"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new RuntimeError("APPLY_CONFLICT", "Generated manifest is invalid", { recoverable: true, cause: error });
  }
}

async function preflightManagedOutput(
  project: RuntimeProjectRecord,
  relativePath: string,
  content: string,
  recordedHashes: Readonly<Record<string, string>>,
): Promise<{ relativePath: string; content: string; contentHash: string; beforeHash: string | null }> {
  const normalized = normalizeRelative(relativePath);
  const target = await safeManagedTarget(project, normalized);
  const contentHash = sha256Text(content);
  const beforeHash = await pathExists(target) ? await sha256File(target) : null;
  const recordedHash = recordedHashes[normalized];
  if (beforeHash !== null && recordedHash === undefined && beforeHash !== contentHash) {
    throw new RuntimeError("APPLY_CONFLICT", "A managed output contains untracked content", {
      recoverable: true,
      details: { relativePath: normalized, currentHash: beforeHash, desiredHash: contentHash },
    });
  }
  if (beforeHash !== null && recordedHash !== undefined && beforeHash !== recordedHash) {
    throw new RuntimeError("APPLY_CONFLICT", "A managed output changed outside BoxSpec", {
      recoverable: true,
      details: { relativePath: normalized, expectedHash: recordedHash, currentHash: beforeHash, desiredHash: contentHash },
    });
  }
  return { relativePath: normalized, content, contentHash, beforeHash };
}

async function preflightContractOutput(
  project: RuntimeProjectRecord,
  relativePath: string,
  content: string,
  approved: LayoutContract,
  recordedHashes: Readonly<Record<string, string>>,
): Promise<{ relativePath: string; content: string; contentHash: string; beforeHash: string | null }> {
  const normalized = normalizeRelative(relativePath);
  const target = await safeManagedTarget(project, normalized);
  const contentHash = sha256Text(content);
  if (!await pathExists(target)) return { relativePath: normalized, content, contentHash, beforeHash: null };
  const bytes = await readFile(target);
  const beforeHash = createHash("sha256").update(bytes).digest("hex");
  const recordedHash = recordedHashes[normalized];
  if (beforeHash === contentHash || beforeHash === recordedHash) return { relativePath: normalized, content, contentHash, beforeHash };
  try {
    const observed = parseLayoutContract(JSON.parse(bytes.toString("utf8")) as unknown);
    if (observed.projectId === approved.projectId && observed.screenId === approved.screenId && hashContract(observed) === hashContract(approved)) {
      return { relativePath: normalized, content, contentHash, beforeHash };
    }
  } catch {
    // Invalid or differently bound contract bytes are reported as drift below.
  }
  throw new RuntimeError("APPLY_CONFLICT", "A managed contract export changed outside BoxSpec", {
    recoverable: true,
    details: { relativePath: normalized, expectedHash: recordedHash ?? null, currentHash: beforeHash, desiredHash: contentHash },
  });
}

function normalizeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new RuntimeError("INVALID_REQUEST", "Generated path is invalid");
  }
  return normalized;
}

function managedPathScreenId(path: string): string | null {
  const contract = /^\.boxspec\/screens\/([A-Za-z][A-Za-z0-9_-]{0,95})\.contract\.json$/.exec(path);
  if (contract) return contract[1]!;
  const generated = /^src\/boxspec\/generated\/([A-Za-z][A-Za-z0-9_-]{0,95})\./.exec(path);
  return generated?.[1] ?? null;
}

function mapManagedDriftError(error: unknown): RuntimeError {
  if (!(error instanceof ManagedSourceDriftError)) return mapRuntimeError(error);
  if (error.code === "STALE_INSPECTION") {
    return new RuntimeError("APPLY_CONFLICT", error.message, { recoverable: true, details: error.details, cause: error });
  }
  if (error.code === "UNSUPPORTED_RESOLUTION") {
    return new RuntimeError("UNSUPPORTED_CAPABILITY", error.message, { recoverable: true, details: error.details, cause: error });
  }
  return new RuntimeError("INVALID_REQUEST", error.message, { details: error.details, cause: error });
}

async function safeManagedTarget(project: RuntimeProjectRecord, relativePath: string): Promise<string> {
  const normalized = normalizeRelative(relativePath);
  const currentRoot = await realpath(project.rootPath);
  const rootInfo = await stat(project.rootPath, { bigint: true });
  if (
    currentRoot.toLowerCase() !== project.canonicalRootPath.toLowerCase() ||
    String(rootInfo.dev) !== project.rootDeviceId ||
    String(rootInfo.ino) !== project.rootFileId
  ) {
    throw new RuntimeError("PROJECT_NOT_GRANTED", "Project root identity changed after approval", { recoverable: true });
  }
  let cursor = project.rootPath;
  const parts = normalized.split("/");
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new RuntimeError("OUT_OF_SCOPE", "Managed output path contains a link or junction", { details: { relativePath } });
      const canonical = await realpath(cursor);
      if (!isContained(currentRoot, canonical)) throw new RuntimeError("OUT_OF_SCOPE", "Managed output path escaped the approved root", { details: { relativePath } });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      throw error;
    }
  }
  const target = resolve(project.rootPath, ...parts);
  if (!isContained(currentRoot, target)) throw new RuntimeError("OUT_OF_SCOPE", "Managed output path escaped the approved root", { details: { relativePath } });
  return target;
}

function isContained(root: string, target: string): boolean {
  const rootKey = root.toLowerCase();
  const targetKey = target.toLowerCase();
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}\\`);
}

async function gitHead(root: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", windowsHide: true });
    return result.stdout.trim();
  } catch (error) {
    throw new RuntimeError("DIRTY_BASELINE", "Project must have a Git HEAD before tasks can start", { recoverable: true, cause: error });
  }
}

async function dependencyLockHash(root: string): Promise<string> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(root, name);
    if (!(await pathExists(path))) continue;
    try {
      // Tasks are isolated from the approved HEAD commit. Hash the same bytes Git
      // will materialize in the task worktree so Windows checkout EOL conversion
      // cannot make a freshly frozen candidate stale.
      const { stdout } = await execFileAsync("git", ["cat-file", "--filters", `--path=${name}`, `HEAD:${name}`], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return createHash("sha256").update(stdout).digest("hex");
    } catch (error) {
      throw new RuntimeError("DIRTY_BASELINE", `Dependency lockfile ${name} is not available from the approved HEAD commit`, {
        recoverable: true,
        cause: error,
      });
    }
  }
  throw new RuntimeError("VERIFY_FAILED", "Project has no supported dependency lockfile");
}

function assertReportIdentity(candidate: FrozenCandidateDescriptor, report: TrustedVerificationReport): void {
  const expected = {
    projectId: candidate.projectId,
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    treeHash: candidate.treeHash,
    contractHash: candidate.contractHash,
    effectiveContractHash: candidate.effectiveContractHash,
    layoutOverridesHash: candidate.layoutOverridesHash,
    baseContractRevision: candidate.baseContractRevision,
    baseCommitHash: candidate.baseCommitHash,
    baseManifestHash: candidate.baseManifestHash,
    generatorVersion: candidate.generatorVersion,
    policyHash: candidate.policyHash,
    policyRevision: candidate.policyRevision,
    dependencyLockHash: candidate.dependencyLockHash,
    fixturesHash: candidate.fixturesHash,
    verificationProfileId: candidate.verificationProfileId,
    verificationProfileHash: candidate.verificationProfileHash,
  };
  const actual = { candidateId: report.candidateId, ...report.identity };
  if (hashCanonical(expected) !== hashCanonical(actual)) throw new RuntimeError("CANDIDATE_STALE", "Verifier report identity differs from the frozen candidate");
  if (report.status === "PASS" && report.checks.some((check) => check.blocking && check.status !== "PASS")) {
    throw new RuntimeError("VERIFY_FAILED", "Verifier attempted to mark incomplete blocking checks as PASS");
  }
}

function toVerifierCandidate(candidate: FrozenCandidateDescriptor): VerifierFrozenCandidateDescriptor {
  let dependencyLock: FrozenCandidateDescriptor["files"][number] | undefined;
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    dependencyLock = candidate.files.find((file) => file.relativePath === name);
    if (dependencyLock) break;
  }
  if (!dependencyLock) throw new RuntimeError("VERIFY_FAILED", "Frozen candidate does not contain its bound dependency lockfile");
  return {
    projectId: candidate.projectId,
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    snapshotRoot: candidate.snapshotRoot,
    dependencyLockPath: dependencyLock.relativePath,
    treeHash: candidate.treeHash,
    baseContractHash: candidate.baseContractHash,
    effectiveContractHash: candidate.effectiveContractHash,
    layoutOverridesHash: candidate.layoutOverridesHash,
    baseContractRevision: candidate.baseContractRevision,
    baseCommitHash: candidate.baseCommitHash,
    baseManifestHash: candidate.baseManifestHash,
    generatorVersion: candidate.generatorVersion,
    policyHash: candidate.policyHash,
    policyRevision: candidate.policyRevision,
    dependencyLockHash: candidate.dependencyLockHash,
    fixturesHash: candidate.fixturesHash,
    verificationProfileId: candidate.verificationProfileId,
    verificationProfileHash: candidate.verificationProfileHash,
    files: candidate.files.map((file) => ({ relativePath: file.relativePath, sha256: file.sha256, size: file.size, executable: file.executable })),
    changes: candidate.changes,
    changedPaths: candidate.changedPaths,
  };
}

async function indexArtifacts(projectId: string, candidateId: string, evidenceRoot: string, artifacts: readonly EvidenceArtifact[]) {
  const result: Record<string, import("./state-store.js").PersistedArtifact> = {};
  const root = resolve(evidenceRoot);
  for (const artifact of artifacts) {
    const relativePath = normalizeRelative(artifact.relativePath);
    const absolutePath = resolve(root, ...relativePath.split("/"));
    if (!absolutePath.startsWith(`${root}\\`) && absolutePath !== root) throw new RuntimeError("OUT_OF_SCOPE", "Evidence artifact escaped its trusted root");
    const info = await stat(absolutePath);
    const actualHash = await sha256File(absolutePath);
    if (!info.isFile() || actualHash !== artifact.sha256) throw new RuntimeError("VERIFY_FAILED", "Evidence artifact integrity check failed");
    result[artifact.artifactId] = { artifactId: artifact.artifactId, projectId, candidateId, absolutePath, relativePath, mimeType: artifact.mediaType, sha256: actualHash, sizeBytes: info.size };
  }
  return result;
}

function toSharedCandidate(review: ReviewDetails) {
  return {
    projectId: review.task.projectId as ProjectId,
    taskId: review.task.taskId as import("@boxspec/shared/domain").TaskId,
    candidateId: review.candidate.candidateId as CandidateId,
    baseContractRevision: review.candidate.baseContractRevision,
    treeHash: review.candidate.treeHash as Sha256,
    baseContractHash: review.candidate.baseContractHash as Sha256,
    effectiveContractHash: review.candidate.effectiveContractHash as Sha256,
    layoutOverridesHash: review.candidate.layoutOverridesHash as Sha256,
    baseCommitHash: review.candidate.baseCommitHash as Sha256,
    baseManifestHash: review.candidate.baseManifestHash as Sha256,
    files: review.candidate.files.map((file) => ({ path: file.relativePath as RelativePath, kind: "file" as const, sha256: file.sha256 as Sha256, sizeBytes: file.size, executable: file.executable })),
    changedPaths: review.candidate.changedPaths as readonly RelativePath[],
  };
}

function toSharedVerification(review: ReviewDetails) {
  return {
    reportId: review.binding.reportId as ReportId,
    status: review.verification.status as VerificationStatus,
    verificationProfileId: review.candidate.verificationProfileId as import("@boxspec/shared/domain").VerificationProfileId,
    evidenceHash: review.binding.evidenceDigest as Sha256,
    verificationProfileHash: review.binding.verificationProfileHash as Sha256,
    policyHash: review.binding.policyHash as Sha256,
    policyRevision: review.binding.policyRevision,
    generatorVersion: review.binding.generatorVersion,
    dependencyLockHash: review.binding.dependencyLockHash as Sha256,
    fixturesHash: review.binding.fixturesHash as Sha256,
    checkedAt: review.verification.checkedAt as import("@boxspec/shared/domain").IsoTimestamp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientConfigPath(rootPath: string, client: ClientSetup["client"]): string {
  return client === "codex"
    ? join(rootPath, ".codex", "config.toml")
    : client === "claude-code"
      ? join(rootPath, ".mcp.json")
      : join(rootPath, "opencode.json");
}

function proposalSummary(proposal: RuntimeProposal): LayoutDraftSummary {
  const status = proposal.status === "LIVE" ? "AWAITING_USER" : proposal.status;
  return {
    proposalId: proposal.proposalId as LayoutDraftId,
    projectId: proposal.projectId as ProjectId,
    screenId: proposal.screenId as ScreenId,
    baseRevision: proposal.baseRevision,
    baseContractHash: (proposal.baseContractHash ?? "") as Sha256,
    targetRevision: proposal.baseRevision + 1,
    draftRevision: proposal.draftRevision ?? 1,
    reason: proposal.reason,
    principalId: proposal.principalId,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt ?? proposal.createdAt,
    status,
  };
}

function withoutPublishIntent(proposal: RuntimeProposal): Omit<RuntimeProposal, "publishIntent"> {
  const { publishIntent: _publishIntent, ...rest } = proposal;
  return rest;
}

function diffContractNodes(before: LayoutContract, after: LayoutContract): Pick<LayoutImplementationHandoff, "addedNodeIds" | "changedNodeIds" | "removedNodeIds" | "affectedNodeIds"> {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const addedNodeIds = [...afterNodes.keys()].filter((id) => !beforeNodes.has(id)).sort() as NodeId[];
  const removedNodeIds = [...beforeNodes.keys()].filter((id) => !afterNodes.has(id)).sort() as NodeId[];
  const changedNodeIds = [...afterNodes.keys()]
    .filter((id) => beforeNodes.has(id) && hashCanonical(beforeNodes.get(id)) !== hashCanonical(afterNodes.get(id)))
    .sort() as NodeId[];
  const affectedNodeIds = [...new Set<NodeId>([...addedNodeIds, ...changedNodeIds, ...removedNodeIds])].sort();
  return { addedNodeIds, changedNodeIds, removedNodeIds, affectedNodeIds };
}

function toLayoutHandoff(value: NonNullable<RuntimeProposal["publishedHandoff"]>): LayoutImplementationHandoff {
  return {
    handoffId: value.handoffId,
    projectId: value.projectId as ProjectId,
    screenId: value.screenId as ScreenId,
    proposalId: value.proposalId as LayoutDraftId,
    baseRevision: value.baseRevision,
    baseContractHash: value.baseContractHash as Sha256,
    newRevision: value.newRevision,
    newContractHash: value.newContractHash as Sha256,
    addedNodeIds: value.addedNodeIds as readonly NodeId[],
    changedNodeIds: value.changedNodeIds as readonly NodeId[],
    removedNodeIds: value.removedNodeIds as readonly NodeId[],
    affectedNodeIds: value.affectedNodeIds as readonly NodeId[],
    status: "AWAITING_AGENT",
  };
}

function assertDraftIdentity(contract: LayoutContract, projectId: string, screenId: string, baseRevision: number): void {
  if (contract.projectId !== projectId || contract.screenId !== screenId) {
    throw new RuntimeError("OUT_OF_SCOPE", "Draft contract identity differs from the requested project or screen");
  }
  if (contract.revision !== baseRevision + 1) {
    throw new RuntimeError("REVISION_CONFLICT", "Draft contract revision must be exactly one greater than its approved base", {
      recoverable: true,
      details: { baseRevision, draftContractRevision: contract.revision },
    });
  }
}

function recoveryProjectId(inspection: unknown): string | null {
  if (!isRecord(inspection)) return null;
  return typeof inspection["projectId"] === "string" ? inspection["projectId"] : null;
}

function parseRecoveryInput(input: unknown): RecoveryInput {
  const value = objectInput(input, "recovery");
  assertNoExtraFields(value, ["transactionId", "recoveryNonce", "strategy", "unknownPathDecisions"]);
  const rawDecisions = value["unknownPathDecisions"];
  if (!Array.isArray(rawDecisions) || rawDecisions.length > 1_000) {
    throw new RuntimeError("INVALID_REQUEST", "unknownPathDecisions must be an array of at most 1000 entries");
  }
  const seen = new Set<string>();
  const unknownPathDecisions = rawDecisions.map((entry, index) => {
    const decision = objectInput(entry, `unknownPathDecisions[${index}]`);
    assertNoExtraFields(decision, ["path", "action"]);
    const path = normalizeRelative(stringField(decision, "path", { min: 1, max: 4_096 })!);
    if (seen.has(path)) throw new RuntimeError("INVALID_REQUEST", "Recovery decisions contain a duplicate path", { details: { path } });
    seen.add(path);
    return {
      path: path as RelativePath,
      action: enumField(decision, "action", ["preserve-current", "finish-after", "restore-before"] as const),
    };
  });
  return {
    transactionId: idField(value, "transactionId") as TransactionId,
    recoveryNonce: idField(value, "recoveryNonce") as import("@boxspec/shared/domain").RecoveryNonce,
    strategy: enumField(value, "strategy", ["finish-after", "restore-before"] as const),
    unknownPathDecisions,
  };
}

async function inspectClientConfig(targetPath: string, client: ClientSetup["client"]): Promise<boolean> {
  const contents = await readFile(targetPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return false;
  if (client === "codex") return /(?:^|\n)\s*\[mcp_servers\.boxspec\]\s*(?:\n|$)/.test(contents);
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed)) return false;
    const servers = client === "claude-code" ? parsed["mcpServers"] : parsed["mcp"];
    return isRecord(servers) && isRecord(servers["boxspec"]);
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
