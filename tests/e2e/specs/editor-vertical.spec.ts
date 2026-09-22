import { expect, test, type ElectronApplication, type Page } from "playwright/test";
import {
  artifactsRoot,
  candidateProjectRoot,
  callExternalMcpTool,
  callPackagedMcpTool,
  dataDir,
  launchDesktop,
  launchPackagedDesktop,
  packagedProfileRoot,
  prepareIsolatedRun,
  projectRoot,
  saveRendererLog,
  screenshot,
  selectProjectDirectory,
  setWindowSize,
} from "../support/electron.js";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let rendererLog: string[];
let running = false;
let campaignRevision = 0;
const campaignName = "헤더-20";

async function start(): Promise<void> {
  ({ app, page, rendererLog } = await launchDesktop());
  running = true;
  await expect(page.getByText(/Starting BoxSpec/)).toBeHidden({ timeout: 15_000 });
}

async function startPackaged(): Promise<void> {
  ({ app, page, rendererLog } = await launchPackagedDesktop());
  running = true;
  await expect(page.getByText(/Starting BoxSpec/)).toBeHidden({ timeout: 30_000 });
}

async function stop(logName: string): Promise<void> {
  await saveRendererLog(rendererLog, logName);
  await app.close();
  running = false;
}

async function currentRevision(): Promise<number> {
  const text = await page.locator(".revision").innerText();
  const match = /Revision\s+(\d+)/.exec(text);
  if (!match) throw new Error(`Revision is not numeric: ${text}`);
  return Number(match[1]);
}

async function waitForRevisionAfter(previous: number): Promise<number> {
  await expect.poll(currentRevision).toBeGreaterThan(previous);
  return currentRevision();
}

interface ScreenContractSnapshot {
  projectId: string;
  screenId: string;
  revision: number;
  designSystem: { id: string; revision: number; tokens: Record<string, unknown> };
  nodes: Array<{ id: string; parentId: string | null; order: number; layout: unknown; placement: unknown; locks: unknown[] }>;
}

async function readPersistedScreen(): Promise<ScreenContractSnapshot> {
  return page.evaluate(async () => {
    type Result<T> = { ok: true; data: T } | { ok: false; error: unknown };
    interface Api {
      bootstrap(): Promise<Result<{ projects: Array<{ projectId: string; name: string }> }>>;
      openProject(input: { projectId: string }): Promise<Result<{ screens: Array<{ screenId: string }> }>>;
      openScreen(input: { projectId: string; screenId: string }): Promise<Result<ScreenContractSnapshot>>;
    }
    const api = (window as unknown as { boxspec: Api }).boxspec;
    const boot = await api.bootstrap();
    if (!boot.ok) throw new Error(JSON.stringify(boot));
    const project = boot.data.projects.find((item) => item.name === "E2E Dashboard");
    if (!project) throw new Error("E2E project is missing");
    const opened = await api.openProject({ projectId: project.projectId });
    if (!opened.ok || !opened.data.screens[0]) throw new Error(JSON.stringify(opened));
    const editor = await api.openScreen({ projectId: project.projectId, screenId: opened.data.screens[0].screenId });
    if (!editor.ok) throw new Error(JSON.stringify(editor));
    return editor.data;
  });
}

function structuralSnapshot(contract: ScreenContractSnapshot): unknown {
  return contract.nodes.map((node) => ({ id: node.id, parentId: node.parentId, order: node.order, layout: node.layout, placement: node.placement, locks: node.locks }));
}

async function findFile(root: string, fileName: string, parentName?: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName && (!parentName || root.endsWith(`\\${parentName}`))) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, fileName, parentName).catch(() => "");
      if (found) return found;
    }
  }
  throw new Error(`Could not find ${fileName} under ${root}`);
}

test.beforeAll(async () => {
  await prepareIsolatedRun();
});

test.afterEach(async ({}, testInfo) => {
  if (running) {
    try {
      if (testInfo.status !== testInfo.expectedStatus) await screenshot(page, `failure-${testInfo.title.replaceAll(/[^a-z0-9]+/gi, "-")}.png`);
    } finally {
      await stop(`renderer-${testInfo.title.replaceAll(/[^a-z0-9]+/gi, "-")}.log`).catch(() => undefined);
    }
  }
});

test("creates the real dashboard contract and exercises layout, policy, keyboard, and save", async () => {
  await start();
  await expect(page).toHaveTitle("BoxSpec");
  await expect(page.getByText("CONNECTED", { exact: true })).toBeVisible();
  const developmentCapabilities = await page.evaluate(async () => {
    const result = await (window as unknown as { boxspec: { bootstrap(): Promise<{ ok: boolean; data?: { capabilities: { verifier: boolean; reasons?: { verifier?: string } } } }> } }).boxspec.bootstrap();
    if (!result.ok || !result.data) throw new Error(JSON.stringify(result));
    return result.data.capabilities;
  });
  const trustedDevelopmentBundle = await stat(join(artifactsRoot, "../../../build/verification-dev/verification-tools.json")).catch(() => null);
  expect(developmentCapabilities.verifier).toBe(Boolean(trustedDevelopmentBundle));
  if (!trustedDevelopmentBundle) expect(developmentCapabilities.reasons?.verifier).toBe("Trusted verification tools are unavailable in this installation.");
  await screenshot(page, "01-welcome.png");

  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create project" });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel("Project name").fill("E2E Dashboard");
  await selectProjectDirectory(app);
  await createDialog.getByRole("button", { name: /Browse/ }).click();
  await expect(createDialog.getByTestId("project-root")).toHaveValue(projectRoot);
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("button", { name: "Create screen" })).toBeVisible();
  await page.getByRole("button", { name: "Create screen" }).click();
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  await expect(page.locator("[data-node-id='header']")).toBeVisible();

  const shellMetrics = await page.evaluate(() => {
    const left = document.querySelector<HTMLElement>(".left-panel");
    const right = document.querySelector<HTMLElement>(".right-area");
    const body = document.body;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!left || !right || !shell) throw new Error("Three-pane shell is incomplete");
    return {
      leftWidth: left.getBoundingClientRect().width,
      rightWidth: right.getBoundingClientRect().width,
      fontSize: getComputedStyle(body).fontSize,
      backgroundColor: getComputedStyle(shell).backgroundColor,
    };
  });
  expect(shellMetrics.leftWidth).toBe(232);
  expect(shellMetrics.rightWidth).toBe(304);
  expect(shellMetrics.fontSize).toBe("13px");
  expect(shellMetrics.backgroundColor).toBe("rgb(17, 19, 24)");

  const contractMetrics = await page.evaluate(() => {
    const metric = (id: string) => {
      const element = document.querySelector<HTMLElement>(`[data-node-id='${id}']`);
      if (!element) throw new Error(`Missing contract node ${id}`);
      const style = getComputedStyle(element);
      return { width: element.offsetWidth, height: element.offsetHeight, flex: style.flex };
    };
    return { header: metric("header"), sidebar: metric("sidebar"), main: metric("main") };
  });
  expect(contractMetrics.header.height).toBe(64);
  expect(contractMetrics.sidebar.width).toBe(260);
  expect(contractMetrics.main.flex).toContain("1 1");

  await page.locator(".layers button").filter({ hasText: "sidebar" }).click();
  const policy = page.getByLabel("Layout lock");
  await expect(policy).toHaveValue("hard");
  let revision = await currentRevision();
  await policy.selectOption("soft");
  revision = await waitForRevisionAfter(revision);
  await policy.selectOption("free");
  revision = await waitForRevisionAfter(revision);
  await policy.selectOption("hard");
  revision = await waitForRevisionAfter(revision);
  await expect(policy).toHaveValue("hard");

  const name = page.getByLabel("Name");
  await name.fill("사이드바");
  await name.dispatchEvent("compositionstart");
  await name.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(name).toBeFocused();
  expect(await currentRevision()).toBe(revision);
  await name.dispatchEvent("compositionend", { data: "사이드바" });
  await page.keyboard.press("Enter");
  revision = await waitForRevisionAfter(revision);
  await expect(name).not.toBeFocused();

  const revisionBeforeTextShortcut = revision;
  await name.focus();
  await page.keyboard.press("r");
  await expect(page.getByTitle("Select (V)")).toHaveClass(/active/);
  await page.keyboard.press("Escape");
  await expect(name).toHaveValue("사이드바");
  await page.waitForTimeout(250);
  expect(await currentRevision()).toBe(revisionBeforeTextShortcut);
  await page.getByTestId("draft-canvas").focus();
  await page.keyboard.press("r");
  await expect(page.getByTitle("Draw region (R)")).toHaveClass(/active/);
  await page.keyboard.press("v");
  await expect(page.getByTitle("Select (V)")).toHaveClass(/active/);

  const width = page.getByLabel("Width value");
  await width.fill("320");
  revision = await waitForRevisionAfter(revision);
  await page.getByTestId("draft-canvas").focus();
  await page.keyboard.press("Control+z");
  await waitForRevisionAfter(revision);
  await expect(page.getByLabel("Width value")).toHaveValue("260");
  await expect(page.getByTestId("persistence-status")).toHaveText("LOCAL SAVED · SOURCE PENDING");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("persistence-status").filter({ hasText: /^SOURCE SYNCED$/ })).toBeVisible({ timeout: 30_000 });
  await screenshot(page, "02-editor-saved.png");

  const stateText = await readFile(join(dataDir, "runtime-state.json"), "utf8");
  expect(stateText).toContain("E2E Dashboard");
  expect(stateText).toContain(projectRoot.replaceAll("\\", "\\\\"));
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);
});

test("relaunches from isolated persisted state and preserves the saved revision", async () => {
  await start();
  await expect(page.getByText("E2E Dashboard", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  await expect(page.locator(".layers button").filter({ hasText: "사이드바" })).toBeVisible();
  await expect(page.getByTestId("persistence-status").filter({ hasText: /^SOURCE SYNCED$/ })).toBeVisible({ timeout: 30_000 });
  expect(await currentRevision()).toBeGreaterThan(1);
  await screenshot(page, "03-relaunch-persisted.png");

  await setWindowSize(app, 1100, 720);
  await expect.poll(async () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1100, height: 720 });
  await expect(page.locator(".left-panel")).toBeVisible();
  await expect(page.locator(".right-area")).toBeVisible();
  await screenshot(page, "04-minimum-window.png");
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);
});

test("persists twenty consecutive UI edits with bounded undo and redo", async () => {
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  await page.getByTestId("layer-header").click();
  const name = page.getByLabel("Name");
  let revision = await currentRevision();
  const startRevision = revision;
  for (let index = 1; index <= 20; index += 1) {
    await name.fill(`헤더-${index}`);
    await page.keyboard.press("Enter");
    revision = await waitForRevisionAfter(revision);
    await expect(name).toHaveValue(`헤더-${index}`);
  }
  expect(revision).toBe(startRevision + 20);

  await page.getByTestId("draft-canvas").focus();
  for (const expectedName of ["헤더-19", "헤더-18", "헤더-17"]) {
    await page.keyboard.press("Control+z");
    revision = await waitForRevisionAfter(revision);
    await expect(name).toHaveValue(expectedName);
  }
  for (const expectedName of ["헤더-18", "헤더-19", campaignName]) {
    await page.keyboard.press("Control+y");
    revision = await waitForRevisionAfter(revision);
    await expect(name).toHaveValue(expectedName);
  }
  campaignRevision = revision;
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("persistence-status").filter({ hasText: /^SOURCE SYNCED$/ })).toBeVisible({ timeout: 30_000 });
  await screenshot(page, "05-twenty-edits-undo-redo.png");
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);
});

test("relaunches after the edit campaign with the final revision and value", async () => {
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  await page.getByTestId("layer-header").click();
  await expect(page.getByLabel("Name")).toHaveValue(campaignName);
  expect(await currentRevision()).toBe(campaignRevision);
  await expect(page.getByTestId("persistence-status").filter({ hasText: /^SOURCE SYNCED$/ })).toBeVisible();
  await screenshot(page, "06-twenty-edits-relaunch.png");
});

test("shows honest empty review and separates client configuration diagnostics", async () => {
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();

  await page.getByRole("button", { name: /^Review/ }).first().click();
  await expect(page.getByText("No candidates", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Clients", exact: true }).click();
  const wizard = page.getByRole("dialog", { name: "MCP client setup" });
  await expect(wizard).toBeVisible();
  for (const client of ["codex", "claude-code", "opencode"]) {
    await expect(wizard.getByRole("button", { name: new RegExp(`^${client}`) })).toBeVisible();
  }
  await expect(wizard.getByText("Configuration not written · handshake unverified")).toBeVisible();
  for (const client of ["codex", "claude-code", "opencode"]) {
    await wizard.getByRole("button", { name: new RegExp(`^${client}`) }).click();
    await wizard.getByRole("button", { name: "Prepare configuration diff" }).click();
    await expect(wizard.getByLabel("Configuration diff")).toBeVisible();
    await wizard.getByRole("button", { name: "Apply reviewed configuration" }).click();
    await expect(wizard.getByRole("button", { name: new RegExp(`^${client}\\s+Config written`) })).toBeVisible();
    await expect(wizard.getByText("Configuration written · handshake unverified")).toBeVisible();
  }
  await screenshot(page, "07-three-client-config-written.png");
  await wizard.getByRole("button", { name: "Run diagnostic" }).click();
  await expect(wizard.getByText(/handshake unverified/i)).toBeVisible();
  await screenshot(page, "08-client-diagnostic-unverified.png");
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);
});

test("opens an agent-proposed complete layout, accepts a pointer resize, publishes it, and lets the agent reread context", async () => {
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const screenButton = page.locator(".screen-list button").filter({ hasText: "Screen 1" });
  await screenButton.click();
  const seed = await page.evaluate(async () => {
    type Result<T> = { ok: true; data: T } | { ok: false; error: unknown };
    interface Api {
      bootstrap(): Promise<Result<{ projects: Array<{ projectId: string; name: string }> }>>;
      openProject(input: { projectId: string }): Promise<Result<{ screens: Array<{ screenId: string; revision: number }> }>>;
      openScreen(input: { projectId: string; screenId: string }): Promise<Result<Record<string, unknown>>>;
      pairClient(input: { projectId: string; client: "codex" }): Promise<Result<{ profilePath: string }>>;
    }
    const api = (window as unknown as { boxspec: Api }).boxspec;
    const boot = await api.bootstrap();
    if (!boot.ok) throw new Error(JSON.stringify(boot));
    const project = boot.data.projects.find((item) => item.name === "E2E Dashboard");
    if (!project) throw new Error("E2E project is missing");
    const opened = await api.openProject({ projectId: project.projectId });
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    const screen = opened.data.screens[0];
    if (!screen) throw new Error("E2E screen is missing");
    const editor = await api.openScreen({ projectId: project.projectId, screenId: screen.screenId });
    if (!editor.ok) throw new Error(JSON.stringify(editor));
    const paired = await api.pairClient({ projectId: project.projectId, client: "codex" });
    if (!paired.ok) throw new Error(JSON.stringify(paired));
    return { projectId: project.projectId, screenId: screen.screenId, baseRevision: screen.revision, contract: editor.data as unknown as Record<string, unknown> };
  });
  const contract = structuredClone(seed.contract) as { revision: number; nodes: Array<{ id: string; name: string; layout: { height: Record<string, unknown> } }> };
  contract.revision = seed.baseRevision + 1;
  const agentNames: Record<string, string> = { root: "AI Complete Dashboard", header: "AI Header", body: "AI Workspace", sidebar: "AI Navigation", main: "AI Content", search: "AI Search", projects: "AI Project Grid" };
  for (const node of contract.nodes) {
    node.name = agentNames[node.id] ?? node.name;
    if (node.id === "header") node.layout.height = { mode: "fixed", value: 72 };
  }
  const proposal = await callExternalMcpTool(seed.projectId, "boxspec_propose_contract_change", {
    requestId: `e2e-propose-${Date.now()}`,
    projectId: seed.projectId,
    screenId: seed.screenId,
    expectedRevision: seed.baseRevision,
    reason: "Complete agent-authored dashboard layout for pointer editing",
    proposedContractJson: JSON.stringify(contract),
  });
  expect(proposal["status"]).toBe("AWAITING_USER");

  await expect(page.getByText("AI DRAFT r1", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  await expect(page.getByTestId("canvas-node-header")).toContainText("AI Header");
  await expect(page.getByTestId("canvas-node-sidebar")).toContainText("AI Navigation");
  await expect(page.getByTestId("canvas-node-projects")).toContainText("AI Project Grid");
  await screenshot(page, "09-agent-draft-auto-open.png");

  await page.getByTestId("canvas-node-header").click();
  const southHandle = page.getByTestId("resize-header-s");
  await expect(southHandle).toBeVisible();
  const handleBox = await southHandle.boundingBox();
  if (!handleBox) throw new Error("Header south resize handle has no bounding box");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 12, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText("AI DRAFT r2", { exact: true })).toBeVisible();

  await page.getByTestId("canvas-node-search").click();
  await page.getByTestId("canvas-node-projects").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("draft-canvas")).toContainText("2 selected");
  await page.getByTestId("draft-canvas").press("Control+g");
  await expect(page.getByText("AI DRAFT r3", { exact: true })).toBeVisible();
  const group = page.locator("[data-node-id^='group_']");
  await expect(group).toHaveCount(1);
  const groupId = await group.getAttribute("data-node-id");
  expect(groupId).toMatch(/^group_[a-f0-9]+$/);
  await screenshot(page, "10-agent-draft-pointer-edited.png");

  await page.getByTestId("implement-layout").click();
  const handoff = page.getByRole("status").filter({ hasText: "Layout sent for implementation" });
  await expect(handoff).toContainText("AWAITING_AGENT");
  const targetRevision = seed.baseRevision + 1;
  await expect(handoff).toContainText(`Revision ${targetRevision}`);
  await expect(page.getByText(`Revision ${targetRevision}`, { exact: true })).toBeVisible();
  await screenshot(page, "11-layout-published-handoff.png");
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);

  const context = await callExternalMcpTool(seed.projectId, "boxspec_get_context", {
    projectId: seed.projectId,
    screenId: seed.screenId,
    expectedRevision: targetRevision,
    nodeIds: contract.nodes.map((node) => node.id),
  });
  expect(context["revision"]).toBe(targetRevision);
  expect(typeof context["contextHash"]).toBe("string");
  const slice = JSON.parse(String(context["contractSliceJson"])) as { includedNodes: Array<{ id: string; name: string; parentId: string | null; layout: { height: { value?: number } } }> };
  const header = slice.includedNodes.find((node) => node.id === "header");
  expect(header?.name).toBe("AI Header");
  expect(header?.layout.height.value).toBeGreaterThan(72);
  const rereadGroup = slice.includedNodes.find((node) => node.id === groupId);
  expect(rereadGroup?.name).toBe("Group");
  expect(slice.includedNodes.find((node) => node.id === "search")?.parentId).toBe(groupId);
  expect(slice.includedNodes.find((node) => node.id === "projects")?.parentId).toBe(groupId);

  await stop("renderer-agent-draft-publish.log");
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  expect(await currentRevision()).toBe(targetRevision);
  await expect(page.getByTestId("canvas-node-header")).toContainText("AI Header");
  await expect(page.getByTestId("canvas-node-header")).toContainText(/91\s*×|×\s*91/);
  await screenshot(page, "12-layout-published-relaunch.png");
});

test("filters and explicitly applies a design theme without changing layout, then persists it", async () => {
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  const before = await readPersistedScreen();
  const beforeColors = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-node-id='root']");
    const surface = document.querySelector<HTMLElement>(".draft-canvas-surface");
    if (!root || !surface) throw new Error("Canvas theme targets are missing");
    return { rootBackground: getComputedStyle(root).backgroundColor, rootColor: getComputedStyle(root).color, surfaceBackground: getComputedStyle(surface).backgroundColor };
  });

  await page.getByTestId("theme-gallery-open").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("theme-gallery")).toBeHidden();
  await page.getByTestId("theme-gallery-open").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible();

  const target = await page.evaluate(async (projectId) => {
    type Theme = { id: string; name: string; mode: "light" | "dark" | "mixed"; style: string };
    type Result = { ok: true; data: Theme[] } | { ok: false; error: unknown };
    const api = (window as unknown as { boxspec: { listThemes(input: { projectId: string }): Promise<Result> } }).boxspec;
    const result = await api.listThemes({ projectId });
    if (!result.ok || !result.data[0]) throw new Error(JSON.stringify(result));
    return result.data.find((theme) => theme.id !== "ds_default") ?? result.data[0];
  }, before.projectId);
  await page.getByTestId("theme-search").fill(target.name);
  await page.getByTestId("theme-mode-filter").getByRole("button", { name: new RegExp(`^${target.mode}$`, "i") }).click();
  await page.getByTestId("theme-style-filter").selectOption({ label: target.style });
  const targetCard = page.getByTestId(`theme-card-${target.id}`);
  await expect(targetCard).toBeVisible();
  await targetCard.click();
  await expect(targetCard).toHaveAttribute("aria-pressed", "true");

  await setWindowSize(app, 1100, 720);
  await expect.poll(async () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1100, height: 720 });
  const galleryBounds = await page.getByTestId("theme-gallery").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(galleryBounds.left).toBeGreaterThanOrEqual(0);
  expect(galleryBounds.top).toBeGreaterThanOrEqual(0);
  expect(galleryBounds.right).toBeLessThanOrEqual(galleryBounds.viewportWidth);
  expect(galleryBounds.bottom).toBeLessThanOrEqual(galleryBounds.viewportHeight);
  await screenshot(page, "13-theme-gallery-filtered.png");

  await page.getByTestId("theme-apply").click();
  const appliedRevision = await waitForRevisionAfter(before.revision);
  const appliedDesignSystemId = `theme_${target.id}`;
  expect(appliedRevision).toBe(before.revision + 1);
  await expect(page.getByTestId("persistence-status")).toHaveText("LOCAL SAVED · SOURCE PENDING");
  const after = await readPersistedScreen();
  expect(after.designSystem.id).toBe(appliedDesignSystemId);
  expect(after.designSystem.revision).toBeGreaterThan(before.designSystem.revision);
  expect(after.designSystem.tokens).not.toEqual(before.designSystem.tokens);
  expect(structuralSnapshot(after)).toEqual(structuralSnapshot(before));
  const afterColors = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-node-id='root']");
    const surface = document.querySelector<HTMLElement>(".draft-canvas-surface");
    if (!root || !surface) throw new Error("Canvas theme targets are missing");
    return { rootBackground: getComputedStyle(root).backgroundColor, rootColor: getComputedStyle(root).color, surfaceBackground: getComputedStyle(surface).backgroundColor };
  });
  expect(afterColors).not.toEqual(beforeColors);
  await page.evaluate(async ({ projectId }) => {
    type Result = { ok: true; data: unknown } | { ok: false; error: unknown };
    const api = (window as unknown as { boxspec: { pairClient(input: { projectId: string; client: "codex" }): Promise<Result> } }).boxspec;
    const paired = await api.pairClient({ projectId, client: "codex" });
    if (!paired.ok) throw new Error(JSON.stringify(paired));
  }, { projectId: after.projectId });
  const themeContext = await callExternalMcpTool(after.projectId, "boxspec_get_context", {
    projectId: after.projectId,
    screenId: after.screenId,
    expectedRevision: after.revision,
    nodeIds: after.nodes.map((node) => node.id),
  }, "theme-boxspec-get-context");
  expect(themeContext["revision"]).toBe(after.revision);
  const contextDesignSystem = JSON.parse(String(themeContext["designSystemJson"])) as { id: string; tokens: Record<string, unknown> };
  expect(contextDesignSystem.id).toBe(appliedDesignSystemId);
  expect(contextDesignSystem.tokens).toEqual(after.designSystem.tokens);
  await screenshot(page, "14-theme-applied.png");
  await page.getByTestId("theme-close").click();
  await page.getByTestId("draft-canvas").focus();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("persistence-status").filter({ hasText: /^SOURCE SYNCED$/ })).toBeVisible({ timeout: 30_000 });

  await stop("renderer-theme-gallery.log");
  await start();
  await page.getByText("E2E Dashboard", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".screen-list button").filter({ hasText: "Screen 1" }).click();
  const reopened = await readPersistedScreen();
  expect(reopened.revision).toBe(appliedRevision);
  expect(reopened.designSystem.id).toBe(appliedDesignSystemId);
  expect(reopened.designSystem.tokens).toEqual(after.designSystem.tokens);
  expect(structuralSnapshot(reopened)).toEqual(structuralSnapshot(before));
  await screenshot(page, "15-theme-relaunch-persisted.png");
});

test("verifies a packaged candidate with trusted tools, reviews it, and applies exact bytes once", async () => {
  test.setTimeout(300_000);
  await startPackaged();
  await expect(page).toHaveTitle("BoxSpec");
  await expect(page.getByText("CONNECTED", { exact: true })).toBeVisible();
  const packagedCapabilities = await page.evaluate(async () => {
    const result = await (window as unknown as { boxspec: { bootstrap(): Promise<{ ok: boolean; data?: { capabilities: { verifier: boolean; review: boolean; apply: boolean } } }> } }).boxspec.bootstrap();
    if (!result.ok || !result.data) throw new Error(JSON.stringify(result));
    return result.data.capabilities;
  });
  expect(packagedCapabilities).toMatchObject({ verifier: true, review: true, apply: true });

  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create project" });
  await createDialog.getByLabel("Project name").fill("Candidate Apply E2E");
  await selectProjectDirectory(app, candidateProjectRoot);
  await createDialog.getByRole("button", { name: /Browse/ }).click();
  await expect(createDialog.getByTestId("project-root")).toHaveValue(candidateProjectRoot);
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Create screen" }).click();
  await expect(page.getByTestId("draft-canvas")).toBeVisible();

  const seed = await page.evaluate(async () => {
    type Result<T> = { ok: true; data: T } | { ok: false; error: unknown };
    interface Api {
      bootstrap(): Promise<Result<{ projects: Array<{ projectId: string; name: string }> }>>;
      openProject(input: { projectId: string }): Promise<Result<{ screens: Array<{ screenId: string; revision: number }> }>>;
      pairClient(input: { projectId: string; client: "codex" }): Promise<Result<{ profilePath: string }>>;
    }
    const api = (window as unknown as { boxspec: Api }).boxspec;
    const boot = await api.bootstrap();
    if (!boot.ok) throw new Error(JSON.stringify(boot));
    const project = boot.data.projects.find((item) => item.name === "Candidate Apply E2E");
    if (!project) throw new Error("Candidate project is missing");
    const opened = await api.openProject({ projectId: project.projectId });
    if (!opened.ok || !opened.data.screens[0]) throw new Error(JSON.stringify(opened));
    const paired = await api.pairClient({ projectId: project.projectId, client: "codex" });
    if (!paired.ok) throw new Error(JSON.stringify(paired));
    return { projectId: project.projectId, screenId: opened.data.screens[0].screenId, revision: opened.data.screens[0].revision, profilePath: paired.data.profilePath };
  });
  expect(seed.profilePath).toContain(seed.projectId);

  const requestSuffix = Date.now().toString(36);
  const markerRelativePath = "src/boxspec/slots/ProjectList.tsx";
  const markerBytes = `export const boxspecCandidateMarker = "verified-native-apply-${requestSuffix}" as const;\n`;
  const started = await callPackagedMcpTool(seed.projectId, "boxspec_start_task", {
    requestId: `start-${requestSuffix}`,
    projectId: seed.projectId,
    screenId: seed.screenId,
    expectedRevision: seed.revision,
    scopeNodeIds: ["projects"],
    objective: "Add a deterministic candidate marker through the trusted verification and native apply path.",
    executionProfileId: "managed-react-vite-p1",
  }, "candidate-start-task");
  expect(started["state"]).toBe("READY");
  expect(started["baseContractRevision"]).toBe(seed.revision);
  const taskId = String(started["taskId"]);

  const patched = await callPackagedMcpTool(seed.projectId, "boxspec_propose_patch", {
    requestId: `patch-${requestSuffix}`,
    taskId,
    expectedRevision: seed.revision,
    files: [{ path: markerRelativePath, operation: "upsert", content: markerBytes }],
  }, "candidate-propose-patch");
  expect(patched["changedPaths"]).toContain(markerRelativePath);
  expect(String(patched["stagingManifestHash"])).toMatch(/^[a-f0-9]{64}$/);

  const submitted = await callPackagedMcpTool(seed.projectId, "boxspec_submit_candidate", {
    requestId: `submit-${requestSuffix}`,
    taskId,
    expectedRevision: seed.revision,
    summary: "Deterministic E2E candidate for trusted packaged verification and native apply.",
    layoutOverrides: [],
  }, "candidate-submit");
  const candidateId = String(submitted["candidateId"]);
  for (const field of ["treeHash", "contractHash", "effectiveContractHash", "layoutOverridesHash"] as const) {
    expect(String(submitted[field])).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(submitted["changedPaths"]).toContain(markerRelativePath);

  const verified = await callPackagedMcpTool(seed.projectId, "boxspec_verify_candidate", {
    requestId: `verify-${requestSuffix}`,
    taskId,
    candidateId,
    verificationProfileId: "managed-react-vite-p1",
  }, "candidate-verify");
  expect(verified).toMatchObject({ taskId, candidateId, state: "VERIFYING" });
  const task = await callPackagedMcpTool(seed.projectId, "boxspec_get_task", { taskId }, "candidate-get-task");
  const reportId = String(task["reportId"]);
  expect(reportId).toMatch(/^[A-Za-z][A-Za-z0-9_-]+$/);
  const report = await callPackagedMcpTool(seed.projectId, "boxspec_get_report", { reportId }, "candidate-get-report");
  expect(report).toMatchObject({ reportId, candidateId, status: "PASS" });
  expect(report["treeHash"]).toBe(submitted["treeHash"]);
  expect(report["contractHash"]).toBe(submitted["contractHash"]);
  expect(report["effectiveContractHash"]).toBe(submitted["effectiveContractHash"]);
  expect(report["layoutOverridesHash"]).toBe(submitted["layoutOverridesHash"]);
  const checks = report["checks"] as Array<{ checkId: string; status: string }>;
  expect(checks.map((check) => check.checkId).sort()).toEqual(["build", "integrity", "interactions", "layout", "policy", "schema", "types"]);
  expect(checks.every((check) => check.status === "PASS")).toBe(true);

  const requested = await callPackagedMcpTool(seed.projectId, "boxspec_request_review", {
    requestId: `review-${requestSuffix}`,
    taskId,
    candidateId,
    reportId,
  }, "candidate-request-review");
  expect(requested).toMatchObject({ taskId, candidateId, state: "PENDING_APPROVAL" });

  await page.getByTestId("review-open").click();
  const reviewRow = page.locator(".review-row").filter({ hasText: candidateId });
  await expect(reviewRow).toBeVisible({ timeout: 15_000 });
  await reviewRow.click();
  const reviewPanel = page.getByRole("complementary", { name: "Candidate review" });
  await expect(reviewPanel).toContainText(candidateId);
  await expect(reviewPanel).toContainText(reportId);
  await expect(reviewPanel.locator(".check-row")).toHaveCount(checks.length);
  await expect(reviewPanel.locator(".check-row .status-pass")).toHaveCount(checks.length);
  const displayedTreeHash = await reviewPanel.getByText(String(submitted["treeHash"]).slice(0, 12), { exact: true }).getAttribute("title");
  expect(displayedTreeHash).toBe(submitted["treeHash"]);
  await screenshot(page, "16-candidate-review-pass.png");

  await reviewPanel.getByRole("button", { name: "Approve and apply", exact: true }).click();
  const markerPath = join(candidateProjectRoot, ...markerRelativePath.split("/"));
  await expect.poll(async () => (await stat(markerPath).catch(() => null))?.isFile() ?? false, { timeout: 30_000 }).toBe(true);
  expect(await readFile(markerPath, "utf8")).toBe(markerBytes);
  expect(createHash("sha256").update(await readFile(markerPath)).digest("hex")).toBe(createHash("sha256").update(markerBytes).digest("hex"));
  await expect(reviewPanel).toBeHidden();
  await expect(reviewRow).toContainText("STALE");

  const reviewTokenPath = await findFile(packagedProfileRoot, `${candidateId}.json`, "reviews");
  const reviewToken = JSON.parse(await readFile(reviewTokenPath, "utf8")) as { candidateId?: string; nonceHash?: string; consumedAt?: string };
  expect(reviewToken).toMatchObject({ candidateId });
  expect(reviewToken.nonceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(new Date(String(reviewToken.consumedAt)).getTime()).toBeGreaterThan(0);
  const approvalFiles = (await readdir(join(reviewTokenPath, "..", "..", "approvals")).catch(() => [])) as string[];
  expect(approvalFiles.length).toBeGreaterThanOrEqual(1);
  const approvalRecords = await Promise.all(approvalFiles.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(reviewTokenPath, "..", "..", "approvals", name), "utf8")) as Record<string, unknown>));
  const approval = approvalRecords.find((item) => item["candidateId"] === candidateId);
  expect(approval?.["reportId"]).toBe(reportId);
  expect(approval?.["treeHash"]).toBe(submitted["treeHash"]);
  expect(new Date(String(approval?.["consumedAt"])).getTime()).toBeGreaterThan(0);

  const gitStatus = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: candidateProjectRoot, encoding: "utf8" });
  expect(gitStatus.status).toBe(0);
  expect(gitStatus.stdout).toContain("src/boxspec/slots/ProjectList.tsx");
  await writeFile(join(artifactsRoot, "candidate-apply-evidence.json"), `${JSON.stringify({ seed, started, patched, submitted, verified, task, report, requested, reviewToken: { ...reviewToken, nonceHash: reviewToken.nonceHash }, approval, markerRelativePath, markerSha256: createHash("sha256").update(markerBytes).digest("hex"), gitStatus: gitStatus.stdout }, null, 2)}\n`, "utf8");
  await writeFile(join(artifactsRoot, "candidate-git-status.txt"), gitStatus.stdout, "utf8");
  await screenshot(page, "17-candidate-native-apply.png");
  expect(rendererLog.filter((line) => /pageerror|console\.error/.test(line))).toEqual([]);
});

test.afterAll(async () => {
  // This marker makes it obvious that all evidence is test-owned and where state lived.
  await readFile(join(artifactsRoot, "run.json"), "utf8");
});
