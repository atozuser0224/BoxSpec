export { analyzeAdoptedWebSource } from "./analyze.js";
export { assertAdoptedMappingCurrent, detectAdoptedMappingDrift, diffAdoptedMappings } from "./drift.js";
export { AdoptedWebError, type AdoptedWebErrorCode } from "./errors.js";
export { sourceShapeFingerprint } from "./fingerprint.js";
export { contentHash } from "./hash.js";
export { materializeAdoptedPatch } from "./patch.js";
export type * from "./types.js";
