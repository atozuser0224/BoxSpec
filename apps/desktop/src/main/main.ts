import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NATIVE_SAFE_FS_MANIFEST } from "@boxspec/shared/native-tools";
import { IPC, type DesktopResult } from "../common/ipc";
import { RuntimeAdapter } from "./runtime-adapter";
import { validateInput, validateRecoveryInput } from "./validation";
import { resolveTrustedRendererUrl } from "./renderer-url";
import { loadDevelopmentVerificationConfig, loadPackagedVerificationConfig } from "./verification-config";

// main.ts is bundled as CommonJS for Electron; __dirname resolves to dist/main.
const currentDirectory = __dirname;
let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeAdapter | null = null;

function trustedRendererUrl(): URL {
  return resolveTrustedRendererUrl({
    packaged: app.isPackaged,
    ...(process.env.BOXSPEC_RENDERER_URL ? { developmentUrl: process.env.BOXSPEC_RENDERER_URL } : {}),
    rendererHtmlPath: join(currentDirectory, "../renderer/index.html"),
  });
}

function senderIsTrusted(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  const actual = new URL(event.senderFrame.url);
  const expected = trustedRendererUrl();
  return actual.protocol === expected.protocol && actual.origin === expected.origin && (actual.protocol !== "file:" || actual.pathname === expected.pathname);
}

function rejected<T>(): DesktopResult<T> {
  return { ok: false, error: { code: "INVALID_REQUEST", message: "Rejected IPC from an untrusted renderer.", recoverable: false } };
}

function handle<T>(channel: string, fn: (input: unknown) => Promise<DesktopResult<T>>): void {
  ipcMain.handle(channel, async (event, input) => senderIsTrusted(event) ? fn(input) : rejected<T>());
}

type Shape = Record<string, "string" | "number" | "object">;
type CheckedInput<S extends Shape> = { [K in keyof S]: S[K] extends "string" ? string : S[K] extends "number" ? number : Record<string, unknown> };
function checked<S extends Shape, R>(
  shape: S,
  fn: (input: CheckedInput<S>) => Promise<DesktopResult<R>>,
): (input: unknown) => Promise<DesktopResult<R>> {
  return async (input) => {
    const validated = validateInput(input, shape);
    return validated.ok ? fn(validated.data) : validated;
  };
}

function registerIpc(): void {
  handle(IPC.bootstrap, async () => runtime?.bootstrap() ?? rejected());
  handle(IPC.chooseDirectory, async () => {
    if (!mainWindow) return rejected();
    const choice = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"], title: "Select an approved project folder" });
    return { ok: true, data: { path: choice.canceled ? null : choice.filePaths[0] ?? null } };
  });

  handle(IPC.projectCreate, checked({ name: "string", rootPath: "string" }, async (input) => {
    const created = await runtime!.call<unknown>([["desktop", "createProject"]], { ...input, target: "web-react" });
    if (!created.ok) return created;
    const project = created.data as { projectId: string };
    const screens = await runtime!.call<unknown[]>([["desktop", "listScreens"]], { projectId: project.projectId });
    return screens.ok ? { ok: true, data: { project: created.data, screens: screens.data } } : screens;
  }));
  handle(IPC.projectOpen, checked({ projectId: "string" }, async (input) => {
    const project = await runtime!.call<unknown>([["desktop", "openProject"]], input);
    if (!project.ok) return project;
    const screens = await runtime!.call<unknown[]>([["desktop", "listScreens"]], input);
    return screens.ok ? { ok: true, data: { project: project.data, screens: screens.data } } : screens;
  }));
  handle(IPC.screenCreate, checked({ projectId: "string", name: "string" }, async (input) => {
    const created = await runtime!.call<{ screenId: string }>([["desktop", "createScreen"]], { ...input, width: 1440, height: 900 });
    if (!created.ok) return created;
    return editorState(input.projectId, created.data.screenId);
  }));
  handle(IPC.screenOpen, checked({ projectId: "string", screenId: "string" }, (input) => editorState(input.projectId, input.screenId)));
  handle(IPC.screenCommand, checked({ projectId: "string", screenId: "string", expectedRevision: "number", command: "object" }, async (input) => {
    const result = await runtime!.call<unknown>([["desktop", "executeEditorCommand"]], { ...input, requestId: crypto.randomUUID() });
    return result.ok ? flattenEditorState(result.data) : result;
  }));
  handle(IPC.screenUndo, checked({ projectId: "string", screenId: "string", expectedRevision: "number" }, async (input) => {
    const result = await runtime!.call<unknown>([["desktop", "undo"]], { ...input, requestId: crypto.randomUUID() });
    return result.ok ? flattenEditorState(result.data) : result;
  }));
  handle(IPC.screenRedo, checked({ projectId: "string", screenId: "string", expectedRevision: "number" }, async (input) => {
    const result = await runtime!.call<unknown>([["desktop", "redo"]], { ...input, requestId: crypto.randomUUID() });
    return result.ok ? flattenEditorState(result.data) : result;
  }));
  handle(IPC.screenSave, checked({ projectId: "string", screenId: "string", expectedRevision: "number" }, async (input) => {
    const saved = await runtime!.call([["desktop", "saveProject"]], { projectId: input.projectId });
    return saved.ok ? editorState(input.projectId, input.screenId) : saved;
  }));
  handle(IPC.draftList, async (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: { code: "INVALID_REQUEST", message: "Request must be an object.", recoverable: true } };
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== "string" || Object.keys(value).some((key) => key !== "projectId")) return { ok: false, error: { code: "INVALID_REQUEST", message: "Invalid layout draft query.", recoverable: true } };
    return runtime!.call([["desktop", "listLayoutDrafts"]], value);
  });
  handle(IPC.draftOpen, checked({ projectId: "string", proposalId: "string" }, (input) => runtime!.call([["desktop", "openLayoutDraft"]], input)));
  handle(IPC.draftCommand, checked({ projectId: "string", proposalId: "string", expectedDraftRevision: "number", contract: "object" }, (input) => runtime!.call([["desktop", "updateLayoutDraft"]], { ...input, requestId: crypto.randomUUID() })));
  handle(IPC.draftPublish, checked({ projectId: "string", proposalId: "string", expectedDraftRevision: "number", expectedBaseRevision: "number", expectedBaseHash: "string" }, async (input) => {
    const result = await runtime!.call<Record<string, unknown>>([["desktop", "publishLayoutDraft"]], { ...input, requestId: crypto.randomUUID() });
    if (!result.ok) return result;
    const screenId = result.data.screenId;
    if (typeof screenId !== "string") return { ok: false, error: { code: "INTERNAL_ERROR", message: "Published handoff is missing screen identity.", recoverable: false } };
    const editor = await editorState(input.projectId, screenId);
    return editor.ok ? { ok: true, data: { handoff: result.data, editor: editor.data } } : editor;
  }));
  handle(IPC.themeList, checked({ projectId: "string" }, (input) => runtime!.call([["desktop", "listThemeGallery"]], input)));
  handle(IPC.themeApplyDraft, checked({ projectId: "string", proposalId: "string", themeId: "string", expectedDraftRevision: "number" }, (input) =>
    runtime!.call([["desktop", "applyThemeToLayoutDraft"]], { ...input, requestId: crypto.randomUUID() })));
  handle(IPC.themeApplyScreen, checked({ projectId: "string", screenId: "string", themeId: "string", expectedRevision: "number" }, async (input) => {
    const result = await runtime!.call<unknown>([["desktop", "applyThemeToScreen"]], { ...input, requestId: crypto.randomUUID() });
    return result.ok ? flattenEditorState(result.data) : result;
  }));
  handle(IPC.themeOpenSource, checked({ projectId: "string", themeId: "string" }, async (input) => {
    const listed = await runtime!.call<Array<{ id: string; source: { url: string } }>>([["desktop", "listThemeGallery"]], { projectId: input.projectId });
    if (!listed.ok) return listed;
    const sourceUrl = listed.data.find((item) => item.id === input.themeId)?.source.url;
    if (!sourceUrl) return { ok: false, error: { code: "NOT_FOUND", message: "Theme source is not in the trusted catalog.", recoverable: true } };
    let parsed: URL;
    try { parsed = new URL(sourceUrl); }
    catch { return { ok: false, error: { code: "INVALID_REQUEST", message: "Theme source URL is invalid.", recoverable: false } }; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false, error: { code: "INVALID_REQUEST", message: "Theme source URL is not allowed.", recoverable: false } };
    try {
      await shell.openExternal(parsed.href, { activate: true });
      return { ok: true, data: { opened: true as const } };
    } catch (error) {
      return { ok: false, error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), recoverable: true } };
    }
  }));

  handle(IPC.reviewList, checked({ projectId: "string" }, (input) => runtime!.call([["desktop", "listReviewQueue"]], input)));
  handle(IPC.reviewOpen, checked({ projectId: "string", candidateId: "string" }, async (input) => {
    const result = await runtime!.call<unknown>([["desktop", "inspectReview"]], input);
    return result.ok ? normalizeReview(result.data) : result;
  }));
  handle(IPC.reviewApproveApply, checked({ projectId: "string", candidateId: "string", reportId: "string", reviewNonce: "string" }, (input) => runtime!.call([["desktop", "approveAndApply"]], input)));
  handle(IPC.recoveryInspect, checked({ projectId: "string", transactionId: "string" }, (input) => runtime!.call([["desktop", "inspectRecovery"]], input)));
  handle(IPC.recoveryResolve, async (input) => {
    const validated = validateRecoveryInput(input);
    return validated.ok ? runtime!.call([["desktop", "recoverApply"]], validated.data) : validated;
  });
  handle(IPC.driftInspect, checked({ projectId: "string" }, (input) => runtime!.call([["desktop", "inspectSourceDrift"]], input)));
  handle(IPC.driftResolve, checked({ projectId: "string", driftId: "string", resolution: "string" }, (input) => runtime!.call([["desktop", "resolveSourceDrift"]], input)));
  handle(IPC.clientStatus, checked({ projectId: "string" }, (input) => runtime!.call([["desktop", "getClientSetup"]], input)));
  handle(IPC.clientGenerate, checked({ projectId: "string", client: "string", scope: "string" }, (input) => runtime!.call([["desktop", "prepareClientConfig"]], input)));
  handle(IPC.clientApply, async (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: { code: "INVALID_REQUEST", message: "Request must be an object.", recoverable: true } };
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["projectId", "planId", "expectedExistingHash"].includes(key)) || typeof value.projectId !== "string" || typeof value.planId !== "string" || !(typeof value.expectedExistingHash === "string" || value.expectedExistingHash === null)) return { ok: false, error: { code: "INVALID_REQUEST", message: "Invalid client configuration plan binding.", recoverable: true } };
    return runtime!.call([["desktop", "applyClientConfig"]], value);
  });
  handle(IPC.clientDiagnose, checked({ projectId: "string", client: "string" }, (input) => runtime!.call([["desktop", "diagnoseClient"]], input)));
  handle(IPC.clientPair, checked({ projectId: "string", client: "string" }, (input) => runtime!.pairClient(input)));
}

async function editorState(projectId: string, screenId: string) {
  const result = await runtime!.call<unknown>([["desktop", "getEditorState"]], { projectId, screenId });
  return result.ok ? flattenEditorState(result.data) : result;
}

function flattenEditorState(value: unknown): DesktopResult<unknown> {
  if (typeof value !== "object" || value === null || !("contract" in value)) return { ok: false, error: { code: "INTERNAL_ERROR", message: "Runtime returned an invalid editor state.", recoverable: false } };
  return { ok: true, data: (value as { contract: unknown }).contract };
}

function normalizeReview(value: unknown): DesktopResult<unknown> {
  if (typeof value !== "object" || value === null) return { ok: false, error: { code: "INTERNAL_ERROR", message: "Runtime returned an invalid review.", recoverable: false } };
  const review = value as Record<string, unknown>;
  const summary = record(review.summary);
  const report = record(review.report);
  const candidate = record(review.candidate);
  const verification = record(review.verification);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const checksPass = checks.length > 0 && checks.every((check) => record(check).status === "PASS");
  const mismatch =
    !sameString(summary.candidateId, report.candidateId, candidate.candidateId) ||
    !sameString(summary.reportId, report.reportId, verification.reportId) ||
    !sameString(candidate.treeHash, report.treeHash) ||
    !sameString(candidate.baseContractHash, report.contractHash) ||
    !sameString(candidate.effectiveContractHash, report.effectiveContractHash) ||
    !sameString(candidate.layoutOverridesHash, report.layoutOverridesHash) ||
    !sameString(verification.evidenceHash, report.evidenceHash) ||
    summary.status !== "PENDING_APPROVAL" || verification.status !== "PASS" || report.status !== "PASS" || !checksPass;
  if (mismatch || typeof review.reviewNonce !== "string" || review.reviewNonce.length < 16) {
    return { ok: false, error: { code: "VERIFY_FAILED", message: "Review evidence identity does not match the sealed candidate. Approval is disabled.", recoverable: false } };
  }
  const files = Array.isArray(candidate.files) ? candidate.files : [];
  return { ok: true, data: {
    candidateId: summary.candidateId,
    reportId: summary.reportId,
    screenId: typeof summary.screenId === "string" ? summary.screenId : "unknown",
    status: report.status ?? "UNVERIFIED",
    reviewNonce: review.reviewNonce,
    candidateHash: candidate.treeHash,
    contractRevision: typeof review.contractRevision === "number" ? review.contractRevision : 0,
    policyRevision: verification.policyRevision ?? 0,
    contractHash: report.contractHash,
    effectiveContractHash: report.effectiveContractHash,
    layoutOverridesHash: report.layoutOverridesHash,
    changes: Array.isArray(review.changes) ? review.changes : files.map((file) => { const entry = record(file); const path = typeof entry.path === "string" ? entry.path : undefined; return { kind: "code", ...(path ? { path } : {}), summary: `Changed ${path ?? "file"}` }; }),
    checks,
    spatial: Array.isArray(report.comparisons) ? report.comparisons : [],
  } };
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function sameString(...values: unknown[]): boolean { return values.length > 0 && values.every((value) => typeof value === "string" && value.length > 0 && value === values[0]); }

async function createWindow(): Promise<void> {
  const expected = trustedRendererUrl();
  mainWindow = new BrowserWindow({
    minWidth: 1100,
    minHeight: 720,
    width: 1440,
    height: 900,
    backgroundColor: "#111318",
    show: false,
    title: "BoxSpec",
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, destination) => {
    if (destination !== expected.href) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(expected.href);
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  const dataDir = !app.isPackaged && process.env.BOXSPEC_DATA_DIR
    ? process.env.BOXSPEC_DATA_DIR
    : join(app.getPath("userData"), "state");
  const launcher = resolveMcpLauncher();
  const nativeSafeFs = resolveNativeSafeFs();
  const verification = app.isPackaged
    ? await loadPackagedVerificationConfig({ resourcesPath: process.resourcesPath, executablePath: process.execPath }).catch(() => undefined)
    : await loadDevelopmentVerificationConfig({ applicationPath: app.getAppPath(), executablePath: process.execPath }).catch(() => undefined);
  runtime = await RuntimeAdapter.open(dataDir, launcher, nativeSafeFs, verification);
  registerIpc();
  await createWindow();
}

function resolveNativeSafeFs(): { binaryPath: string; expectedSha256: string } | undefined {
  if (process.platform !== "win32") return undefined;
  const binaryPath = app.isPackaged
    ? join(dirname(process.execPath), NATIVE_SAFE_FS_MANIFEST.packagedRelativePath)
    : join(app.getAppPath(), "..", "..", NATIVE_SAFE_FS_MANIFEST.developmentRelativePath);
  return { binaryPath, expectedSha256: NATIVE_SAFE_FS_MANIFEST.sha256 };
}

function resolveMcpLauncher(): { path: string; argsPrefix: string[] } | undefined {
  if (app.isPackaged) return { path: process.execPath, argsPrefix: ["--mcp-stdio"] };
  const path = process.env.BOXSPEC_MCP_LAUNCHER;
  if (!path) return undefined;
  let argsPrefix: string[] = [];
  if (process.env.BOXSPEC_MCP_LAUNCHER_ARGS) {
    const parsed: unknown = JSON.parse(process.env.BOXSPEC_MCP_LAUNCHER_ARGS);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("BOXSPEC_MCP_LAUNCHER_ARGS must be a JSON string array.");
    argsPrefix = parsed;
  }
  return { path, argsPrefix };
}

async function startPackagedMcp(): Promise<void> {
  const entry = join(process.resourcesPath, "mcp", "dist", "index.js");
  // Windows Electron GUI mode does not expose a usable stdin stream to the
  // transport. The bundled executable's Node mode inherits the original pipes.
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  const stop = (): void => { if (child.exitCode === null) child.kill(); };
  app.once("before-quit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      app.removeListener("before-quit", stop);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
      app.exit(code ?? 1);
    });
  });
}

const packagedMcpMode = app.isPackaged && process.argv[1] === "--mcp-stdio";
void (packagedMcpMode ? startPackagedMcp() : startDesktop()).catch((error) => {
  if (packagedMcpMode) {
    process.stderr.write(`BoxSpec MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
    return;
  }
  dialog.showErrorBox("BoxSpec failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

if (!packagedMcpMode) {
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { void runtime?.close(); });
}
