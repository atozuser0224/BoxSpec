import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BoxSpecCore, canonicalJson, hashContract, parseLayoutContract, type LayoutContract } from "@boxspec/core";
import {
  executeManagedSourceDriftResolution,
  inspectManagedSourceDrift,
  ManagedSourceDriftError,
  planManagedSourceDriftResolution,
  type ManagedFileObservation,
  type ManagedOutputIntent,
  type ManagedOwnershipRecord,
  type SafeManagedWrite,
} from "../src/source-drift-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("managed source drift recovery", () => {
  it("preserves an external contract edit as a validated Core import draft without changing approval", async () => {
    const root = await temporaryRoot();
    const approved = await exampleContract();
    const core = BoxSpecCore.open({ databasePath: join(root, "core.sqlite") });
    try {
    core.createProject({ projectId: approved.projectId, name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: approved, commandId: "create-screen", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    const relativePath = `.boxspec/screens/${approved.screenId}.contract.json`;
    const absolutePath = join(root, ...relativePath.split("/"));
    const desiredContent = `${canonicalJson(approved)}\n`;
    const external = { ...approved, name: "External draft" };
    const externalContent = `${JSON.stringify(external)}\n`;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, externalContent, "utf8");

    const inspection = inspectManagedSourceDrift({
      projectId: approved.projectId,
      manifestHash: hash("manifest"),
      intents: [contractIntent(approved, desiredContent)],
      ownership: [ownership(relativePath, "contract-export", approved.screenId, desiredContent)],
      observations: [await observe(absolutePath, relativePath, "contract-export", approved.screenId)],
    });
    expect(inspection.drifts).toHaveLength(1);
    expect(inspection.drifts[0]).toMatchObject({
      kind: "contract-export",
      contractImportStatus: "valid",
      allowedResolutions: ["propose-contract", "restore-contract"],
    });

    const plan = planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "propose-contract",
      currentManifestHash: hash("manifest"),
      currentObservations: [await observe(absolutePath, relativePath, "contract-export", approved.screenId)],
    });
    expect(plan.action).toBe("import-contract-draft");
    await executeManagedSourceDriftResolution(plan, {
      trustedWrite: async (restore) => {
        expect(restore.writes).toEqual([expect.objectContaining({ expectedBeforeHash: hash(externalContent), contentHash: hash(desiredContent) })]);
        for (const write of restore.writes) await exactCheckedWrite(root, write);
      },
      persistUnmanaged: async () => { throw new Error("unexpected unmanage"); },
      createImportDraft: async (importPlan) => {
        expect(importPlan.expectedObservedHash).toBe(hash(externalContent));
        const imported = core.importScreenDraft({ path: absolutePath, draftId: "external-draft", importedAt: "2026-09-22T00:00:02.000Z" });
        expect(imported.contract.name).toBe("External draft");
        expect(imported.sourceHash).toBe(importPlan.sourceHash);
      },
    });
    expect(core.getScreen(approved.projectId, approved.screenId).name).toBe(approved.name);
    expect(await readFile(absolutePath, "utf8")).toBe(desiredContent);
    } finally {
      core.close();
    }
  });

  it("rejects a resolution when bytes change after inspection", async () => {
    const root = await temporaryRoot();
    const approved = await exampleContract();
    const relativePath = `.boxspec/screens/${approved.screenId}.contract.json`;
    const absolutePath = join(root, ...relativePath.split("/"));
    const desired = `${canonicalJson(approved)}\n`;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, JSON.stringify({ ...approved, name: "First edit" }), "utf8");
    const inspection = inspectManagedSourceDrift({
      projectId: approved.projectId,
      manifestHash: null,
      intents: [contractIntent(approved, desired)],
      ownership: [ownership(relativePath, "contract-export", approved.screenId, desired)],
      observations: [await observe(absolutePath, relativePath, "contract-export", approved.screenId)],
    });
    await writeFile(absolutePath, JSON.stringify({ ...approved, name: "Second edit" }), "utf8");
    expect(() => planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "restore-contract",
      currentManifestHash: null,
      currentObservations: [awaitObservationSync(absolutePath, relativePath, "contract-export", approved.screenId)],
    })).toThrowError(expect.objectContaining({ code: "STALE_INSPECTION" }));
    expect(JSON.parse(await readFile(absolutePath, "utf8"))).toMatchObject({ name: "Second edit" });
  });

  it("rejects a resolution when the managed ownership manifest changes after inspection", async () => {
    const root = await temporaryRoot();
    const screenId = "dashboard";
    const path = "src/boxspec/generated/dashboard.layout.tsx";
    const desired = "export const layout = 1;\n";
    const external = "export const layout = 2;\n";
    const absolutePath = join(root, ...path.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, external, "utf8");
    const observation = await observe(absolutePath, path, "generated", screenId);
    const inspection = inspectManagedSourceDrift({
      projectId: "prj_demo",
      manifestHash: hash("manifest-before"),
      intents: [{ path, kind: "generated", screenId, desiredContent: desired, desiredHash: hash(desired) }],
      ownership: [ownership(path, "generated", screenId, desired)],
      observations: [observation],
    });

    expect(() => planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "restore-contract",
      currentManifestHash: hash("manifest-after"),
      currentObservations: [observation],
    })).toThrowError(expect.objectContaining({ code: "STALE_INSPECTION" }));
    expect(await readFile(absolutePath, "utf8")).toBe(external);
  });

  it("rejects code-to-contract inference and restores an entire generated unit through an injected trusted writer", async () => {
    const root = await temporaryRoot();
    const screenId = "dashboard";
    const paths = ["src/boxspec/generated/dashboard.layout.tsx", "src/boxspec/generated/dashboard.layout.css"];
    const desired = ["export const layout = 1;\n", ".root { display: grid; }\n"];
    const external = ["export const layout = 999;\n", desired[1]!];
    for (let index = 0; index < paths.length; index++) {
      const target = join(root, ...paths[index]!.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, external[index]!, "utf8");
    }
    const intents = paths.map((path, index): ManagedOutputIntent => ({
      path,
      kind: "generated",
      screenId,
      desiredContent: desired[index]!,
      desiredHash: hash(desired[index]!),
    }));
    const owned = paths.map((path, index) => ownership(path, "generated", screenId, desired[index]!));
    const observed = await Promise.all(paths.map((path) => observe(join(root, ...path.split("/")), path, "generated", screenId)));
    const inspection = inspectManagedSourceDrift({ projectId: "prj_demo", manifestHash: hash("manifest"), intents, ownership: owned, observations: observed });
    expect(inspection.drifts[0]?.unitSnapshots).toHaveLength(2);
    expect(() => planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "propose-contract",
      currentManifestHash: hash("manifest"),
      currentObservations: observed,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_RESOLUTION" }));

    const plan = planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "restore-contract",
      currentManifestHash: hash("manifest"),
      currentObservations: observed,
    });
    expect(plan.action).toBe("restore-managed");
    await executeManagedSourceDriftResolution(plan, {
      createImportDraft: async () => { throw new Error("unexpected import"); },
      persistUnmanaged: async () => { throw new Error("unexpected unmanage"); },
      trustedWrite: async (restore) => {
        for (const write of restore.writes) await exactCheckedWrite(root, write);
      },
    });
    for (let index = 0; index < paths.length; index++) {
      expect(await readFile(join(root, ...paths[index]!.split("/")), "utf8")).toBe(desired[index]);
    }
  });

  it("treats clean prior-compiler output as a safe managed migration, not external drift", () => {
    const screenId = "dashboard";
    const path = "src/boxspec/generated/dashboard.layout.tsx";
    const priorCompilerContent = "export const generatorVersion = '1.0.0';\n";
    const currentCompilerContent = "export const generatorVersion = '1.1.0';\n";
    const inspection = inspectManagedSourceDrift({
      projectId: "prj_demo",
      manifestHash: hash("manifest-v1"),
      intents: [{ path, kind: "generated", screenId, desiredContent: currentCompilerContent, desiredHash: hash(currentCompilerContent) }],
      ownership: [ownership(path, "generated", screenId, priorCompilerContent)],
      observations: [{ path, kind: "generated", screenId, exists: true, contentHash: hash(priorCompilerContent), content: priorCompilerContent }],
    });

    expect(inspection.drifts).toEqual([]);
    expect(inspection.safeWrites).toEqual([{
      path,
      kind: "generated",
      expectedBeforeHash: hash(priorCompilerContent),
      content: currentCompilerContent,
      contentHash: hash(currentCompilerContent),
    }]);
  });

  it("persists screen-level unmanage while preserving bytes and suppressing future managed writes", async () => {
    const root = await temporaryRoot();
    const screenId = "dashboard";
    const path = "src/boxspec/generated/dashboard.layout.tsx";
    const desired = "export const layout = 1;\n";
    const userBytes = "export const layout = 'mine';\n";
    const absolutePath = join(root, ...path.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, userBytes, "utf8");
    const intent: ManagedOutputIntent = { path, kind: "generated", screenId, desiredContent: desired, desiredHash: hash(desired) };
    const owned = ownership(path, "generated", screenId, desired);
    const observed = await observe(absolutePath, path, "generated", screenId);
    const inspection = inspectManagedSourceDrift({ projectId: "prj_demo", manifestHash: hash("manifest"), intents: [intent], ownership: [owned], observations: [observed] });
    const plan = planManagedSourceDriftResolution({
      inspection,
      driftId: inspection.drifts[0]!.driftId,
      resolution: "unmanage",
      currentManifestHash: hash("manifest"),
      currentObservations: [observed],
    });
    const unmanaged = new Set<string>();
    await executeManagedSourceDriftResolution(plan, {
      trustedWrite: async () => { throw new Error("unexpected write"); },
      createImportDraft: async () => { throw new Error("unexpected import"); },
      persistUnmanaged: async (unmanage) => { unmanaged.add(unmanage.screenId); },
    });
    expect(await readFile(absolutePath, "utf8")).toBe(userBytes);
    const next = inspectManagedSourceDrift({
      projectId: "prj_demo",
      manifestHash: hash("next-manifest"),
      intents: [intent],
      ownership: [owned],
      observations: [await observe(absolutePath, path, "generated", screenId)],
      unmanagedGeneratedScreenIds: [...unmanaged],
    });
    expect(next.drifts).toEqual([]);
    expect(next.safeWrites).toEqual([]);
    expect(await readFile(absolutePath, "utf8")).toBe(userBytes);
  });

  it("does not report semantic-only contract serialization differences as drift", async () => {
    const root = await temporaryRoot();
    const approved = await exampleContract();
    const path = `.boxspec/screens/${approved.screenId}.contract.json`;
    const absolute = join(root, ...path.split("/"));
    const desired = `${canonicalJson(approved)}\n`;
    const pretty = `${JSON.stringify(approved, null, 2)}\n`;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, pretty, "utf8");
    const inspection = inspectManagedSourceDrift({
      projectId: approved.projectId,
      manifestHash: null,
      intents: [contractIntent(approved, desired)],
      ownership: [ownership(path, "contract-export", approved.screenId, desired)],
      observations: [await observe(absolute, path, "contract-export", approved.screenId)],
    });
    expect(inspection.drifts).toEqual([]);
    expect(inspection.safeWrites).toEqual([expect.objectContaining({ path, expectedBeforeHash: hash(pretty), contentHash: hash(desired) })]);
  });

  it("rejects generated paths outside the exact managed namespace and Windows alias forms", () => {
    const content = "x";
    const base = { projectId: "prj_demo", manifestHash: null, ownership: [], unmanagedGeneratedScreenIds: [] } as const;
    for (const path of ["src/App.tsx", "src/boxspec/generated/file.tsx:stream", "src/boxspec/generated/CON.tsx"]) {
      expect(() => inspectManagedSourceDrift({
        ...base,
        intents: [{ path, kind: "generated", screenId: "dashboard", desiredContent: content, desiredHash: hash(content) }],
        observations: [{ path, kind: "generated", screenId: "dashboard", exists: false, contentHash: null }],
      })).toThrowError(ManagedSourceDriftError);
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boxspec-source-drift-"));
  roots.push(root);
  return root;
}

async function exampleContract(): Promise<LayoutContract> {
  const value = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../examples/dashboard.contract.json"), "utf8")) as unknown;
  return parseLayoutContract(value);
}

function contractIntent(contract: LayoutContract, desiredContent: string): ManagedOutputIntent {
  return {
    path: `.boxspec/screens/${contract.screenId}.contract.json`,
    kind: "contract-export",
    screenId: contract.screenId,
    desiredContent,
    desiredHash: hash(desiredContent),
    baseContractRevision: contract.revision,
    baseContractHash: hashContract(contract),
  };
}

function ownership(path: string, kind: "contract-export" | "generated", screenId: string, content: string): ManagedOwnershipRecord {
  return { path, kind, screenId, contentHash: hash(content) };
}

async function observe(absolutePath: string, path: string, kind: "contract-export" | "generated", screenId: string): Promise<ManagedFileObservation> {
  const content = await readFile(absolutePath, "utf8");
  return { path, kind, screenId, exists: true, contentHash: hash(content), content };
}

function awaitObservationSync(absolutePath: string, path: string, kind: "contract-export" | "generated", screenId: string): ManagedFileObservation {
  const content = requireRead(absolutePath);
  return { path, kind, screenId, exists: true, contentHash: hash(content), content };
}

function requireRead(path: string): string {
  return (process.getBuiltinModule("node:fs") as typeof import("node:fs")).readFileSync(path, "utf8");
}

async function exactCheckedWrite(root: string, write: SafeManagedWrite): Promise<void> {
  const target = join(root, ...write.path.split("/"));
  const current = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  expect(current === null ? null : hash(current)).toBe(write.expectedBeforeHash);
  await writeFile(target, write.content, "utf8");
  expect(hash(await readFile(target, "utf8"))).toBe(write.contentHash);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
