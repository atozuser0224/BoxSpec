import { randomUUID } from "node:crypto";
import type { RequestId } from "@boxspec/shared/domain";
import type { CoreIpcClient, CoreUseCases } from "@boxspec/shared/runtime";
import { isRecord } from "./catalog.js";

/**
 * Adapt one authenticated, connection-bound Core IPC channel to the bridge.
 * The principal argument is deliberately not serialized; the IPC session owns identity.
 */
export function createIpcCoreAdapter(client: CoreIpcClient): CoreUseCases {
  return {
    async invoke(_principal, tool, input, signal) {
      const requestId = getRequestId(input);
      const response = await client.invoke({
        protocolVersion: "1.0.0",
        channel: "mcp",
        requestId,
        tool,
        payload: input
      }, signal);
      if (response.protocolVersion !== "1.0.0" || response.requestId !== requestId) {
        throw new Error("Core IPC response binding mismatch");
      }
      return response.result;
    }
  };
}

function getRequestId(input: unknown): RequestId {
  if (isRecord(input) && typeof input.requestId === "string" && input.requestId.length <= 128) {
    return input.requestId as RequestId;
  }
  return `mcp-${randomUUID()}` as RequestId;
}
