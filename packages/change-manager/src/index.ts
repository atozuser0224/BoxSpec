export { createChangeManager } from "./manager.js";
export { computeCandidateTreeHash, sha256 } from "./hash.js";
/**
 * Trusted desktop/runtime integration only. This helper enforces filesystem
 * identity and hash preconditions; it is not an approval or authorization boundary.
 * Never expose it through MCP or accept its binary/path inputs from a project.
 */
export {
  NativeSafeFsClient,
  type EnsuredDirectory,
  type NativeBoundPrepared,
  type NativeEntryIdentity,
  type NativeRootIdentity,
  type PreparedReplacement,
  type RecoveryClassification,
} from "./native-safe-fs.js";
export {
  canonicalizeGrantedRoot,
  normalizeRelativePath,
  normalizeScopeEntry,
  pathMatchesScope,
  resolveSafeProjectPath,
  windowsCollisionKey,
} from "./path-safety.js";
export * from "./types.js";
