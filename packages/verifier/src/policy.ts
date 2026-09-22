import type { VerificationPolicy, Violation, FrozenCandidateDescriptor } from "./types.js";
import { normalizeRelativePath } from "./hash.js";

function matches(path: string, rule: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRule = rule.replaceAll("\\", "/");
  if (normalizedRule === "**") return true;
  if (normalizedRule.endsWith("/**")) {
    const prefix = normalizedRule.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedRule.endsWith("/")) return normalizedPath.startsWith(normalizedRule);
  return normalizedPath === normalizedRule;
}

export function evaluatePolicy(candidate: FrozenCandidateDescriptor, policy: VerificationPolicy): Violation[] {
  const violations: Violation[] = [];
  const changeByPath = new Map<string, FrozenCandidateDescriptor["changes"][number]>();
  for (const change of candidate.changes) {
    let normalized: string;
    try {
      normalized = normalizeRelativePath(change.relativePath);
    } catch (error) {
      violations.push({ id: `policy:unsafe-change:${violations.length}`, checkId: "policy", kind: "unsafe-change-path", severity: "error", blocking: true, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (changeByPath.has(normalized)) {
      violations.push({ id: `policy:duplicate-change:${normalized}`, checkId: "policy", kind: "duplicate-change", severity: "error", blocking: true, message: `Candidate change is duplicated: ${normalized}` });
    } else changeByPath.set(normalized, change);
  }
  const changedPaths = new Set<string>();
  for (const changedPath of candidate.changedPaths) {
    let normalized: string;
    try {
      normalized = normalizeRelativePath(changedPath);
    } catch (error) {
      violations.push({ id: `policy:unsafe:${violations.length}`, checkId: "policy", kind: "unsafe-changed-path", severity: "error", blocking: true, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (changedPaths.has(normalized)) {
      violations.push({ id: `policy:duplicate:${normalized}`, checkId: "policy", kind: "duplicate-changed-path", severity: "error", blocking: true, message: `Changed path is duplicated: ${normalized}` });
      continue;
    }
    changedPaths.add(normalized);
    const change = changeByPath.get(normalized);
    if (!change) {
      violations.push({ id: `policy:unbound:${normalized}`, checkId: "policy", kind: "changed-path-unbound", severity: "error", blocking: true, message: `Changed path has no bound change record: ${normalized}` });
    } else {
      const file = candidate.files.find((entry) => entry.relativePath === normalized);
      if (change.afterSha256 === null) {
        if (file) violations.push({ id: `policy:delete-present:${normalized}`, checkId: "policy", kind: "deleted-path-present", severity: "error", blocking: true, message: `Deleted path is still present in the frozen snapshot: ${normalized}` });
      } else if (!file || file.sha256 !== change.afterSha256 || file.size !== change.afterSize) {
        violations.push({ id: `policy:change-mismatch:${normalized}`, checkId: "policy", kind: "change-manifest-mismatch", severity: "error", blocking: true, message: `Changed path does not match its frozen after identity: ${normalized}` });
      }
    }
    if (policy.protectedPaths.some((rule) => matches(normalized, rule))) {
      violations.push({
        id: `policy:protected:${normalized}`,
        checkId: "policy",
        kind: "protected-path",
        severity: "error",
        blocking: true,
        message: `Candidate changes protected path ${normalized}`,
        actual: normalized,
      });
    }
    if (policy.allowedPaths.length > 0 && !policy.allowedPaths.some((rule) => matches(normalized, rule))) {
      violations.push({
        id: `policy:outside-allowed:${normalized}`,
        checkId: "policy",
        kind: "outside-allowed-path",
        severity: "error",
        blocking: true,
        message: `Changed path is outside the approved scope: ${normalized}`,
        actual: normalized,
      });
    }
  }
  for (const relativePath of changeByPath.keys()) {
    if (!changedPaths.has(relativePath)) {
      violations.push({ id: `policy:change-not-listed:${relativePath}`, checkId: "policy", kind: "change-not-listed", severity: "error", blocking: true, message: `Change record is absent from changedPaths: ${relativePath}` });
    }
  }
  for (const [relativePath, expectedHash] of Object.entries(policy.generatedFiles ?? {})) {
    const file = candidate.files.find((entry) => entry.relativePath.replaceAll("\\", "/") === relativePath.replaceAll("\\", "/"));
    if (!file || file.sha256 !== expectedHash) {
      violations.push({
        id: `policy:generated:${relativePath}`,
        checkId: "policy",
        kind: "generated-file-mismatch",
        severity: "error",
        blocking: true,
        message: `Generator-owned file does not match its trusted hash: ${relativePath}`,
        expected: expectedHash,
        actual: file?.sha256 ?? null,
      });
    }
  }
  return violations;
}
