import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeBridge } from "./bridge-probe.js";
import { redactValue } from "./redaction.js";
import { resolveExecutable, runCommand } from "./process.js";
import type {
  AdapterCapability,
  BridgeCommand,
  BridgeProbeData,
  ClientName,
  DoctorOptions,
  DoctorReport,
  OverallStatus,
  Probe,
  ProbeStatus,
} from "./types.js";

const CLI_VERSION = "0.1.0";
const SELECTED_NODE_VERSION = "v24.19.0";
const SELECTED_PLAYWRIGHT_VERSION = "1.63.0";
const DEFAULT_TIMEOUT_MS = 8_000;
const CLIENTS: readonly ClientName[] = ["codex", "claude-code", "opencode"];
const VERSION_ARGUMENTS: Readonly<Record<ClientName | "git", readonly string[]>> = {
  codex: ["--version"],
  "claude-code": ["--version"],
  opencode: ["--version"],
  git: ["--version"],
};

interface DoctorState {
  readonly clients: Readonly<Record<ClientName, boolean | null>>;
  readonly source: "boxspec-state" | "not-found" | "invalid";
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridgeCommand = options.bridge ?? await discoverBridge(cwd, env);
  const state = await readDoctorState(options.statePath ?? defaultStatePath(env));
  const [runtime, bridge, browser, git] = await Promise.all([
    probeRuntime(),
    probeBridge(bridgeCommand, timeoutMs),
    probeBrowser(timeoutMs),
    probeGit(cwd, options.executableOverrides?.git ?? "git", env, timeoutMs),
  ] as const);
  const agentRows = await Promise.all(CLIENTS.map(async (client) => [client, await probeAgent(client, options.executableOverrides?.[client] ?? agentCommand(client), env, timeoutMs)] as const));
  const agents = Object.fromEntries(agentRows) as Record<ClientName, DoctorReport["agents"][ClientName]>;
  const core = deriveCoreProbe(bridge);
  const grants = deriveGrantProbe(bridge);
  const adapter = deriveAdapterProbe(bridge);
  const clientConfiguration = Object.fromEntries(CLIENTS.map((client) => {
    const written = state.clients[client];
    const status: ProbeStatus = written === true ? "PASS" : written === false ? "FAIL" : state.source === "invalid" ? "FAIL" : "UNKNOWN";
    const summary = written === true
      ? "BoxSpec recorded a successful client configuration write; no call through that client was run by doctor."
      : written === false
        ? "BoxSpec recorded that client configuration was not written."
        : state.source === "invalid"
          ? "The BoxSpec-owned diagnostic state file was invalid."
          : "No BoxSpec-owned configuration-write record was available.";
    return [client, { status, summary, data: { written, actualClientCall: "not-run" as const } }] as const;
  })) as Record<ClientName, DoctorReport["clientConfiguration"][ClientName]>;
  const installation = installationProbe();
  const requiredStatuses = [
    installation.status,
    runtime.status,
    bridge.status,
    core.status,
    grants.status,
    browser.status,
    git.status,
    adapter.status,
    ...CLIENTS.map((client) => agents[client].status),
    ...CLIENTS.map((client) => clientConfiguration[client].status),
  ];
  const report: DoctorReport = {
    schemaVersion: "1.0.0",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    overallStatus: aggregateStatus(requiredStatuses),
    redaction: { applied: true, policyVersion: "1.0.0", replacement: "[REDACTED]" },
    installation,
    runtime,
    bridge,
    core,
    grants,
    browser,
    git,
    adapter,
    agents,
    clientConfiguration,
  };
  return redactValue(report, env) as DoctorReport;
}

export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  if (report.overallStatus === "PASS") return 0;
  return allProbeStatuses(report).includes("FAIL") ? 1 : 2;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `BoxSpec doctor: ${report.overallStatus}`,
    formatLine("Installation", report.installation),
    formatLine("Runtime", report.runtime),
    formatLine("Bridge / MCP call", report.bridge),
    formatLine("Core", report.core),
    formatLine("Grant", report.grants),
    formatLine("Playwright browser", report.browser),
    formatLine("Git", report.git),
    formatLine("React adapter", report.adapter),
  ];
  for (const client of CLIENTS) {
    lines.push(formatLine(`${displayClient(client)} executable`, report.agents[client]));
    lines.push(formatLine(`${displayClient(client)} config`, report.clientConfiguration[client]));
  }
  lines.push("", "Configuration-write records and real MCP calls are reported separately.");
  lines.push("Use --json for the redacted machine-readable report.");
  return lines.join("\n");
}

export function aggregateStatus(statuses: readonly ProbeStatus[]): OverallStatus {
  if (statuses.some((status) => status === "FAIL")) return "FAIL";
  return statuses.every((status) => status === "PASS") ? "PASS" : "DEGRADED";
}

async function probeRuntime(): Promise<DoctorReport["runtime"]> {
  try {
    const packageName = "@boxspec/runtime";
    const module = await import(packageName) as Record<string, unknown>;
    const factoryExported = typeof module.createBoxSpecRuntime === "function";
    return {
      status: factoryExported ? "PASS" : "UNAVAILABLE",
      summary: factoryExported ? "The BoxSpec runtime module and factory loaded." : "The runtime module loaded but does not export createBoxSpecRuntime().",
      data: { moduleResolved: true, factoryExported },
    };
  } catch {
    return {
      status: "UNAVAILABLE",
      summary: "The BoxSpec runtime module could not be loaded.",
      data: { moduleResolved: false, factoryExported: false },
    };
  }
}

async function probeBrowser(timeoutMs: number): Promise<DoctorReport["browser"]> {
  try {
    const packageName = "playwright";
    const playwright = await import(packageName) as typeof import("playwright");
    const executablePath = playwright.chromium.executablePath();
    const executablePresent = await isFile(executablePath);
    const packageVersion = await readPackageVersion("playwright");
    if (!executablePresent) {
      return { status: "UNAVAILABLE", summary: "Playwright is installed, but its matching Chromium executable is absent.", data: { packageVersion, executablePresent: false, launchSucceeded: false } };
    }
    try {
      const browser = await playwright.chromium.launch({ headless: true, timeout: timeoutMs });
      const browserVersion = browser.version();
      await browser.close();
      const selectedVersion = packageVersion === SELECTED_PLAYWRIGHT_VERSION;
      return {
        status: selectedVersion ? "PASS" : "FAIL",
        summary: selectedVersion ? "The Playwright-managed Chromium executable launched successfully." : `Chromium launched, but Playwright ${packageVersion} does not match the selected ${SELECTED_PLAYWRIGHT_VERSION}.`,
        data: { packageVersion, executablePresent: true, launchSucceeded: true, browserVersion, ...(selectedVersion ? {} : { diagnosticCode: "PLAYWRIGHT_VERSION_MISMATCH" }) },
      };
    } catch (error) {
      return {
        status: "FAIL",
        summary: "The Playwright-managed Chromium executable exists but did not launch.",
        data: { packageVersion, executablePresent: true, launchSucceeded: false, diagnosticCode: classifyBrowserError(error) },
      };
    }
  } catch {
    return { status: "UNAVAILABLE", summary: "Playwright 1.63.0 is not available to the doctor process.", data: { executablePresent: false, launchSucceeded: false } };
  }
}

async function probeGit(cwd: string, command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<DoctorReport["git"]> {
  const executable = await resolveExecutable(command, env);
  if (executable === null) return { status: "UNAVAILABLE", summary: "Git was not found on PATH.", data: { available: false, currentDirectoryIsWorktree: null } };
  const version = await runCommand(executable, VERSION_ARGUMENTS.git, { cwd, env, timeoutMs });
  if (version.exitCode !== 0) return { status: "FAIL", summary: "Git was found but its version probe failed.", data: { available: true, currentDirectoryIsWorktree: null } };
  const worktree = await runCommand(executable, ["rev-parse", "--is-inside-work-tree"], { cwd, env, timeoutMs });
  return {
    status: "PASS",
    summary: worktree.exitCode === 0 ? "Git is available and the current directory is in a worktree." : "Git is available; the current directory is not in a Git worktree.",
    data: { available: true, version: firstLine(version.stdout), currentDirectoryIsWorktree: worktree.exitCode === 0 && worktree.stdout.trim() === "true" },
  };
}

async function probeAgent(client: ClientName, command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<DoctorReport["agents"][ClientName]> {
  const executable = await resolveExecutable(command, env);
  if (executable === null) return { status: "UNAVAILABLE", summary: `${displayClient(client)} was not found on PATH.`, data: { executable: command, available: false } };
  const result = await runCommand(executable, VERSION_ARGUMENTS[client], { env, timeoutMs });
  if (result.exitCode !== 0) return { status: "FAIL", summary: `${displayClient(client)} was found but its version probe failed.`, data: { executable, available: true } };
  return { status: "PASS", summary: `${displayClient(client)} is available.`, data: { executable, available: true, version: firstLine(result.stdout || result.stderr) } };
}

function deriveCoreProbe(bridge: Probe<BridgeProbeData>): DoctorReport["core"] {
  if (bridge.data.capabilityCallSucceeded) {
    const appRunning = bridge.data.appRunning;
    return {
      status: appRunning === true ? "PASS" : appRunning === false ? "UNAVAILABLE" : "UNKNOWN",
      summary: appRunning === true ? "Core answered the MCP capability call." : appRunning === false ? "Core reported that the app is not running." : "The capability call returned no app-running state.",
      data: { actualMcpCall: true, ...(appRunning === undefined ? {} : { appRunning }) },
    };
  }
  const errorCode = bridge.data.capabilityErrorCode;
  return {
    status: errorCode === "APP_NOT_RUNNING" ? "UNAVAILABLE" : bridge.data.handshakeSucceeded ? "UNKNOWN" : "NOT_RUN",
    summary: errorCode === "APP_NOT_RUNNING" ? "The bridge reported that Core is not running." : "No successful capability call reached Core.",
    data: { actualMcpCall: false, ...(errorCode === undefined ? {} : { errorCode }) },
  };
}

function deriveGrantProbe(bridge: Probe<BridgeProbeData>): DoctorReport["grants"] {
  if (bridge.data.capabilityCallSucceeded) return { status: "PASS", summary: "A paired principal and grant were accepted for the capability call.", data: { state: "active", observedThrough: "capability-call" } };
  if (bridge.data.capabilityErrorCode === "PAIRING_REQUIRED") return { status: "UNAVAILABLE", summary: "A pairing grant is required.", data: { state: "required", observedThrough: "bridge-error" } };
  if (bridge.data.capabilityErrorCode === "PROJECT_NOT_GRANTED") return { status: "UNAVAILABLE", summary: "The current principal has no project grant.", data: { state: "denied", observedThrough: "bridge-error" } };
  return { status: "UNKNOWN", summary: "Grant state could not be observed without a capability call.", data: { state: "unknown", observedThrough: "not-observed" } };
}

function deriveAdapterProbe(bridge: Probe<BridgeProbeData>): DoctorReport["adapter"] {
  const capabilities = bridge.data.adapters ?? [];
  const web = capabilities.find((item) => item.target === "web-react");
  if (web === undefined) return { status: "UNKNOWN", summary: "No verified web-react adapter capability was returned.", data: { target: "web-react", capabilities } };
  return {
    status: web.status === "available" ? "PASS" : "UNAVAILABLE",
    summary: web.status === "available" ? "The runtime reports the web-react adapter available." : `The runtime reports the web-react adapter ${web.status}.`,
    data: { target: "web-react", capabilities },
  };
}

function installationProbe(): DoctorReport["installation"] {
  const installPath = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const selectedVersion = process.version === SELECTED_NODE_VERSION;
  return {
    status: selectedVersion ? "PASS" : "FAIL",
    summary: selectedVersion ? `The doctor entry is running on selected Node ${SELECTED_NODE_VERSION.slice(1)}.` : `The doctor entry is running on ${process.version}; selected Node is ${SELECTED_NODE_VERSION}.`,
    data: { cliVersion: CLI_VERSION, nodeVersion: process.version, platform: process.platform, architecture: process.arch, installPath },
  };
}

async function discoverBridge(cwd: string, env: NodeJS.ProcessEnv): Promise<BridgeCommand | undefined> {
  const configured = env.BOXSPEC_BRIDGE_COMMAND;
  if (configured !== undefined && configured.length > 0) {
    return { command: configured, args: parseBridgeArgs(env.BOXSPEC_BRIDGE_ARGS_JSON), cwd, env: bridgeEnvironment(env) };
  }
  const developmentEntry = path.join(cwd, "apps", "mcp", "dist", "index.js");
  if (await isFile(developmentEntry)) return { command: process.execPath, args: [developmentEntry], cwd, env: bridgeEnvironment(env) };
  const installedEntry = path.resolve(fileURLToPath(new URL("../../mcp/index.js", import.meta.url)));
  if (await isFile(installedEntry)) return { command: process.execPath, args: [installedEntry], cwd, env: bridgeEnvironment(env) };
  return undefined;
}

function bridgeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "COMSPEC", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "BOXSPEC_DATA_DIR", "BOXSPEC_MCP_PROFILE_ROOT"];
  return Object.fromEntries(allowed.flatMap((name) => typeof env[name] === "string" ? [[name, env[name] as string]] : []));
}

function parseBridgeArgs(input: string | undefined): string[] {
  if (input === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(input);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

async function readDoctorState(statePath: string | undefined): Promise<DoctorState> {
  const empty: Record<ClientName, null> = { codex: null, "claude-code": null, opencode: null };
  if (statePath === undefined) return { clients: empty, source: "not-found" };
  try {
    const info = await stat(statePath);
    if (!info.isFile() || info.size > 65_536) return { clients: empty, source: "invalid" };
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    const root = asRecord(value);
    const clients = asRecord(root?.clients);
    if (root?.schemaVersion !== "1.0.0" || clients === undefined || !hasOnlyKeys(root, ["schemaVersion", "clients"]) || !hasOnlyKeys(clients, CLIENTS) || CLIENTS.some((client) => typeof clients[client] !== "boolean")) {
      return { clients: empty, source: "invalid" };
    }
    return {
      source: "boxspec-state",
      clients: Object.fromEntries(CLIENTS.map((client) => [client, typeof clients[client] === "boolean" ? clients[client] as boolean : null])) as Record<ClientName, boolean | null>,
    };
  } catch (error) {
    const code = asRecord(error)?.code;
    return { clients: empty, source: code === "ENOENT" ? "not-found" : "invalid" };
  }
}

function defaultStatePath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.BOXSPEC_DOCTOR_STATE_PATH) return env.BOXSPEC_DOCTOR_STATE_PATH;
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "BoxSpec", "doctor-state.json");
  return undefined;
}

async function readPackageVersion(packageName: string): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(packageName);
    let directory = path.dirname(entry);
    for (let index = 0; index < 8; index += 1) {
      const manifest = path.join(directory, "package.json");
      if (await isFile(manifest)) {
        const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
        const version = asRecord(value)?.version;
        if (typeof version === "string") return version;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // The package presence probe reports the useful failure state.
  }
  return "unknown";
}

function allProbeStatuses(report: DoctorReport): ProbeStatus[] {
  return [
    report.installation.status, report.runtime.status, report.bridge.status, report.core.status,
    report.grants.status, report.browser.status, report.git.status, report.adapter.status,
    ...CLIENTS.map((client) => report.agents[client].status),
    ...CLIENTS.map((client) => report.clientConfiguration[client].status),
  ];
}

function formatLine(label: string, probe: Pick<Probe, "status" | "summary">): string {
  return `${probe.status.padEnd(11)} ${label}: ${probe.summary}`;
}

function displayClient(client: ClientName): string {
  if (client === "claude-code") return "Claude Code";
  return client === "codex" ? "Codex" : "OpenCode";
}

function agentCommand(client: ClientName): string {
  return client === "claude-code" ? "claude" : client;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "unknown";
}

function classifyBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return "BROWSER_LAUNCH_TIMEOUT";
  if (/executable doesn.t exist|enoent|not found/i.test(message)) return "BROWSER_EXECUTABLE_UNAVAILABLE";
  if (/host system is missing dependencies|dependency/i.test(message)) return "BROWSER_DEPENDENCY_MISSING";
  return "BROWSER_LAUNCH_FAILED";
}

async function isFile(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isFile(); } catch { return false; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
