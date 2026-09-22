export type UpdaterErrorCode =
  | "INVALID_MANIFEST"
  | "MISSING_TRUST"
  | "SIGNATURE_INVALID"
  | "PUBLISHER_UNTRUSTED"
  | "CHANNEL_MISMATCH"
  | "VERSION_REJECTED"
  | "REPLAY_REJECTED"
  | "SCHEMA_INCOMPATIBLE"
  | "STAGING_MISMATCH"
  | "PUBLISHER_MISMATCH"
  | "HEALTH_CHECK_FAILED"
  | "RECOVERY_BLOCKED"
  | "JOURNAL_INVALID";

export class UpdaterError extends Error {
  override readonly name = "UpdaterError";

  constructor(
    readonly code: UpdaterErrorCode,
    message: string,
    readonly recoverable = false,
  ) {
    super(message);
  }
}
