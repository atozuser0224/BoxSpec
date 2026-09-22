import type { ContractNode, LayoutContract } from "@boxspec/shared/contracts";
import { describe, expect, it } from "vitest";
import { buildManagedReactGraph, computeDependencyClosure, createTrustedClosurePacket } from "../src/index.js";

describe("managed React component dependency closure", () => {
  it("includes descendants, siblings, ancestors, and every screen consuming a changed component", () => {
    const first = contract("screen_a", [
      node("root_a", null),
      node("header_a", "root_a"),
      node("shared_a", "root_a", "SharedCard"),
      node("shared_child_a", "shared_a"),
      node("sibling_a", "root_a")
    ]);
    const second = contract("screen_b", [
      node("root_b", null),
      node("shared_b", "root_b", "SharedCard"),
      node("shared_child_b", "shared_b"),
      node("sibling_b", "root_b")
    ]);
    const unrelated = contract("screen_c", [node("root_c", null), node("only_c", "root_c")]);
    const graph = buildManagedReactGraph([first, second, unrelated], { indexRevision: 7 });

    const closure = computeDependencyClosure(graph, { screenId: "screen_a", selectedNodeIds: ["shared_a"] });

    expect(closure.model).toBe("managed-react-slot-bindings-v1");
    expect(closure.changedComponentKeys).toEqual(["SharedCard"]);
    expect(closure.affectedScreenIds).toEqual(["screen_a", "screen_b"]);
    expect(closure.requiresAllScreenReverification).toBe(true);
    expect(nodeReasons(closure.nodes)).toEqual(expect.objectContaining({
      "screen_a/shared_a": expect.arrayContaining(["selected"]),
      "screen_a/shared_child_a": expect.arrayContaining(["descendant"]),
      "screen_a/root_a": expect.arrayContaining(["ancestor"]),
      "screen_a/header_a": expect.arrayContaining(["sibling"]),
      "screen_a/sibling_a": expect.arrayContaining(["sibling"]),
      "screen_b/shared_b": expect.arrayContaining(["shared-component-consumer"]),
      "screen_b/shared_child_b": expect.arrayContaining(["descendant"]),
      "screen_b/root_b": expect.arrayContaining(["ancestor"]),
      "screen_b/sibling_b": expect.arrayContaining(["sibling"])
    }));
    expect(closure.nodes.some((entry) => entry.screenId === "screen_c")).toBe(false);
    const attestation = createTrustedClosurePacket(graph, closure, ["src/boxspec/Shared.tsx"]);
    expect(attestation.closureHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.packet).toMatchObject({
      indexRevision: 7,
      graphHash: graph.graphHash,
      selectedPaths: ["src/boxspec/Shared.tsx"],
      affectedScreenIds: ["screen_a", "screen_b"],
      affectedSourcePaths: ["src/boxspec/Shared.tsx"],
      resolver: { algorithm: "boxspec-project-closure-v1" }
    });
    expect(createTrustedClosurePacket(graph, closure, ["src/boxspec/Shared.tsx"]).closureHash).toBe(attestation.closureHash);
  });

  it("keeps a local non-component selection within its screen", () => {
    const first = contract("screen_a", [node("root_a", null), node("left_a", "root_a"), node("right_a", "root_a")]);
    const second = contract("screen_b", [node("root_b", null), node("only_b", "root_b")]);
    const closure = computeDependencyClosure(buildManagedReactGraph([first, second], { indexRevision: 1 }), {
      screenId: "screen_a",
      selectedNodeIds: ["left_a"]
    });
    expect(closure.affectedScreenIds).toEqual(["screen_a"]);
    expect(closure.changedComponentKeys).toEqual([]);
    expect(closure.requiresAllScreenReverification).toBe(false);
    expect(closure.nodes.map((entry) => entry.nodeId)).toEqual(["left_a", "right_a", "root_a"]);
  });

  it("rejects a duplicate component key bound to different source identities", () => {
    const first = contract("screen_a", [node("root_a", null), node("shared_a", "root_a", "SharedCard", "src/boxspec/Shared.tsx")]);
    const second = contract("screen_b", [node("root_b", null), node("shared_b", "root_b", "SharedCard", "src/boxspec/Other.tsx")]);
    expect(() => buildManagedReactGraph([first, second], { indexRevision: 1 })).toThrow(expect.objectContaining({ code: "GRAPH_CONFLICT" }));
  });

  it("rejects cross-project and non-React graphs", () => {
    const first = contract("screen_a", [node("root_a", null)]);
    const foreign = { ...contract("screen_b", [node("root_b", null)]), projectId: "project_other" } as LayoutContract;
    const nonReact = { ...contract("screen_c", [node("root_c", null)]), target: "unity-ugui" } as LayoutContract;
    expect(() => buildManagedReactGraph([first, foreign], { indexRevision: 1 })).toThrow(expect.objectContaining({ code: "GRAPH_CONFLICT" }));
    expect(() => buildManagedReactGraph([first, nonReact], { indexRevision: 1 })).toThrow(expect.objectContaining({ code: "GRAPH_CONFLICT" }));
  });
});

function node(id: string, parentId: string | null, componentKey: string | null = null, sourcePath = "src/boxspec/Shared.tsx"): ContractNode {
  return {
    id,
    parentId,
    order: 0,
    name: id,
    role: parentId === null ? "viewport" : "container",
    layout: {
      mode: parentId === null ? "column" : "leaf",
      width: { mode: "fill", weight: 1, min: 0 },
      height: { mode: "fill", weight: 1, min: 0 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      gap: 0,
      align: "stretch",
      justify: "start"
    },
    placement: { kind: "flow" },
    visible: true,
    content: {},
    slot: {
      ownership: "managed",
      componentKey,
      sourcePath: componentKey === null ? null : sourcePath,
      exportName: componentKey
    },
    locks: [],
    responsive: []
  } as ContractNode;
}

function contract(screenId: string, nodes: readonly ContractNode[]): LayoutContract {
  return {
    schemaVersion: "1.0.0",
    projectId: "project_demo",
    screenId,
    name: screenId,
    revision: 1,
    target: "web-react",
    coordinateSpace: { unit: "css-px", origin: "top-left" },
    rootNodeId: nodes[0]!.id,
    defaultPolicy: { layout: "hard", topology: "hard", presentation: "free", content: "free" },
    breakpoints: [{ id: "desktop", minWidth: 0, maxWidthExclusive: null }],
    designSystem: { id: "demo", revision: 1, tokens: {} },
    nodes,
    assertions: [],
    verification: {
      viewports: [{ id: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 }],
      fixtureIds: [],
      requiredChecks: ["schema"],
      logicalTolerance: 1,
      boundaryTests: true
    }
  } as LayoutContract;
}

function nodeReasons(nodes: readonly { readonly screenId: string; readonly nodeId: string; readonly reasons: readonly string[] }[]): Record<string, readonly string[]> {
  return Object.fromEntries(nodes.map((entry) => [`${entry.screenId}/${entry.nodeId}`, entry.reasons]));
}
