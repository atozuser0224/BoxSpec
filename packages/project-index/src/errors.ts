export type ProjectIndexErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_PATH"
  | "OUT_OF_SCOPE"
  | "ALIAS_REJECTED"
  | "RESOURCE_LIMIT"
  | "ASSET_NOT_FOUND"
  | "ASSET_CHANGED"
  | "GRAPH_CONFLICT"
  | "CANCELLED";

export class ProjectIndexError extends Error {
  readonly code: ProjectIndexErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ProjectIndexErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ProjectIndexError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProjectIndexError("CANCELLED", "Project indexing was cancelled");
}
