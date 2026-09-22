import type {
  BootstrapData,
  DesktopResult,
  RuntimeCapabilities,
} from "../common/ipc";

type UnknownRecord = Record<string, unknown>;
type Callable = (...args: unknown[]) => unknown;

export interface RuntimeVerificationConfig {
  verificationProfiles: Readonly<Record<string, unknown>>;
  defaultVerificationProfileId: string;
  fixtures: Readonly<Record<string, unknown>>;
  approvedExecutionProfileIds: readonly string[];
}

const unavailableCapabilities: RuntimeCapabilities = {
  editor: false,
  review: false,
  apply: false,
  recovery: false,
  drift: false,
  clients: false,
  verifier: false,
  reasons: {
    editor: "Core runtime is not available.",
    review: "Review runtime is not available.",
    apply: "Change manager is not available.",
    recovery: "Recovery service is not available.",
    drift: "Drift inspection is not available.",
    clients: "MCP client integration is not available.",
    verifier: "Verifier is not available.",
  },
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult<T>(code: string, message: string, details?: unknown): DesktopResult<T> {
  return { ok: false, error: { code, message, recoverable: code !== "INTERNAL_ERROR", ...(details === undefined ? {} : { details }) } };
}

function normalizeResult<T>(value: unknown): DesktopResult<T> {
  if (isRecord(value) && value.ok === true && "data" in value) {
    return { ok: true, data: value.data as T };
  }
  if (isRecord(value) && value.ok === false) {
    const source = isRecord(value.error) ? value.error : value;
    return errorResult(
      typeof source.code === "string" ? source.code : "INTERNAL_ERROR",
      typeof source.message === "string" ? source.message : "The runtime rejected the request.",
      source.details,
    );
  }
  return { ok: true, data: value as T };
}

function resolveMethod(root: unknown, path: readonly string[]): { fn: Callable; owner: UnknownRecord } | null {
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!isRecord(current)) return null;
    current = current[path[index] ?? ""];
  }
  if (!isRecord(current)) return null;
  const fn = current[path[path.length - 1] ?? ""];
  return typeof fn === "function" ? { fn: fn as Callable, owner: current } : null;
}

export class RuntimeAdapter {
  private runtime: unknown;
  private localIpcHost: unknown;
  private loadError: string | undefined;
  private verificationConfigured: boolean;

  private constructor(runtime: unknown, loadError?: string, localIpcHost?: unknown, verificationConfigured = false) {
    this.runtime = runtime;
    this.loadError = loadError;
    this.localIpcHost = localIpcHost;
    this.verificationConfigured = verificationConfigured;
  }

  static async open(
    dataDir: string,
    launcher?: { path: string; argsPrefix: string[] },
    nativeSafeFs?: { binaryPath: string; expectedSha256: string },
    verification?: RuntimeVerificationConfig,
  ): Promise<RuntimeAdapter> {
    try {
      // Kept dynamic so the desktop can render an honest diagnostic if an installation
      // is damaged instead of crashing before the trusted window is created.
      const packageName = "@boxspec/runtime";
      const module = await import(packageName) as UnknownRecord;
      const factory = module.createBoxSpecRuntime;
      if (typeof factory !== "function") {
        return new RuntimeAdapter(undefined, "@boxspec/runtime does not export createBoxSpecRuntime().");
      }
      const runtime = await (factory as Callable)({
        dataDir,
        ...(launcher ? { mcpLauncherPath: launcher.path, mcpLauncherArgs: launcher.argsPrefix } : {}),
        ...(nativeSafeFs ? { nativeSafeFs } : {}),
        ...(verification ?? {}),
      });
      let localIpcHost: unknown;
      try {
        const localIpcPackage = "@boxspec/local-ipc";
        const localIpcModule = await import(localIpcPackage) as UnknownRecord;
        const hostFactory = localIpcModule.createLocalIpcHost;
        const runtimeRecord = isRecord(runtime) ? runtime : {};
        const authorize = runtimeRecord.authorizeMcpSession;
        if (typeof hostFactory === "function" && typeof authorize === "function" && "mcp" in runtimeRecord) {
          localIpcHost = await (hostFactory as Callable)({
            mcp: runtimeRecord.mcp,
            authorizeSession: (binding: unknown, tool: unknown, payload: unknown, signal?: AbortSignal) =>
              (authorize as Callable).call(runtime, binding, tool, payload, signal),
          });
          const start = resolveMethod(localIpcHost, ["start"]);
          if (start) await start.fn.call(start.owner);
        }
      } catch (error) {
        // Editing remains available. Pairing reports the precise host failure when requested.
        localIpcHost = { startError: error instanceof Error ? error.message : String(error) };
      }
      return new RuntimeAdapter(runtime, undefined, localIpcHost, verification !== undefined);
    } catch (error) {
      return new RuntimeAdapter(undefined, error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    const hostClose = resolveMethod(this.localIpcHost, ["close"]);
    if (hostClose) await hostClose.fn.call(hostClose.owner);
    const method = resolveMethod(this.runtime, ["close"]);
    if (method) await method.fn.call(method.owner);
  }

  async pairClient(input: { projectId: string; client: string }): Promise<DesktopResult<{ profilePath: string; expiresAt: string }>> {
    const issue = resolveMethod(this.localIpcHost, ["issuePairingProfile"]);
    if (!issue) {
      const detail = isRecord(this.localIpcHost) && typeof this.localIpcHost.startError === "string" ? ` ${this.localIpcHost.startError}` : "";
      return errorResult("CAPABILITY_UNAVAILABLE", `Authenticated local IPC host is unavailable.${detail}`);
    }
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const grant = await this.call<{ grantId: string; permissions: Array<"read" | "candidate-write" | "verify"> }>([["desktop", "pairMcpClient"]], {
      projectId: input.projectId,
      principalId: `${input.client}-local`,
      permissions: ["read", "candidate-write", "verify"],
      expiresAt,
    });
    if (!grant.ok) return grant;
    try {
      const value = await issue.fn.call(issue.owner, { profileName: input.projectId, principalId: `${input.client}-local`, grantId: grant.data.grantId, projectId: input.projectId, permissions: grant.data.permissions, expiresAt });
      const result = normalizeResult<{ profilePath: string }>(value);
      if (!result.ok) return result;
      return { ok: true, data: { profilePath: result.data.profilePath, expiresAt } };
    } catch (error) {
      await this.call([["desktop", "revokeMcpGrant"]], { projectId: input.projectId, grantId: grant.data.grantId });
      return errorResult("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  has(path: readonly string[]): boolean {
    return resolveMethod(this.runtime, path) !== null;
  }

  async call<T>(paths: readonly (readonly string[])[], input?: unknown): Promise<DesktopResult<T>> {
    if (this.runtime === undefined) {
      return errorResult("BACKEND_UNAVAILABLE", this.loadError ?? "BoxSpec runtime did not start.");
    }
    const resolved = paths.map((path) => resolveMethod(this.runtime, path)).find((method) => method !== null);
    if (!resolved) {
      return errorResult("CAPABILITY_UNAVAILABLE", `Runtime capability ${paths[0]?.join(".") ?? "unknown"} is not installed.`);
    }
    try {
      const value = input === undefined
        ? await resolved.fn.call(resolved.owner)
        : await resolved.fn.call(resolved.owner, input);
      return normalizeResult<T>(value);
    } catch (error) {
      return errorResult("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  async bootstrap(): Promise<DesktopResult<BootstrapData>> {
    if (this.runtime === undefined) {
      return {
        ok: true,
        data: {
          backend: { available: false, message: this.loadError ?? "BoxSpec runtime did not start." },
          capabilities: unavailableCapabilities,
          projects: [],
          recovery: [],
        },
      };
    }

    const projectResult = await this.call<BootstrapData["projects"]>([["desktop", "listProjects"]]);
    const projects = projectResult.ok ? projectResult.data : [];
    const recoveryGroups = await Promise.all(projects.map(async (project) => {
      const result = await this.call<string[]>([["desktop", "listRecovery"]], { projectId: project.projectId });
      return result.ok ? result.data.map((transactionId) => ({ transactionId, projectId: project.projectId, status: "INTERRUPTED" as const, summary: "An apply transaction did not finish. Inspect its journal before choosing a recovery action.", files: [] })) : [];
    }));
    const installed = {
      editor: projectResult.ok && this.has(["desktop", "executeEditorCommand"]),
      review: this.has(["desktop", "inspectReview"]),
      apply: this.has(["desktop", "approveAndApply"]),
      recovery: this.has(["desktop", "inspectRecovery"]) && this.has(["desktop", "recoverApply"]),
      drift: this.has(["desktop", "inspectSourceDrift"]) && this.has(["desktop", "resolveSourceDrift"]),
      clients: this.has(["desktop", "getClientSetup"]) && this.has(["desktop", "prepareClientConfig"]),
      verifier: this.verificationConfigured && this.has(["desktop", "inspectReview"]),
    };
    const reasons = Object.fromEntries(Object.entries(installed)
      .filter(([, available]) => !available)
      .map(([capability]) => [capability, unavailableCapabilities.reasons?.[capability as keyof NonNullable<RuntimeCapabilities["reasons"]>]]));
    if (!installed.verifier) reasons.verifier = "Trusted verification tools are unavailable in this installation.";
    const capabilities: RuntimeCapabilities = { ...installed, reasons };
    return {
      ok: true,
      data: {
        backend: { available: true },
        capabilities,
        projects,
        recovery: recoveryGroups.flat(),
      },
    };
  }
}
