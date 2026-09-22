import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AdapterCapability, BridgeCommand, BridgeProbeData, Probe } from "./types.js";

const EXPECTED_TOOLS = [
  "boxspec_get_capabilities", "boxspec_list_projects", "boxspec_get_selection", "boxspec_get_context",
  "boxspec_search_assets", "boxspec_start_task", "boxspec_get_task", "boxspec_propose_patch",
  "boxspec_submit_candidate", "boxspec_verify_candidate", "boxspec_get_report", "boxspec_get_artifact",
  "boxspec_propose_contract_change", "boxspec_request_review", "boxspec_cancel_task",
] as const;

export async function probeBridge(command: BridgeCommand | undefined, timeoutMs: number): Promise<Probe<BridgeProbeData>> {
  if (command === undefined) {
    return bridgeResult("UNAVAILABLE", "No BoxSpec bridge launcher was found or configured.", {
      commandConfigured: false,
      processStarted: false,
      handshakeSucceeded: false,
      toolsListed: false,
      capabilityCallSucceeded: false,
      diagnosticCode: "BRIDGE_COMMAND_UNAVAILABLE",
    });
  }

  const transport = new StdioClientTransport({
    command: command.command,
    args: [...command.args],
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.env === undefined ? {} : { env: { ...command.env } }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + String(chunk)).slice(-16_384);
  });
  const client = new Client(
    { name: "boxspec-doctor", version: "0.1.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: Math.min(timeoutMs, 3_000), maxRetries: 0 } } },
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("BoxSpec bridge diagnostic timed out")), timeoutMs);
  timer.unref();
  let processStarted = false;
  let handshakeSucceeded = false;
  let toolsListed = false;
  try {
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    processStarted = transport.pid !== null;
    handshakeSucceeded = true;
    const listed = await client.listTools(undefined, { signal: controller.signal, timeout: timeoutMs, cacheMode: "bypass" });
    toolsListed = true;
    const listedNames = new Set(listed.tools.map((tool) => tool.name));
    const catalogMatches = listedNames.size === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((name) => listedNames.has(name));
    const hasCapabilities = listed.tools.some((tool) => tool.name === "boxspec_get_capabilities");
    if (!hasCapabilities) {
      return bridgeResult("FAIL", "The bridge connected but did not advertise boxspec_get_capabilities.", {
        commandConfigured: true,
        processStarted,
        handshakeSucceeded,
        toolsListed,
        capabilityCallSucceeded: false,
        ...connectionMetadata(client),
        toolCount: listed.tools.length,
        diagnosticCode: "CAPABILITY_TOOL_MISSING",
      });
    }
    const result = await client.callTool(
      { name: "boxspec_get_capabilities", arguments: {} },
      { signal: controller.signal, timeout: timeoutMs },
    );
    const body = asRecord(result.structuredContent);
    if (result.isError === true || body?.ok !== true) {
      const errorCode = typeof body?.code === "string" ? body.code : classifyDiagnostic(stderr);
      return bridgeResult(classifyCapabilityStatus(errorCode), capabilityFailureSummary(errorCode), {
        commandConfigured: true,
        processStarted,
        handshakeSucceeded,
        toolsListed,
        capabilityCallSucceeded: false,
        ...connectionMetadata(client),
        toolCount: listed.tools.length,
        capabilityErrorCode: errorCode,
        diagnosticCode: "CAPABILITY_CALL_REJECTED",
      });
    }
    const data = asRecord(body.data);
    const adapters = parseAdapters(data?.adapters);
    const appRunning = typeof data?.appRunning === "boolean" ? data.appRunning : undefined;
    return bridgeResult(!catalogMatches ? "FAIL" : appRunning === false ? "UNAVAILABLE" : "PASS", !catalogMatches
      ? "The bridge capability call succeeded, but the advertised tool catalog did not match the 15-tool P1 contract."
      : appRunning === false
        ? "The MCP call completed, but Core reported that the BoxSpec app is not running."
        : "The bridge handshake, tool listing, and capability call succeeded.", {
      commandConfigured: true,
      processStarted,
      handshakeSucceeded,
      toolsListed,
      capabilityCallSucceeded: true,
      ...connectionMetadata(client),
      toolCount: listed.tools.length,
      ...(appRunning === undefined ? {} : { appRunning }),
      adapters,
      ...(catalogMatches ? {} : { diagnosticCode: "UNEXPECTED_TOOL_CATALOG" }),
    });
  } catch (error) {
    processStarted ||= transport.pid !== null;
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = classifyDiagnostic(`${message}\n${stderr}`);
    const unavailable = errorCode === "PAIRING_REQUIRED" || errorCode === "PROJECT_NOT_GRANTED" || errorCode === "APP_NOT_RUNNING";
    return bridgeResult(unavailable ? "UNAVAILABLE" : "FAIL", unavailable ? capabilityFailureSummary(errorCode) : "The bridge process or MCP handshake failed.", {
      commandConfigured: true,
      processStarted,
      handshakeSucceeded,
      toolsListed,
      capabilityCallSucceeded: false,
      capabilityErrorCode: errorCode,
      diagnosticCode: controller.signal.aborted ? "BRIDGE_TIMEOUT" : "BRIDGE_HANDSHAKE_FAILED",
    });
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

function bridgeResult(status: Probe<BridgeProbeData>["status"], summary: string, data: BridgeProbeData): Probe<BridgeProbeData> {
  return { status, summary, data };
}

function parseAdapters(input: unknown): readonly AdapterCapability[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item): AdapterCapability[] => {
    const row = asRecord(item);
    if (typeof row?.target !== "string") return [];
    const status = row.status === "available" || row.status === "experimental" || row.status === "unavailable" ? row.status : "unknown";
    return [{ target: row.target, status, ...(typeof row.reason === "string" ? { reason: row.reason } : {}) }];
  });
}

function classifyCapabilityStatus(code: string): "FAIL" | "UNAVAILABLE" {
  return code === "PAIRING_REQUIRED" || code === "PROJECT_NOT_GRANTED" || code === "APP_NOT_RUNNING" ? "UNAVAILABLE" : "FAIL";
}

function capabilityFailureSummary(code: string): string {
  switch (code) {
    case "PAIRING_REQUIRED": return "The bridge is reachable, but no valid pairing grant is active.";
    case "PROJECT_NOT_GRANTED": return "The bridge is reachable, but the selected project is not granted.";
    case "APP_NOT_RUNNING": return "The bridge is reachable, but the BoxSpec app/Core is not running.";
    default: return "The bridge is reachable, but the capability call failed.";
  }
}

function classifyDiagnostic(input: string): string {
  for (const code of ["PAIRING_REQUIRED", "PROJECT_NOT_GRANTED", "APP_NOT_RUNNING"] as const) {
    if (input.includes(code)) return code;
  }
  return "UNKNOWN_BRIDGE_ERROR";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function connectionMetadata(client: Client): Pick<BridgeProbeData, "protocolVersion" | "protocolEra" | "serverName" | "serverVersion"> {
  const protocolVersion = client.getNegotiatedProtocolVersion();
  const protocolEra = client.getProtocolEra();
  const server = client.getServerVersion();
  return {
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(protocolEra === undefined ? {} : { protocolEra }),
    ...(server?.name === undefined ? {} : { serverName: server.name }),
    ...(server?.version === undefined ? {} : { serverVersion: server.version }),
  };
}
