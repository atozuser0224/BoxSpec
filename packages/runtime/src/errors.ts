export type RuntimeErrorCode =
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

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly recoverable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: { recoverable?: boolean; details?: Readonly<Record<string, unknown>>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.details = options.details;
  }
}

export function mapRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (isRecord(error) && typeof error.code === "string") {
    const mapped = CORE_ERROR_MAP[error.code];
    if (mapped) {
      return new RuntimeError(mapped, error instanceof Error ? error.message : String(error.message ?? error.code), {
        recoverable: mapped === "REVISION_CONFLICT" || mapped === "APPLY_CONFLICT",
        ...(isRecord(error.details) ? { details: error.details } : {}),
        cause: error,
      });
    }
  }
  if (isRecord(error) && typeof error.code === "string" && isRuntimeErrorCode(error.code)) {
    return new RuntimeError(error.code, error instanceof Error ? error.message : String(error.message ?? error.code), {
      recoverable: error.recoverable === true,
      ...(isRecord(error.details) ? { details: error.details } : {}),
      cause: error,
    });
  }
  return new RuntimeError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected runtime error", {
    cause: error,
  });
}

const CORE_ERROR_MAP: Readonly<Record<string, RuntimeErrorCode>> = {
  SCHEMA_INVALID: "INVALID_REQUEST",
  SEMANTIC_INVALID: "INVALID_REQUEST",
  IMPORT_INVALID: "INVALID_REQUEST",
  POLICY_VIOLATION: "CONSTRAINT_CONFLICT",
  COMMAND_ID_CONFLICT: "IDEMPOTENCY_CONFLICT",
  EXPORT_DRIFT: "APPLY_CONFLICT",
  UNSUPPORTED_TARGET: "UNSUPPORTED_ADAPTER",
  UNSUPPORTED_SCHEMA_VERSION: "UNSUPPORTED_CAPABILITY",
  READ_ONLY: "UNSUPPORTED_CAPABILITY",
  MIGRATION_FAILED: "INVALID_REQUEST",
  PERSISTENCE_ERROR: "INTERNAL_ERROR",
  THEME_NOT_FOUND: "NOT_FOUND",
  THEME_REVISION_CONFLICT: "REVISION_CONFLICT",
  THEME_APPLICATION_INVALID: "CONSTRAINT_CONFLICT",
  THEME_CATALOG_INVALID: "INTERNAL_ERROR",
};

function isRuntimeErrorCode(value: string): value is RuntimeErrorCode {
  return ERROR_CODES.has(value as RuntimeErrorCode);
}

const ERROR_CODES = new Set<RuntimeErrorCode>([
  "APP_NOT_RUNNING", "PAIRING_REQUIRED", "PROJECT_NOT_GRANTED", "REVISION_CONFLICT", "OUT_OF_SCOPE",
  "PROTECTED_PATH", "CONSTRAINT_CONFLICT", "UNSUPPORTED_ADAPTER", "UNSUPPORTED_CAPABILITY",
  "EXECUTION_APPROVAL_REQUIRED", "CANDIDATE_STALE", "VERIFY_FAILED", "CANCELLED", "RESOURCE_LIMIT",
  "DIRTY_BASELINE", "APPLY_CONFLICT", "INVALID_REQUEST", "IDEMPOTENCY_CONFLICT", "NOT_FOUND", "INTERNAL_ERROR",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
