export { createProfileCoreIpcClient } from "./client.js";
export { createLocalIpcHost } from "./host.js";
export { assertSafeProfileName, defaultProfileRoot, loadProfile, persistProfile, profilePath, verifyProfileAccess } from "./profile.js";
export { LOCAL_IPC_PROTOCOL_VERSION, LocalIpcError, TOOL_PERMISSION } from "./types.js";
export type {
  GrantPermission,
  IssuePairingProfileInput,
  LocalIpcErrorCode,
  LocalIpcHost,
  LocalIpcHostOptions,
  McpPairingProfile,
  McpPrincipal,
  ProfileCoreIpcClientOptions,
  ProfileCoreIpcConnection,
  SessionBinding,
} from "./types.js";
