import type { RequestId } from "@boxspec/shared/domain";
import type { CoreIpcRequest, CoreIpcResponse, SafeMcpToolName } from "@boxspec/shared/runtime";
import { SAFE_MCP_TOOL_NAMES } from "@boxspec/shared/runtime";
import { LOCAL_IPC_PROTOCOL_VERSION } from "./types.js";

export interface AuthenticateFrame {
  readonly type: "authenticate";
  readonly protocolVersion: typeof LOCAL_IPC_PROTOCOL_VERSION;
  readonly sessionToken: string;
}

export interface AuthenticatedFrame {
  readonly type: "authenticated";
  readonly protocolVersion: typeof LOCAL_IPC_PROTOCOL_VERSION;
}

export interface AuthenticationErrorFrame {
  readonly type: "authentication_error";
  readonly protocolVersion: typeof LOCAL_IPC_PROTOCOL_VERSION;
  readonly code: "PAIRING_REQUIRED";
}

export interface CancelFrame {
  readonly type: "cancel";
  readonly protocolVersion: typeof LOCAL_IPC_PROTOCOL_VERSION;
  readonly requestId: RequestId;
}

const safeTools = new Set<string>(SAFE_MCP_TOOL_NAMES);

export function isAuthenticateFrame(value: unknown): value is AuthenticateFrame {
  return isExactRecord(value, ["protocolVersion", "sessionToken", "type"])
    && value.type === "authenticate"
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION
    && typeof value.sessionToken === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value.sessionToken);
}

export function isAuthenticatedFrame(value: unknown): value is AuthenticatedFrame {
  return isExactRecord(value, ["protocolVersion", "type"])
    && value.type === "authenticated"
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION;
}

export function isAuthenticationErrorFrame(value: unknown): value is AuthenticationErrorFrame {
  return isExactRecord(value, ["code", "protocolVersion", "type"])
    && value.type === "authentication_error"
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION
    && value.code === "PAIRING_REQUIRED";
}

export function isCancelFrame(value: unknown): value is CancelFrame {
  return isExactRecord(value, ["protocolVersion", "requestId", "type"])
    && value.type === "cancel"
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION
    && isRequestId(value.requestId);
}

export function parseMcpRequest(value: unknown): Extract<CoreIpcRequest, { readonly channel: "mcp" }> | null {
  if (!isExactRecord(value, ["channel", "payload", "protocolVersion", "requestId", "tool"])) return null;
  if (value.protocolVersion !== LOCAL_IPC_PROTOCOL_VERSION || value.channel !== "mcp") return null;
  if (!isRequestId(value.requestId) || typeof value.tool !== "string" || !safeTools.has(value.tool)) return null;
  if (containsCallerIdentity(value.payload)) return null;
  return value as unknown as Extract<CoreIpcRequest, { readonly channel: "mcp" }>;
}

export function isCoreIpcResponse(value: unknown): value is CoreIpcResponse {
  return isExactRecord(value, ["protocolVersion", "requestId", "result"])
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION
    && isRequestId(value.requestId)
    && isRecord(value.result)
    && typeof value.result.ok === "boolean";
}

export function isSafeMcpToolName(value: string): value is SafeMcpToolName {
  return safeTools.has(value);
}

function containsCallerIdentity(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return ["principal", "principalId", "grantId", "role", "channel"].some((key) => Object.hasOwn(payload, key));
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\r\n\0]/u.test(value);
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
