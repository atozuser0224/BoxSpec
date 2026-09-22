import type { GrantId, Principal, ProjectId } from "@boxspec/shared/domain";
import type { CoreUseCases, SafeMcpToolName } from "@boxspec/shared/runtime";

export const LOCAL_IPC_PROTOCOL_VERSION = "1.0.0" as const;

export type GrantPermission = "read" | "candidate-write" | "verify";
export type McpPrincipal = Extract<Principal, { readonly kind: "mcp-client" }>;

export interface McpPairingProfile {
  readonly protocolVersion: typeof LOCAL_IPC_PROTOCOL_VERSION;
  readonly pipePath: string;
  readonly sessionToken: string;
  readonly principalId: string;
  readonly grantId: GrantId;
  readonly expiresAt: string;
}

export interface SessionBinding {
  readonly principalId: string;
  readonly grantId: GrantId;
  readonly projectId: ProjectId;
  readonly permissions: readonly GrantPermission[];
  readonly expiresAt: string;
}

export interface IssuePairingProfileInput extends SessionBinding {
  readonly profileName: string;
}

export interface LocalIpcHostOptions {
  readonly mcp: CoreUseCases;
  /** Re-check the durable grant and exact binding before every invocation. */
  readonly authorizeSession: (
    binding: SessionBinding,
    tool: SafeMcpToolName,
    payload: unknown,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  readonly pipePath?: string;
  readonly profileRoot?: string;
  readonly maxMessageBytes?: number;
  readonly authenticationTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly diagnostic?: (message: string, error?: unknown) => void;
}

export interface LocalIpcHost {
  readonly pipePath: string;
  start(): Promise<void>;
  issuePairingProfile(input: IssuePairingProfileInput): Promise<{ readonly profilePath: string; readonly profile: McpPairingProfile }>;
  revokeGrant(grantId: GrantId): void;
  close(): Promise<void>;
}

export interface ProfileCoreIpcClientOptions {
  readonly profileName: string;
  readonly profileRoot?: string;
  readonly maxMessageBytes?: number;
  readonly connectTimeoutMs?: number;
}

export interface ProfileCoreIpcConnection {
  readonly client: import("@boxspec/shared/runtime").CoreIpcClient;
  readonly principal: McpPrincipal;
  close(): Promise<void>;
}

export type LocalIpcErrorCode = "APP_NOT_RUNNING" | "PAIRING_REQUIRED" | "INVALID_REQUEST" | "RESOURCE_LIMIT";

export class LocalIpcError extends Error {
  override readonly name = "LocalIpcError";

  constructor(readonly code: LocalIpcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export const TOOL_PERMISSION: Readonly<Record<SafeMcpToolName, GrantPermission>> = {
  boxspec_get_capabilities: "read",
  boxspec_list_projects: "read",
  boxspec_get_selection: "read",
  boxspec_get_context: "read",
  boxspec_search_assets: "read",
  boxspec_start_task: "candidate-write",
  boxspec_get_task: "read",
  boxspec_propose_patch: "candidate-write",
  boxspec_submit_candidate: "candidate-write",
  boxspec_verify_candidate: "verify",
  boxspec_get_report: "read",
  boxspec_get_artifact: "read",
  boxspec_propose_contract_change: "candidate-write",
  boxspec_request_review: "candidate-write",
  boxspec_cancel_task: "candidate-write",
};
