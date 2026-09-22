import { CoreError } from "./errors.js";
import { canonicalJson, cloneContract, ordinalCompare, sha256 } from "./canonical.js";
import type { Actor, LayoutContract, LayoutNode, LayoutOverride, Policy, PolicyLock } from "./model.js";
import { parseLayoutContract } from "./validation.js";

function decodeSegment(segment: string): string { return segment.replaceAll("~1", "/").replaceAll("~0", "~"); }
function segments(path: string): string[] {
  if (!path.startsWith("/layout/")) throw new CoreError("POLICY_VIOLATION", `Only layout scalar paths are supported: '${path}'`, { path });
  return path.slice(1).split("/").map(decodeSegment);
}
function matches(lock: PolicyLock, path: string): boolean { return path === lock.path || path.startsWith(`${lock.path}/`); }
export function policyForPath(contract: LayoutContract, node: LayoutNode, path: string): PolicyLock | { path: string; policy: "hard" | "free" } {
  const matchesBySpecificity = node.locks.filter((lock) => matches(lock, path)).sort((a, b) => b.path.length - a.path.length);
  return matchesBySpecificity[0] ?? { path: "/layout", policy: contract.defaultPolicy.layout };
}
function descendantsOf(contract: LayoutContract, nodeId: string): LayoutNode[] {
  const result: LayoutNode[] = [];
  const queue = [nodeId];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const node of contract.nodes) if (node.parentId === parentId) { result.push(node); queue.push(node.id); }
  }
  return result;
}
function assertNoAncestorBypass(contract: LayoutContract, node: LayoutNode, path: string, actor: Actor): void {
  if (actor.kind !== "agent" || !path.startsWith("/layout/")) return;
  const impactedNodes = path.startsWith("/layout/width") || path.startsWith("/layout/height") ? [node, ...descendantsOf(contract, node.id)] : descendantsOf(contract, node.id);
  const protectedDescendants = impactedNodes.filter((descendant) =>
    descendant.locks.some((lock) => lock.policy === "hard" && (lock.path === "/layout" || lock.path.startsWith("/layout/"))) ||
    contract.assertions.some((assertion) => (assertion.kind === "numeric" || assertion.kind === "relation") && (assertion.nodeId === descendant.id || (assertion.kind === "relation" && assertion.otherNodeId === descendant.id))),
  );
  if (protectedDescendants.length) throw new CoreError("POLICY_VIOLATION", `Ancestor layout change '${path}' could move hard-constrained descendants`, { nodeId: node.id, path, descendantNodeIds: protectedDescendants.map((item) => item.id) });
}
function setScalar(target: object, path: string, value: LayoutOverride["value"]): void {
  const parts = segments(path);
  let cursor: Record<string, unknown> = target as Record<string, unknown>;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) throw new CoreError("POLICY_VIOLATION", `Override path '${path}' does not resolve to an existing scalar leaf`, { path });
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts.at(-1)!;
  if (!(leaf in cursor) || (cursor[leaf] !== null && typeof cursor[leaf] === "object")) throw new CoreError("POLICY_VIOLATION", `Override path '${path}' does not resolve to an existing scalar leaf`, { path });
  if (typeof cursor[leaf] !== typeof value && !(cursor[leaf] === null && value === null)) throw new CoreError("POLICY_VIOLATION", `Override value has a different scalar type at '${path}'`, { path });
  cursor[leaf] = value;
}
function valueAt(source: unknown, path: string): { found: boolean; value?: unknown } {
  let current = source;
  for (const key of path.split("/").slice(1).map(decodeSegment)) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(key in current)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}
export interface EffectiveContract { contract: LayoutContract; baseContractHash: string; effectiveContractHash: string; layoutOverridesHash: string }
export function applyLayoutOverrides(base: LayoutContract, overrides: readonly LayoutOverride[], actor: Actor = { kind: "agent", id: "agent" }): EffectiveContract {
  const effective = cloneContract(base);
  const seen = new Set<string>();
  for (const override of overrides) {
    const key = `${override.nodeId}:${override.path}`;
    if (seen.has(key)) throw new CoreError("POLICY_VIOLATION", `Duplicate override '${key}'`, { nodeId: override.nodeId, path: override.path });
    seen.add(key);
    const node = effective.nodes.find((candidate) => candidate.id === override.nodeId);
    if (!node) throw new CoreError("POLICY_VIOLATION", `Override node '${override.nodeId}' does not exist`, { nodeId: override.nodeId });
    const policy = policyForPath(base, node, override.path);
    assertNoAncestorBypass(base, node, override.path, actor);
    if (actor.kind === "agent" && policy.policy === "hard") throw new CoreError("POLICY_VIOLATION", `Hard path '${override.path}' cannot be changed by an agent`, { nodeId: node.id, path: override.path, policy: "hard" });
    if (policy.policy === "soft") {
      if (typeof override.value !== "number" || override.value < policy.min || override.value > policy.max) throw new CoreError("POLICY_VIOLATION", `Value for soft path '${override.path}' must be within [${policy.min}, ${policy.max}]`, { nodeId: node.id, path: override.path, value: override.value, min: policy.min, max: policy.max });
    }
    setScalar(node, override.path, override.value);
  }
  const contract = parseLayoutContract(effective);
  return { contract, baseContractHash: sha256(canonicalJson(base)), effectiveContractHash: sha256(canonicalJson(contract)), layoutOverridesHash: sha256(canonicalJson(overrides)) };
}

function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (deepEqualExact(before, after)) return [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) return [path || "/"];
  return [...new Set([...Object.keys(before as object), ...Object.keys(after as object)])].sort(ordinalCompare).flatMap((key) => changedPaths((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${path}/${key}`));
}
function deepEqualExact(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => deepEqualExact(value, right[index]));
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort(ordinalCompare), rightKeys = Object.keys(right).sort(ordinalCompare);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqualExact((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
export function assertAgentContractChangeAllowed(before: LayoutContract, after: LayoutContract, actor: Actor): void {
  if (actor.kind !== "agent") return;
  const immutableBefore = { ...before, revision: 0, nodes: [] };
  const immutableAfter = { ...after, revision: 0, nodes: [] };
  if (!deepEqualExact(immutableBefore, immutableAfter)) {
    const paths = changedPaths(immutableBefore, immutableAfter).filter((path) => path !== "/revision" && path !== "/nodes");
    throw new CoreError("POLICY_VIOLATION", "Agent replace-contract cannot change contract policy, verification, assertions, breakpoints, target, design system, identity, or metadata", { paths });
  }
  const beforeIds = before.nodes.map((n) => n.id).sort();
  const afterIds = after.nodes.map((n) => n.id).sort();
  if (canonicalJson(beforeIds) !== canonicalJson(afterIds)) throw new CoreError("POLICY_VIOLATION", "Agent cannot create or delete nodes", {});
  for (const oldNode of before.nodes) {
    const newNode = after.nodes.find((node) => node.id === oldNode.id)!;
    if (oldNode.parentId !== newNode.parentId || oldNode.order !== newNode.order) throw new CoreError("POLICY_VIOLATION", "Agent cannot change parent or order", { nodeId: oldNode.id });
    for (const path of changedPaths(oldNode, newNode)) {
      if (path === "/locks" || path.startsWith("/locks/") || !path.startsWith("/layout/")) throw new CoreError("POLICY_VIOLATION", `Agent cannot change '${path}' through replace-contract`, { nodeId: oldNode.id, path });
      const oldTarget = valueAt(oldNode, path), newTarget = valueAt(newNode, path);
      if (!oldTarget.found || !newTarget.found || oldTarget.value === null || newTarget.value === null || typeof oldTarget.value === "object" || typeof newTarget.value === "object" || typeof oldTarget.value !== typeof newTarget.value) throw new CoreError("POLICY_VIOLATION", "Agent replace-contract may only change an existing scalar layout leaf without changing its type", { nodeId: oldNode.id, path });
      const rule = policyForPath(before, oldNode, path);
      assertNoAncestorBypass(before, oldNode, path, actor);
      if (rule.policy === "hard") throw new CoreError("POLICY_VIOLATION", `Hard path '${path}' cannot be changed by an agent`, { nodeId: oldNode.id, path });
      const value = newTarget.value;
      if (rule.policy === "soft" && (typeof value !== "number" || value < rule.min || value > rule.max)) throw new CoreError("POLICY_VIOLATION", `Soft path '${path}' is outside its range`, { nodeId: oldNode.id, path });
    }
  }
}
