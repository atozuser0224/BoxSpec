import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBoxSpecRuntime } from "../../packages/runtime/dist/index.js";
import { NativeSafeFsClient } from "../../packages/change-manager/dist/index.js";
import { NATIVE_SAFE_FS_MANIFEST } from "../../packages/shared/dist/native-tools.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const nativeSafeFs = {
  binaryPath: join(repoRoot, ...NATIVE_SAFE_FS_MANIFEST.developmentRelativePath.split("/")),
  expectedSha256: NATIVE_SAFE_FS_MANIFEST.sha256,
};

function protectedProjection(value) {
  const { designSystem: _designSystem, revision: _revision, ...protectedValue } = value;
  return protectedValue;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function withTempRoots(run) {
  const root = await mkdtemp(join(tmpdir(), "boxspec-runtime-security-"));
  const dataDir = await mkdtemp(join(tmpdir(), "boxspec-runtime-state-security-"));
  try {
    return await run(root, dataDir);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("trusted authoring save rejects an existing junction in a managed output parent", async (t) => {
  await withTempRoots(async (root, dataDir) => {
    const outside = await mkdtemp(join(tmpdir(), "boxspec-runtime-outside-"));
    let runtime;
    try {
      await mkdir(join(root, ".boxspec"), { recursive: true });
      try {
        await symlink(outside, join(root, ".boxspec", "screens"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error?.code === "EPERM") {
          t.skip("junction creation is not permitted on this Windows host");
          return;
        }
        throw error;
      }
      runtime = await createBoxSpecRuntime({ dataDir });
      const project = await runtime.desktop.createProject({ name: "Junction regression", rootPath: root, target: "web-react" });
      await runtime.desktop.createScreen({ projectId: project.projectId, name: "Screen", width: 1440, height: 900 });
      await assert.rejects(runtime.desktop.saveProject({ projectId: project.projectId }), (error) => error?.code === "OUT_OF_SCOPE");
    } finally {
      await runtime?.close();
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("recovery authority rejects foreign, stale, incomplete, and malformed decisions", async () => {
  await withTempRoots(async (root, dataDir) => {
    const recoveries = [];
    const applied = [];
    const unavailable = new Proxy({}, { get: () => async () => { throw new Error("unexpected change-manager call"); } });
    const changeManager = {
      agent: unavailable,
      verifier: unavailable,
      desktop: {
        ...unavailable,
        inspectRecoveries: async () => structuredClone(recoveries),
        recoverInterruptedApply: async (transactionId, decision) => {
          applied.push({ transactionId, decision });
          return { transactionId, phase: decision === "restore-before" ? "ROLLED_BACK" : "APPLIED", affectedPaths: ["a.txt"] };
        },
      },
      initialize: async () => [],
    };
    const runtime = await createBoxSpecRuntime({ dataDir, changeManager });
    try {
      const first = await runtime.desktop.createProject({ name: "Recovery one", rootPath: root, target: "web-react" });
      const secondRoot = await mkdtemp(join(tmpdir(), "boxspec-runtime-security-second-"));
      try {
        const second = await runtime.desktop.createProject({ name: "Recovery two", rootPath: secondRoot, target: "web-react" });
        recoveries.push({ transactionId: "txn-own", projectId: first.projectId, phase: "RECOVERY_REQUIRED", fileStates: [{ relativePath: "a.txt", state: "BEFORE" }], needsUserDecision: true, sourceDriftPaths: [] });
        assert.deepEqual(await runtime.desktop.listRecovery({ projectId: second.projectId }), []);
        await assert.rejects(runtime.desktop.inspectRecovery({ projectId: second.projectId, transactionId: "txn-own" }), (error) => error?.code === "NOT_FOUND");

        const malformed = await runtime.desktop.inspectRecovery({ projectId: first.projectId, transactionId: "txn-own" });
        await assert.rejects(
          runtime.desktop.recoverApply({ projectId: first.projectId, recovery: { transactionId: "txn-own", recoveryNonce: malformed.recoveryNonce, strategy: "not-a-strategy", unknownPathDecisions: [] } }),
          (error) => error?.code === "INVALID_REQUEST",
        );
        assert.deepEqual(applied, []);

        const stale = await runtime.desktop.inspectRecovery({ projectId: first.projectId, transactionId: "txn-own" });
        recoveries[0].phase = "SOURCE_DRIFT";
        await assert.rejects(
          runtime.desktop.recoverApply({ projectId: first.projectId, recovery: { transactionId: "txn-own", recoveryNonce: stale.recoveryNonce, strategy: "finish-after", unknownPathDecisions: [] } }),
          (error) => error?.code === "APPLY_CONFLICT",
        );
        assert.deepEqual(applied, []);

        recoveries[0] = { ...recoveries[0], fileStates: [{ relativePath: "a.txt", state: "UNKNOWN" }], sourceDriftPaths: ["a.txt"] };
        const incomplete = await runtime.desktop.inspectRecovery({ projectId: first.projectId, transactionId: "txn-own" });
        await assert.rejects(
          runtime.desktop.recoverApply({ projectId: first.projectId, recovery: { transactionId: "txn-own", recoveryNonce: incomplete.recoveryNonce, strategy: "finish-after", unknownPathDecisions: [] } }),
          (error) => error?.code === "APPLY_CONFLICT",
        );
        assert.deepEqual(applied, []);

        const preserve = await runtime.desktop.inspectRecovery({ projectId: first.projectId, transactionId: "txn-own" });
        assert.deepEqual(
          await runtime.desktop.recoverApply({ projectId: first.projectId, recovery: { transactionId: "txn-own", recoveryNonce: preserve.recoveryNonce, strategy: "finish-after", unknownPathDecisions: [{ path: "a.txt", action: "preserve-current" }] } }),
          { transactionId: "txn-own", status: "BLOCKED", unknownPaths: ["a.txt"] },
        );
        assert.deepEqual(applied, []);
      } finally {
        await rm(secondRoot, { recursive: true, force: true });
      }
    } finally {
      await runtime.close();
    }
  });
});

test("live drafts bind proposal identity, remain isolated, and reject stale publication", async () => {
  await withTempRoots(async (root, dataDir) => {
    const sentinel = join(root, "user-source.ts");
    await writeFile(sentinel, "export const userSource = true;\n", "utf8");
    execFileSync("git", ["init"], { cwd: root, windowsHide: true });
    execFileSync("git", ["config", "user.email", "security@example.invalid"], { cwd: root, windowsHide: true });
    execFileSync("git", ["config", "user.name", "BoxSpec Security"], { cwd: root, windowsHide: true });
    execFileSync("git", ["add", "-A"], { cwd: root, windowsHide: true });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, windowsHide: true });
    const runtime = await createBoxSpecRuntime({ dataDir });
    try {
      const project = await runtime.desktop.createProject({ name: "Draft security", rootPath: root, target: "web-react" });
      const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "Screen", width: 1440, height: 900 });
      const grant = await runtime.desktop.pairMcpClient({
        projectId: project.projectId,
        principalId: "draft-agent",
        permissions: ["read", "candidate-write"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const principal = { kind: "mcp-client", principalId: "draft-agent", grantId: grant.grantId };
      const approved = (await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract;

      for (const [requestId, proposed] of [
        ["draft-wrong-project", { ...approved, projectId: "prj_foreign", revision: 2 }],
        ["draft-wrong-screen", { ...approved, screenId: "screen_foreign", revision: 2 }],
        ["draft-wrong-revision", { ...approved, revision: 3 }],
        ["draft-wrong-target", { ...approved, target: "desktop-native", revision: 2 }],
      ]) {
        const rejected = await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", {
          requestId,
          projectId: project.projectId,
          screenId: screen.screenId,
          expectedRevision: 1,
          reason: "hostile identity substitution",
          proposedContractJson: JSON.stringify(proposed),
        });
        assert.equal(rejected.ok, false);
      }

      const proposed = structuredClone(approved);
      proposed.revision = 2;
      proposed.nodes = proposed.nodes.map((node) => node.id === "header" ? { ...node, name: "Agent draft header" } : node);
      const created = await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", {
        requestId: "draft-valid",
        projectId: project.projectId,
        screenId: screen.screenId,
        expectedRevision: 1,
        reason: "layout proposal",
        proposedContractJson: JSON.stringify(proposed),
      });
      assert.equal(created.ok, true);
      const proposalId = created.data.proposalId;
      const [summary] = await runtime.desktop.listLayoutDrafts({ projectId: project.projectId });
      assert.equal(summary.proposalId, proposalId);
      assert.equal((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.revision, 1);
      assert.equal(await readFile(sentinel, "utf8"), "export const userSource = true;\n");

      const opened = await runtime.desktop.openLayoutDraft({ projectId: project.projectId, proposalId });
      const existingIds = opened.contract.nodes.map((node) => node.id);
      const editedContract = {
        ...opened.contract,
        nodes: opened.contract.nodes.map((node) => node.id === "header" ? { ...node, name: "User edited draft header" } : node),
      };
      const edited = await runtime.desktop.updateLayoutDraft({
        requestId: "draft-user-edit",
        projectId: project.projectId,
        proposalId,
        expectedDraftRevision: 1,
        contract: editedContract,
      });
      assert.deepEqual(edited.contract.nodes.map((node) => node.id), existingIds);
      assert.equal(edited.summary.status, "USER_EDITING_DRAFT");
      assert.equal((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.revision, 1);
      assert.equal(await readFile(sentinel, "utf8"), "export const userSource = true;\n");

      const competing = await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", {
        requestId: "draft-competing",
        projectId: project.projectId,
        screenId: screen.screenId,
        expectedRevision: 1,
        reason: "later agent proposal",
        proposedContractJson: JSON.stringify({ ...proposed, name: "Competing draft" }),
      });
      assert.equal(competing.ok, true);
      const drafts = await runtime.desktop.listLayoutDrafts({ projectId: project.projectId });
      assert.equal(drafts.length, 2);
      assert.equal((await runtime.desktop.openLayoutDraft({ projectId: project.projectId, proposalId })).contract.nodes.find((node) => node.id === "header").name, "User edited draft header");

      await runtime.desktop.executeEditorCommand({
        requestId: "approved-user-edit",
        projectId: project.projectId,
        screenId: screen.screenId,
        expectedRevision: 1,
        command: { type: "replace-contract", contract: { ...approved, revision: 2, name: "Approved user edit" } },
      });
      await assert.rejects(
        runtime.desktop.publishLayoutDraft({
          requestId: "draft-publish-stale",
          projectId: project.projectId,
          proposalId,
          expectedDraftRevision: 2,
          expectedBaseRevision: 1,
          expectedBaseHash: summary.baseContractHash,
        }),
        (error) => error?.code === "REVISION_CONFLICT",
      );
      assert.equal((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.name, "Approved user edit");
      assert.equal(await readFile(sentinel, "utf8"), "export const userSource = true;\n");
    } finally {
      await runtime.close();
    }
  });
});

test("startup reconciles a durable layout publish intent after the Core mutation", async () => {
  await withTempRoots(async (root, dataDir) => {
    await writeFile(join(root, "README.md"), "publish recovery fixture\n", "utf8");
    execFileSync("git", ["init"], { cwd: root, windowsHide: true });
    execFileSync("git", ["config", "user.email", "security@example.invalid"], { cwd: root, windowsHide: true });
    execFileSync("git", ["config", "user.name", "BoxSpec Security"], { cwd: root, windowsHide: true });
    execFileSync("git", ["add", "-A"], { cwd: root, windowsHide: true });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, windowsHide: true });
    let runtime = await createBoxSpecRuntime({ dataDir });
    let projectId;
    let screenId;
    let proposalId;
    let published;
    try {
      const project = await runtime.desktop.createProject({ name: "Publish recovery", rootPath: root, target: "web-react" });
      projectId = project.projectId;
      const screen = await runtime.desktop.createScreen({ projectId, name: "Screen", width: 1440, height: 900 });
      screenId = screen.screenId;
      const grant = await runtime.desktop.pairMcpClient({ projectId, principalId: "publish-agent", permissions: ["read", "candidate-write"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const principal = { kind: "mcp-client", principalId: "publish-agent", grantId: grant.grantId };
      const approved = (await runtime.desktop.getEditorState({ projectId, screenId })).contract;
      const proposal = await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", {
        requestId: "publish-proposal",
        projectId,
        screenId,
        expectedRevision: approved.revision,
        reason: "recovery fixture",
        proposedContractJson: JSON.stringify({ ...approved, revision: approved.revision + 1, name: "Published layout" }),
      });
      assert.equal(proposal.ok, true);
      proposalId = proposal.data.proposalId;
      const detail = await runtime.desktop.openLayoutDraft({ projectId, proposalId });
      published = await runtime.desktop.publishLayoutDraft({
        requestId: "publish-request",
        projectId,
        proposalId,
        expectedDraftRevision: detail.summary.draftRevision,
        expectedBaseRevision: detail.summary.baseRevision,
        expectedBaseHash: detail.summary.baseContractHash,
      });
    } finally {
      await runtime.close();
    }

    const statePath = join(dataDir, "runtime-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const record = state.proposals[proposalId];
    record.status = "USER_EDITING_DRAFT";
    record.publishIntent = { requestId: "publish-request", handoff: published };
    delete record.publishRequestId;
    delete record.publishedHandoff;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    runtime = await createBoxSpecRuntime({ dataDir });
    try {
      const [reconciled] = await runtime.desktop.listLayoutDrafts({ projectId });
      assert.equal(reconciled.status, "PUBLISHED");
      assert.equal((await runtime.desktop.getEditorState({ projectId, screenId })).contract.name, "Published layout");
      assert.deepEqual(await runtime.desktop.publishLayoutDraft({
        requestId: "publish-request",
        projectId,
        proposalId,
        expectedDraftRevision: reconciled.draftRevision,
        expectedBaseRevision: reconciled.baseRevision,
        expectedBaseHash: reconciled.baseContractHash,
      }), published);
      const persisted = JSON.parse(await readFile(statePath, "utf8")).proposals[proposalId];
      assert.equal(persisted.publishIntent, undefined);
      assert.deepEqual(persisted.publishedHandoff, published);
    } finally {
      await runtime.close();
    }
  });
});

test("startup finalizes a journaled native managed write after commit", { skip: process.platform !== "win32" }, async () => {
  await withTempRoots(async (root, dataDir) => {
    let runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    let projectId;
    try {
      projectId = (await runtime.desktop.createProject({ name: "Managed write recovery", rootPath: root, target: "web-react" })).projectId;
    } finally {
      await runtime.close();
    }

    const statePath = join(dataDir, "runtime-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const project = state.projects[projectId];
    const client = new NativeSafeFsClient(nativeSafeFs.binaryPath, nativeSafeFs.expectedSha256);
    const rootIdentity = await client.inspectRoot(root);
    assert.equal(rootIdentity.volumeId, project.nativeRootVolumeId);
    assert.equal(rootIdentity.fileId, project.nativeRootFileId);
    await client.ensureDirectory({ root, rootIdentity, relativePath: ".boxspec/security" });
    const transactionId = "managed-write-security-recovery";
    const relativePath = ".boxspec/security/recovered.txt";
    const prepared = await client.prepareReplace({ transactionId, root, rootIdentity, relativePath, expectedBeforeHash: null, afterBytes: Buffer.from("recovered\n", "utf8") });
    await client.commitReplace({ transactionId, root, rootIdentity, relativePath, preparedId: prepared.preparedId });
    state.managedWrites[transactionId] = {
      transactionId,
      projectId,
      relativePath,
      preparedId: prepared.preparedId,
      beforeHash: prepared.beforeHash,
      afterHash: prepared.afterHash,
      createdAt: new Date().toISOString(),
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    try {
      assert.equal(await readFile(join(root, ".boxspec", "security", "recovered.txt"), "utf8"), "recovered\n");
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).managedWrites, {});
    } finally {
      await runtime.close();
    }
  });
});

test("startup completes only exact BEFORE/AFTER members of a durable managed-save batch", { skip: process.platform !== "win32" }, async () => {
  await withTempRoots(async (root, dataDir) => {
    let runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    let projectId;
    try {
      projectId = (await runtime.desktop.createProject({ name: "Managed batch recovery", rootPath: root, target: "web-react" })).projectId;
    } finally {
      await runtime.close();
    }

    const parent = join(root, ".boxspec", "security-batch");
    await mkdir(parent, { recursive: true });
    const beforeA = "before-a\n", beforeB = "before-b\n", afterA = "after-a\n", afterB = "after-b\n";
    const first = ".boxspec/security-batch/a.txt", second = ".boxspec/security-batch/b.txt";
    await writeFile(join(root, first), afterA, "utf8");
    await writeFile(join(root, second), beforeB, "utf8");
    const statePath = join(dataDir, "runtime-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.managedSaveBatches = {
      "security-batch": {
        batchId: "security-batch",
        projectId,
        createdAt: new Date().toISOString(),
        outputs: [
          { relativePath: first, content: afterA, beforeHash: sha256Text(beforeA), afterHash: sha256Text(afterA) },
          { relativePath: second, content: afterB, beforeHash: sha256Text(beforeB), afterHash: sha256Text(afterB) },
        ],
      },
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    try {
      assert.equal(await readFile(join(root, first), "utf8"), afterA);
      assert.equal(await readFile(join(root, second), "utf8"), afterB);
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).managedSaveBatches, {});
    } finally {
      await runtime.close();
    }

    const unknownState = JSON.parse(await readFile(statePath, "utf8"));
    const userEdit = "user edit must survive\n";
    await writeFile(join(root, second), userEdit, "utf8");
    unknownState.managedSaveBatches = {
      "security-unknown-batch": {
        batchId: "security-unknown-batch",
        projectId,
        createdAt: new Date().toISOString(),
        outputs: [
          { relativePath: first, content: afterA, beforeHash: sha256Text(beforeA), afterHash: sha256Text(afterA) },
          { relativePath: second, content: "next-b\n", beforeHash: sha256Text(afterB), afterHash: sha256Text("next-b\n") },
        ],
      },
    };
    await writeFile(statePath, `${JSON.stringify(unknownState, null, 2)}\n`, "utf8");
    runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    try {
      assert.equal(await readFile(join(root, second), "utf8"), userEdit);
      assert.ok(JSON.parse(await readFile(statePath, "utf8")).managedSaveBatches["security-unknown-batch"]);
    } finally {
      await runtime.close();
    }
  });
});

test("runtime resolves themes from its trusted catalog and preserves protected screen state", async () => {
  await withTempRoots(async (root, dataDir) => {
    const runtime = await createBoxSpecRuntime({ dataDir });
    try {
      const project = await runtime.desktop.createProject({ name: "Theme authority", rootPath: root, target: "web-react" });
      const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "Screen", width: 1440, height: 900 });
      const before = (await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract;
      const gallery = await runtime.desktop.listThemeGallery({ projectId: project.projectId });
      assert.equal(gallery.length, 17);
      const themeId = gallery[0].id;

      await assert.rejects(
        runtime.desktop.applyThemeToScreen({ requestId: "unknown-theme", projectId: project.projectId, screenId: screen.screenId, themeId: "not_in_catalog", expectedRevision: before.revision }),
      );
      const themed = await runtime.desktop.applyThemeToScreen({ requestId: "trusted-theme", projectId: project.projectId, screenId: screen.screenId, themeId, expectedRevision: before.revision });
      assert.equal(themed.contract.revision, before.revision + 1);
      assert.deepEqual(protectedProjection(themed.contract), protectedProjection(before));
      await assert.rejects(
        runtime.desktop.applyThemeToScreen({ requestId: "stale-theme", projectId: project.projectId, screenId: screen.screenId, themeId, expectedRevision: before.revision }),
        (error) => error?.code === "REVISION_CONFLICT",
      );
    } finally {
      await runtime.close();
    }
  });
});

test("source-drift resolution binds the whole unit, persists unmanage, and imports contracts as drafts only", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  await withTempRoots(async (root, dataDir) => {
    let runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    let projectId;
    let screenId;
    const userLayout = "// user layout bytes\n";
    const laterCss = "/* later user css */\n";
    try {
      const project = await runtime.desktop.createProject({ name: "Drift authority", rootPath: root, target: "web-react" });
      projectId = project.projectId;
      const screen = await runtime.desktop.createScreen({ projectId, name: "Screen", width: 1440, height: 900 });
      screenId = screen.screenId;
      await runtime.desktop.saveProject({ projectId });
      const layoutPath = join(root, "src", "boxspec", "generated", `${screenId}.layout.tsx`);
      const cssPath = join(root, "src", "boxspec", "generated", `${screenId}.layout.module.css`);
      await writeFile(layoutPath, userLayout, "utf8");
      const firstInspection = await runtime.desktop.inspectSourceDrift({ projectId });
      const unitDrift = firstInspection.find((item) => item.paths.includes(`src/boxspec/generated/${screenId}.layout.tsx`));
      assert.ok(unitDrift);

      await writeFile(cssPath, laterCss, "utf8");
      await assert.rejects(
        runtime.desktop.resolveSourceDrift({ projectId, driftId: unitDrift.driftId, resolution: "restore-contract" }),
        (error) => error?.code === "APPLY_CONFLICT",
      );
      assert.equal(await readFile(layoutPath, "utf8"), userLayout);
      assert.equal(await readFile(cssPath, "utf8"), laterCss);

      const freshInspection = await runtime.desktop.inspectSourceDrift({ projectId });
      const freshUnit = freshInspection.find((item) => item.paths.includes(`src/boxspec/generated/${screenId}.layout.tsx`));
      assert.ok(freshUnit);
      const manifestPath = join(root, ".boxspec", "generated-manifest.json");
      const manifestBytes = await readFile(manifestPath, "utf8");
      await writeFile(manifestPath, `${JSON.stringify(JSON.parse(manifestBytes), null, 2)}\n`, "utf8");
      await assert.rejects(
        runtime.desktop.resolveSourceDrift({ projectId, driftId: freshUnit.driftId, resolution: "unmanage" }),
        (error) => error?.code === "APPLY_CONFLICT",
      );
      await writeFile(manifestPath, manifestBytes, "utf8");
      const reboundInspection = await runtime.desktop.inspectSourceDrift({ projectId });
      const reboundUnit = reboundInspection.find((item) => item.paths.includes(`src/boxspec/generated/${screenId}.layout.tsx`));
      assert.ok(reboundUnit);
      await runtime.desktop.resolveSourceDrift({ projectId, driftId: reboundUnit.driftId, resolution: "unmanage" });
    } finally {
      await runtime.close();
    }

    runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    try {
      const layoutPath = join(root, "src", "boxspec", "generated", `${screenId}.layout.tsx`);
      const cssPath = join(root, "src", "boxspec", "generated", `${screenId}.layout.module.css`);
      await runtime.desktop.saveProject({ projectId });
      assert.equal(await readFile(layoutPath, "utf8"), userLayout);
      assert.equal(await readFile(cssPath, "utf8"), laterCss);

      const approvedBefore = (await runtime.desktop.getEditorState({ projectId, screenId })).contract;
      const contractPath = join(root, ".boxspec", "screens", `${screenId}.contract.json`);
      await writeFile(contractPath, `${JSON.stringify({ ...approvedBefore, name: "External draft only" })}\n`, "utf8");
      const contractInspection = await runtime.desktop.inspectSourceDrift({ projectId });
      const contractDrift = contractInspection.find((item) => item.paths.includes(`.boxspec/screens/${screenId}.contract.json`));
      assert.ok(contractDrift);
      await writeFile(contractPath, `${JSON.stringify({ ...approvedBefore, name: "Changed after inspection" })}\n`, "utf8");
      await assert.rejects(
        runtime.desktop.resolveSourceDrift({ projectId, driftId: contractDrift.driftId, resolution: "propose-contract" }),
        (error) => error?.code === "APPLY_CONFLICT",
      );
      assert.equal((await runtime.desktop.listLayoutDrafts({ projectId })).some((item) => item.reason.includes("Source drift")), false);
      await writeFile(contractPath, `${JSON.stringify({ ...approvedBefore, name: "External draft only" })}\n`, "utf8");
      const reboundContractInspection = await runtime.desktop.inspectSourceDrift({ projectId });
      const reboundContractDrift = reboundContractInspection.find((item) => item.paths.includes(`.boxspec/screens/${screenId}.contract.json`));
      assert.ok(reboundContractDrift);
      await runtime.desktop.resolveSourceDrift({ projectId, driftId: reboundContractDrift.driftId, resolution: "propose-contract" });
      assert.equal((await runtime.desktop.getEditorState({ projectId, screenId })).contract.name, approvedBefore.name);
      const sourceDraft = (await runtime.desktop.listLayoutDrafts({ projectId })).find((item) => item.reason.includes("Source drift"));
      assert.ok(sourceDraft);
      assert.equal((await runtime.desktop.openLayoutDraft({ projectId, proposalId: sourceDraft.proposalId })).contract.name, "External draft only");
      assert.equal(JSON.parse(await readFile(contractPath, "utf8")).name, approvedBefore.name);
    } finally {
      await runtime.close();
    }
  });
});
