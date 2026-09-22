export type CoreErrorCode = "SCHEMA_INVALID" | "SEMANTIC_INVALID" | "CONSTRAINT_CONFLICT" | "POLICY_VIOLATION" | "REVISION_CONFLICT" | "COMMAND_ID_CONFLICT" | "NOT_FOUND" | "IMPORT_INVALID" | "EXPORT_DRIFT" | "UNSUPPORTED_TARGET" | "UNSUPPORTED_SCHEMA_VERSION" | "READ_ONLY" | "MIGRATION_FAILED" | "PERSISTENCE_ERROR";

export class CoreError extends Error {
  override readonly name = "CoreError";
  constructor(readonly code: CoreErrorCode, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
