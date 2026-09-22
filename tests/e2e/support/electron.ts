import { mkdir, rm, cp, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(currentDirectory, "../../..");
export const e2eRoot = join(repositoryRoot, "tests", "e2e");
export const artifactsRoot = join(e2eRoot, "artifacts");
export const dataDir = join(artifactsRoot, "state");
export const projectRoot = join(artifactsRoot, "project-with-한글-and-spaces");
export const candidateProjectRoot = join(artifactsRoot, "candidate-project-with-한글-and-spaces");
export const screenshotsRoot = join(artifactsRoot, "screenshots");
export const localAppDataRoot = join(artifactsRoot, "local-app-data");
export const mcpProfileRoot = join(localAppDataRoot, "BoxSpec", "mcp-profiles");
export const packagedProfileRoot = join(artifactsRoot, "packaged-profile");
export const packagedAppDataRoot = join(packagedProfileRoot, "app-data");
export const packagedLocalAppDataRoot = join(packagedProfileRoot, "local-app-data");
export const packagedTempRoot = join(packagedProfileRoot, "temp");
export const packagedMcpProfileRoot = join(packagedLocalAppDataRoot, "BoxSpec", "mcp-profiles");
export const desktopRoot = join(repositoryRoot, "apps", "desktop");
export const mcpLauncherPath = join(repositoryRoot, "apps", "mcp", "dist", "index.js");
export const packagedExecutablePath = join(repositoryRoot, "build", "windows", "unpacked", "BoxSpec-win32-x64", "BoxSpec.exe");

async function createGitFixture(targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  await cp(join(repositoryRoot, "samples", "react-dashboard"), targetRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${join("samples", "react-dashboard", "node_modules")}`),
  });
  const sampleModules = join(repositoryRoot, "samples", "react-dashboard", "node_modules");
  if (existsSync(sampleModules)) await symlink(sampleModules, join(targetRoot, "node_modules"), "junction");
  const git = spawnSync("git", ["init", "--initial-branch=main"], { cwd: targetRoot, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  for (const args of [["config", "user.email", "e2e@boxspec.invalid"], ["config", "user.name", "BoxSpec E2E"], ["add", "."], ["commit", "-m", "fixture baseline"]]) {
    const result = spawnSync("git", args, { cwd: targetRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

export async function prepareIsolatedRun(): Promise<void> {
  const expectedPrefix = `${resolve(e2eRoot)}\\`;
  for (const target of [artifactsRoot]) {
    const absolute = resolve(target);
    if (!`${absolute}\\`.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to clean an E2E path outside ${e2eRoot}: ${absolute}`);
    }
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(screenshotsRoot, { recursive: true });
  await createGitFixture(projectRoot);
  await createGitFixture(candidateProjectRoot);
  await mkdir(packagedTempRoot, { recursive: true });
  await writeFile(join(artifactsRoot, "run.json"), `${JSON.stringify({ repositoryRoot, dataDir, projectRoot, candidateProjectRoot, packagedProfileRoot }, null, 2)}\n`, "utf8");
}

export async function launchPackagedDesktop(): Promise<{ app: ElectronApplication; page: Page; rendererLog: string[] }> {
  const verificationManifest = join(dirname(packagedExecutablePath), "resources", "verification-tools.json");
  if (!existsSync(packagedExecutablePath)) throw new Error(`Packaged BoxSpec executable is missing: ${packagedExecutablePath}`);
  if (!existsSync(verificationManifest)) throw new Error(`Packaged verification manifest is missing: ${verificationManifest}`);
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const app = await electron.launch({
    executablePath: packagedExecutablePath,
    cwd: dirname(packagedExecutablePath),
    env: {
      ...inheritedEnvironment,
      APPDATA: packagedAppDataRoot,
      LOCALAPPDATA: packagedLocalAppDataRoot,
      TEMP: packagedTempRoot,
      TMP: packagedTempRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await app.firstWindow();
  const rendererLog: string[] = [];
  page.on("console", (message) => rendererLog.push(`console.${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => rendererLog.push(`pageerror: ${error.stack ?? error.message}`));
  await page.waitForLoadState("domcontentloaded");
  return { app, page, rendererLog };
}

export async function launchDesktop(): Promise<{ app: ElectronApplication; page: Page; rendererLog: string[] }> {
  const executablePath = join(desktopRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!existsSync(join(desktopRoot, "dist", "main", "main.cjs"))) {
    throw new Error("Desktop build is missing. Run pnpm --filter @boxspec/desktop build before E2E.");
  }
  if (!existsSync(executablePath)) throw new Error(`Electron executable is missing: ${executablePath}`);
  if (!existsSync(mcpLauncherPath)) throw new Error(`MCP launcher build is missing: ${mcpLauncherPath}`);

  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const app = await electron.launch({
    executablePath,
    args: [desktopRoot],
    cwd: repositoryRoot,
    env: {
      ...inheritedEnvironment,
      BOXSPEC_DATA_DIR: dataDir,
      BOXSPEC_MCP_LAUNCHER: process.execPath,
      BOXSPEC_MCP_LAUNCHER_ARGS: JSON.stringify([mcpLauncherPath]),
      LOCALAPPDATA: localAppDataRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await app.firstWindow();
  const rendererLog: string[] = [];
  page.on("console", (message) => rendererLog.push(`console.${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => rendererLog.push(`pageerror: ${error.stack ?? error.message}`));
  await page.waitForLoadState("domcontentloaded");
  return { app, page, rendererLog };
}

export async function selectProjectDirectory(app: ElectronApplication, selectedPath = projectRoot): Promise<void> {
  // Playwright cannot drive Electron's native Windows folder chooser. We replace only
  // the chooser response; project creation, path validation, approval, and persistence
  // still cross the real preload/IPC/runtime boundary. Native chooser behavior remains
  // explicitly outside this automated result.
  await app.evaluate(async ({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath], bookmarks: [] });
  }, selectedPath);
}

export async function saveRendererLog(lines: string[], name: string): Promise<void> {
  await writeFile(join(artifactsRoot, name), `${lines.join("\n")}\n`, "utf8");
}

export async function screenshot(page: Page, name: string): Promise<string> {
  const path = join(screenshotsRoot, name);
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("BoxSpec window is missing");
    window.setContentSize(size.width, size.height);
  }, { width, height });
}

export async function callExternalMcpTool(profileName: string, tool: string, args: Record<string, unknown>, evidenceLabel = tool): Promise<Record<string, unknown>> {
  return callMcpTool({ profileName, tool, args, evidenceLabel, profileRoot: mcpProfileRoot });
}

export async function callPackagedMcpTool(profileName: string, tool: string, args: Record<string, unknown>, evidenceLabel = tool): Promise<Record<string, unknown>> {
  return callMcpTool({
    profileName,
    tool,
    args,
    evidenceLabel,
    profileRoot: packagedMcpProfileRoot,
    launcherCommand: packagedExecutablePath,
    launcherArgs: ["--mcp-stdio"],
    launcherCwd: dirname(packagedExecutablePath),
  });
}

async function callMcpTool(input: {
  profileName: string;
  tool: string;
  args: Record<string, unknown>;
  evidenceLabel: string;
  profileRoot: string;
  launcherCommand?: string;
  launcherArgs?: string[];
  launcherCwd?: string;
}): Promise<Record<string, unknown>> {
  const requestPath = join(artifactsRoot, `mcp-${input.evidenceLabel}-request.json`);
  const resultPath = join(artifactsRoot, `mcp-${input.evidenceLabel}-result.json`);
  await writeFile(requestPath, `${JSON.stringify({ profileName: input.profileName, tool: input.tool, args: input.args, launcherCommand: input.launcherCommand, launcherArgs: input.launcherArgs, launcherCwd: input.launcherCwd }, null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, [join(e2eRoot, "support", "mcp-client.mjs"), requestPath, resultPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, BOXSPEC_MCP_PROFILE_ROOT: input.profileRoot },
  });
  if (result.status !== 0) throw new Error(`External MCP SDK call failed (${String(result.status)}): ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(resultPath, "utf8"))) as {
    result?: { isError?: boolean; structuredContent?: { ok?: boolean; data?: Record<string, unknown>; code?: string; message?: string } };
    launcherStderr?: string;
  };
  const structured = parsed.result?.structuredContent;
  if (parsed.result?.isError || !structured?.ok || !structured.data) {
    throw new Error(`External MCP ${input.tool} was rejected: ${JSON.stringify(parsed)}`);
  }
  return structured.data;
}
