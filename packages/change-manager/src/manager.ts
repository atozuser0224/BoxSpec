import { randomUUID } from "node:crypto";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { GitRepository } from "./git.js";
import { NativeSafeFsClient, type NativeRootIdentity } from "./native-safe-fs.js";
import { compareOrdinal, computeCandidateTreeHash, sameCandidateIdentity, sha256 } from "./hash.js";
import {
  canonicalizeGrantedRoot,
  normalizeRelativePath,
  normalizeScopeEntry,
  pathMatchesScope,
  resolveSafeProjectPath,
  windowsCollisionKey,
} from "./path-safety.js";
import { ensureDirectory, readJson, writeJsonAtomic } from "./persistence.js";
import type {
  AgentAuthorization,
  AgentChangeManager,
  ApplyApprovedCandidateInput,
  ApplyJournal,
  ApplyJournalFile,
  ApplyResult,
  ApprovalRecord,
  ApprovalReceipt,
  ApproveCandidateInput,
  AuthorizeGrantInput,
  CandidateChange,
  CandidateFile,
  CandidateIdentity,
  ChangeManagerControllers,
  ChangeManagerOptions,
  CreateSubsetCandidateInput,
  DesktopChangeManager,
  FreezeCandidateInput,
  FrozenCandidateDescriptor,
  ProjectGrant,
  ProposePatchInput,
  ProposePatchResult,
  RecoveryDecision,
  RecoveryFileState,
  RecoveryInspection,
  RecoveryResult,
  RegisterProjectGrantInput,
  ReviewBinding,
  ReviewDetails,
  StartTaskInput,
  TaskRecord,
  TrustedVerificationInput,
  VerificationRecord,
  VerifierChangeManager,
} from "./types.js";
import { ChangeManagerError } from "./types.js";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/u;
const PORTABLE_APPLY_TEST_CAPABILITY = Symbol("portable-apply-test-only");

interface InternalChangeManagerOptions extends ChangeManagerOptions {
  readonly portableApplyTestCapability?: symbol;
}

interface MutableTask extends Omit<TaskRecord, "state" | "revision" | "candidateId"> {
  state: TaskRecord["state"];
  revision: number;
  candidateId?: string;
}

interface MutableJournal extends Omit<ApplyJournal, "phase" | "updatedAt" | "files" | "integrityHash"> {
  phase: ApplyJournal["phase"];
  updatedAt: string;
  integrityHash: string;
  files: Array<
    Omit<ApplyJournalFile, "stage" | "nativePreparedId"> & {
      stage: ApplyJournalFile["stage"];
      nativePreparedId?: string;
    }
  >;
}

interface ReviewToken {
  readonly candidateId: string;
  readonly reportId: string;
  readonly nonceHash: string;
  readonly bindingHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

interface StoredCandidate extends FrozenCandidateDescriptor {
  readonly projectId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly ownerPrincipalId: string;
}

export function createChangeManager(options: ChangeManagerOptions): ChangeManagerControllers {
  const manager = new ChangeManagerEngine(options);
  return manager.controllers();
}

/** @internal Imported only by source-level integration tests; not exported by the package entrypoint. */
export function createChangeManagerForTests(options: ChangeManagerOptions): ChangeManagerControllers {
  return new ChangeManagerEngine({ ...options, portableApplyTestCapability: PORTABLE_APPLY_TEST_CAPABILITY }).controllers();
}

class ChangeManagerEngine {
  private readonly stateRoot: string;
  private readonly gitBinary: string;
  private readonly clock: () => Date;
  private readonly idGenerator: (prefix: string) => string;
  private readonly verificationMaxAgeMs: number;
  private readonly approvalMaxAgeMs: number;
  private readonly maxSnapshotBytes: number;
  private readonly nativeSafeFs: NativeSafeFsClient | null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: InternalChangeManagerOptions) {
    this.stateRoot = path.resolve(options.stateRoot);
    this.gitBinary = options.gitBinary ?? "git";
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.verificationMaxAgeMs = options.verificationMaxAgeMs ?? 30 * 60_000;
    this.approvalMaxAgeMs = options.approvalMaxAgeMs ?? 10 * 60_000;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 512 * 1024 * 1024;
    this.nativeSafeFs = options.nativeSafeFs
      ? new NativeSafeFsClient(options.nativeSafeFs.binaryPath, options.nativeSafeFs.expectedSha256)
      : null;
  }

  controllers(): ChangeManagerControllers {
    const agent: AgentChangeManager = {
      startTask: (input) => this.exclusive(() => this.startTask(input)),
      proposePatch: (input) => this.exclusive(() => this.proposePatch(input)),
      freezeCandidate: (input) => this.exclusive(() => this.freezeCandidate(input)),
      requestReview: (input) => this.exclusive(() => this.requestReview(input)),
      cancelTask: (input) => this.exclusive(() => this.cancelTask(input)),
      getTask: (input) => this.exclusive(() => this.getOwnedTask(input)),
      listTasks: (input) => this.exclusive(() => this.listOwnedTasks(input)),
      getCandidate: (input) => this.exclusive(() => this.getOwnedCandidate(input)),
      authorizeGrant: (input) => this.exclusive(() => this.authorizeGrant(input)),
    };
    const verifier: VerifierChangeManager = {
      getFrozenCandidate: (candidateId) => this.exclusive(() => this.getVerifiedSnapshot(candidateId)),
      recordTrustedVerification: (input) => this.exclusive(() => this.recordTrustedVerification(input)),
      getVerification: (candidateId) => this.exclusive(() => this.readOptional(this.verificationPath(candidateId))),
    };
    const desktop: DesktopChangeManager = {
      registerProjectGrant: (input) => this.exclusive(() => this.registerProjectGrant(input)),
      inspectReview: (candidateId) => this.exclusive(() => this.inspectReview(candidateId, true)),
      createSubsetCandidate: (input) => this.exclusive(() => this.createSubsetCandidate(input)),
      approveCandidate: (input) => this.exclusive(() => this.approveCandidate(input)),
      applyApprovedCandidate: (input) => this.exclusive(() => this.applyApprovedCandidate(input)),
      inspectRecoveries: () => this.exclusive(() => this.inspectRecoveries()),
      recoverInterruptedApply: (transactionId, decision) =>
        this.exclusive(() => this.recoverInterruptedApply(transactionId, decision)),
      getProjectGrant: (projectId) =>
        this.exclusive(async () => {
          const grants = (await this.readAll<ProjectGrant>("grants"))
            .filter((grant) => grant.projectId === projectId && grant.revokedAt === undefined)
            .sort((left, right) => right.grantRevision - left.grantRevision);
          return grants[0] ?? null;
        }),
      listProjectGrants: () => this.exclusive(() => this.readAll<ProjectGrant>("grants")),
      listReviews: (projectId) => this.exclusive(() => this.listReviews(projectId)),
      revokeProjectGrant: (input) => this.exclusive(() => this.revokeProjectGrant(input)),
    };
    return {
      agent,
      verifier,
      desktop,
      initialize: () => this.exclusive(() => this.initialize()),
    };
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async initialize(): Promise<readonly RecoveryInspection[]> {
    await this.nativeSafeFs?.verifyExecutable();
    await Promise.all(
      ["grants", "tasks", "worktrees", "candidates", "verifications", "approvals", "journals", "reviews"].map((entry) =>
        ensureDirectory(path.join(this.stateRoot, entry)),
      ),
    );
    await this.finalizeCommittedJournals();
    return this.inspectRecoveries();
  }

  private async registerProjectGrant(input: RegisterProjectGrantInput): Promise<ProjectGrant> {
    assertId(input.projectId, "projectId");
    assertId(input.principalId, "principalId");
    if (!Number.isInteger(input.grantRevision) || input.grantRevision < 1) invalid("Invalid grant revision");
    if (input.permissions.length === 0) invalid("At least one grant permission is required");
    const expiresAt = parseFutureTimestamp(input.expiresAt, this.clock());
    const canonicalSourceRoot = await canonicalizeGrantedRoot(input.sourceRoot);
    const rootStats = await stat(canonicalSourceRoot, { bigint: true });
    if (!rootStats.isDirectory()) invalid("Granted root is not a directory");
    const repository = new GitRepository(canonicalSourceRoot, this.gitBinary);
    const topLevel = await canonicalizeGrantedRoot(await repository.topLevel());
    if (!samePath(topLevel, canonicalSourceRoot)) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Only a complete Git repository root can be granted", false);
    }
    const allowedWritePaths = uniqueNormalizedScope(input.allowedWritePaths);
    const protectedPaths = uniqueNormalizedScope(input.protectedPaths);
    if (allowedWritePaths.length === 0) invalid("At least one allowed write path is required");
    const nativeIdentity = await this.nativeSafeFs?.inspectRoot(canonicalSourceRoot);
    const grant: ProjectGrant = {
      grantId: this.idGenerator("grant"),
      projectId: input.projectId,
      principalId: input.principalId,
      approvedByPrincipalId: input.approvedPrincipalId,
      permissions: [...new Set(input.permissions)],
      sourceRoot: path.resolve(input.sourceRoot),
      canonicalSourceRoot,
      allowedWritePaths,
      protectedPaths,
      executionProfileIds: [...new Set(input.executionProfileIds)],
      grantRevision: input.grantRevision,
      rootDeviceId: nativeIdentity?.volumeId ?? String(rootStats.dev),
      rootFileId: nativeIdentity?.fileId ?? String(rootStats.ino),
      ...(nativeIdentity ? { nativeRootCanonicalPath: nativeIdentity.canonicalPath } : {}),
      approvedAt: this.now(),
      expiresAt: expiresAt.toISOString(),
    };
    await writeJsonAtomic(this.grantPath(grant.grantId), grant);
    return grant;
  }

  private async revokeProjectGrant(input: { projectId: string; grantId: string }): Promise<ProjectGrant> {
    const grant = await this.readRequired<ProjectGrant>(
      this.grantPath(input.grantId),
      "PROJECT_NOT_GRANTED",
      "Grant not found",
    );
    if (grant.projectId !== input.projectId) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Grant does not belong to the project", false);
    }
    const revoked = { ...grant, revokedAt: this.now() };
    await writeJsonAtomic(this.grantPath(grant.grantId), revoked);
    return revoked;
  }

  private async authorizeGrant(input: AuthorizeGrantInput): Promise<ProjectGrant> {
    const grant = await this.requireGrant(input.grantId, input.projectId);
    if (grant.grantId !== input.grantId || grant.principalId !== input.principalId) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Grant does not belong to this principal and project", false);
    }
    if (!grant.permissions.includes(input.permission)) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Grant lacks the requested permission", false, {
        permission: input.permission,
      });
    }
    return grant;
  }

  private async startTask(input: StartTaskInput): Promise<TaskRecord> {
    validateHashes(
      input.contractHash,
      input.policyHash,
      input.dependencyLockHash,
      input.fixturesHash,
      input.verificationProfileHash,
    );
    const grant = await this.authorizeGrant({ ...input, permission: "candidate-write" });
    if (!grant.executionProfileIds.includes(input.executionProfileId)) {
      throw new ChangeManagerError("EXECUTION_APPROVAL_REQUIRED", "Execution profile is not approved by this grant", true);
    }
    await this.revalidateRoot(grant);
    const repository = new GitRepository(grant.canonicalSourceRoot, this.gitBinary);
    const baseCommit = await repository.head();
    if (input.expectedBaseCommit !== undefined && input.expectedBaseCommit !== baseCommit) {
      throw new ChangeManagerError("DIRTY_BASELINE", "Project HEAD changed before task creation", true, {
        expected: input.expectedBaseCommit,
        actual: baseCommit,
      });
    }
    const taskId = this.idGenerator("task");
    const workspacePath = path.join(this.stateRoot, "worktrees", taskId);
    await repository.addWorktree(workspacePath, baseCommit);
    const sourceBranch = await repository.text(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const baseManifestHash = computeCandidateTreeHash(await this.hashWorkspace(grant.canonicalSourceRoot));
    const task: MutableTask = {
      taskId,
      projectId: input.projectId,
      ownerPrincipalId: input.principalId,
      grantId: input.grantId,
      screenId: input.screenId,
      baseContractRevision: input.expectedRevision,
      contractHash: input.contractHash,
      baseManifestHash,
      policyHash: input.policyHash,
      policyRevision: input.policyRevision,
      generatorVersion: input.generatorVersion,
      dependencyLockHash: input.dependencyLockHash,
      fixturesHash: input.fixturesHash,
      verificationProfileId: input.verificationProfileId,
      verificationProfileHash: input.verificationProfileHash,
      grantRevision: grant.grantRevision,
      scopeNodeIds: [...input.scopeNodeIds],
      executionProfileId: input.executionProfileId,
      objective: input.objective,
      baseCommit,
      sourceBranch,
      workspacePath,
      state: "READY",
      revision: 1,
      createdAt: this.now(),
    };
    await writeJsonAtomic(this.taskPath(taskId), task);
    return task;
  }

  private async proposePatch(input: ProposePatchInput): Promise<ProposePatchResult> {
    const task = await this.requireOwnedTask(input);
    this.assertTaskRevision(task, input.expectedRevision);
    const grant = await this.requireCurrentTaskGrant(task, input, "candidate-write");
    if (input.files.length === 0 || input.files.length > 1000) invalid("Patch file count is out of range");
    const seen = new Set<string>();
    for (const patch of input.files) {
      const relativePath = this.authorizeChangedPath(grant, patch.relativePath);
      const key = windowsCollisionKey(relativePath);
      if (seen.has(key)) invalid("Patch contains colliding paths");
      seen.add(key);
      const target = await resolveSafeProjectPath(task.workspacePath, relativePath);
      await assertWritableTarget(target);
      if (patch.operation === "delete") {
        if (patch.contentUtf8 !== undefined) invalid("Delete patch must not contain content");
        await rm(target, { force: true });
      } else {
        if (patch.contentUtf8 === undefined) invalid("Upsert patch requires contentUtf8");
        const bytes = Buffer.from(patch.contentUtf8, "utf8");
        if (bytes.byteLength > 2 * 1024 * 1024) invalid("Patch file exceeds the 2 MiB limit");
        await writeExclusiveReplacement(target, bytes, this.idGenerator("patch"));
      }
    }
    task.revision += 1;
    task.state = "IMPLEMENTING";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    const manifest = await this.hashWorkspace(task.workspacePath);
    return {
      taskId: task.taskId,
      taskRevision: task.revision,
      stagingManifestHash: computeCandidateTreeHash(manifest),
      changedPaths: (await new GitRepository(task.workspacePath, this.gitBinary).changedPaths(task.workspacePath, task.baseCommit)).map(
        normalizeRelativePath,
      ),
    };
  }

  private async freezeCandidate(input: FreezeCandidateInput): Promise<FrozenCandidateDescriptor> {
    validateHashes(
      input.contractHash,
      input.effectiveContractHash,
      input.layoutOverridesHash,
      input.policyHash,
    );
    const task = await this.requireOwnedTask(input);
    this.assertTaskRevision(task, input.expectedRevision);
    const grant = await this.requireCurrentTaskGrant(task, input, "candidate-write");
    if (
      input.contractHash !== task.contractHash ||
      input.policyHash !== task.policyHash ||
      input.policyRevision !== task.policyRevision
    ) {
      throw new ChangeManagerError("CANDIDATE_STALE", "Candidate contract, policy, or manifest binding is stale", true);
    }
    await this.revalidateRoot(grant);
    task.state = "SNAPSHOTTING";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    const repository = new GitRepository(task.workspacePath, this.gitBinary);
    const changedPaths = (await repository.changedPaths(task.workspacePath, task.baseCommit)).map(normalizeRelativePath);
    const collisionKeys = new Set<string>();
    for (const changedPath of changedPaths) {
      this.authorizeChangedPath(grant, changedPath);
      const key = windowsCollisionKey(changedPath);
      if (collisionKeys.has(key)) invalid("Candidate contains Windows-colliding changed paths");
      collisionKeys.add(key);
    }
    const candidateId = this.idGenerator("candidate");
    const snapshotRoot = path.join(this.stateRoot, "candidates", candidateId, "files");
    await ensureDirectory(snapshotRoot);
    const files: CandidateFile[] = [];
    let totalBytes = 0;
    const allKeys = new Set<string>();
    for (const rawPath of await repository.snapshotPaths(task.workspacePath)) {
      const relativePath = normalizeRelativePath(rawPath);
      const key = windowsCollisionKey(relativePath);
      if (allKeys.has(key)) invalid("Candidate contains Windows-colliding paths");
      allKeys.add(key);
      const source = await resolveSafeProjectPath(task.workspacePath, relativePath);
      let stats;
      try {
        stats = await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && changedPaths.includes(relativePath)) continue;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new ChangeManagerError("PROTECTED_PATH", "Candidate contains a link, hardlink, or special file", false, {
          relativePath,
        });
      }
      totalBytes += stats.size;
      if (totalBytes > this.maxSnapshotBytes) invalid("Candidate snapshot exceeds configured byte limit");
      const bytes = await readFile(source);
      const destination = await resolveSafeProjectPath(snapshotRoot, relativePath);
      await ensureDirectory(path.dirname(destination));
      await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
      const executable = (stats.mode & 0o111) !== 0;
      if (executable) await chmod(destination, 0o555);
      files.push({ relativePath, sha256: sha256(bytes), size: bytes.byteLength, executable });
    }
    files.sort((left, right) => compareOrdinal(left.relativePath, right.relativePath));
    const changes: CandidateChange[] = [];
    for (const relativePath of changedPaths) {
      const before = await repository.readCommittedFile(task.baseCommit, relativePath);
      const afterFile = files.find((file) => file.relativePath === relativePath);
      changes.push({
        relativePath,
        beforeSha256: before === null ? null : sha256(before),
        afterSha256: afterFile?.sha256 ?? null,
        beforeSize: before?.byteLength ?? null,
        afterSize: afterFile?.size ?? null,
      });
    }
    const treeHash = computeCandidateTreeHash(files);
    const candidate: StoredCandidate = {
      candidateId,
      taskId: task.taskId,
      projectId: task.projectId,
      grantId: task.grantId,
      grantRevision: task.grantRevision,
      ownerPrincipalId: task.ownerPrincipalId,
      snapshotRoot,
      treeHash,
      baseContractHash: input.contractHash,
      contractHash: input.contractHash,
      effectiveContractHash: input.effectiveContractHash,
      layoutOverridesHash: input.layoutOverridesHash,
      generatorVersion: task.generatorVersion,
      policyHash: input.policyHash,
      policyRevision: input.policyRevision,
      dependencyLockHash: task.dependencyLockHash,
      fixturesHash: task.fixturesHash,
      verificationProfileHash: task.verificationProfileHash,
      verificationProfileId: task.verificationProfileId,
      baseCommitHash: sha256(task.baseCommit),
      baseCommit: task.baseCommit,
      baseManifestHash: task.baseManifestHash,
      baseContractRevision: task.baseContractRevision,
      createdAt: this.now(),
      files,
      changes,
      changedPaths,
    };
    await writeJsonAtomic(this.candidatePath(candidateId), candidate);
    task.candidateId = candidateId;
    task.state = "VERIFYING";
    task.revision += 1;
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return candidate;
  }

  private async recordTrustedVerification(input: TrustedVerificationInput): Promise<VerificationRecord> {
    const candidate = await this.getVerifiedSnapshot(input.candidateId);
    const task = await this.requireTask(candidate.taskId);
    if (task.candidateId !== candidate.candidateId) stale("Candidate is no longer current for its task");
    if (!sameCandidateIdentity(candidate, input)) {
      throw new ChangeManagerError("CANDIDATE_STALE", "Verification identity does not match the frozen candidate", false);
    }
    validateHashes(input.evidenceDigest);
    const checkedAt = new Date(input.checkedAt);
    if (!Number.isFinite(checkedAt.getTime()) || checkedAt.getTime() > this.clock().getTime() + 60_000) {
      invalid("Invalid verification timestamp");
    }
    const record: VerificationRecord = {
      ...input,
      verificationId: this.idGenerator("verification"),
      recordedAt: this.now(),
    };
    await writeJsonAtomic(this.verificationPath(input.candidateId), record);
    task.state = input.status === "PASS" ? "VERIFYING" : "NEEDS_REPAIR";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return record;
  }

  private async requestReview(input: AgentAuthorization & { candidateId: string }): Promise<ReviewDetails> {
    const candidate = await this.requireOwnedCandidate(input);
    await this.requireCurrentCandidateGrant(candidate, input, "candidate-write");
    const details = await this.inspectReview(input.candidateId, false);
    if (!details.canApprove) {
      throw new ChangeManagerError("VERIFY_FAILED", "Candidate is not eligible for review", true, {
        reasons: [...details.blockReasons],
      });
    }
    const task = await this.requireTask(candidate.taskId);
    task.state = "PENDING_APPROVAL";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return { ...details, task };
  }

  private async inspectReview(candidateId: string, issueNonce: boolean): Promise<ReviewDetails> {
    const candidate = await this.getVerifiedSnapshot(candidateId);
    const task = await this.requireTask(candidate.taskId);
    const verification = await this.readRequired<VerificationRecord>(
      this.verificationPath(candidateId),
      "NOT_FOUND",
      "No trusted verification exists for this candidate",
    );
    const grant = await this.requireGrant(task.grantId, task.projectId);
    const sourceDriftPaths = await this.findSourceDrift(grant, candidate);
    const blockReasons: string[] = [];
    if (task.candidateId !== candidate.candidateId) blockReasons.push("candidate is no longer current");
    if (!candidateMatchesTask(candidate, task)) blockReasons.push("task policy or verification profile changed");
    if (!sameCandidateIdentity(candidate, verification)) blockReasons.push("verification identity mismatch");
    if (verification.status !== "PASS") blockReasons.push(`verification status is ${verification.status}`);
    if (this.clock().getTime() - new Date(verification.checkedAt).getTime() > this.verificationMaxAgeMs) {
      blockReasons.push("verification expired");
    }
    if (grant.grantId !== task.grantId || grant.grantRevision !== task.grantRevision) blockReasons.push("grant changed");
    if (!grant.executionProfileIds.includes(task.executionProfileId)) blockReasons.push("execution profile grant changed");
    if (sourceDriftPaths.length > 0) blockReasons.push("source drift detected");
    const binding: ReviewBinding = {
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
      reportId: verification.reportId,
      evidenceDigest: verification.evidenceDigest,
      verificationId: verification.verificationId,
    };
    const base = { task, candidate, verification, binding, sourceDriftPaths, canApprove: blockReasons.length === 0, blockReasons };
    if (!issueNonce || blockReasons.length > 0) return base;
    const reviewNonce = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const now = this.clock();
    const token: ReviewToken = {
      candidateId,
      reportId: verification.reportId,
      nonceHash: sha256(reviewNonce),
      bindingHash: canonicalHash(binding),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    };
    await writeJsonAtomic(this.reviewTokenPath(candidateId), token);
    return { ...base, reviewNonce };
  }

  private async createSubsetCandidate(input: CreateSubsetCandidateInput): Promise<FrozenCandidateDescriptor> {
    assertId(input.parentCandidateId, "parentCandidateId");
    assertId(input.parentReportId, "parentReportId");
    validateHashes(input.closureHash);
    const parent = await this.getVerifiedSnapshot(input.parentCandidateId);
    const task = await this.requireTask(parent.taskId);
    if (task.candidateId !== parent.candidateId) stale("Parent candidate is no longer current for its task");

    const selectedPaths = canonicalSelectedPaths(input.selectedPaths);
    if (selectedPaths.length === 0) invalid("Subset candidate must select at least one whole-file change");
    const parentPaths = new Map(parent.changedPaths.map((entry) => [windowsCollisionKey(entry), entry]));
    for (const selectedPath of selectedPaths) {
      if (parentPaths.get(windowsCollisionKey(selectedPath)) !== selectedPath) {
        invalid("Subset selection must contain only exact canonical parent changed paths");
      }
    }

    const token = await this.readRequired<ReviewToken>(
      this.reviewTokenPath(parent.candidateId),
      "EXECUTION_APPROVAL_REQUIRED",
      "Desktop review nonce is missing",
    );
    if (
      token.consumedAt !== undefined ||
      token.reportId !== input.parentReportId ||
      token.nonceHash !== sha256(input.reviewNonce) ||
      new Date(token.expiresAt).getTime() < this.clock().getTime()
    ) {
      throw new ChangeManagerError("EXECUTION_APPROVAL_REQUIRED", "Desktop review nonce is invalid, expired, or used", false);
    }
    const review = await this.inspectReview(parent.candidateId, false);
    if (!review.canApprove || review.verification.status !== "PASS") {
      throw new ChangeManagerError("VERIFY_FAILED", "Subset derivation requires a current passing parent review", true, {
        reasons: [...review.blockReasons],
      });
    }
    if (review.verification.reportId !== input.parentReportId || token.bindingHash !== canonicalHash(review.binding)) {
      stale("Parent report or review binding changed before subset derivation");
    }

    const grant = await this.requireGrant(task.grantId, task.projectId);
    if (
      parent.grantId !== grant.grantId ||
      parent.grantRevision !== grant.grantRevision ||
      !candidateMatchesTask(parent, task) ||
      !grant.executionProfileIds.includes(task.executionProfileId)
    ) {
      stale("Parent grant, policy, or verification profile binding is stale");
    }
    await this.revalidateRoot(grant);

    const candidateId = this.idGenerator("candidate");
    const snapshotRoot = path.join(this.stateRoot, "candidates", candidateId, "files");
    await ensureDirectory(snapshotRoot);
    const selected = new Set(selectedPaths.map(windowsCollisionKey));
    const changed = new Set(parent.changedPaths.map(windowsCollisionKey));
    const childFiles = new Map<string, CandidateFile>();
    let totalBytes = 0;
    const writeSnapshotEntry = async (relativePath: string, bytes: Buffer, executable: boolean): Promise<void> => {
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxSnapshotBytes) invalid("Candidate snapshot exceeds configured byte limit");
      const destination = await resolveSafeProjectPath(snapshotRoot, relativePath);
      await ensureDirectory(path.dirname(destination));
      await writeFile(destination, bytes, { flag: "wx", mode: executable ? 0o555 : 0o444 });
      if (executable) await chmod(destination, 0o555);
      childFiles.set(relativePath, {
        relativePath,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        executable,
      });
    };

    try {
      for (const file of parent.files) {
        const key = windowsCollisionKey(file.relativePath);
        if (changed.has(key) && !selected.has(key)) continue;
        const source = await resolveSafeProjectPath(parent.snapshotRoot, file.relativePath);
        const bytes = await readFile(source);
        if (sha256(bytes) !== file.sha256) stale("Parent snapshot changed during subset derivation");
        await writeSnapshotEntry(file.relativePath, bytes, file.executable);
      }
      const repository = new GitRepository(grant.canonicalSourceRoot, this.gitBinary);
      for (const change of parent.changes) {
        if (selected.has(windowsCollisionKey(change.relativePath)) || change.beforeSha256 === null) continue;
        const [bytes, executable] = await Promise.all([
          repository.readCommittedFile(parent.baseCommit, change.relativePath),
          repository.committedFileExecutable(parent.baseCommit, change.relativePath),
        ]);
        if (bytes === null || executable === null || sha256(bytes) !== change.beforeSha256) {
          stale("Parent base file changed or cannot be reconstructed");
        }
        await writeSnapshotEntry(change.relativePath, bytes, executable);
      }
    } catch (error) {
      await rm(path.dirname(snapshotRoot), { recursive: true, force: true });
      throw error;
    }

    const files = [...childFiles.values()].sort((left, right) => compareOrdinal(left.relativePath, right.relativePath));
    const changes = selectedPaths.map((relativePath) => {
      const change = parent.changes.find((entry) => entry.relativePath === relativePath);
      if (change === undefined) invalid("Subset selection does not identify a parent change");
      return change;
    });
    const candidate: StoredCandidate = {
      ...parent,
      candidateId,
      snapshotRoot,
      treeHash: computeCandidateTreeHash(files),
      createdAt: this.now(),
      files,
      changes,
      changedPaths: selectedPaths,
      subsetOrigin: {
        parentCandidateId: parent.candidateId,
        parentReportId: input.parentReportId,
        closureHash: input.closureHash,
        selectedPaths,
      },
    };

    await writeJsonAtomic(this.reviewTokenPath(parent.candidateId), { ...token, consumedAt: this.now() });
    for (const approval of (await this.readAll<ApprovalRecord>("approvals")).filter(
      (entry) => entry.candidateId === parent.candidateId && entry.consumedAt === undefined,
    )) {
      await writeJsonAtomic(this.approvalPath(approval.approvalId), { ...approval, consumedAt: this.now() });
    }
    await writeJsonAtomic(this.candidatePath(candidateId), candidate);
    task.candidateId = candidateId;
    task.state = "VERIFYING";
    task.revision += 1;
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return candidate;
  }

  private async approveCandidate(input: ApproveCandidateInput): Promise<ApprovalReceipt> {
    const token = await this.readRequired<ReviewToken>(
      this.reviewTokenPath(input.candidateId),
      "EXECUTION_APPROVAL_REQUIRED",
      "Desktop review nonce is missing",
    );
    if (
      token.consumedAt !== undefined ||
      token.reportId !== input.reportId ||
      token.nonceHash !== sha256(input.reviewNonce) ||
      new Date(token.expiresAt).getTime() < this.clock().getTime()
    ) {
      throw new ChangeManagerError("EXECUTION_APPROVAL_REQUIRED", "Desktop review nonce is invalid, expired, or used", false);
    }
    const review = await this.inspectReview(input.candidateId, false);
    if (!review.canApprove) {
      throw new ChangeManagerError("VERIFY_FAILED", "Approval blocked by stale or failing evidence", true, {
        reasons: [...review.blockReasons],
      });
    }
    if (token.bindingHash !== canonicalHash(review.binding)) stale("Review binding changed after nonce issuance");
    const approvedAt = new Date(input.approvedAt);
    if (!Number.isFinite(approvedAt.getTime()) || Math.abs(approvedAt.getTime() - this.clock().getTime()) > 60_000) {
      invalid("Approval timestamp is invalid or stale");
    }
    const grant = await this.requireGrant(review.task.grantId, review.task.projectId);
    const applyConfirmationToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const approval: ApprovalRecord = {
      ...review.binding,
      approvalId: this.idGenerator("approval"),
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(approvedAt.getTime() + this.approvalMaxAgeMs).toISOString(),
      approvedPrincipalId: grant.approvedByPrincipalId,
      grantId: grant.grantId,
      grantRevision: grant.grantRevision,
      confirmationTokenHash: sha256(applyConfirmationToken),
    };
    await writeJsonAtomic(this.approvalPath(approval.approvalId), approval);
    await writeJsonAtomic(this.reviewTokenPath(input.candidateId), { ...token, consumedAt: this.now() });
    return { ...approval, applyConfirmationToken };
  }

  private async applyApprovedCandidate(input: ApplyApprovedCandidateInput): Promise<ApplyResult> {
    if (
      process.platform === "win32" &&
      this.nativeSafeFs === null &&
      this.options.portableApplyTestCapability !== PORTABLE_APPLY_TEST_CAPABILITY
    ) {
      throw new ChangeManagerError(
        "UNSUPPORTED_CAPABILITY",
        "Handle-relative Windows safe filesystem helper is required for source apply",
        false,
      );
    }
    const approval = await this.readRequired<ApprovalRecord>(
      this.approvalPath(input.approvalId),
      "NOT_FOUND",
      "Approval not found",
    );
    if (approval.candidateId !== input.candidateId) invalid("Approval does not identify this candidate");
    if (approval.confirmationTokenHash !== sha256(input.applyConfirmationToken)) {
      throw new ChangeManagerError("EXECUTION_APPROVAL_REQUIRED", "Apply confirmation token is invalid", false);
    }
    if (approval.consumedAt !== undefined) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Approval has already been consumed", false);
    }
    if (new Date(approval.expiresAt).getTime() < this.clock().getTime()) {
      throw new ChangeManagerError("CANDIDATE_STALE", "Approval expired before apply", true);
    }
    const review = await this.inspectReview(input.candidateId, false);
    if (!review.canApprove || !sameReviewBinding(review.binding, approval)) {
      throw new ChangeManagerError("CANDIDATE_STALE", "Candidate, evidence, policy, or source changed after approval", true);
    }
    const candidate = review.candidate as StoredCandidate;
    const grant = await this.requireGrant(review.task.grantId, review.task.projectId);
    await this.revalidateRoot(grant);
    if (
      grant.grantId !== approval.grantId ||
      grant.grantRevision !== approval.grantRevision ||
      grant.approvedByPrincipalId !== approval.approvedPrincipalId
    ) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Approval grant was revoked or replaced", false);
    }
    const applyingTask = await this.requireTask(candidate.taskId);
    applyingTask.state = "APPLYING";
    await writeJsonAtomic(this.taskPath(applyingTask.taskId), applyingTask);
    const transactionId = this.idGenerator("transaction");
    const journalDirectory = path.join(this.stateRoot, "journals", transactionId);
    const files: MutableJournal["files"] = [];
    for (const change of candidate.changes) {
      const relativePath = this.authorizeChangedPath(grant, change.relativePath);
      const targetPath = await resolveSafeProjectPath(grant.canonicalSourceRoot, relativePath);
      const snapshotPath = change.afterSha256 === null ? null : await resolveSafeProjectPath(candidate.snapshotRoot, relativePath);
      const backupPath = change.beforeSha256 === null ? null : path.join(journalDirectory, "backups", relativePath);
      files.push({
        ...change,
        targetPath,
        snapshotPath,
        backupPath,
        displacedPath: `${targetPath}.boxspec-${transactionId}.before`,
        tempPath: `${targetPath}.boxspec-${transactionId}.tmp`,
        stage: "PENDING",
      });
    }
    const journal: MutableJournal = {
      journalVersion: 1,
      transactionId,
      candidateId: candidate.candidateId,
      approvalId: approval.approvalId,
      projectId: candidate.projectId,
      sourceRoot: grant.canonicalSourceRoot,
      rootDeviceId: grant.rootDeviceId,
      rootFileId: grant.rootFileId,
      ...(grant.nativeRootCanonicalPath ? { nativeRootCanonicalPath: grant.nativeRootCanonicalPath } : {}),
      sealedApprovalHash: approvalSealHash(approval),
      integrityHash: "",
      phase: "PREPARED",
      createdAt: this.now(),
      updatedAt: this.now(),
      directoryIntents: [...new Set(
        files
          .filter((file) => file.afterSha256 !== null)
          .map((file) => path.posix.dirname(file.relativePath))
          .filter((directory) => directory !== "."),
      )].sort(compareOrdinal),
      files,
    };
    await ensureDirectory(journalDirectory);
    await this.writeJournal(journal);
    await this.fault("after-journal-prepared", { transactionId });
    if (process.platform === "win32" && this.nativeSafeFs !== null) {
      return this.applyWithNativeSafeFs(journal, approval, candidate, grant);
    }
    for (const file of files) {
      await this.assertCurrentHash(file.targetPath, file.beforeSha256, file.relativePath);
      if (file.backupPath !== null) {
        await ensureDirectory(path.dirname(file.backupPath));
        await copyFile(file.targetPath, file.backupPath);
        await syncFile(file.backupPath);
        await this.assertCurrentHash(file.backupPath, file.beforeSha256, file.relativePath);
      }
      file.stage = "BACKED_UP";
    }
    journal.phase = "BACKED_UP";
    await this.writeJournal(journal);
    await this.fault("after-backups-written", { transactionId });
    for (const file of files) {
      if (file.snapshotPath !== null) {
        const bytes = await readFile(file.snapshotPath);
        if (sha256(bytes) !== file.afterSha256) stale("Frozen candidate bytes changed before apply");
        await ensureDirectory(path.dirname(file.targetPath));
        await writeExclusiveFile(file.tempPath, bytes);
      }
    }
    await this.fault("after-temp-files-written", { transactionId });
    journal.phase = "REPLACING";
    await this.writeJournal(journal);
    for (const file of files) {
      await this.revalidateRoot(grant);
      await resolveSafeProjectPath(grant.canonicalSourceRoot, file.relativePath);
      await this.assertCurrentHash(file.targetPath, file.beforeSha256, file.relativePath);
      if (file.beforeSha256 !== null) {
        await rename(file.targetPath, file.displacedPath);
      }
      file.stage = "TARGET_MOVED";
      await this.writeJournal(journal);
      await this.fault("after-target-moved", { transactionId, relativePath: file.relativePath });
      if (file.afterSha256 !== null) await rename(file.tempPath, file.targetPath);
      file.stage = "REPLACED";
      await this.writeJournal(journal);
      await this.fault("after-file-replaced", { transactionId, relativePath: file.relativePath });
    }
    journal.phase = "VERIFYING";
    await this.writeJournal(journal);
    await this.fault("before-final-verification", { transactionId });
    for (const file of files) {
      await this.assertCurrentHash(file.targetPath, file.afterSha256, file.relativePath);
      file.stage = "VERIFIED";
    }
    await this.fault("after-final-verification", { transactionId });
    journal.phase = "APPLIED";
    await this.writeJournal(journal);
    await this.fault("after-journal-applied", { transactionId });
    for (const file of files) await rm(file.displacedPath, { force: true });
    const consumed: ApprovalRecord = { ...approval, consumedAt: this.now() };
    await writeJsonAtomic(this.approvalPath(approval.approvalId), consumed);
    const task = await this.requireTask(candidate.taskId);
    task.state = "APPLIED";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return { transactionId, candidateId: candidate.candidateId, phase: "APPLIED", appliedPaths: candidate.changedPaths };
  }

  private async applyWithNativeSafeFs(
    journal: MutableJournal,
    approval: ApprovalRecord,
    candidate: StoredCandidate,
    grant: ProjectGrant,
  ): Promise<ApplyResult> {
    const client = this.nativeSafeFs;
    if (client === null) throw new ChangeManagerError("UNSUPPORTED_CAPABILITY", "Native filesystem helper unavailable", false);
    const rootIdentity = nativeRootIdentity(grant);
    for (const relativePath of journal.directoryIntents) {
      await client.ensureDirectory({
        root: grant.canonicalSourceRoot,
        rootIdentity,
        relativePath,
      });
    }
    for (const file of journal.files) {
      const afterBytes = file.snapshotPath === null ? null : await readFile(file.snapshotPath);
      if (afterBytes !== null && sha256(afterBytes) !== file.afterSha256) stale("Frozen candidate bytes changed before native prepare");
      const prepared = await client.prepareReplace({
        transactionId: journal.transactionId,
        root: grant.canonicalSourceRoot,
        rootIdentity,
        relativePath: file.relativePath,
        expectedBeforeHash: file.beforeSha256,
        afterBytes,
      });
      if (prepared.beforeHash !== file.beforeSha256 || prepared.afterHash !== file.afterSha256) {
        throw new ChangeManagerError("APPLY_CONFLICT", "Native prepared hashes differ from journal intent", false, {
          relativePath: file.relativePath,
        });
      }
      file.nativePreparedId = prepared.preparedId;
      file.stage = "BACKED_UP";
      await this.writeJournal(journal);
    }
    journal.phase = "BACKED_UP";
    await this.writeJournal(journal);
    await this.fault("after-backups-written", { transactionId: journal.transactionId });
    await this.fault("after-temp-files-written", { transactionId: journal.transactionId });
    journal.phase = "REPLACING";
    await this.writeJournal(journal);
    for (const file of journal.files) {
      if (file.nativePreparedId === undefined) {
        throw new ChangeManagerError("APPLY_CONFLICT", "Native prepared binding missing", false);
      }
      const committed = await client.commitReplace({
        transactionId: journal.transactionId,
        root: grant.canonicalSourceRoot,
        rootIdentity,
        relativePath: file.relativePath,
        preparedId: file.nativePreparedId,
      });
      if (committed.afterHash !== file.afterSha256) {
        throw new ChangeManagerError("APPLY_CONFLICT", "Native commit did not produce the journaled after hash", false, {
          relativePath: file.relativePath,
        });
      }
      file.stage = "REPLACED";
      await this.writeJournal(journal);
      await this.fault("after-file-replaced", { transactionId: journal.transactionId, relativePath: file.relativePath });
    }
    journal.phase = "VERIFYING";
    await this.writeJournal(journal);
    await this.fault("before-final-verification", { transactionId: journal.transactionId });
    for (const file of journal.files) {
      const classification = await this.classifyNativeFile(journal, file);
      if (classification !== "AFTER") {
        throw new ChangeManagerError("APPLY_CONFLICT", "Native final verification did not observe exact after bytes", false, {
          relativePath: file.relativePath,
          classification,
        });
      }
      file.stage = "VERIFIED";
    }
    await this.fault("after-final-verification", { transactionId: journal.transactionId });
    journal.phase = "APPLIED";
    await this.writeJournal(journal);
    await this.fault("after-journal-applied", { transactionId: journal.transactionId });
    await this.finalizeNativeArtifacts(journal);
    await writeJsonAtomic(this.approvalPath(approval.approvalId), { ...approval, consumedAt: this.now() });
    const task = await this.requireTask(candidate.taskId);
    task.state = "APPLIED";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return {
      transactionId: journal.transactionId,
      candidateId: candidate.candidateId,
      phase: "APPLIED",
      appliedPaths: candidate.changedPaths,
    };
  }

  private async classifyNativeFile(journal: ApplyJournal, file: ApplyJournalFile): Promise<RecoveryFileState> {
    if (this.nativeSafeFs === null || file.nativePreparedId === undefined) return "UNKNOWN";
    try {
      return (
        await this.nativeSafeFs.classifyRecovery({
          transactionId: journal.transactionId,
          root: journal.sourceRoot,
          rootIdentity: nativeRootIdentity(journal),
          relativePath: file.relativePath,
          preparedId: file.nativePreparedId,
          beforeHash: file.beforeSha256,
          afterHash: file.afterSha256,
        })
      ).state;
    } catch {
      return "UNKNOWN";
    }
  }

  private async finalizeNativeArtifacts(journal: ApplyJournal): Promise<void> {
    if (this.nativeSafeFs === null) return;
    for (const file of journal.files) {
      if (file.nativePreparedId === undefined) continue;
      await this.nativeSafeFs.finalizeReplace({
        transactionId: journal.transactionId,
        root: journal.sourceRoot,
        rootIdentity: nativeRootIdentity(journal),
        relativePath: file.relativePath,
        preparedId: file.nativePreparedId,
      });
    }
  }

  private async inspectRecoveries(): Promise<readonly RecoveryInspection[]> {
    const rawJournals = await this.readAll<MutableJournal>("journals", 2);
    const inspections: RecoveryInspection[] = [];
    for (const rawJournal of rawJournals) {
      let journal: MutableJournal;
      try {
        journal = await this.readJournal(rawJournal.transactionId);
      } catch {
        inspections.push({
          transactionId: rawJournal.transactionId,
          projectId: rawJournal.projectId,
          phase: "SOURCE_DRIFT",
          fileStates: [],
          needsUserDecision: true,
          sourceDriftPaths: ["<invalid-journal>"],
        });
        continue;
      }
      if (journal.phase === "APPLIED" || journal.phase === "ROLLED_BACK") continue;
      const fileStates = await Promise.all(
        journal.files.map(async (file) => ({ relativePath: file.relativePath, state: await this.classifyJournalFile(journal, file) })),
      );
      const sourceDriftPaths = fileStates.filter((entry) => entry.state === "UNKNOWN").map((entry) => entry.relativePath);
      inspections.push({
        transactionId: journal.transactionId,
        projectId: journal.projectId,
        phase: sourceDriftPaths.length > 0 ? "SOURCE_DRIFT" : "RECOVERY_REQUIRED",
        fileStates,
        needsUserDecision: true,
        sourceDriftPaths,
      });
    }
    return inspections;
  }

  private async recoverInterruptedApply(transactionId: string, decision: RecoveryDecision): Promise<RecoveryResult> {
    if (decision !== "restore-before" && decision !== "finish-after") {
      throw new ChangeManagerError("INVALID_REQUEST", "Unknown recovery decision", false);
    }
    const journal = await this.readJournal(transactionId);
    if (journal.phase === "APPLIED" || journal.phase === "ROLLED_BACK") {
      return {
        transactionId,
        phase: journal.phase,
        affectedPaths: journal.files.map((file) => file.relativePath),
      };
    }
    const approvalForRoot = await this.readRequired<ApprovalRecord>(
      this.approvalPath(journal.approvalId),
      "NOT_FOUND",
      "Approval missing during recovery",
    );
    if (approvalSealHash(approvalForRoot) !== journal.sealedApprovalHash) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Sealed approval record changed", false);
    }
    const grant = await this.requireGrant(approvalForRoot.grantId, journal.projectId, true);
    if (grant.rootDeviceId !== journal.rootDeviceId || grant.rootFileId !== journal.rootFileId) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Journal root identity no longer matches", false);
    }
    await this.revalidateRoot(grant);
    const states = await Promise.all(journal.files.map((file) => this.classifyJournalFile(journal, file)));
    const unknown = journal.files.filter((_file, index) => states[index] === "UNKNOWN").map((file) => file.relativePath);
    if (unknown.length > 0) {
      journal.phase = "SOURCE_DRIFT";
      await this.writeJournal(journal);
      throw new ChangeManagerError("APPLY_CONFLICT", "Recovery blocked by source drift", true, { unknownPaths: unknown });
    }
    if (decision === "restore-before") {
      for (const [index, file] of journal.files.entries()) {
        if (
          states[index] === "BEFORE" &&
          (file.nativePreparedId !== undefined || (await hashFileOrNull(file.targetPath)) === file.beforeSha256)
        ) continue;
        if (file.nativePreparedId !== undefined && this.nativeSafeFs !== null) {
          await this.nativeSafeFs.recoverReplace({
            transactionId: journal.transactionId,
            root: journal.sourceRoot,
            rootIdentity: nativeRootIdentity(journal),
            relativePath: file.relativePath,
            preparedId: file.nativePreparedId,
            decision: "restore_before",
          });
        } else await this.restoreBefore(file);
      }
      journal.phase = "ROLLED_BACK";
    } else {
      const approval = await this.readRequired<ApprovalRecord>(
        this.approvalPath(journal.approvalId),
        "NOT_FOUND",
        "Approval missing during recovery",
      );
      const candidate = await this.getVerifiedSnapshot(journal.candidateId);
      if (!sameReviewBinding(await this.bindingFor(candidate), approval)) stale("Recovery approval binding is stale");
      for (const [index, file] of journal.files.entries()) {
        if (
          states[index] === "AFTER" &&
          (file.nativePreparedId !== undefined || (await hashFileOrNull(file.targetPath)) === file.afterSha256)
        ) continue;
        if (file.nativePreparedId !== undefined && this.nativeSafeFs !== null) {
          await this.nativeSafeFs.recoverReplace({
            transactionId: journal.transactionId,
            root: journal.sourceRoot,
            rootIdentity: nativeRootIdentity(journal),
            relativePath: file.relativePath,
            preparedId: file.nativePreparedId,
            decision: "finish_after",
          });
        } else await this.finishAfter(file);
      }
      journal.phase = "APPLIED";
      await writeJsonAtomic(this.approvalPath(approval.approvalId), { ...approval, consumedAt: this.now() });
    }
    await this.writeJournal(journal);
    if (journal.files.some((file) => file.nativePreparedId !== undefined)) {
      if (journal.phase === "APPLIED") await this.finalizeNativeArtifacts(journal);
    } else {
      for (const file of journal.files) {
        await rm(file.tempPath, { force: true });
        await rm(file.displacedPath, { force: true });
      }
    }
    const task = await this.requireTask((await this.requireCandidate(journal.candidateId)).taskId);
    task.state = journal.phase === "APPLIED" ? "APPLIED" : "PENDING_APPROVAL";
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return { transactionId, phase: journal.phase, affectedPaths: journal.files.map((file) => file.relativePath) } as RecoveryResult;
  }

  private async cancelTask(input: AgentAuthorization & { taskId: string }): Promise<TaskRecord> {
    const task = await this.requireOwnedTask(input);
    await this.requireCurrentTaskGrant(task, input, "candidate-write");
    if (task.state === "APPLYING" || task.state === "APPLIED") {
      throw new ChangeManagerError("APPLY_CONFLICT", "An applying or applied task cannot be cancelled", false);
    }
    await new GitRepository(task.workspacePath, this.gitBinary).removeWorktree(task.workspacePath);
    task.state = "CANCELLED";
    task.revision += 1;
    await writeJsonAtomic(this.taskPath(task.taskId), task);
    return task;
  }

  private async listOwnedTasks(input: AgentAuthorization & { projectId: string }): Promise<readonly TaskRecord[]> {
    await this.authorizeGrant({ ...input, permission: "read" });
    return (await this.readAll<TaskRecord>("tasks")).filter(
      (task) => task.projectId === input.projectId && task.ownerPrincipalId === input.principalId && task.grantId === input.grantId,
    );
  }

  private async getOwnedTask(input: AgentAuthorization & { taskId: string }): Promise<TaskRecord> {
    return this.requireOwnedTask(input);
  }

  private async getOwnedCandidate(input: AgentAuthorization & { candidateId: string }): Promise<FrozenCandidateDescriptor> {
    return this.requireOwnedCandidate(input);
  }

  private async listReviews(projectId: string): Promise<readonly ReviewDetails[]> {
    const candidates = (await this.readAll<StoredCandidate>("candidates", 2)).filter((entry) => entry.projectId === projectId);
    const reviews: ReviewDetails[] = [];
    for (const candidate of candidates) {
      const verification = await this.readOptional<VerificationRecord>(this.verificationPath(candidate.candidateId));
      if (verification !== null) reviews.push(await this.inspectReview(candidate.candidateId, false));
    }
    return reviews;
  }

  private async getVerifiedSnapshot(candidateId: string): Promise<StoredCandidate> {
    const candidate = await this.requireCandidate(candidateId);
    const actualFiles = await this.hashSnapshot(candidate.snapshotRoot);
    if (actualFiles.length !== candidate.files.length || computeCandidateTreeHash(actualFiles) !== candidate.treeHash) {
      throw new ChangeManagerError("CANDIDATE_STALE", "Frozen candidate snapshot was modified", false);
    }
    return candidate;
  }

  private async hashSnapshot(snapshotRoot: string): Promise<CandidateFile[]> {
    const files: CandidateFile[] = [];
    await walkRegularFiles(snapshotRoot, async (absolutePath, relativePath, stats) => {
      if (stats.nlink !== 1) throw new ChangeManagerError("PROTECTED_PATH", "Hardlinked snapshot file rejected", false);
      const bytes = await readFile(absolutePath);
      files.push({ relativePath, sha256: sha256(bytes), size: bytes.byteLength, executable: (Number(stats.mode) & 0o111) !== 0 });
    });
    files.sort((left, right) => compareOrdinal(left.relativePath, right.relativePath));
    const keys = files.map((file) => windowsCollisionKey(file.relativePath));
    if (new Set(keys).size !== keys.length) invalid("Snapshot contains Windows-colliding paths");
    return files;
  }

  private async hashWorkspace(workspacePath: string): Promise<CandidateFile[]> {
    const repository = new GitRepository(workspacePath, this.gitBinary);
    const files: CandidateFile[] = [];
    for (const rawPath of await repository.snapshotPaths(workspacePath)) {
      const relativePath = normalizeRelativePath(rawPath);
      const absolutePath = await resolveSafeProjectPath(workspacePath, relativePath);
      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) protectedPath(relativePath);
      const bytes = await readFile(absolutePath);
      files.push({ relativePath, sha256: sha256(bytes), size: bytes.byteLength, executable: (stats.mode & 0o111) !== 0 });
    }
    return files;
  }

  private async findSourceDrift(grant: ProjectGrant, candidate: FrozenCandidateDescriptor): Promise<string[]> {
    try {
      await this.revalidateRoot(grant);
    } catch {
      return [...candidate.changedPaths];
    }
    const drift: string[] = [];
    const task = await this.requireTask(candidate.taskId);
    const repository = new GitRepository(grant.canonicalSourceRoot, this.gitBinary);
    try {
      const [head, branch, manifest] = await Promise.all([
        repository.head(),
        repository.text(["symbolic-ref", "--quiet", "--short", "HEAD"]),
        this.hashWorkspace(grant.canonicalSourceRoot),
      ]);
      if (head !== task.baseCommit) drift.push("<source-head>");
      if (branch !== task.sourceBranch) drift.push("<source-branch>");
      if (computeCandidateTreeHash(manifest) !== task.baseManifestHash) drift.push("<source-manifest>");
    } catch {
      drift.push("<source-identity>");
    }
    for (const change of candidate.changes) {
      try {
        const target = await resolveSafeProjectPath(grant.canonicalSourceRoot, change.relativePath);
        const actual = await hashFileOrNull(target);
        if (actual !== change.beforeSha256) drift.push(change.relativePath);
      } catch {
        drift.push(change.relativePath);
      }
    }
    return drift;
  }

  private async revalidateRoot(grant: ProjectGrant): Promise<void> {
    const canonical = await canonicalizeGrantedRoot(grant.sourceRoot);
    if (this.nativeSafeFs !== null) {
      if (grant.nativeRootCanonicalPath === undefined) {
        throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Grant lacks a native root identity", false);
      }
      const native = await this.nativeSafeFs.inspectRoot(canonical);
      if (
        native.canonicalPath !== grant.nativeRootCanonicalPath ||
        native.volumeId !== grant.rootDeviceId ||
        native.fileId !== grant.rootFileId
      ) {
        throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Granted project native root identity changed", false);
      }
      return;
    }
    const stats = await stat(canonical, { bigint: true });
    if (
      !samePath(canonical, grant.canonicalSourceRoot) ||
      String(stats.dev) !== grant.rootDeviceId ||
      String(stats.ino) !== grant.rootFileId
    ) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Granted project root identity changed", false);
    }
  }

  private authorizeChangedPath(grant: ProjectGrant, input: string): string {
    const relativePath = normalizeRelativePath(input);
    if (pathMatchesScope(relativePath, grant.protectedPaths)) protectedPath(relativePath);
    if (!pathMatchesScope(relativePath, grant.allowedWritePaths)) {
      throw new ChangeManagerError("OUT_OF_SCOPE", "Changed path is outside the approved UI scope", false, { relativePath });
    }
    return relativePath;
  }

  private async requireCurrentTaskGrant(
    task: MutableTask,
    authorization: AgentAuthorization,
    permission: "read" | "candidate-write" | "verify",
  ): Promise<ProjectGrant> {
    const grant = await this.authorizeGrant({ ...authorization, projectId: task.projectId, permission });
    if (task.grantId !== grant.grantId || task.grantRevision !== grant.grantRevision) stale("Task grant is stale");
    return grant;
  }

  private async requireCurrentCandidateGrant(
    candidate: StoredCandidate,
    authorization: AgentAuthorization,
    permission: "read" | "candidate-write" | "verify",
  ): Promise<ProjectGrant> {
    const grant = await this.authorizeGrant({ ...authorization, projectId: candidate.projectId, permission });
    if (candidate.grantId !== grant.grantId || candidate.grantRevision !== grant.grantRevision) stale("Candidate grant is stale");
    return grant;
  }

  private async requireGrant(grantId: string, projectId?: string, allowRevokedForRecovery = false): Promise<ProjectGrant> {
    const grant = await this.readRequired<ProjectGrant>(this.grantPath(grantId), "PROJECT_NOT_GRANTED", "Project is not granted");
    if (projectId !== undefined && grant.projectId !== projectId) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Grant does not belong to this project", false);
    }
    if (!allowRevokedForRecovery && (grant.revokedAt !== undefined || new Date(grant.expiresAt).getTime() <= this.clock().getTime())) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Project grant expired", true);
    }
    return grant;
  }

  private async requireTask(taskId: string): Promise<MutableTask> {
    return this.readRequired(this.taskPath(taskId), "NOT_FOUND", "Task not found");
  }

  private async requireOwnedTask(input: AgentAuthorization & { taskId: string }): Promise<MutableTask> {
    const task = await this.requireTask(input.taskId);
    if (task.ownerPrincipalId !== input.principalId || task.grantId !== input.grantId) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Task is owned by another principal or grant", false);
    }
    return task;
  }

  private async requireCandidate(candidateId: string): Promise<StoredCandidate> {
    return this.readRequired(this.candidatePath(candidateId), "NOT_FOUND", "Candidate not found");
  }

  private async requireOwnedCandidate(input: AgentAuthorization & { candidateId: string }): Promise<StoredCandidate> {
    const candidate = await this.requireCandidate(input.candidateId);
    if (candidate.ownerPrincipalId !== input.principalId || candidate.grantId !== input.grantId) {
      throw new ChangeManagerError("PROJECT_NOT_GRANTED", "Candidate is owned by another principal or grant", false);
    }
    return candidate;
  }

  private assertTaskRevision(task: MutableTask, expectedRevision: number): void {
    if (task.revision !== expectedRevision) {
      throw new ChangeManagerError("REVISION_CONFLICT", "Task revision changed", true, {
        expectedRevision,
        actualRevision: task.revision,
      });
    }
  }

  private async bindingFor(candidate: FrozenCandidateDescriptor): Promise<ReviewBinding> {
    const verification = await this.readRequired<VerificationRecord>(
      this.verificationPath(candidate.candidateId),
      "NOT_FOUND",
      "Verification missing",
    );
    return {
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      candidateId: candidate.candidateId,
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
      reportId: verification.reportId,
      evidenceDigest: verification.evidenceDigest,
      verificationId: verification.verificationId,
    };
  }

  private async classifyJournalFile(journal: ApplyJournal, file: ApplyJournalFile): Promise<RecoveryFileState> {
    if (file.nativePreparedId !== undefined) return this.classifyNativeFile(journal, file);
    try {
      const targetHash = await hashFileOrNull(file.targetPath);
      if (targetHash === file.afterSha256) return "AFTER";
      if (targetHash === file.beforeSha256) return "BEFORE";
      if (targetHash === null && file.beforeSha256 !== null) {
        const displacedHash = await hashFileOrNull(file.displacedPath);
        if (displacedHash === file.beforeSha256) return "BEFORE";
      }
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }

  private async restoreBefore(file: ApplyJournalFile): Promise<void> {
    const actual = await hashFileOrNull(file.targetPath);
    const displaced = await hashFileOrNull(file.displacedPath);
    if (actual !== file.afterSha256 && !(actual === null && displaced === file.beforeSha256)) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Recovery source no longer matches before/after state", false, {
        relativePath: file.relativePath,
      });
    }
    if (file.beforeSha256 === null) {
      await rm(file.targetPath, { force: true });
      return;
    }
    if (file.backupPath === null || (await hashFileOrNull(file.backupPath)) !== file.beforeSha256) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Recovery backup is missing or corrupt", false, {
        relativePath: file.relativePath,
      });
    }
    await writeExclusiveReplacement(file.targetPath, await readFile(file.backupPath), randomUUID());
  }

  private async finishAfter(file: ApplyJournalFile): Promise<void> {
    const actual = await hashFileOrNull(file.targetPath);
    const displaced = await hashFileOrNull(file.displacedPath);
    if (actual !== file.beforeSha256 && !(actual === null && displaced === file.beforeSha256)) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Recovery source no longer matches before/after state", false, {
        relativePath: file.relativePath,
      });
    }
    if (file.afterSha256 === null) {
      await rm(file.targetPath, { force: true });
      return;
    }
    if (file.snapshotPath === null || (await hashFileOrNull(file.snapshotPath)) !== file.afterSha256) stale("Snapshot missing during recovery");
    await writeExclusiveReplacement(file.targetPath, await readFile(file.snapshotPath), randomUUID());
  }

  private async assertCurrentHash(targetPath: string, expected: string | null, relativePath: string): Promise<void> {
    const actual = await hashFileOrNull(targetPath);
    if (actual !== expected) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Source changed since the candidate baseline", true, {
        relativePath,
        expected,
        actual,
      });
    }
  }

  private async writeJournal(journal: MutableJournal): Promise<void> {
    journal.updatedAt = this.now();
    journal.integrityHash = "";
    journal.integrityHash = canonicalHash(journal);
    await writeJsonAtomic(this.journalPath(journal.transactionId), journal);
  }

  private async finalizeCommittedJournals(): Promise<void> {
    for (const raw of await this.readAll<MutableJournal>("journals", 2)) {
      if (raw.phase !== "APPLIED") continue;
      let journal: MutableJournal;
      try {
        journal = await this.readJournal(raw.transactionId);
      } catch {
        continue;
      }
      const states = await Promise.all(journal.files.map((file) => this.classifyJournalFile(journal, file)));
      if (states.some((state) => state !== "AFTER")) continue;
      if (journal.files.some((file) => file.nativePreparedId !== undefined)) await this.finalizeNativeArtifacts(journal);
      else {
        for (const file of journal.files) {
          await rm(file.tempPath, { force: true });
          await rm(file.displacedPath, { force: true });
        }
      }
      const approval = await this.readOptional<ApprovalRecord>(this.approvalPath(journal.approvalId));
      if (approval !== null && approvalSealHash(approval) === journal.sealedApprovalHash && approval.consumedAt === undefined) {
        await writeJsonAtomic(this.approvalPath(approval.approvalId), { ...approval, consumedAt: this.now() });
      }
      const candidate = await this.readOptional<StoredCandidate>(this.candidatePath(journal.candidateId));
      if (candidate !== null) {
        const task = await this.readOptional<MutableTask>(this.taskPath(candidate.taskId));
        if (task !== null) {
          task.state = "APPLIED";
          await writeJsonAtomic(this.taskPath(task.taskId), task);
        }
      }
    }
  }

  private async readJournal(transactionId: string): Promise<MutableJournal> {
    const journal = await this.readRequired<MutableJournal>(
      this.journalPath(transactionId),
      "NOT_FOUND",
      "Apply journal not found",
    );
    const integrityHash = journal.integrityHash;
    journal.integrityHash = "";
    const actual = canonicalHash(journal);
    journal.integrityHash = integrityHash;
    if (journal.journalVersion !== 1 || integrityHash !== actual) {
      throw new ChangeManagerError("APPLY_CONFLICT", "Apply journal is corrupt or unsupported", false);
    }
    return journal;
  }

  private async fault(point: Parameters<NonNullable<ChangeManagerOptions["faultInjector"]>>[0], context: Record<string, unknown>) {
    await this.options.faultInjector?.(point, context);
  }

  private grantPath(grantId: string): string {
    return path.join(this.stateRoot, "grants", `${safeId(grantId)}.json`);
  }
  private taskPath(taskId: string): string {
    return path.join(this.stateRoot, "tasks", `${safeId(taskId)}.json`);
  }
  private candidatePath(candidateId: string): string {
    return path.join(this.stateRoot, "candidates", safeId(candidateId), "manifest.json");
  }
  private verificationPath(candidateId: string): string {
    return path.join(this.stateRoot, "verifications", `${safeId(candidateId)}.json`);
  }
  private approvalPath(approvalId: string): string {
    return path.join(this.stateRoot, "approvals", `${safeId(approvalId)}.json`);
  }
  private journalPath(transactionId: string): string {
    return path.join(this.stateRoot, "journals", safeId(transactionId), "journal.json");
  }
  private reviewTokenPath(candidateId: string): string {
    return path.join(this.stateRoot, "reviews", `${safeId(candidateId)}.json`);
  }

  private async readRequired<T>(
    filePath: string,
    code: ConstructorParameters<typeof ChangeManagerError>[0],
    message: string,
  ): Promise<T> {
    try {
      return await readJson<T>(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChangeManagerError(code, message, true);
      throw error;
    }
  }

  private async readOptional<T>(filePath: string): Promise<T | null> {
    try {
      return await readJson<T>(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readAll<T>(directory: string, depth = 1): Promise<T[]> {
    const root = path.join(this.stateRoot, directory);
    const results: T[] = [];
    const visit = async (current: string, remaining: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory() && remaining > 1) await visit(absolute, remaining - 1);
        else if (entry.isFile() && entry.name.endsWith(".json")) results.push(await readJson<T>(absolute));
      }
    };
    await visit(root, depth);
    return results;
  }
}

function assertId(value: string, field: string): void {
  if (!ID.test(value)) invalid(`Invalid ${field}`);
}

function safeId(value: string): string {
  assertId(value, "identifier");
  return value;
}

function validateHashes(...values: string[]): void {
  if (values.some((value) => !HASH.test(value))) invalid("Expected lowercase SHA-256 hash");
}

function invalid(message: string): never {
  throw new ChangeManagerError("INVALID_REQUEST", message, false);
}

function stale(message: string): never {
  throw new ChangeManagerError("CANDIDATE_STALE", message, true);
}

function protectedPath(relativePath: string): never {
  throw new ChangeManagerError("PROTECTED_PATH", "Protected, linked, or special path rejected", false, { relativePath });
}

function parseFutureTimestamp(value: string, now: Date): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) invalid("Expiry must be a future timestamp");
  return parsed;
}

function uniqueNormalizedScope(values: readonly string[]): string[] {
  const normalized = values.map(normalizeScopeEntry);
  const keys = normalized.map((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US"));
  if (new Set(keys).size !== keys.length) invalid("Scope contains Windows-colliding paths");
    return [...new Set(normalized)].sort(compareOrdinal);
}

function canonicalSelectedPaths(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 1000) invalid("Subset path count is out of range");
  const normalized = values.map((entry) => {
    const pathValue = normalizeRelativePath(entry);
    if (pathValue !== entry || entry.normalize("NFC") !== entry) {
      invalid("Subset paths must use canonical NFC project-relative Windows spelling");
    }
    return pathValue;
  });
  const keys = normalized.map(windowsCollisionKey);
  if (new Set(keys).size !== keys.length) invalid("Subset contains duplicate or Windows-colliding paths");
  return normalized.sort(compareOrdinal);
}

function candidateMatchesTask(candidate: StoredCandidate, task: MutableTask): boolean {
  return (
    candidate.projectId === task.projectId &&
    candidate.taskId === task.taskId &&
    candidate.grantId === task.grantId &&
    candidate.grantRevision === task.grantRevision &&
    candidate.ownerPrincipalId === task.ownerPrincipalId &&
    candidate.baseContractHash === task.contractHash &&
    candidate.contractHash === task.contractHash &&
    candidate.policyHash === task.policyHash &&
    candidate.policyRevision === task.policyRevision &&
    candidate.dependencyLockHash === task.dependencyLockHash &&
    candidate.fixturesHash === task.fixturesHash &&
    candidate.verificationProfileId === task.verificationProfileId &&
    candidate.verificationProfileHash === task.verificationProfileHash &&
    candidate.generatorVersion === task.generatorVersion &&
    candidate.baseCommit === task.baseCommit &&
    candidate.baseCommitHash === sha256(task.baseCommit) &&
    candidate.baseManifestHash === task.baseManifestHash &&
    candidate.baseContractRevision === task.baseContractRevision
  );
}

function scopesOverlap(left: string, right: string): boolean {
  const leftPrefix = left.endsWith("/") ? left : `${left}/`;
  const rightPrefix = right.endsWith("/") ? right : `${right}/`;
  return left === right || leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLocaleLowerCase("en-US") : path.resolve(value);
  return normalize(left) === normalize(right);
}

function nativeRootIdentity(value: {
  readonly nativeRootCanonicalPath?: string;
  readonly rootDeviceId: string;
  readonly rootFileId: string;
}): NativeRootIdentity {
  if (value.nativeRootCanonicalPath === undefined) {
    throw new ChangeManagerError("UNSUPPORTED_CAPABILITY", "Native root identity is absent", false);
  }
  return {
    canonicalPath: value.nativeRootCanonicalPath,
    volumeId: value.rootDeviceId,
    fileId: value.rootFileId,
  };
}

function sameReviewBinding(left: ReviewBinding, right: ReviewBinding): boolean {
  return (
    sameCandidateIdentity(left, right) &&
    left.candidateId === right.candidateId &&
    left.reportId === right.reportId &&
    left.evidenceDigest === right.evidenceDigest &&
    left.verificationId === right.verificationId
  );
}

function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function approvalSealHash(approval: ApprovalRecord): string {
  const { consumedAt: _consumedAt, ...immutable } = approval;
  return canonicalHash(immutable);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : Number(value.toFixed(3));
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareOrdinal)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      result[key] = canonicalize(entry);
    }
    return result;
  }
  throw new TypeError("Canonical JSON rejects unsupported values");
}

async function hashFileOrNull(filePath: string): Promise<string | null> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) protectedPath(filePath);
    return sha256(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertWritableTarget(target: string): Promise<void> {
  try {
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) protectedPath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeExclusiveFile(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveReplacement(target: string, bytes: Buffer, nonce: string): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const temporary = `${target}.boxspec-${nonce}.tmp`;
  await writeExclusiveFile(temporary, bytes);
  try {
    await rm(target, { force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function walkRegularFiles(
  root: string,
  visitor: (absolutePath: string, relativePath: string, stats: Awaited<ReturnType<typeof lstat>>) => Promise<void>,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stats = await lstat(absolute);
      const relative = normalizeRelativePath(path.relative(root, absolute).replaceAll(path.sep, "/"));
      if (stats.isSymbolicLink()) protectedPath(relative);
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) await visitor(absolute, relative, stats);
      else protectedPath(relative);
    }
  };
  await visit(root);
}
