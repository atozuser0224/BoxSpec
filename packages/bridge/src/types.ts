import type { Principal } from "@boxspec/shared/domain";
import type { CoreUseCases, SafeMcpToolName } from "@boxspec/shared/runtime";

export type { CoreUseCases as BridgeCoreUseCases, SafeMcpToolName };

export type McpPrincipal = Extract<Principal, { readonly kind: "mcp-client" }>;

export interface BridgeOptions {
  /** Obtained from the trusted pairing/launcher channel, never from tool arguments. */
  readonly principal: McpPrincipal;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxConcurrentRequests?: number;
  readonly serverVersion?: string;
}

export interface JsonSchema {
  readonly [key: string]: unknown;
}

export interface ToolContract {
  readonly name: SafeMcpToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export interface ToolCatalog {
  readonly schemaVersion: "1.0.0";
  readonly transport: "stdio";
  readonly tools: readonly ToolContract[];
}
