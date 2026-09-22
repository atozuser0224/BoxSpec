import { createHash } from "node:crypto";
import type { CandidateFile } from "./types.js";

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeCandidateTreeHash(files: readonly CandidateFile[]): string {
  const hash = createHash("sha256");
  hash.update("boxspec-candidate-tree-v1\0", "utf8");
  for (const file of [...files].sort((left, right) => compareOrdinal(left.relativePath, right.relativePath))) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(String(pathBytes.byteLength));
    hash.update(":");
    hash.update(pathBytes);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(file.executable ? "x" : "-");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sameCandidateIdentity(
  left: import("./types.js").CandidateIdentity,
  right: import("./types.js").CandidateIdentity,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.treeHash === right.treeHash &&
    left.baseContractHash === right.baseContractHash &&
    left.contractHash === right.contractHash &&
    left.effectiveContractHash === right.effectiveContractHash &&
    left.layoutOverridesHash === right.layoutOverridesHash &&
    left.policyHash === right.policyHash &&
    left.dependencyLockHash === right.dependencyLockHash &&
    left.fixturesHash === right.fixturesHash &&
    left.verificationProfileHash === right.verificationProfileHash &&
    left.verificationProfileId === right.verificationProfileId &&
    left.generatorVersion === right.generatorVersion &&
    left.baseCommitHash === right.baseCommitHash &&
    left.baseManifestHash === right.baseManifestHash &&
    left.baseContractRevision === right.baseContractRevision &&
    left.policyRevision === right.policyRevision
  );
}
