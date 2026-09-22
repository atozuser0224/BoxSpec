import type { JsonObject, RequestId } from "./domain.js";

export type BoxSpecErrorCode =
  | "APP_NOT_RUNNING"
  | "PAIRING_REQUIRED"
  | "PROJECT_NOT_GRANTED"
  | "REVISION_CONFLICT"
  | "OUT_OF_SCOPE"
  | "PROTECTED_PATH"
  | "CONSTRAINT_CONFLICT"
  | "UNSUPPORTED_ADAPTER"
  | "UNSUPPORTED_CAPABILITY"
  | "EXECUTION_APPROVAL_REQUIRED"
  | "CANDIDATE_STALE"
  | "VERIFY_FAILED"
  | "CANCELLED"
  | "RESOURCE_LIMIT"
  | "DIRTY_BASELINE"
  | "APPLY_CONFLICT"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export interface BoxSpecError {
  readonly code: BoxSpecErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly requestId: RequestId;
  readonly details?: JsonObject;
}

export type ToolResult<Value> =
  | { readonly ok: true; readonly data: Value }
  | ({ readonly ok: false } & BoxSpecError);

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`);
}
