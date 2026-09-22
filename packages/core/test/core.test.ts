import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoxSpecCore,
  CoreError,
  applyLayoutOverrides,
  canonicalJson,
  compileReactShell,
  hashContract,
  inspectContractDocument,
  migrateContractFile,
  parseLayoutContract,
  validateLayoutContract,
  type LayoutContract,
} from "../src/index.js";

const directories: string[] = [];
function temporaryDirectory(): string { const path = mkdtempSync(join(tmpdir(), "boxspec-core-")); directories.push(path); return path; }
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });
function example(): LayoutContract {
  const value = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../examples/dashboard.contract.json"), "utf8")) as unknown;
  return parseLayoutContract(value);
}
function clone<T>(value: T): T { return structuredClone(value); }

describe("contract validation and canonicalization", () => {
  it("accepts the production dashboard and produces a stable hash", () => {
    const contract = example();
    expect(validateLayoutContract(contract)).toMatchObject({ ok: true });
    expect(hashContract(contract)).toHaveLength(64);
    expect(hashContract(JSON.parse(canonicalJson(contract)) as LayoutContract)).toBe(hashContract(contract));
  });
  it("uses locale-independent ordinal ordering for Unicode keys", () => {
    expect(canonicalJson({ "한글": 1, "ä": 2, Z: 3, a: 4 })).toBe('{"Z":3,"a":4,"ä":2,"한글":1}');
  });
  it("rejects schema-invalid negative dimensions", () => {
    const contract = clone(example()) as any;
    contract.nodes[0].layout.gap = -1;
    const result = validateLayoutContract(contract);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "SCHEMA_MINIMUM")).toBe(true);
  });
  it("rejects duplicate ids, missing relationships and cycles", () => {
    const duplicate = clone(example()) as any;
    duplicate.nodes[1].id = "root";
    expect(validateLayoutContract(duplicate).diagnostics.some((item) => item.code === "DUPLICATE_NODE_ID")).toBe(true);
    const missing = clone(example()) as any;
    missing.nodes.find((node: any) => node.id === "main").parentId = "absent";
    expect(validateLayoutContract(missing).diagnostics.some((item) => item.code === "PARENT_NOT_FOUND")).toBe(true);
    const missingAssertionNode = clone(example()) as any;
    missingAssertionNode.assertions[0].nodeId = "absent";
    expect(validateLayoutContract(missingAssertionNode).diagnostics.some((item) => item.code === "ASSERTION_NODE_NOT_FOUND")).toBe(true);
    const cycle = clone(example()) as any;
    cycle.nodes.find((node: any) => node.id === "body").parentId = "main";
    expect(validateLayoutContract(cycle).diagnostics.some((item) => item.code === "PARENT_CYCLE")).toBe(true);
  });
  it("rejects overlapping breakpoints and incompatible sizing", () => {
    const overlap = clone(example()) as any;
    overlap.breakpoints[0].maxWidthExclusive = 800;
    expect(validateLayoutContract(overlap).diagnostics.some((item) => item.code === "BREAKPOINT_OVERLAP")).toBe(true);
    const sizing = clone(example()) as any;
    sizing.nodes.find((node: any) => node.id === "body").layout.height = { mode: "hug", min: 0 };
    expect(validateLayoutContract(sizing).diagnostics.some((item) => item.code === "SIZING_CYCLE")).toBe(true);
  });
  it("reports fixed-child constraint conflicts", () => {
    const contract = clone(example()) as any;
    const body = contract.nodes.find((node: any) => node.id === "body");
    body.layout.width = { mode: "fixed", value: 500 };
    const main = contract.nodes.find((node: any) => node.id === "main");
    main.layout.width = { mode: "fixed", value: 300 };
    expect(validateLayoutContract(contract).diagnostics.some((item) => item.code === "CONSTRAINT_CONFLICT")).toBe(true);
  });
});

describe("policy", () => {
  it("blocks the real sidebar 260 to 320 hard mutation", () => {
    expect(() => applyLayoutOverrides(example(), [{ nodeId: "sidebar", path: "/layout/width/value", value: 320 }])).toThrowError(CoreError);
    try { applyLayoutOverrides(example(), [{ nodeId: "sidebar", path: "/layout/width/value", value: 320 }]); }
    catch (error) { expect((error as CoreError).code).toBe("POLICY_VIOLATION"); }
  });
  it("allows free values and enforces explicit soft bounds", () => {
    const free = clone(example()) as any;
    free.nodes.find((node: any) => node.id === "main").locks.push({ path: "/layout/gap", policy: "free" });
    expect(applyLayoutOverrides(parseLayoutContract(free), [{ nodeId: "main", path: "/layout/gap", value: 20 }]).contract.nodes.find((node) => node.id === "main")?.layout.gap).toBe(20);
    const soft = clone(free) as any;
    soft.nodes.find((node: any) => node.id === "main").locks = [{ path: "/layout/gap", policy: "soft", min: 12, max: 20 }];
    expect(() => applyLayoutOverrides(parseLayoutContract(soft), [{ nodeId: "main", path: "/layout/gap", value: 21 }])).toThrowError(CoreError);
    expect(applyLayoutOverrides(parseLayoutContract(soft), [{ nodeId: "main", path: "/layout/gap", value: 12 }]).contract.nodes.find((node) => node.id === "main")?.layout.gap).toBe(12);
  });
  it("blocks an ancestor change that could bypass descendant hard geometry", () => {
    const contract = clone(example()) as any;
    contract.nodes.find((node: any) => node.id === "body").locks.push({ path: "/layout/gap", policy: "free" });
    expect(() => applyLayoutOverrides(parseLayoutContract(contract), [{ nodeId: "body", path: "/layout/gap", value: 10 }])).toThrowError(CoreError);
  });
  it("rejects non-scalar and missing override paths", () => {
    const contract = clone(example()) as any;
    contract.nodes.find((node: any) => node.id === "main").locks.push({ path: "/layout", policy: "free" });
    expect(() => applyLayoutOverrides(parseLayoutContract(contract), [{ nodeId: "main", path: "/layout/width", value: 2 }])).toThrowError(CoreError);
    expect(() => applyLayoutOverrides(parseLayoutContract(contract), [{ nodeId: "main", path: "/layout/missing", value: 2 }])).toThrowError(CoreError);
  });
  it("rejects an agent full replacement that weakens policy and verification", () => {
    const directory = temporaryDirectory();
    const core = BoxSpecCore.open({ databasePath: join(directory, "state.sqlite") });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    const weakened = clone(example()) as any;
    weakened.revision = 2;
    weakened.defaultPolicy.layout = "free";
    weakened.assertions = [];
    weakened.verification.requiredChecks = ["schema"];
    expect(() => core.execute({ type: "replace-contract", projectId: "prj_demo", screenId: "dashboard", contract: parseLayoutContract(weakened), commandId: "attack-1", expectedRevision: 1, actor: { kind: "agent", id: "hostile" }, timestamp: "2026-09-22T00:00:02.000Z" })).toThrowError(CoreError);
    expect(core.getScreen("prj_demo", "dashboard")).toMatchObject({ revision: 1, defaultPolicy: { layout: "hard" } });
    core.close();
  });
  it("rejects an agent full replacement that changes a sizing shape", () => {
    const before = clone(example()) as any;
    before.nodes.find((node: any) => node.id === "sidebar").locks = [{ path: "/layout/width", policy: "free" }];
    const parsedBefore = parseLayoutContract(before);
    const after = clone(parsedBefore) as any;
    after.revision = 2;
    after.nodes.find((node: any) => node.id === "sidebar").layout.width = { mode: "hug", min: 0 };
    const directory = temporaryDirectory(), core = BoxSpecCore.open({ databasePath: join(directory, "state.sqlite") });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: parsedBefore, commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    expect(() => core.execute({ type: "replace-contract", projectId: "prj_demo", screenId: "dashboard", contract: parseLayoutContract(after), commandId: "attack-shape", expectedRevision: 1, actor: { kind: "agent", id: "hostile" }, timestamp: "2026-09-22T00:00:02.000Z" })).toThrowError(CoreError);
    core.close();
  });
});

describe("deterministic React compiler", () => {
  it("emits byte-stable, syntactically valid header/sidebar/main shell", () => {
    const first = compileReactShell(example());
    const second = compileReactShell(example());
    expect(first).toEqual(second);
    const tsx = first.files.find((file) => file.path.endsWith(".tsx"))!.content;
    const css = first.files.find((file) => file.path.endsWith(".css"))!.content;
    expect(tsx).toContain('data-boxspec-node="header"');
    expect(tsx).toContain('data-boxspec-node="sidebar"');
    expect(tsx).toContain('data-boxspec-node="main"');
    expect(css).toContain(".node_header"); expect(css).toContain("height:64px");
    expect(css).toContain(".node_sidebar"); expect(css).toContain("width:260px");
    expect(css).toContain(".node_main"); expect(css).toContain("flex-grow:1");
    const compileDirectory = temporaryDirectory();
    const compileSource = tsx
      .replace('import type { ComponentType } from "react";', "type ComponentType = () => JSX.Element;")
      .replace(/import styles from .*?;/, "const styles: Record<string, string> = {};");
    const sourcePath = join(compileDirectory, "generated.tsx"), declarationsPath = join(compileDirectory, "jsx.d.ts");
    writeFileSync(sourcePath, compileSource);
    writeFileSync(declarationsPath, "declare namespace JSX { interface Element {} interface IntrinsicElements { div: { [key: string]: unknown } } }");
    const compiler = resolve(import.meta.dirname, "../node_modules/typescript/bin/tsc");
    const checked = spawnSync(process.execPath, [compiler, sourcePath, declarationsPath, "--ignoreConfig", "--noEmit", "--jsx", "preserve", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck"], { encoding: "utf8" });
    expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
  });
  it("emits and consumes safe presentation variables without replacing contract geometry", () => {
    const themed = clone(example()) as any;
    themed.designSystem = {
      id: "theme_test",
      revision: 2,
      tokens: {
        ...themed.designSystem.tokens,
        "color.background": { type: "color", value: "#102030" },
        "color.surface": { type: "color", value: "#203040" },
        "color.text": { type: "color", value: "#F0F2F4" },
        "color.accent": { type: "color", value: "#42A5F5" },
        "color.border": { type: "color", value: "#506070" },
        "font.family.body": { type: "font-family", value: "Inter, system-ui, sans-serif" },
        "font.family.display": { type: "font-family", value: "Manrope, system-ui, sans-serif" },
        "radius.medium": { type: "dimension", value: 12 },
        "border.width": { type: "dimension", value: 1 },
      },
    };
    const parsed = parseLayoutContract(themed), first = compileReactShell(parsed), second = compileReactShell(parsed);
    expect(first).toEqual(second);
    expect(first.sourceHash).not.toBe(compileReactShell(example()).sourceHash);
    const css = first.files.find((file) => file.path.endsWith(".css"))!.content;
    expect(css).toContain("--boxspec-color-background:#102030");
    expect(css).toContain("--boxspec-color-surface:#203040");
    expect(css).toContain("--boxspec-font-family-body:Inter, system-ui, sans-serif");
    expect(css).toContain("--boxspec-radius-medium:12px");
    expect(css).toContain("--boxspec-spacing-page:24px");
    expect(css).toContain("background-color:var(--boxspec-color-background)");
    expect(css).toContain("font-family:var(--boxspec-font-family-body)");
    expect(css).toContain(".node_sidebar{display:block;width:260px");
    expect(css).toContain("background-color:var(--boxspec-color-surface);border-radius:var(--boxspec-radius-medium)");
    expect(css).toContain(".node_main{display:flex;flex-direction:column;min-width:0px;flex-grow:1");
    expect(parsed.nodes).toEqual(example().nodes);
    expect(parsed.assertions).toEqual(example().assertions);
  });
  it("rejects supported token injection and never renders unknown token names", () => {
    const hostile = clone(example()) as any;
    hostile.designSystem.tokens["color.background"] = { type: "color", value: "#fff;}body{display:none" };
    expect(() => compileReactShell(hostile)).toThrowError(CoreError);
    const hostileFont = clone(example()) as any;
    hostileFont.designSystem.tokens["font.family.body"] = { type: "font-family", value: "Inter;display:none" };
    expect(() => compileReactShell(hostileFont)).toThrowError(CoreError);
    const unknown = clone(example()) as any;
    unknown.designSystem.tokens["evil;}body{display:none"] = { type: "color", value: "#000000" };
    const css = compileReactShell(unknown).files.find((file) => file.path.endsWith(".css"))!.content;
    expect(css).not.toContain("evil");
    expect(css).not.toContain("body{display:none");
  });
});

describe("SQLite revisions, restart, history and export", () => {
  it("persists a real edit across restart with history and atomic export", () => {
    const directory = temporaryDirectory(), databasePath = join(directory, "state.sqlite"), exportRoot = join(directory, "projects");
    let core = BoxSpecCore.open({ databasePath, exportRoot });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    const result = core.execute({ type: "rename-screen", projectId: "prj_demo", screenId: "dashboard", commandId: "rename-1", expectedRevision: 1, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:02.000Z", name: "Renamed" });
    expect(result.revision).toBe(2);
    expect(core.reconcileScreen("prj_demo", "dashboard").status).toBe("current");
    core.close();
    core = BoxSpecCore.open({ databasePath, exportRoot });
    expect(core.getScreen("prj_demo", "dashboard")).toMatchObject({ name: "Renamed", revision: 2 });
    expect(core.history("prj_demo", "dashboard")).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(exportRoot, "prj_demo", ".boxspec", "screens", "dashboard.contract.json"), "utf8"))).toMatchObject({ revision: 2, name: "Renamed" });
    core.close();
  });
  it("treats external JSON as an import draft and never silently replaces current state", () => {
    const directory = temporaryDirectory(), databasePath = join(directory, "state.sqlite"), exportRoot = join(directory, "projects");
    const core = BoxSpecCore.open({ databasePath, exportRoot });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    const path = join(exportRoot, "prj_demo", ".boxspec", "screens", "dashboard.contract.json");
    const external = { ...clone(example()), name: "External draft" };
    writeFileSync(path, JSON.stringify(external));
    expect(core.reconcileScreen("prj_demo", "dashboard").status).toBe("drift");
    expect(core.importScreenDraft({ path, draftId: "draft-1", importedAt: "2026-09-22T00:00:02.000Z" }).contract.name).toBe("External draft");
    expect(core.getScreen("prj_demo", "dashboard").name).toBe("프로젝트 대시보드");
    writeFileSync(path, "{}");
    expect(() => core.importScreenDraft({ path, draftId: "draft-2", importedAt: "2026-09-22T00:00:03.000Z" })).toThrowError(CoreError);
    core.close();
  });
  it("enforces revision drift and command id idempotency", () => {
    const directory = temporaryDirectory();
    const core = BoxSpecCore.open({ databasePath: join(directory, "state.sqlite") });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    const command = { type: "rename-screen" as const, projectId: "prj_demo", screenId: "dashboard", commandId: "same-1", expectedRevision: 1, actor: { kind: "user" as const, id: "owner" }, timestamp: "2026-09-22T00:00:02.000Z", name: "A" };
    expect(core.execute(command).replayed).toBe(false);
    expect(core.execute(command).replayed).toBe(true);
    expect(() => core.execute({ ...command, name: "B" })).toThrowError(CoreError);
    expect(() => core.execute({ ...command, commandId: "stale-1", name: "C" })).toThrowError(CoreError);
    core.close();
  });
  it("records undo as a new revision", () => {
    const directory = temporaryDirectory();
    const core = BoxSpecCore.open({ databasePath: join(directory, "state.sqlite") });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    core.execute({ type: "rename-screen", projectId: "prj_demo", screenId: "dashboard", commandId: "rename-1", expectedRevision: 1, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:02.000Z", name: "Changed" });
    const undone = core.undo({ projectId: "prj_demo", screenId: "dashboard", commandId: "undo-1", expectedRevision: 2, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:03.000Z" });
    expect(undone.contract).toMatchObject({ name: "프로젝트 대시보드", revision: 3 });
    expect(core.history("prj_demo", "dashboard").at(-1)?.type).toBe("undo");
    const redone = core.redo({ projectId: "prj_demo", screenId: "dashboard", commandId: "redo-1", expectedRevision: 3, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:04.000Z" });
    expect(redone.contract).toMatchObject({ name: "Changed", revision: 4 });
    expect(core.history("prj_demo", "dashboard").at(-1)?.type).toBe("redo");
    core.close();
  });
  it("persists undo and redo stacks across restart", () => {
    const directory = temporaryDirectory(), databasePath = join(directory, "state.sqlite");
    let core = BoxSpecCore.open({ databasePath });
    core.createProject({ projectId: "prj_demo", name: "Demo", createdAt: "2026-09-22T00:00:00.000Z" });
    core.createScreen({ contract: example(), commandId: "create-1", actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:01.000Z" });
    core.execute({ type: "rename-screen", projectId: "prj_demo", screenId: "dashboard", commandId: "rename-1", expectedRevision: 1, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:02.000Z", name: "Changed" });
    core.undo({ projectId: "prj_demo", screenId: "dashboard", commandId: "undo-1", expectedRevision: 2, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:03.000Z" });
    core.close(); core = BoxSpecCore.open({ databasePath });
    expect(core.redo({ projectId: "prj_demo", screenId: "dashboard", commandId: "redo-1", expectedRevision: 3, actor: { kind: "user", id: "owner" }, timestamp: "2026-09-22T00:00:04.000Z" }).contract.name).toBe("Changed");
    core.close();
  });
  it("rejects malformed commands and unknown fields at the runtime boundary", () => {
    const directory = temporaryDirectory();
    const core = BoxSpecCore.open({ databasePath: join(directory, "state.sqlite") });
    expect(() => core.execute({ type: "rename-screen", unexpected: true })).toThrowError(CoreError);
    core.close();
  });
});

describe("versioned read-only open and migration recovery", () => {
  it("opens unsupported schema versions read-only and preserves unknown fields", () => {
    const future = { ...clone(example()), schemaVersion: "2.0.0", futureCapability: { mode: "quantum", untouched: true, precise: 0.123456789, nested: ["e\u0301", { tiny: 0.000000123456789 }] } };
    const inspected = inspectContractDocument(future);
    expect(inspected.status).toBe("read-only");
    if (inspected.status === "read-only") expect(inspected.document.futureCapability).toEqual({ mode: "quantum", untouched: true, precise: 0.123456789, nested: ["e\u0301", { tiny: 0.000000123456789 }] });
    try { parseLayoutContract(future); throw new Error("expected read-only rejection"); }
    catch (error) { expect((error as CoreError).code).toBe("READ_ONLY"); }
  });
  it("backs up, deterministically migrates, validates and publishes a legacy file", () => {
    const directory = temporaryDirectory(), path = join(directory, "legacy.json"), backupPath = join(directory, "legacy.backup.json");
    const legacy = { ...clone(example()), schemaVersion: "0.9.0" };
    const original = JSON.stringify(legacy);
    writeFileSync(path, original);
    const result = migrateContractFile({ path, backupPath, migrations: [{ from: "0.9.0", to: "1.0.0", migrate: (document) => ({ ...document, schemaVersion: "1.0.0" }) }] });
    expect(result.contract.schemaVersion).toBe("1.0.0");
    expect(readFileSync(backupPath, "utf8")).toBe(original);
    expect(parseLayoutContract(JSON.parse(readFileSync(path, "utf8")))).toMatchObject({ schemaVersion: "1.0.0", revision: 1 });
  });
  it("detects nondeterministic migration and restores the original bytes", () => {
    const directory = temporaryDirectory(), path = join(directory, "legacy.json"), backupPath = join(directory, "legacy.backup.json");
    const legacy = { ...clone(example()), schemaVersion: "0.9.0" };
    const original = JSON.stringify(legacy); writeFileSync(path, original);
    let invocation = 0;
    expect(() => migrateContractFile({ path, backupPath, migrations: [{ from: "0.9.0", to: "1.0.0", migrate: (document) => ({ ...document, schemaVersion: "1.0.0", name: `run-${++invocation}` }) }] })).toThrowError(CoreError);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(backupPath, "utf8")).toBe(original);
  });
});
