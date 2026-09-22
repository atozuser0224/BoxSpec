import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
  type StandardSchemaWithJSON,
  type Tool
} from "@modelcontextprotocol/server";
import type { BoxSpecErrorCode, ToolResult } from "@boxspec/shared/errors";
import type { RequestId } from "@boxspec/shared/domain";
import { isRecord, loadToolCatalog } from "./catalog.js";
import type {
  BridgeCoreUseCases,
  BridgeOptions,
  SafeMcpToolName
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESULT_BYTES = 1_048_576;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

export function createBoxSpecMcpServer(
  core: BridgeCoreUseCases,
  options: BridgeOptions
): McpServer {
  assertOptions(options);
  const catalog = loadToolCatalog();
  const server = new McpServer({
    name: "boxspec",
    version: options.serverVersion ?? "0.1.0"
  }, { capabilities: { tools: {}, resources: {} } });
  const tools = new Map(catalog.tools.map((tool) => [tool.name, {
    contract: tool,
    inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
    outputSchema: fromJsonSchema<ToolResult<unknown>>(tool.outputSchema as JsonSchemaType)
  }]));
  let inFlight = 0;

  server.server.setRequestHandler("tools/list", async () => ({
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      outputSchema: tool.outputSchema as Tool["outputSchema"],
      annotations: tool.annotations
    }))
  }));

  server.server.setRequestHandler("tools/call", async (request, context) => {
    const registration = tools.get(request.params.name as SafeMcpToolName);
    if (!registration) {
      return protocolResult(failure(
        "INVALID_REQUEST",
        `Unknown or unavailable BoxSpec tool: ${request.params.name}`,
        extractRequestId(request.params.arguments),
        false
      ), false);
    }
    const input = request.params.arguments ?? {};
    const inputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (inputBytes > (options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)) {
      return protocolResult(failure(
        "RESOURCE_LIMIT",
        `Tool request exceeds the ${options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES} byte bridge limit`,
        extractRequestId(input),
        true
      ), false);
    }
    const inputValidation = await registration.inputSchema["~standard"].validate(input);
    if (inputValidation.issues) {
      return protocolResult(invalidRequest(input, inputValidation.issues), false);
    }
    if (inFlight >= (options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)) {
      return protocolResult(failure(
        "RESOURCE_LIMIT",
        "Too many concurrent BoxSpec requests",
        extractRequestId(input),
        true
      ), false);
    }
    inFlight += 1;
    try {
      const result = await invokeCore(core, options, registration.contract.name, input, context, registration.outputSchema);
      return server.server.projectCallToolResult(result, registration.contract.outputSchema);
    } finally {
      inFlight -= 1;
    }
  });

  server.server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [{
      name: "boxspec-screen-context",
      uriTemplate: "boxspec://projects/{projectId}/screens/{screenId}{?revision,nodeIds,cursor}",
      description: "A revision-pinned, grant-scoped BoxSpec context slice",
      mimeType: "application/json"
    }]
  }));
  server.server.setRequestHandler("resources/read", async (request, context) => {
      const uri = new URL(request.params.uri);
      if (uri.protocol !== "boxspec:" || uri.hostname !== "projects") {
        throw new Error("Invalid BoxSpec context resource URI");
      }
      const revision = Number(uri.searchParams.get("revision"));
      const nodeIds = (uri.searchParams.get("nodeIds") ?? "").split(",").filter(Boolean);
      const cursor = uri.searchParams.get("cursor");
      const input = {
        projectId: decodeURIComponent(uri.hostname === "projects" ? uri.pathname.split("/")[1] ?? "" : ""),
        screenId: decodeURIComponent(uri.pathname.split("/")[3] ?? ""),
        expectedRevision: revision,
        nodeIds,
        ...(cursor === null ? {} : { cursor })
      };
      const registration = tools.get("boxspec_get_context");
      if (!registration) throw new Error("Context resource is unavailable");
      const validated = await registration.inputSchema["~standard"].validate(input);
      if (validated.issues) throw new Error("Invalid BoxSpec context resource URI");
      if (inFlight >= (options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)) {
        throw new Error("BoxSpec context resource limit reached");
      }
      inFlight += 1;
      let result: CallToolResult;
      try {
        result = await invokeCore(
          core,
          options,
          "boxspec_get_context",
          input,
          context,
          registration.outputSchema
        );
      } finally {
        inFlight -= 1;
      }
      if (!isRecord(result.structuredContent) || result.structuredContent.ok !== true) {
        const code = isRecord(result.structuredContent) && typeof result.structuredContent.code === "string"
          ? result.structuredContent.code
          : "INTERNAL_ERROR";
        throw new Error(`BoxSpec context resource denied: ${code}`);
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result.structuredContent)
        }]
      };
  });
  return server;
}

export async function invokeCore(
  core: BridgeCoreUseCases,
  options: BridgeOptions,
  tool: SafeMcpToolName,
  input: unknown,
  context: ServerContext,
  outputSchema: StandardSchemaWithJSON
): Promise<CallToolResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onClientAbort = (): void => controller.abort(context.mcpReq.signal.reason);
  let resolveCancellation: ((value: { readonly kind: "cancelled" }) => void) | undefined;
  const cancellation = new Promise<{ readonly kind: "cancelled" }>((resolvePromise) => {
    resolveCancellation = resolvePromise;
  });
  const onAbort = (): void => resolveCancellation?.({ kind: "cancelled" });
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let clientAbortListenerAttached = false;
  if (context.mcpReq.signal.aborted) {
    controller.abort(context.mcpReq.signal.reason);
  } else {
    context.mcpReq.signal.addEventListener("abort", onClientAbort, { once: true });
    clientAbortListenerAttached = true;
  }
  const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("BoxSpec MCP request timed out"));
    }, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref();

  let result: unknown;
  try {
    if (controller.signal.aborted) {
      result = failure("CANCELLED", "BoxSpec request cancelled", extractRequestId(input), true);
    } else {
      const invocation = core.invoke(options.principal, tool, input, controller.signal).then(
        (value) => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error })
      );
      const settled = await Promise.race([invocation, cancellation]);
      if (settled.kind === "result") {
        result = settled.value;
      } else if (settled.kind === "error") {
        writeDiagnostic(`Core invocation failed for ${tool}`, settled.error);
        const transportCode = transportErrorCode(settled.error);
        result = failure(
          transportCode,
          transportCode === "APP_NOT_RUNNING" ? "The BoxSpec desktop runtime is not running" :
            transportCode === "PAIRING_REQUIRED" ? "BoxSpec MCP pairing is missing, expired, or invalid" :
              "BoxSpec core request failed",
          extractRequestId(input),
          transportCode !== "INTERNAL_ERROR"
        );
      } else {
        result = failure(
          "CANCELLED",
          timedOut ? "BoxSpec request timed out" : "BoxSpec request cancelled",
          extractRequestId(input),
          true
        );
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
    if (clientAbortListenerAttached) context.mcpReq.signal.removeEventListener("abort", onClientAbort);
  }

  const outputValidation = await outputSchema["~standard"].validate(result);
  if (outputValidation.issues) {
    writeDiagnostic(`Core returned an invalid ${tool} result`, outputValidation.issues);
    result = failure("INTERNAL_ERROR", "BoxSpec core returned an invalid tool result", extractRequestId(input), false);
  }

  const maxBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  let serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    result = failure(
      "RESOURCE_LIMIT",
      `Tool result exceeds the ${maxBytes} byte bridge limit`,
      extractRequestId(input),
      true
    );
    serialized = JSON.stringify(result);
  }
  return {
    content: [{ type: "text", text: serialized }],
    structuredContent: result,
    ...(!isRecord(result) || result.ok !== true ? { isError: true } : {})
  };
}

function writeDiagnostic(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${safeDescribe(error)}`;
  process.stderr.write(`[boxspec-mcp] ${message}${suffix}\n`);
}

function safeDescribe(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4096);
  } catch {
    return String(value).slice(0, 4096);
  }
}

function protocolResult(result: ToolResult<unknown>, ok: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(!ok ? { isError: true } : {})
  };
}

function invalidRequest(
  input: unknown,
  issues: readonly unknown[]
): ToolResult<never> {
  return failure("INVALID_REQUEST", "Tool input did not match the advertised schema", extractRequestId(input), true, {
    validationErrors: issues.slice(0, 20).map(formatValidationIssue)
  });
}

function formatValidationIssue(issue: unknown): { readonly path: string; readonly message: string } {
  if (!isRecord(issue)) return { path: "", message: "invalid" };
  const rawPath = Array.isArray(issue.path) ? issue.path : [];
  return {
    path: rawPath.map((segment: unknown) => {
      if (isRecord(segment) && (typeof segment.key === "string" || typeof segment.key === "number")) {
        return String(segment.key);
      }
      return typeof segment === "string" || typeof segment === "number" ? String(segment) : "?";
    }).join("/"),
    message: typeof issue.message === "string" ? issue.message : "invalid"
  };
}

function failure(
  code: BoxSpecErrorCode,
  message: string,
  requestId: RequestId,
  recoverable: boolean,
  details?: Record<string, unknown>
): ToolResult<never> {
  return {
    ok: false,
    code,
    message,
    recoverable,
    requestId,
    ...(details === undefined ? {} : { details: details as never })
  };
}

function transportErrorCode(error: unknown): "APP_NOT_RUNNING" | "PAIRING_REQUIRED" | "INTERNAL_ERROR" {
  if (isRecord(error) && error.code === "APP_NOT_RUNNING") return "APP_NOT_RUNNING";
  if (isRecord(error) && error.code === "PAIRING_REQUIRED") return "PAIRING_REQUIRED";
  return "INTERNAL_ERROR";
}

function extractRequestId(input: unknown): RequestId {
  if (isRecord(input) && typeof input.requestId === "string" && input.requestId.length <= 128) {
    return input.requestId as RequestId;
  }
  return `bridge-${randomUUID()}` as RequestId;
}

function assertOptions(options: BridgeOptions): void {
  if (options.principal.kind !== "mcp-client" || options.principal.principalId.length === 0 || options.principal.grantId.length === 0) {
    throw new Error("A paired MCP principal and short-lived grant are required");
  }
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)) {
    throw new Error("requestTimeoutMs must be a positive integer");
  }
  if (options.maxRequestBytes !== undefined && (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1024)) {
    throw new Error("maxRequestBytes must be an integer of at least 1024");
  }
  if (options.maxResultBytes !== undefined && (!Number.isSafeInteger(options.maxResultBytes) || options.maxResultBytes < 1024)) {
    throw new Error("maxResultBytes must be an integer of at least 1024");
  }
  if (options.maxConcurrentRequests !== undefined && (!Number.isSafeInteger(options.maxConcurrentRequests) || options.maxConcurrentRequests < 1)) {
    throw new Error("maxConcurrentRequests must be a positive integer");
  }
}
