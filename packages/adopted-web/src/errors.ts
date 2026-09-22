export type AdoptedWebErrorCode = "INVALID_INPUT" | "CONTEXT_NOT_APPROVED" | "SOURCE_STALE" | "MAPPING_STALE";

export class AdoptedWebError extends Error {
  readonly code: AdoptedWebErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: AdoptedWebErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "AdoptedWebError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
