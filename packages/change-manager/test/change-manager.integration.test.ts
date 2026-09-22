import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_SAFE_FS_MANIFEST } from "@boxspec/shared/native-tools";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChangeManagerError,
  NativeSafeFsClient,
  createChangeManager,
  type ChangeManagerControllers,
  type FaultPoint,
  type FrozenCandidateDescriptor,
  type ProjectGrant,
  type TaskRecord,
} from "../src/index.js";
import { createTestChangeManager } from "../src/testing.js";

const execFileAsync = promisify(execFile);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NATIVE_SAFE_FS_BINARY = path.resolve(WORKSPACE_ROOT, NATIVE_SAFE_FS_MANIFEST.developmentRelativePath);

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

interface Harness {
  root: string;
  source: string;
  state: string;
  clock: { value: Date };
  manager: ChangeManagerControllers;
  grant: ProjectGrant;
  task: TaskRecord;
  auth: { principalId: string; grantId: string };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function readUtf8OrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function createHarness(
  faultInjector?: (point: FaultPoint) => void | Promise<void>,
  nativeSafeFs?: { binaryPath: string; expectedSha256: string },
): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxspec-change-manager-"));
  cleanup.push(root);
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  await mkdir(path.join(source, "ui", "protected"), { recursive: true });
  await writeFile(path.join(source, "ui", "App.tsx"), "export const App = 'before';\n");
  await writeFile(path.join(source, "ui", "Other.tsx"), "export const Other = 'before';\n");
  await writeFile(path.join(source, "ui", "protected", "policy.ts"), "export const locked = true;\n");
  await writeFile(path.join(source, "business.ts"), "export const balance = 100;\n");
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "boxspec@example.invalid");
  await git(source, "config", "user.name", "BoxSpec Test");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "baseline");
  const clock = { value: new Date("2026-09-22T00:00:00.000Z") };
  let sequence = 0;
  const options = {
    stateRoot: state,
    clock: () => clock.value,
    idGenerator: (prefix) => `${prefix}_${++sequence}`,
    faultInjector: faultInjector === undefined ? undefined : (point) => faultInjector(point),
    ...(nativeSafeFs ? { nativeSafeFs } : {}),
  };
  const manager = nativeSafeFs ? createChangeManager(options) : createTestChangeManager(options);
  await manager.initialize();
  const grant = await manager.desktop.registerProjectGrant({
    projectId: "project_a",
    principalId: "client_a",
    permissions: ["read", "candidate-write", "verify"],
    sourceRoot: source,
    allowedWritePaths: ["ui/"],
    protectedPaths: ["ui/protected/"],
    executionProfileIds: ["profile_a"],
    grantRevision: 1,
    approvedPrincipalId: "desktop_a",
    expiresAt: "2026-09-23T00:00:00.000Z",
  });
  const auth = { principalId: "client_a", grantId: grant.grantId };
  const task = await manager.agent.startTask({
    ...auth,
    projectId: "project_a",
    screenId: "screen_a",
    expectedRevision: 7,
    scopeNodeIds: ["main"],
    objective: "Update the main UI",
    executionProfileId: "profile_a",
    contractHash: HASH_A,
    policyHash: HASH_C,
    policyRevision: 3,
    generatorVersion: "test-1",
    dependencyLockHash: HASH_F,
    fixturesHash: HASH_1,
    verificationProfileId: "verification_a",
    verificationProfileHash: HASH_2,
  });
  return { root, source, state, clock, manager, grant, task, auth };
}

async function freeze(
  harness: Harness,
  patches: readonly { relativePath: string; contentUtf8: string }[] = [
    { relativePath: "ui/App.tsx", contentUtf8: "export const App = 'after';\n" },
  ],
): Promise<FrozenCandidateDescriptor> {
  const patch = await harness.manager.agent.proposePatch({
    ...harness.auth,
    taskId: harness.task.taskId,
    expectedRevision: harness.task.revision,
    files: patches.map((entry) => ({ ...entry, operation: "upsert" as const })),
  });
  return harness.manager.agent.freezeCandidate({
    ...harness.auth,
    taskId: harness.task.taskId,
    expectedRevision: patch.taskRevision,
    contractHash: HASH_A,
    effectiveContractHash: HASH_D,
    layoutOverridesHash: HASH_E,
    policyHash: HASH_C,
    policyRevision: 3,
  });
}

async function verifyAndApprove(harness: Harness, candidate: FrozenCandidateDescriptor) {
  const verification = await harness.manager.verifier.recordTrustedVerification({
    candidateId: candidate.candidateId,
    projectId: candidate.projectId,
    taskId: candidate.taskId,
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
    status: "PASS",
    reportId: "report_a",
    evidenceDigest: HASH_F,
    checkedAt: harness.clock.value.toISOString(),
  });
  await harness.manager.agent.requestReview({ ...harness.auth, candidateId: candidate.candidateId });
  const review = await harness.manager.desktop.inspectReview(candidate.candidateId);
  expect(review.reviewNonce).toBeTruthy();
  const approval = await harness.manager.desktop.approveCandidate({
    candidateId: candidate.candidateId,
    reportId: verification.reportId,
    reviewNonce: review.reviewNonce!,
    approvedAt: harness.clock.value.toISOString(),
  });
  return { verification, approval };
}

async function passAndInspect(harness: Harness, candidate: FrozenCandidateDescriptor, reportId = "report_subset") {
  const verification = await harness.manager.verifier.recordTrustedVerification({
    ...candidate,
    status: "PASS",
    reportId,
    evidenceDigest: HASH_F,
    checkedAt: harness.clock.value.toISOString(),
  });
  await harness.manager.agent.requestReview({ ...harness.auth, candidateId: candidate.candidateId });
  const review = await harness.manager.desktop.inspectReview(candidate.candidateId);
  expect(review.reviewNonce).toBeTruthy();
  return { verification, review };
}

describe("change manager integration", () => {
  it("derives an immutable whole-file subset, stales the parent, and applies only freshly reverified child changes", async () => {
    const harness = await createHarness();
    const parent = await freeze(harness, [
      { relativePath: "ui/App.tsx", contentUtf8: "export const App = 'after';\n" },
      { relativePath: "ui/Other.tsx", contentUtf8: "export const Other = 'after';\n" },
    ]);
    const firstReview = await passAndInspect(harness, parent, "report_parent");
    const parentApproval = await harness.manager.desktop.approveCandidate({
      candidateId: parent.candidateId,
      reportId: firstReview.verification.reportId,
      reviewNonce: firstReview.review.reviewNonce!,
      approvedAt: harness.clock.value.toISOString(),
    });
    const freshParentReview = await harness.manager.desktop.inspectReview(parent.candidateId);
    const child = await harness.manager.desktop.createSubsetCandidate({
      parentCandidateId: parent.candidateId,
      parentReportId: firstReview.verification.reportId,
      reviewNonce: freshParentReview.reviewNonce!,
      selectedPaths: ["ui/App.tsx"],
      closureHash: HASH_B,
    });

    expect(child.candidateId).not.toBe(parent.candidateId);
    expect(child.treeHash).not.toBe(parent.treeHash);
    expect(child.changedPaths).toEqual(["ui/App.tsx"]);
    expect(child.changes.map((entry) => entry.relativePath)).toEqual(["ui/App.tsx"]);
    expect(child.subsetOrigin).toEqual({
      parentCandidateId: parent.candidateId,
      parentReportId: "report_parent",
      closureHash: HASH_B,
      selectedPaths: ["ui/App.tsx"],
    });
    expect(await readFile(path.join(child.snapshotRoot, "ui", "App.tsx"), "utf8")).toContain("after");
    expect(await readFile(path.join(child.snapshotRoot, "ui", "Other.tsx"), "utf8")).toContain("before");
    expect(await harness.manager.verifier.getVerification(child.candidateId)).toBeNull();
    expect((await harness.manager.agent.getTask({ ...harness.auth, taskId: child.taskId })).candidateId).toBe(child.candidateId);

    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: parent.candidateId,
        approvalId: parentApproval.approvalId,
        applyConfirmationToken: parentApproval.applyConfirmationToken,
      }),
    ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
    await expect(
      harness.manager.verifier.recordTrustedVerification({
        ...firstReview.verification,
        verificationId: undefined as never,
        recordedAt: undefined as never,
        checkedAt: harness.clock.value.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_STALE" });

    const childReview = await passAndInspect(harness, child, "report_child");
    const childApproval = await harness.manager.desktop.approveCandidate({
      candidateId: child.candidateId,
      reportId: childReview.verification.reportId,
      reviewNonce: childReview.review.reviewNonce!,
      approvedAt: harness.clock.value.toISOString(),
    });
    const applied = await harness.manager.desktop.applyApprovedCandidate({
      candidateId: child.candidateId,
      approvalId: childApproval.approvalId,
      applyConfirmationToken: childApproval.applyConfirmationToken,
    });
    expect(applied.appliedPaths).toEqual(["ui/App.tsx"]);
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("after");
    expect(await readFile(path.join(harness.source, "ui", "Other.tsx"), "utf8")).toContain("before");
  });

  it("accepts a dependency-expanded canonical file closure and rejects empty, foreign, colliding, and noncanonical selections", async () => {
    const harness = await createHarness();
    const parent = await freeze(harness, [
      { relativePath: "ui/App.tsx", contentUtf8: "export const App = 'after';\n" },
      { relativePath: "ui/Other.tsx", contentUtf8: "export const Other = 'after';\n" },
      { relativePath: "ui/Third.tsx", contentUtf8: "export const Third = 'after';\n" },
    ]);
    const { verification, review } = await passAndInspect(harness, parent);
    const base = {
      parentCandidateId: parent.candidateId,
      parentReportId: verification.reportId,
      reviewNonce: review.reviewNonce!,
      closureHash: HASH_B,
    };
    for (const selectedPaths of [[], ["ui/Missing.tsx"], ["ui/App.tsx", "ui/app.tsx"], ["ui\\App.tsx"]]) {
      await expect(harness.manager.desktop.createSubsetCandidate({ ...base, selectedPaths })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    const child = await harness.manager.desktop.createSubsetCandidate({
      ...base,
      selectedPaths: ["ui/Other.tsx", "ui/App.tsx"],
    });
    expect(child.changedPaths).toEqual(["ui/App.tsx", "ui/Other.tsx"]);
    await expect(readFile(path.join(child.snapshotRoot, "ui", "Third.tsx"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects subset derivation after source drift", async () => {
    const harness = await createHarness();
    const parent = await freeze(harness);
    const { verification, review } = await passAndInspect(harness, parent);
    await writeFile(path.join(harness.source, "ui", "App.tsx"), "source drift\n");
    await expect(
      harness.manager.desktop.createSubsetCandidate({
        parentCandidateId: parent.candidateId,
        parentReportId: verification.reportId,
        reviewNonce: review.reviewNonce!,
        selectedPaths: ["ui/App.tsx"],
        closureHash: HASH_B,
      }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" });
  });

  it.each(["policyHash", "verificationProfileHash"] as const)(
    "rejects subset derivation after the task %s binding changes",
    async (field) => {
      const harness = await createHarness();
      const parent = await freeze(harness);
      const { verification, review } = await passAndInspect(harness, parent);
      const taskPath = path.join(harness.state, "tasks", `${harness.task.taskId}.json`);
      const persisted = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
      persisted[field] = HASH_B;
      await writeFile(taskPath, `${JSON.stringify(persisted)}\n`, "utf8");
      await expect(
        harness.manager.desktop.createSubsetCandidate({
          parentCandidateId: parent.candidateId,
          parentReportId: verification.reportId,
          reviewNonce: review.reviewNonce!,
          selectedPaths: ["ui/App.tsx"],
          closureHash: HASH_B,
        }),
      ).rejects.toMatchObject({ code: "VERIFY_FAILED" });
    },
  );

  it("rejects subset derivation after its project grant is revoked", async () => {
    const harness = await createHarness();
    const parent = await freeze(harness);
    const { verification, review } = await passAndInspect(harness, parent);
    await harness.manager.desktop.revokeProjectGrant({ projectId: parent.projectId, grantId: harness.grant.grantId });
    await expect(
      harness.manager.desktop.createSubsetCandidate({
        parentCandidateId: parent.candidateId,
        parentReportId: verification.reportId,
        reviewNonce: review.reviewNonce!,
        selectedPaths: ["ui/App.tsx"],
        closureHash: HASH_B,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_GRANTED" });
  });

  it("creates a real detached Git worktree and freezes exact full-tree bytes", async () => {
    const harness = await createHarness();
    expect(await git(harness.task.workspacePath, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(await git(harness.task.workspacePath, "rev-parse", "HEAD")).toBe(harness.task.baseCommit);

    const candidate = await freeze(harness);
    expect(candidate.changedPaths).toEqual(["ui/App.tsx"]);
    expect(candidate.files.map((entry) => entry.relativePath)).toEqual([
      "business.ts",
      "ui/App.tsx",
      "ui/Other.tsx",
      "ui/protected/policy.ts",
    ]);
    expect(await readFile(path.join(candidate.snapshotRoot, "ui", "App.tsx"), "utf8")).toContain("after");
    await writeFile(path.join(harness.task.workspacePath, "ui", "App.tsx"), "later mutation\n");
    expect(await readFile(path.join(candidate.snapshotRoot, "ui", "App.tsx"), "utf8")).toContain("after");
  });

  it("rejects scope, protected paths, stale revisions, expired grants, and principal reuse", async () => {
    const harness = await createHarness();
    const base = { ...harness.auth, taskId: harness.task.taskId, expectedRevision: 1 };
    await expect(
      harness.manager.agent.proposePatch({
        ...base,
        files: [{ relativePath: "business.ts", operation: "upsert", contentUtf8: "changed\n" }],
      }),
    ).rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
    await expect(
      harness.manager.agent.proposePatch({
        ...base,
        files: [{ relativePath: "ui/protected/policy.ts", operation: "upsert", contentUtf8: "changed\n" }],
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
    await expect(harness.manager.agent.getTask({ principalId: "client_b", grantId: harness.grant.grantId, taskId: harness.task.taskId })).rejects.toMatchObject({
      code: "PROJECT_NOT_GRANTED",
    });
    await expect(
      harness.manager.agent.freezeCandidate({
        ...harness.auth,
        taskId: harness.task.taskId,
        expectedRevision: 99,
        contractHash: HASH_A,
        effectiveContractHash: HASH_D,
        layoutOverridesHash: HASH_E,
        policyHash: HASH_C,
        policyRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    harness.clock.value = new Date("2026-09-24T00:00:00.000Z");
    await expect(harness.manager.agent.authorizeGrant({ ...harness.auth, projectId: "project_a", permission: "read" })).rejects.toMatchObject({
      code: "PROJECT_NOT_GRANTED",
    });
  });

  it("security: rejects symlink traversal in a task workspace", async () => {
    const harness = await createHarness();
    const outside = path.join(harness.root, "outside");
    await mkdir(outside);
    const link = path.join(harness.task.workspacePath, "ui", "linked");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(
      harness.manager.agent.proposePatch({
        ...harness.auth,
        taskId: harness.task.taskId,
        expectedRevision: 1,
        files: [{ relativePath: "ui/linked/escape.ts", operation: "upsert", contentUtf8: "escape\n" }],
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
  });

  it("detects frozen snapshot mutation and rejects mismatched trusted identity", async () => {
    const harness = await createHarness();
    const candidate = await freeze(harness);
    await expect(
      harness.manager.verifier.recordTrustedVerification({
        ...candidate,
        treeHash: HASH_A,
        status: "PASS",
        reportId: "report_a",
        evidenceDigest: HASH_F,
        checkedAt: harness.clock.value.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
    await chmod(path.join(candidate.snapshotRoot, "ui", "App.tsx"), 0o644);
    await writeFile(path.join(candidate.snapshotRoot, "ui", "App.tsx"), "tampered\n");
    await expect(harness.manager.verifier.getFrozenCandidate(candidate.candidateId)).rejects.toMatchObject({
      code: "CANDIDATE_STALE",
    });
  });

  it("binds approval to a server-side single-use nonce and current trusted PASS", async () => {
    const harness = await createHarness();
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await expect(
      harness.manager.desktop.approveCandidate({
        candidateId: candidate.candidateId,
        reportId: approval.reportId,
        reviewNonce: "wrong",
        approvedAt: harness.clock.value.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_APPROVAL_REQUIRED" });
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: "wrong",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_APPROVAL_REQUIRED" });
  });

  it("blocks source drift after approval without overwriting user bytes", async () => {
    const harness = await createHarness();
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await writeFile(path.join(harness.source, "ui", "App.tsx"), "user drift\n");
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toBe("user drift\n");
  });

  it("blocks full-source manifest and HEAD drift outside the changed UI path", async () => {
    const harness = await createHarness();
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await writeFile(path.join(harness.source, "business.ts"), "export const balance = 999;\n");
    await git(harness.source, "add", "business.ts");
    await git(harness.source, "commit", "-m", "source drift");
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("before");
  });

  it("freezes and applies a scoped deletion as an explicit after-null change", async () => {
    const harness = await createHarness();
    const patch = await harness.manager.agent.proposePatch({
      ...harness.auth,
      taskId: harness.task.taskId,
      expectedRevision: 1,
      files: [{ relativePath: "ui/Other.tsx", operation: "delete" }],
    });
    const candidate = await harness.manager.agent.freezeCandidate({
      ...harness.auth,
      taskId: harness.task.taskId,
      expectedRevision: patch.taskRevision,
      contractHash: HASH_A,
      effectiveContractHash: HASH_D,
      layoutOverridesHash: HASH_E,
      policyHash: HASH_C,
      policyRevision: 3,
    });
    expect(candidate.changes).toContainEqual(
      expect.objectContaining({ relativePath: "ui/Other.tsx", afterSha256: null, afterSize: null }),
    );
    const { approval } = await verifyAndApprove(harness, candidate);
    await harness.manager.desktop.applyApprovedCandidate({
      candidateId: candidate.candidateId,
      approvalId: approval.approvalId,
      applyConfirmationToken: approval.applyConfirmationToken,
    });
    await expect(readFile(path.join(harness.source, "ui", "Other.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects expired verification and expired approvals", async () => {
    const verificationHarness = await createHarness();
    const candidate = await freeze(verificationHarness);
    await verificationHarness.manager.verifier.recordTrustedVerification({
      ...candidate,
      status: "PASS",
      reportId: "report_a",
      evidenceDigest: HASH_F,
      checkedAt: verificationHarness.clock.value.toISOString(),
    });
    verificationHarness.clock.value = new Date(verificationHarness.clock.value.getTime() + 31 * 60_000);
    const staleReview = await verificationHarness.manager.desktop.inspectReview(candidate.candidateId);
    expect(staleReview.canApprove).toBe(false);
    expect(staleReview.blockReasons).toContain("verification expired");

    const approvalHarness = await createHarness();
    const approvedCandidate = await freeze(approvalHarness);
    const { approval } = await verifyAndApprove(approvalHarness, approvedCandidate);
    approvalHarness.clock.value = new Date(approvalHarness.clock.value.getTime() + 11 * 60_000);
    await expect(
      approvalHarness.manager.desktop.applyApprovedCandidate({
        candidateId: approvedCandidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
  });

  it("durably revokes a principal grant across restart", async () => {
    const harness = await createHarness();
    await harness.manager.desktop.revokeProjectGrant({ projectId: "project_a", grantId: harness.grant.grantId });
    const restarted = createTestChangeManager({ stateRoot: harness.state, clock: () => harness.clock.value });
    await restarted.initialize();
    await expect(
      restarted.agent.authorizeGrant({ ...harness.auth, projectId: "project_a", permission: "read" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_GRANTED" });
  });

  it("finalizes a committed APPLIED journal after a restart", async () => {
    let crash = true;
    const harness = await createHarness((point) => {
      if (crash && point === "after-journal-applied") throw new Error("committed crash");
    });
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toThrow("committed crash");
    crash = false;
    const restarted = createTestChangeManager({ stateRoot: harness.state, clock: () => harness.clock.value });
    expect(await restarted.initialize()).toEqual([]);
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("after");
    await expect(
      restarted.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
  });

  it("uses the pinned native helper for a public Windows apply and removes transaction artifacts", async () => {
    if (process.platform !== "win32") return;
    const binaryPath = NATIVE_SAFE_FS_BINARY;
    const expectedSha256 = NATIVE_SAFE_FS_MANIFEST.sha256;
    const harness = await createHarness(undefined, { binaryPath, expectedSha256 });
    const candidate = await freeze(harness, [
      { relativePath: "ui/App.tsx", contentUtf8: "export const App = 'after';\n" },
      { relativePath: "ui/new/nested/Added.tsx", contentUtf8: "export const Added = true;\n" },
    ]);
    const { approval } = await verifyAndApprove(harness, candidate);
    const result = await harness.manager.desktop.applyApprovedCandidate({
      candidateId: candidate.candidateId,
      approvalId: approval.approvalId,
      applyConfirmationToken: approval.applyConfirmationToken,
    });
    expect(result.phase).toBe("APPLIED");
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("after");
    expect(await readFile(path.join(harness.source, "ui", "new", "nested", "Added.tsx"), "utf8")).toContain("Added");
    const uiEntries = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(harness.source, "ui")));
    expect(uiEntries.some((entry) => entry.startsWith(".__boxspec-"))).toBe(false);
    const nestedEntries = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(harness.source, "ui", "new", "nested")));
    expect(nestedEntries.some((entry) => entry.startsWith(".__boxspec-"))).toBe(false);
  }, 30_000);

  it("creates missing managed-write directories through the pinned native helper", async () => {
    if (process.platform !== "win32") return;
    const binaryPath = NATIVE_SAFE_FS_BINARY;
    const root = await mkdtemp(path.join(os.tmpdir(), "boxspec-native-directory-"));
    cleanup.push(root);
    const client = new NativeSafeFsClient(binaryPath, NATIVE_SAFE_FS_MANIFEST.sha256);
    const rootIdentity = await client.inspectRoot(root);
    const result = await client.ensureDirectory({
      root,
      rootIdentity,
      relativePath: ".boxspec/screens",
    });
    expect(result.created).toEqual([".boxspec", ".boxspec/screens"]);
    expect((await lstat(path.join(root, ".boxspec", "screens"))).isDirectory()).toBe(true);
    expect((await client.ensureDirectory({ root, rootIdentity, relativePath: ".boxspec/screens" })).created).toEqual([]);
  }, 30_000);

  it("recovers a native crash after exact replacement by restoring the journaled BEFORE bytes", async () => {
    if (process.platform !== "win32") return;
    const binaryPath = NATIVE_SAFE_FS_BINARY;
    const expectedSha256 = NATIVE_SAFE_FS_MANIFEST.sha256;
    let crash = true;
    const harness = await createHarness(
      (point) => {
        if (crash && point === "after-file-replaced") throw new Error("native crash");
      },
      { binaryPath, expectedSha256 },
    );
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toThrow("native crash");
    crash = false;
    const restarted = createChangeManager({ stateRoot: harness.state, clock: () => harness.clock.value, nativeSafeFs: { binaryPath, expectedSha256 } });
    const inspections = await restarted.initialize();
    expect(inspections).toHaveLength(1);
    expect(inspections[0]?.fileStates).toEqual([{ relativePath: "ui/App.tsx", state: "AFTER" }]);
    const nativeBytesBeforeInvalidDecision = await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8");
    await expect(
      restarted.desktop.recoverInterruptedApply(
        inspections[0]!.transactionId,
        "not-a-strategy" as unknown as "restore-before",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toBe(nativeBytesBeforeInvalidDecision);
    const recovered = await restarted.desktop.recoverInterruptedApply(inspections[0]!.transactionId, "restore-before");
    expect(recovered.phase).toBe("ROLLED_BACK");
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("before");
  }, 30_000);

  it.each<FaultPoint>(["after-journal-prepared", "after-target-moved", "after-file-replaced", "before-final-verification"])(
    "recovers a journaled crash at %s without losing originals",
    async (faultPoint) => {
      let crashEnabled = true;
      const harness = await createHarness((point) => {
        if (crashEnabled && point === faultPoint) throw new Error(`simulated crash at ${point}`);
      });
      const candidate = await freeze(harness, [
        { relativePath: "ui/App.tsx", contentUtf8: "export const App = 'after';\n" },
        { relativePath: "ui/Other.tsx", contentUtf8: "export const Other = 'after';\n" },
      ]);
      const { approval } = await verifyAndApprove(harness, candidate);
      await expect(
        harness.manager.desktop.applyApprovedCandidate({
          candidateId: candidate.candidateId,
          approvalId: approval.approvalId,
          applyConfirmationToken: approval.applyConfirmationToken,
        }),
      ).rejects.toThrow(/simulated crash/u);
      crashEnabled = false;

      const restarted = createTestChangeManager({ stateRoot: harness.state, clock: () => harness.clock.value });
      const inspections = await restarted.initialize();
      expect(inspections).toHaveLength(1);
      expect(inspections[0]?.sourceDriftPaths).toEqual([]);
      const bytesBeforeInvalidDecision = await Promise.all([
        readUtf8OrNull(path.join(harness.source, "ui", "App.tsx")),
        readUtf8OrNull(path.join(harness.source, "ui", "Other.tsx")),
      ]);
      await expect(
        restarted.desktop.recoverInterruptedApply(
          inspections[0]!.transactionId,
          "not-a-strategy" as unknown as "restore-before",
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(
        await Promise.all([
          readUtf8OrNull(path.join(harness.source, "ui", "App.tsx")),
          readUtf8OrNull(path.join(harness.source, "ui", "Other.tsx")),
        ]),
      ).toEqual(bytesBeforeInvalidDecision);
      const recovery = await restarted.desktop.recoverInterruptedApply(inspections[0]!.transactionId, "restore-before");
      expect(recovery.phase).toBe("ROLLED_BACK");
      expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toContain("before");
      expect(await readFile(path.join(harness.source, "ui", "Other.tsx"), "utf8")).toContain("before");
    },
  );

  it("recovery blocks ambiguous user edits instead of overwriting them", async () => {
    let shouldCrash = true;
    const harness = await createHarness((point) => {
      if (shouldCrash && point === "after-file-replaced") throw new Error("crash");
    });
    const candidate = await freeze(harness);
    const { approval } = await verifyAndApprove(harness, candidate);
    await expect(
      harness.manager.desktop.applyApprovedCandidate({
        candidateId: candidate.candidateId,
        approvalId: approval.approvalId,
        applyConfirmationToken: approval.applyConfirmationToken,
      }),
    ).rejects.toThrow("crash");
    shouldCrash = false;
    await writeFile(path.join(harness.source, "ui", "App.tsx"), "user edit after crash\n");
    const restarted = createTestChangeManager({ stateRoot: harness.state, clock: () => harness.clock.value });
    const inspections = await restarted.initialize();
    expect(inspections[0]?.sourceDriftPaths).toEqual(["ui/App.tsx"]);
    await expect(
      restarted.desktop.recoverInterruptedApply(inspections[0]!.transactionId, "restore-before"),
    ).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
    expect(await readFile(path.join(harness.source, "ui", "App.tsx"), "utf8")).toBe("user edit after crash\n");
  });
});
