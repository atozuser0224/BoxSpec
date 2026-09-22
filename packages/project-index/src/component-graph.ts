import type { ContractNode, LayoutContract } from "@boxspec/shared/contracts";
import type { JsonValue } from "@boxspec/shared/domain";
import { hashProjectIndexProjection } from "./canonical.js";
import { ProjectIndexError } from "./errors.js";
import { normalizeProjectRelativePath } from "./path-safety.js";

export interface ManagedComponentConsumer {
  readonly projectId: string;
  readonly screenId: string;
  readonly nodeId: string;
  readonly componentKey: string;
  readonly sourcePath: string | null;
  readonly exportName: string | null;
}

export interface ManagedComponentRecord {
  readonly componentKey: string;
  readonly sourcePath: string | null;
  readonly exportName: string | null;
  readonly consumers: readonly ManagedComponentConsumer[];
}

export interface ManagedReactGraph {
  readonly projectId: string;
  readonly indexRevision: number;
  readonly graphHash: string;
  readonly screens: readonly string[];
  readonly components: readonly ManagedComponentRecord[];
  readonly contracts: ReadonlyMap<string, LayoutContract>;
}

export interface DependencyClosureInput {
  readonly screenId: string;
  readonly selectedNodeIds: readonly string[];
  readonly changedComponentKeys?: readonly string[];
}

export type DependencyReason = "selected" | "descendant" | "ancestor" | "sibling" | "shared-component-consumer";

export interface AffectedNode {
  readonly screenId: string;
  readonly nodeId: string;
  readonly reasons: readonly DependencyReason[];
}

export interface DependencyClosure {
  readonly projectId: string;
  readonly sourceScreenId: string;
  readonly selectedNodeIds: readonly string[];
  readonly changedComponentKeys: readonly string[];
  readonly affectedScreenIds: readonly string[];
  readonly nodes: readonly AffectedNode[];
  readonly requiresAllScreenReverification: boolean;
  readonly model: "managed-react-slot-bindings-v1";
}

export interface TrustedClosurePacket {
  readonly schemaVersion: "1.0.0";
  readonly resolver: {
    readonly packageName: "@boxspec/project-index";
    readonly packageVersion: "0.1.0";
    readonly model: "managed-react-slot-bindings-v1";
    readonly algorithm: "boxspec-project-closure-v1";
  };
  readonly projectId: string;
  readonly indexRevision: number;
  readonly graphHash: string;
  readonly sourceScreenId: string;
  readonly selectedNodeIds: readonly string[];
  readonly selectedPaths: readonly string[];
  readonly changedComponentKeys: readonly string[];
  readonly affectedScreenIds: readonly string[];
  readonly affectedNodes: readonly AffectedNode[];
  readonly affectedSourcePaths: readonly string[];
}

export interface HashedTrustedClosure {
  readonly packet: TrustedClosurePacket;
  readonly closureHash: string;
}

export function buildManagedReactGraph(contracts: readonly LayoutContract[], options: { readonly indexRevision: number }): ManagedReactGraph {
  if (contracts.length === 0 || contracts.length > 1_000) throw new ProjectIndexError("INVALID_CONFIG", "One to 1000 screen contracts are required");
  if (!Number.isSafeInteger(options.indexRevision) || options.indexRevision < 1) throw new ProjectIndexError("INVALID_CONFIG", "indexRevision must be a positive integer");
  const projectId = contracts[0]!.projectId;
  const byScreen = new Map<string, LayoutContract>();
  const consumers = new Map<string, ManagedComponentConsumer[]>();
  const identities = new Map<string, string>();
  for (const contract of contracts) {
    if (contract.projectId !== projectId) throw new ProjectIndexError("GRAPH_CONFLICT", "Dependency graph cannot mix projects");
    if (contract.target !== "web-react") throw new ProjectIndexError("GRAPH_CONFLICT", "Only managed React contracts are supported by this graph");
    if (byScreen.has(contract.screenId)) throw new ProjectIndexError("GRAPH_CONFLICT", "Duplicate screen contract in dependency graph", { screenId: contract.screenId });
    validateTree(contract);
    byScreen.set(contract.screenId, contract);
    for (const node of contract.nodes) {
      if (node.slot.ownership !== "managed" || node.slot.componentKey === null) continue;
      const sourcePath = node.slot.sourcePath === null ? null : normalizeProjectRelativePath(node.slot.sourcePath);
      const exportName = node.slot.exportName;
      const identity = `${sourcePath ?? ""}\0${exportName ?? ""}`;
      const previous = identities.get(node.slot.componentKey);
      if (previous !== undefined && previous !== identity) {
        throw new ProjectIndexError("GRAPH_CONFLICT", "A managed component key has conflicting source identities", { componentKey: node.slot.componentKey });
      }
      identities.set(node.slot.componentKey, identity);
      const consumer: ManagedComponentConsumer = Object.freeze({ projectId, screenId: contract.screenId, nodeId: node.id, componentKey: node.slot.componentKey, sourcePath, exportName });
      const list = consumers.get(node.slot.componentKey) ?? [];
      list.push(consumer);
      consumers.set(node.slot.componentKey, list);
    }
  }
  const components = [...consumers.entries()].map(([componentKey, entries]): ManagedComponentRecord => Object.freeze({
    componentKey,
    sourcePath: entries[0]!.sourcePath,
    exportName: entries[0]!.exportName,
    consumers: Object.freeze(entries.sort(compareConsumer))
  })).sort((left, right) => left.componentKey.localeCompare(right.componentKey, "en-US"));
  const projection = graphProjection(projectId, options.indexRevision, byScreen, components);
  return Object.freeze({
    projectId,
    indexRevision: options.indexRevision,
    graphHash: hashProjectIndexProjection(projection),
    screens: Object.freeze([...byScreen.keys()].sort()),
    components: Object.freeze(components),
    contracts: byScreen
  });
}

export function computeDependencyClosure(graph: ManagedReactGraph, input: DependencyClosureInput): DependencyClosure {
  if (input.selectedNodeIds.length === 0 || input.selectedNodeIds.length > 1_000) throw new ProjectIndexError("INVALID_CONFIG", "One to 1000 selected nodes are required");
  const source = graph.contracts.get(input.screenId);
  if (source === undefined) throw new ProjectIndexError("OUT_OF_SCOPE", "Selected screen is not in the managed dependency graph");
  const sourceNodes = new Map(source.nodes.map((node) => [node.id as string, node]));
  const changedKeys = new Set(input.changedComponentKeys ?? []);
  for (const nodeId of input.selectedNodeIds) {
    const node = sourceNodes.get(nodeId);
    if (node === undefined) throw new ProjectIndexError("OUT_OF_SCOPE", "Selected node is not in the selected screen", { nodeId });
    if (node.slot.ownership === "managed" && node.slot.componentKey !== null) changedKeys.add(node.slot.componentKey);
  }
  const knownComponents = new Map(graph.components.map((component) => [component.componentKey, component]));
  for (const key of changedKeys) if (!knownComponents.has(key)) throw new ProjectIndexError("OUT_OF_SCOPE", "Changed component key is not in the managed dependency graph", { componentKey: key });

  const reasons = new Map<string, Set<DependencyReason>>();
  const include = (screenId: string, nodeId: string, reason: DependencyReason): void => {
    const key = `${screenId}\0${nodeId}`;
    const current = reasons.get(key) ?? new Set<DependencyReason>();
    current.add(reason);
    reasons.set(key, current);
  };
  for (const nodeId of input.selectedNodeIds) includeStructuralClosure(source, nodeId, "selected", include);
  for (const componentKey of changedKeys) {
    for (const consumer of knownComponents.get(componentKey)!.consumers) {
      const contract = graph.contracts.get(consumer.screenId)!;
      includeStructuralClosure(contract, consumer.nodeId, "shared-component-consumer", include);
    }
  }
  const nodes = [...reasons.entries()].map(([key, value]): AffectedNode => {
    const [screenId, nodeId] = key.split("\0") as [string, string];
    return Object.freeze({ screenId, nodeId, reasons: Object.freeze([...value].sort()) });
  }).sort((left, right) => left.screenId.localeCompare(right.screenId, "en-US") || left.nodeId.localeCompare(right.nodeId, "en-US"));
  const affectedScreenIds = [...new Set(nodes.map((node) => node.screenId))].sort();
  return Object.freeze({
    projectId: graph.projectId,
    sourceScreenId: input.screenId,
    selectedNodeIds: Object.freeze([...new Set(input.selectedNodeIds)].sort()),
    changedComponentKeys: Object.freeze([...changedKeys].sort()),
    affectedScreenIds: Object.freeze(affectedScreenIds),
    nodes: Object.freeze(nodes),
    requiresAllScreenReverification: affectedScreenIds.length > 1,
    model: "managed-react-slot-bindings-v1"
  });
}

export function createTrustedClosurePacket(
  graph: ManagedReactGraph,
  closure: DependencyClosure,
  selectedPaths: readonly string[]
): HashedTrustedClosure {
  if (closure.projectId !== graph.projectId || closure.model !== "managed-react-slot-bindings-v1") {
    throw new ProjectIndexError("GRAPH_CONFLICT", "Dependency closure does not belong to the supplied graph");
  }
  if (!graph.contracts.has(closure.sourceScreenId)) throw new ProjectIndexError("GRAPH_CONFLICT", "Closure source screen is not in the supplied graph");
  if (selectedPaths.length === 0 || selectedPaths.length > 1_000) throw new ProjectIndexError("INVALID_CONFIG", "One to 1000 selected candidate paths are required");
  const canonicalSelectedPaths = sortedUnique(selectedPaths.map(normalizeProjectRelativePath), "selected candidate paths");
  const affectedSourcePaths = sortedUnique([...new Set(closure.nodes.flatMap((affected) => {
    const contract = graph.contracts.get(affected.screenId);
    const node = contract?.nodes.find((candidate) => candidate.id === affected.nodeId);
    if (node === undefined) {
      throw new ProjectIndexError("GRAPH_CONFLICT", "Closure references a node outside the supplied graph", {
        screenId: affected.screenId,
        nodeId: affected.nodeId
      });
    }
    return node.slot.sourcePath === null ? [] : [normalizeProjectRelativePath(node.slot.sourcePath)];
  }))], "affected source paths");
  const packet: TrustedClosurePacket = Object.freeze({
    schemaVersion: "1.0.0",
    resolver: Object.freeze({
      packageName: "@boxspec/project-index",
      packageVersion: "0.1.0",
      model: "managed-react-slot-bindings-v1",
      algorithm: "boxspec-project-closure-v1"
    }),
    projectId: graph.projectId,
    indexRevision: graph.indexRevision,
    graphHash: graph.graphHash,
    sourceScreenId: closure.sourceScreenId,
    selectedNodeIds: Object.freeze([...closure.selectedNodeIds]),
    selectedPaths: Object.freeze(canonicalSelectedPaths),
    changedComponentKeys: Object.freeze([...closure.changedComponentKeys]),
    affectedScreenIds: Object.freeze([...closure.affectedScreenIds]),
    affectedNodes: Object.freeze(closure.nodes.map((node) => Object.freeze({ ...node, reasons: Object.freeze([...node.reasons]) }))),
    affectedSourcePaths: Object.freeze(affectedSourcePaths)
  });
  return Object.freeze({ packet, closureHash: hashProjectIndexProjection(packet as unknown as JsonValue) });
}

function graphProjection(
  projectId: string,
  indexRevision: number,
  contracts: ReadonlyMap<string, LayoutContract>,
  components: readonly ManagedComponentRecord[]
): JsonValue {
  return {
    schemaVersion: "1.0.0",
    model: "managed-react-slot-bindings-v1",
    projectId,
    indexRevision,
    screens: [...contracts.values()].sort((left, right) => left.screenId.localeCompare(right.screenId, "en-US")).map((contract) => ({
      screenId: contract.screenId,
      revision: contract.revision,
      rootNodeId: contract.rootNodeId,
      nodes: contract.nodes.map((node) => ({
        componentKey: node.slot.ownership === "managed" ? node.slot.componentKey : null,
        exportName: node.slot.ownership === "managed" ? node.slot.exportName : null,
        id: node.id,
        order: node.order,
        ownership: node.slot.ownership,
        parentId: node.parentId,
        sourcePath: node.slot.ownership === "managed" ? node.slot.sourcePath : null
      })).sort((left, right) => left.id.localeCompare(right.id, "en-US"))
    })),
    components: components.map((component) => ({
      componentKey: component.componentKey,
      exportName: component.exportName,
      sourcePath: component.sourcePath,
      consumers: component.consumers.map((consumer) => ({ screenId: consumer.screenId, nodeId: consumer.nodeId }))
    }))
  } as unknown as JsonValue;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) throw new ProjectIndexError("INVALID_CONFIG", `${label} contain a duplicate`, { value: sorted[index] });
  }
  return sorted;
}

function includeStructuralClosure(
  contract: LayoutContract,
  startId: string,
  startReason: DependencyReason,
  include: (screenId: string, nodeId: string, reason: DependencyReason) => void
): void {
  const byId = new Map(contract.nodes.map((node) => [node.id as string, node]));
  const children = childrenByParent(contract.nodes);
  const visitDescendants = (nodeId: string): void => {
    for (const child of children.get(nodeId) ?? []) {
      include(contract.screenId, child.id, "descendant");
      visitDescendants(child.id);
    }
  };
  include(contract.screenId, startId, startReason);
  visitDescendants(startId);
  let current = byId.get(startId);
  while (current?.parentId !== null && current?.parentId !== undefined) {
    const parent = byId.get(current.parentId);
    if (parent === undefined) throw new ProjectIndexError("GRAPH_CONFLICT", "Managed contract contains a missing parent", { nodeId: current.id });
    include(contract.screenId, parent.id, "ancestor");
    for (const sibling of children.get(parent.id) ?? []) if (sibling.id !== current.id) include(contract.screenId, sibling.id, "sibling");
    current = parent;
  }
}

function validateTree(contract: LayoutContract): void {
  if (contract.nodes.length === 0 || contract.nodes.length > 100_000) throw new ProjectIndexError("RESOURCE_LIMIT", "Managed screen node count is outside supported bounds", { screenId: contract.screenId });
  const byId = new Map<string, ContractNode>();
  for (const node of contract.nodes) {
    if (byId.has(node.id)) throw new ProjectIndexError("GRAPH_CONFLICT", "Managed contract contains duplicate node IDs", { screenId: contract.screenId, nodeId: node.id });
    byId.set(node.id, node);
  }
  if (!byId.has(contract.rootNodeId)) throw new ProjectIndexError("GRAPH_CONFLICT", "Managed contract root node is missing", { screenId: contract.screenId });
  for (const node of contract.nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) throw new ProjectIndexError("GRAPH_CONFLICT", "Managed contract contains a missing parent", { screenId: contract.screenId, nodeId: node.id });
    const visited = new Set<string>();
    let cursor: ContractNode | undefined = node;
    while (cursor !== undefined) {
      if (visited.has(cursor.id)) throw new ProjectIndexError("GRAPH_CONFLICT", "Managed contract contains a parent cycle", { screenId: contract.screenId, nodeId: node.id });
      visited.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }
}

function childrenByParent(nodes: readonly ContractNode[]): ReadonlyMap<string, readonly ContractNode[]> {
  const result = new Map<string, ContractNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const entries = result.get(node.parentId) ?? [];
    entries.push(node);
    result.set(node.parentId, entries);
  }
  for (const entries of result.values()) entries.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id, "en-US"));
  return result;
}

function compareConsumer(left: ManagedComponentConsumer, right: ManagedComponentConsumer): number {
  return left.screenId.localeCompare(right.screenId, "en-US") || left.nodeId.localeCompare(right.nodeId, "en-US");
}
