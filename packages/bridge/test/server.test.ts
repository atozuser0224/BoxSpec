import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema, type JsonSchemaType, type ServerContext } from "@modelcontextprotocol/server";
import type { Principal, RequestId } from "@boxspec/shared/domain";
import type { CoreUseCases, SafeMcpToolName } from "@boxspec/shared/runtime";
import type { ToolResult } from "@boxspec/shared/errors";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_TOOL_NAMES,
  SAFE_TOOL_NAMES,
  createBoxSpecMcpServer,
  loadToolCatalog
} from "../src/index.js";
import { invokeCore } from "../src/server.js";

const principal = {
  kind: "mcp-client",
  principalId: "client-test",
  grantId: "grant-test"
} as Extract<Principal, { readonly kind: "mcp-client" }>;

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("BoxSpec MCP protocol adapter", () => {
  it("advertises exactly the checked-in safe schemas and no privileged tools", async () => {
    const core = createCore(() => capabilityResult());
    const { client } = await connect(core);
    const listed = await client.listTools();
    const source = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../contracts/mcp-tools.json"), "utf8"));

    expect(listed.tools.map((tool) => tool.name)).toEqual([...SAFE_TOOL_NAMES]);
    expect(listed.tools.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
      annotations
    }))).toEqual(source.tools.map(({ name, description, inputSchema, outputSchema, annotations }: Record<string, unknown>) => ({
      name,
      description,
      inputSchema,
      outputSchema,
      annotations
    })));
    expect(listed.tools.some((tool) => (FORBIDDEN_TOOL_NAMES as readonly string[]).includes(tool.name))).toBe(false);
  });

  it("passes the launcher principal out of band and returns structured plus text results", async () => {
    const calls: Array<{ principal: unknown; tool: string; input: unknown }> = [];
    const core = createCore((calledPrincipal, tool, input) => {
      calls.push({ principal: calledPrincipal, tool, input });
      return contextResult();
    });
    const { client } = await connect(core);

    const result = await client.callTool({
      name: "boxspec_get_context",
      arguments: {
        projectId: "project_demo",
        screenId: "dashboard",
        expectedRevision: 1,
        nodeIds: ["main"]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(contextResult());
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null")).toEqual(contextResult());
    expect(calls).toEqual([{ principal, tool: "boxspec_get_context", input: {
      projectId: "project_demo",
      screenId: "dashboard",
      expectedRevision: 1,
      nodeIds: ["main"]
    } }]);
  });

  it("denies malformed payloads before invoking core", async () => {
    let calls = 0;
    const core = createCore(() => {
      calls += 1;
      return contextResult();
    });
    const { client } = await connect(core);

    const result = await client.callTool({
      name: "boxspec_get_context",
      arguments: {
        projectId: "project_demo",
        screenId: "dashboard",
        expectedRevision: 0,
        nodeIds: [],
        principalId: "spoofed"
      }
    });
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("maps bridge timeout to a bounded CANCELLED domain result", async () => {
    const core = createCore(() => new Promise(() => undefined));
    const { client } = await connect(core, { requestTimeoutMs: 10 });

    const started = Date.now();
    const result = await client.callTool({ name: "boxspec_get_capabilities", arguments: {} });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "CANCELLED" });
  });

  it("does not invoke core when the protocol request is already cancelled", async () => {
    let calls = 0;
    const core = createCore(() => {
      calls += 1;
      return capabilityResult();
    });
    const controller = new AbortController();
    controller.abort(new Error("pre-cancelled"));
    const contract = loadToolCatalog().tools.find((tool) => tool.name === "boxspec_get_capabilities");
    expect(contract).toBeDefined();
    const outputSchema = fromJsonSchema<ToolResult<unknown>>(contract!.outputSchema as JsonSchemaType);

    const result = await invokeCore(
      core,
      { principal },
      "boxspec_get_capabilities",
      {},
      { mcpReq: { signal: controller.signal } } as unknown as ServerContext,
      outputSchema
    );

    expect(calls).toBe(0);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "CANCELLED" });
  });

  it("enforces an aggregate request byte limit before core", async () => {
    let calls = 0;
    const core = createCore(() => {
      calls += 1;
      return { ok: false, code: "NOT_FOUND", message: "not used", recoverable: false, requestId: "request-1" as RequestId };
    });
    const { client } = await connect(core, { maxRequestBytes: 1024 });
    const result = await client.callTool({
      name: "boxspec_propose_patch",
      arguments: {
        requestId: "request-large-1",
        taskId: "task_demo",
        expectedRevision: 1,
        files: [{ kind: "create", path: "src/large.tsx", content: "x".repeat(2048) }]
      }
    });
    expect(result.structuredContent).toMatchObject({ ok: false, code: "RESOURCE_LIMIT" });
    expect(calls).toBe(0);
  });

  it("routes context resources through the same grant-scoped core principal", async () => {
    const calls: Array<{ principal: unknown; tool: string }> = [];
    const core = createCore((calledPrincipal, tool) => {
      calls.push({ principal: calledPrincipal, tool });
      return contextResult();
    });
    const { client } = await connect(core);
    const result = await client.readResource({
      uri: "boxspec://projects/project_demo/screens/dashboard?revision=1&nodeIds=main"
    });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({ mimeType: "application/json" });
    expect(calls).toEqual([{ principal, tool: "boxspec_get_context" }]);
  });

  it("replaces an invalid or oversized core result instead of emitting it", async () => {
    const invalid = createCore(() => ({ ok: true, data: { secret: "must-not-leak" } }));
    const first = await connect(invalid);
    const invalidResult = await first.client.callTool({ name: "boxspec_get_capabilities", arguments: {} });
    expect(invalidResult.structuredContent).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(invalidResult)).not.toContain("must-not-leak");

    const oversized = createCore(() => contextResult("x".repeat(4096)));
    const second = await connect(oversized, { maxResultBytes: 1024 });
    const largeResult = await second.client.callTool({
      name: "boxspec_get_context",
      arguments: { projectId: "project_demo", screenId: "dashboard", expectedRevision: 1, nodeIds: ["main"] }
    });
    expect(largeResult.structuredContent).toMatchObject({ ok: false, code: "RESOURCE_LIMIT" });
  });

  it("fails closed if the local catalog drifts from the shared safe-tool set", () => {
    const catalog = loadToolCatalog();
    expect(catalog.tools).toHaveLength(15);
  });

  it("dispatches every advertised safe tool through its exact input/output contract", async () => {
    const called: string[] = [];
    const core = createCore((_principal, tool, input) => {
      called.push(tool);
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "contract test denial",
        recoverable: false,
        requestId: requestIdOf(input)
      };
    });
    const { client } = await connect(core);
    for (const [name, argumentsValue] of Object.entries(validInputs)) {
      const result = await client.callTool({ name, arguments: argumentsValue });
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    expect(called).toEqual([...SAFE_TOOL_NAMES]);
  });
});

const validInputs: Readonly<Record<string, Record<string, unknown>>> = {
  boxspec_get_capabilities: {},
  boxspec_list_projects: {},
  boxspec_get_selection: { projectId: "project_demo" },
  boxspec_get_context: { projectId: "project_demo", screenId: "dashboard", expectedRevision: 1, nodeIds: ["main"] },
  boxspec_search_assets: { projectId: "project_demo", query: "logo" },
  boxspec_start_task: { requestId: "request-start", projectId: "project_demo", screenId: "dashboard", expectedRevision: 1, scopeNodeIds: ["main"], objective: "Implement list", executionProfileId: "profile_demo" },
  boxspec_get_task: { taskId: "task_demo" },
  boxspec_propose_patch: { requestId: "request-patch", taskId: "task_demo", expectedRevision: 1, files: [{ kind: "create", path: "src/boxspec/List.tsx", content: "export {};" }] },
  boxspec_submit_candidate: { requestId: "request-submit", taskId: "task_demo", expectedRevision: 1, summary: "ready" },
  boxspec_verify_candidate: { requestId: "request-verify", taskId: "task_demo", candidateId: "candidate_demo", verificationProfileId: "profile_demo" },
  boxspec_get_report: { reportId: "report_demo" },
  boxspec_get_artifact: { artifactId: "artifact_demo", representation: "metadata" },
  boxspec_propose_contract_change: { requestId: "request-contract", projectId: "project_demo", screenId: "dashboard", expectedRevision: 1, reason: "Need room", proposedContractJson: "{}" },
  boxspec_request_review: { requestId: "request-review", taskId: "task_demo", candidateId: "candidate_demo", reportId: "report_demo" },
  boxspec_cancel_task: { requestId: "request-cancel", taskId: "task_demo", reason: "stop" }
};

function requestIdOf(input: unknown): RequestId {
  return (typeof input === "object" && input !== null && "requestId" in input && typeof input.requestId === "string"
    ? input.requestId
    : "read-contract-test") as RequestId;
}

function createCore(
  implementation: (
    principal: Extract<Principal, { readonly kind: "mcp-client" }>,
    tool: SafeMcpToolName,
    input: unknown,
    signal?: AbortSignal
  ) => ToolResult<unknown> | Promise<ToolResult<unknown>>
): CoreUseCases {
  return { invoke: async (calledPrincipal, tool, input, signal) => implementation(calledPrincipal, tool, input, signal) };
}

async function connect(
  core: CoreUseCases,
  overrides: { requestTimeoutMs?: number; maxRequestBytes?: number; maxResultBytes?: number } = {}
): Promise<{ client: Client }> {
  const server = createBoxSpecMcpServer(core, { principal, ...overrides });
  const client = new Client({ name: "boxspec-bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client };
}

function capabilityResult(): ToolResult<unknown> {
  return {
    ok: true,
    data: {
      serverVersion: "0.1.0",
      toolSchemaVersion: "1.0.0",
      contractVersions: ["1.0.0"],
      protocolVersion: "2026-07-28",
      appRunning: true,
      adapters: [{ target: "web-react", status: "available", reason: "test core" }],
      maxPatchBytes: 262144
    }
  };
}

function contextResult(designSystemJson = "{}"): ToolResult<unknown> {
  return {
    ok: true,
    data: {
      projectId: "project_demo",
      screenId: "dashboard",
      revision: 1,
      contextHash: "a".repeat(64),
      schemaVersion: "1.0.0",
      contractSliceJson: JSON.stringify({ kind: "context-slice" }),
      designSystemJson,
      bindingsJson: "{}",
      scopeNodeIds: ["main"],
      affectedNodeIds: ["main"],
      protectedPaths: ["package.json"],
      nextCursor: null
    }
  };
}
