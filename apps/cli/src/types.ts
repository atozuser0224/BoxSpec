export const PROBE_STATUSES = ["PASS", "FAIL", "UNAVAILABLE", "UNKNOWN", "NOT_RUN"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];
export type OverallStatus = "PASS" | "FAIL" | "DEGRADED";
export type ClientName = "codex" | "claude-code" | "opencode";

export interface Probe<T extends Record<string, unknown> = Record<string, never>> {
  readonly status: ProbeStatus;
  readonly summary: string;
  readonly data: T;
}

export interface AdapterCapability {
  readonly target: string;
  readonly status: "available" | "experimental" | "unavailable" | "unknown";
  readonly reason?: string;
}

export interface BridgeProbeData extends Record<string, unknown> {
  readonly commandConfigured: boolean;
  readonly processStarted: boolean;
  readonly handshakeSucceeded: boolean;
  readonly toolsListed: boolean;
  readonly capabilityCallSucceeded: boolean;
  readonly protocolVersion?: string;
  readonly protocolEra?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolCount?: number;
  readonly capabilityErrorCode?: string;
  readonly appRunning?: boolean;
  readonly adapters?: readonly AdapterCapability[];
  readonly diagnosticCode?: string;
}

export interface DoctorReport {
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly overallStatus: OverallStatus;
  readonly redaction: {
    readonly applied: true;
    readonly policyVersion: "1.0.0";
    readonly replacement: "[REDACTED]";
  };
  readonly installation: Probe<{
    readonly cliVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly architecture: string;
    readonly installPath: string;
  }>;
  readonly runtime: Probe<{
    readonly moduleResolved: boolean;
    readonly factoryExported: boolean;
  }>;
  readonly bridge: Probe<BridgeProbeData>;
  readonly core: Probe<{
    readonly actualMcpCall: boolean;
    readonly appRunning?: boolean;
    readonly errorCode?: string;
  }>;
  readonly grants: Probe<{
    readonly state: "active" | "required" | "denied" | "unknown";
    readonly observedThrough: "capability-call" | "bridge-error" | "not-observed";
  }>;
  readonly browser: Probe<{
    readonly packageVersion?: string;
    readonly executablePresent: boolean;
    readonly launchSucceeded: boolean;
    readonly browserVersion?: string;
    readonly diagnosticCode?: string;
  }>;
  readonly git: Probe<{
    readonly available: boolean;
    readonly version?: string;
    readonly currentDirectoryIsWorktree: boolean | null;
  }>;
  readonly adapter: Probe<{
    readonly target: "web-react";
    readonly capabilities: readonly AdapterCapability[];
  }>;
  readonly agents: Readonly<Record<ClientName, Probe<{
    readonly executable: string;
    readonly available: boolean;
    readonly version?: string;
  }>>>;
  readonly clientConfiguration: Readonly<Record<ClientName, Probe<{
    readonly written: boolean | null;
    readonly actualClientCall: "not-run";
  }>>>;
}

export interface BridgeCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DoctorOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly bridge?: BridgeCommand;
  readonly statePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly executableOverrides?: Partial<Record<ClientName | "git", string>>;
}
