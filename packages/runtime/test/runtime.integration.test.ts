import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { GrantId, ProjectId, RequestId, ScreenId } from "@boxspec/shared/domain";
import { NATIVE_SAFE_FS_MANIFEST } from "@boxspec/shared/native-tools";
import { verifyCandidate, type VerificationProfile } from "@boxspec/verifier";
import { createBoxSpecRuntime, normalizeVerificationCheckStatus } from "../src/index.js";

const temporaryRoots: string[] = [];
const nativeSafeFs = {
  binaryPath: fileURLToPath(new URL(`../../../${NATIVE_SAFE_FS_MANIFEST.developmentRelativePath}`, import.meta.url)),
  expectedSha256: NATIVE_SAFE_FS_MANIFEST.sha256,
} as const;
const activeRuntimes: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(activeRuntimes.splice(0).map((runtime) => runtime.close()));
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("BoxSpec application runtime", () => {
  it("never promotes unexecuted or unsupported checks to PASS", () => {
    expect(normalizeVerificationCheckStatus("NOT_RUN")).toBe("UNVERIFIED");
    expect(normalizeVerificationCheckStatus("UNSUPPORTED")).toBe("UNVERIFIED");
  }, 30_000);

  it("auto-provisions an agent anchor and reports applied launcher configuration", async () => {
    const root = await makeProject();
    const dataDir = await makeDataDir();
    const runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs, mcpLauncherPath: process.execPath, mcpLauncherArgs: ["apps/mcp/dist/index.js"] });
    activeRuntimes.push(runtime);
    const project = await runtime.desktop.createProject({ name: "Test", rootPath: root, target: "web-react" });
    const grant = await runtime.desktop.pairMcpClient({ projectId: project.projectId, principalId: "client-anchor", permissions: ["read"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const selection = okData(await runtime.mcp.invoke({ kind: "mcp-client", principalId: "client-anchor", grantId: grant.grantId }, "boxspec_get_selection", { projectId: project.projectId }));
    expect(selection).toMatchObject({ projectId: project.projectId, revision: 1, nodeIds: ["root"] });
    const [theme] = await runtime.desktop.listThemeGallery({ projectId: project.projectId });
    expect(theme).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
    const anchor = await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: selection["screenId"] as ScreenId });
    const themedAnchor = await runtime.desktop.applyThemeToScreen({
      requestId: "theme-screen-0001" as RequestId,
      projectId: project.projectId,
      screenId: selection["screenId"] as ScreenId,
      themeId: theme!.id,
      expectedRevision: 1,
    });
    expect(themedAnchor.contract.revision).toBe(2);
    expect(themedAnchor.contract.nodes).toEqual(anchor.contract.nodes);
    expect(themedAnchor.contract.designSystem.id).not.toBe(anchor.contract.designSystem.id);
    await expect(runtime.desktop.applyThemeToScreen({
      requestId: "theme-screen-stale" as RequestId,
      projectId: project.projectId,
      screenId: selection["screenId"] as ScreenId,
      themeId: theme!.id,
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(runtime.desktop.applyThemeToScreen({
      requestId: "theme-screen-unknown" as RequestId,
      projectId: project.projectId,
      screenId: selection["screenId"] as ScreenId,
      themeId: "not-a-real-theme" as never,
      expectedRevision: 2,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const themedSelection = okData(await runtime.mcp.invoke({ kind: "mcp-client", principalId: "client-anchor", grantId: grant.grantId }, "boxspec_get_selection", { projectId: project.projectId }));
    expect(themedSelection).toMatchObject({ revision: 2, nodeIds: ["root"] });
    const plan = await runtime.desktop.prepareClientConfig({ projectId: project.projectId, client: "codex", scope: "project" });
    expect(plan.renderedText).toContain(`args = ["apps/mcp/dist/index.js", "--profile", "${project.projectId}"]`);
    await runtime.desktop.applyClientConfig({ projectId: project.projectId, planId: plan.planId, expectedExistingHash: plan.expectedExistingHash });
    expect(await runtime.desktop.getClientSetup({ projectId: project.projectId })).toContainEqual(expect.objectContaining({ client: "codex", configured: true }));
  }, 30_000);

  it("resumes a durable multi-output managed save after a simulated process crash", async () => {
    const root = await makeProject();
    const dataDir = await makeDataDir();
    const runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    activeRuntimes.push(runtime);
    const project = await runtime.desktop.createProject({ name: "Test", rootPath: root, target: "web-react" });
    const firstPath = ".boxspec/screens/crash-a.txt";
    const secondPath = ".boxspec/screens/crash-b.txt";
    const beforeA = "before-a\n", beforeB = "before-b\n", afterA = "after-a\n", afterB = "after-b\n";
    await writeFile(join(root, firstPath), beforeA, "utf8");
    await writeFile(join(root, secondPath), beforeB, "utf8");
    await runtime.close();
    await writeFile(join(root, firstPath), afterA, "utf8");
    const statePath = join(dataDir, "runtime-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state["managedSaveBatches"] = {
      "crash-batch": {
        batchId: "crash-batch",
        projectId: project.projectId,
        createdAt: new Date().toISOString(),
        outputs: [
          { relativePath: firstPath, content: afterA, beforeHash: textHash(beforeA), afterHash: textHash(afterA) },
          { relativePath: secondPath, content: afterB, beforeHash: textHash(beforeB), afterHash: textHash(afterB) },
        ],
      },
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const reopened = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    activeRuntimes.push(reopened);
    expect(await readFile(join(root, firstPath), "utf8")).toBe(afterA);
    expect(await readFile(join(root, secondPath), "utf8")).toBe(afterB);
    const recoveredState = JSON.parse(await readFile(statePath, "utf8")) as { managedSaveBatches: Record<string, unknown> };
    expect(recoveredState.managedSaveBatches).toEqual({});
    await reopened.close();
  }, 30_000);

  it("persists authoring state and rejects a revoked grant before idempotent replay", async () => {
    const root = await makeProject();
    const dataDir = await makeDataDir();
    const runtime = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    activeRuntimes.push(runtime);
    const project = await runtime.desktop.createProject({ name: "Test", rootPath: root, target: "web-react" });
    const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "Dashboard", width: 1440, height: 900 });
    await runtime.desktop.saveProject({ projectId: project.projectId });
    const exportedContractPath = join(root, ".boxspec", "screens", `${screen.screenId}.contract.json`);
    const exportedContractBefore = await readFile(exportedContractPath, "utf8");
    await writeFile(exportedContractPath, `${JSON.stringify(JSON.parse(exportedContractBefore), null, 2)}\n`, "utf8");
    await runtime.desktop.saveProject({ projectId: project.projectId });
    expect(await readFile(exportedContractPath, "utf8")).toBe(exportedContractBefore);
    commit(root, "approved baseline");
    const grant = await runtime.desktop.pairMcpClient({
      projectId: project.projectId,
      principalId: "client-a",
      permissions: ["read", "candidate-write", "verify"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const principal = { kind: "mcp-client" as const, principalId: "client-a", grantId: grant.grantId };
    const proposedContract = (await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract;
    const proposal = {
      requestId: "proposal-0001",
      projectId: project.projectId,
      screenId: screen.screenId,
      expectedRevision: 1,
      reason: "test",
      proposedContractJson: JSON.stringify({ ...proposedContract, revision: 2 }),
    };
    expect((await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", proposal)).ok).toBe(true);
    const [draft] = await runtime.desktop.listLayoutDrafts({ projectId: project.projectId });
    expect(draft).toMatchObject({ baseRevision: 1, targetRevision: 2, draftRevision: 1, status: "AWAITING_USER" });
    const openedDraft = await runtime.desktop.openLayoutDraft({ projectId: project.projectId, proposalId: draft!.proposalId });
    expect((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.revision).toBe(1);
    const editedContract = {
      ...openedDraft.contract,
      nodes: openedDraft.contract.nodes.map((node) => node.id === "header"
        ? { ...node, layout: { ...node.layout, height: { mode: "fixed" as const, value: 72 } } }
        : node),
    };
    const editedDraft = await runtime.desktop.updateLayoutDraft({ requestId: "draft-edit-0001" as RequestId, projectId: project.projectId, proposalId: draft!.proposalId, expectedDraftRevision: 1, contract: editedContract });
    expect(editedDraft.summary).toMatchObject({ draftRevision: 2, status: "USER_EDITING_DRAFT" });
    const [theme] = await runtime.desktop.listThemeGallery({ projectId: project.projectId });
    const themedDraft = await runtime.desktop.applyThemeToLayoutDraft({ requestId: "theme-draft-0001" as RequestId, projectId: project.projectId, proposalId: draft!.proposalId, themeId: theme!.id, expectedDraftRevision: 2 });
    expect(themedDraft.summary.draftRevision).toBe(3);
    expect(themedDraft.contract.revision).toBe(2);
    expect(themedDraft.contract.nodes).toEqual(editedDraft.contract.nodes);
    expect((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.designSystem.id).not.toBe(themedDraft.contract.designSystem.id);
    const handoff = await runtime.desktop.publishLayoutDraft({ requestId: "draft-publish-0001" as RequestId, projectId: project.projectId, proposalId: draft!.proposalId, expectedDraftRevision: 3, expectedBaseRevision: 1, expectedBaseHash: draft!.baseContractHash });
    expect(handoff).toMatchObject({ newRevision: 2, changedNodeIds: ["header"], affectedNodeIds: ["header"], status: "AWAITING_AGENT" });
    expect((await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract.revision).toBe(2);
    const generatedPath = join(root, "src", "boxspec", "generated", `${screen.screenId}.layout.tsx`);
    await writeFile(generatedPath, "// external user edit\n", "utf8");
    await expect(runtime.desktop.saveProject({ projectId: project.projectId })).rejects.toMatchObject({ code: "APPLY_CONFLICT" });
    expect(await readFile(exportedContractPath, "utf8")).toBe(exportedContractBefore);
    expect(await readFile(generatedPath, "utf8")).toBe("// external user edit\n");
    const [generatedDrift] = (await runtime.desktop.inspectSourceDrift({ projectId: project.projectId }))
      .filter((item) => item.paths.includes(`src/boxspec/generated/${screen.screenId}.layout.tsx`));
    expect(generatedDrift).toBeDefined();
    await expect(runtime.desktop.resolveSourceDrift({ projectId: project.projectId, driftId: generatedDrift!.driftId, resolution: "propose-contract" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await runtime.desktop.resolveSourceDrift({ projectId: project.projectId, driftId: generatedDrift!.driftId, resolution: "restore-contract" });
    expect(await readFile(generatedPath, "utf8")).not.toBe("// external user edit\n");
    await runtime.desktop.saveProject({ projectId: project.projectId });
    await writeFile(generatedPath, "// user-owned generated unit\n", "utf8");
    const [unmanageDrift] = (await runtime.desktop.inspectSourceDrift({ projectId: project.projectId }))
      .filter((item) => item.paths.includes(`src/boxspec/generated/${screen.screenId}.layout.tsx`));
    await runtime.desktop.resolveSourceDrift({ projectId: project.projectId, driftId: unmanageDrift!.driftId, resolution: "unmanage" });
    await runtime.desktop.saveProject({ projectId: project.projectId });
    expect(await readFile(generatedPath, "utf8")).toBe("// user-owned generated unit\n");
    const currentContract = (await runtime.desktop.getEditorState({ projectId: project.projectId, screenId: screen.screenId })).contract;
    const externalContract = { ...currentContract, name: "Imported external layout" };
    await writeFile(exportedContractPath, `${JSON.stringify(externalContract)}\n`, "utf8");
    const [contractDrift] = (await runtime.desktop.inspectSourceDrift({ projectId: project.projectId }))
      .filter((item) => item.paths.includes(`.boxspec/screens/${screen.screenId}.contract.json`));
    expect(contractDrift).toBeDefined();
    await runtime.desktop.resolveSourceDrift({ projectId: project.projectId, driftId: contractDrift!.driftId, resolution: "propose-contract" });
    const sourceDraft = (await runtime.desktop.listLayoutDrafts({ projectId: project.projectId }))
      .find((item) => item.status === "AWAITING_USER" && item.reason.includes("Source drift"));
    expect(sourceDraft).toMatchObject({ baseRevision: 2, targetRevision: 3, draftRevision: 1 });
    expect((await runtime.desktop.openLayoutDraft({ projectId: project.projectId, proposalId: sourceDraft!.proposalId })).contract.name).toBe("Imported external layout");
    expect(JSON.parse(await readFile(exportedContractPath, "utf8"))).toMatchObject({ name: currentContract.name, revision: 2 });
    await runtime.desktop.revokeMcpGrant({ projectId: project.projectId, grantId: grant.grantId });
    const replay = await runtime.mcp.invoke(principal, "boxspec_propose_contract_change", proposal);
    expect(replay).toMatchObject({ ok: false, code: "PAIRING_REQUIRED" });
    await runtime.close();

    const reopened = await createBoxSpecRuntime({ dataDir, nativeSafeFs });
    activeRuntimes.push(reopened);
    expect(await reopened.desktop.listProjects()).toHaveLength(1);
    expect(await reopened.desktop.listScreens({ projectId: project.projectId })).toEqual([
      expect.objectContaining({ screenId: screen.screenId, revision: 2 }),
    ]);
    await reopened.desktop.saveProject({ projectId: project.projectId });
    expect(await readFile(generatedPath, "utf8")).toBe("// user-owned generated unit\n");
    await reopened.close();
  }, 120_000);

  it("binds a real frozen candidate to trusted verification and a one-time desktop review nonce", async () => {
    const root = await makeProject();
    const dataDir = await makeDataDir();
    const executable = process.execPath;
    const executableSha256 = createHash("sha256").update(await import("node:fs/promises").then((fs) => fs.readFile(executable))).digest("hex");
    const profile: VerificationProfile = {
      typecheck: { executable, executableSha256, args: ["scripts/typecheck.mjs"], cwd: ".", timeoutMs: 10_000 },
      build: { executable, executableSha256, args: ["scripts/build.mjs", "{outputDir}"], cwd: ".", timeoutMs: 10_000 },
      route: "/index.html",
      interactions: [{ id: "main-visible", fixtureId: "populated", viewportId: "desktop", steps: [{ action: "expect-visible", selector: '[data-boxspec-node="main"]' }] }],
    };
    const runtime = await createBoxSpecRuntime({
      dataDir,
      verificationProfiles: { trusted: profile },
      defaultVerificationProfileId: "trusted",
      fixtures: { empty: {}, populated: {}, loading: {}, error: {}, "long-text": {} },
      approvedExecutionProfileIds: ["approved-local"],
      nativeSafeFs,
      verifier: verifyCandidate,
    });
    activeRuntimes.push(runtime);
    const project = await runtime.desktop.createProject({ name: "Test", rootPath: root, target: "web-react" });
    const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "Dashboard", width: 1440, height: 900 });
    await runtime.desktop.saveProject({ projectId: project.projectId });
    commit(root, "approved baseline");
    const grant = await runtime.desktop.pairMcpClient({ projectId: project.projectId, principalId: "client-a", permissions: ["read", "candidate-write", "verify"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const principal = { kind: "mcp-client" as const, principalId: "client-a", grantId: grant.grantId };
    const started = okData(await runtime.mcp.invoke(principal, "boxspec_start_task", { requestId: "start-0001", projectId: project.projectId, screenId: screen.screenId, expectedRevision: 1, scopeNodeIds: ["main"], objective: "Implement slot", executionProfileId: "approved-local" }));
    const taskId = String(started["taskId"]);
    const patched = await runtime.mcp.invoke(principal, "boxspec_propose_patch", { requestId: "patch-0001", taskId, expectedRevision: 1, files: [{ path: "src/boxspec/slots/ProjectList.tsx", operation: "upsert", content: "export function ProjectList(){return null}\n" }] });
    expect(patched.ok).toBe(true);
    const submitted = okData(await runtime.mcp.invoke(principal, "boxspec_submit_candidate", { requestId: "submit-0001", taskId, expectedRevision: 1, summary: "done", layoutOverrides: [] }));
    const candidateId = String(submitted["candidateId"]);
    const verified = await runtime.mcp.invoke(principal, "boxspec_verify_candidate", { requestId: "verify-0001", taskId, candidateId, verificationProfileId: "trusted" });
    expect(verified.ok).toBe(true);
    const task = okData(await runtime.mcp.invoke(principal, "boxspec_get_task", { taskId }));
    const reportId = String(task["reportId"]);
    const report = okData(await runtime.mcp.invoke(principal, "boxspec_get_report", { reportId }));
    if (report["status"] !== "PASS") throw new Error(`Expected real verifier PASS: ${JSON.stringify(report, null, 2)}`);
    expect((await runtime.mcp.invoke(principal, "boxspec_request_review", { requestId: "review-0001", taskId, candidateId, reportId })).ok).toBe(true);
    const review = await runtime.desktop.inspectReview({ projectId: project.projectId, candidateId: candidateId as never });
    await expect(runtime.desktop.approveAndApply({ projectId: project.projectId, candidateId: candidateId as never, reportId: reportId as never, reviewNonce: review.reviewNonce })).resolves.toMatchObject({ status: "APPLIED" });
    await expect(runtime.desktop.approveAndApply({ projectId: project.projectId, candidateId: candidateId as never, reportId: reportId as never, reviewNonce: review.reviewNonce })).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
    await runtime.close();
  }, 60_000);
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boxspec-runtime-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".boxspec", "screens"), { recursive: true });
  await mkdir(join(root, "src", "boxspec", "generated"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"runtime-fixture","version":"1.0.0"}\n');
  await writeFile(join(root, "package-lock.json"), '{"name":"runtime-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
  await writeFile(join(root, "scripts", "typecheck.mjs"), 'process.exitCode = 0;\n');
  await writeFile(join(root, "scripts", "build.mjs"), `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const output = process.argv[2];
await mkdir(output, { recursive: true });
await writeFile(join(output, "index.html"), \`<!doctype html><style>
html,body{margin:0;width:100%;height:100%}.root{display:flex;flex-direction:column;width:100vw;height:100vh}.header{height:64px;flex-shrink:0}.body{display:flex;flex:1;min-height:0}.sidebar{width:260px;flex-shrink:0}.main{display:flex;flex-direction:column;flex:1;min-width:0;padding:24px;box-sizing:border-box;gap:16px}.search{height:48px}.projects{flex:1}@media(max-width:767px){.sidebar{display:none}}
</style><div class="root" data-boxspec-node="root"><div class="header" data-boxspec-node="header"></div><div class="body" data-boxspec-node="body"><div class="sidebar" data-boxspec-node="sidebar"></div><div class="main" data-boxspec-node="main"><div class="search" data-boxspec-node="search"></div><div class="projects" data-boxspec-node="projects"></div></div></div></div>\`);
`);
  execFileSync("git", ["init"], { cwd: root, windowsHide: true });
  execFileSync("git", ["config", "user.email", "boxspec@example.invalid"], { cwd: root, windowsHide: true });
  execFileSync("git", ["config", "user.name", "BoxSpec Test"], { cwd: root, windowsHide: true });
  commit(root, "initial");
  return root;
}

function commit(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, windowsHide: true });
  execFileSync("git", ["commit", "--allow-empty", "-m", message], { cwd: root, windowsHide: true });
}

function okData(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("data" in result) || typeof result.data !== "object" || result.data === null) throw new Error(`Expected success: ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function makeDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boxspec-runtime-state-"));
  temporaryRoots.push(root);
  return root;
}
