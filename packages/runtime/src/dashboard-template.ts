export interface DashboardTemplateInput {
  readonly projectId: string;
  readonly screenId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export function createDashboardContract(input: DashboardTemplateInput): Record<string, unknown> {
  const fixed = (value: number) => ({ mode: "fixed", value });
  const fill = () => ({ mode: "fill", weight: 1, min: 0 });
  const padding = (value = 0) => ({ top: value, right: value, bottom: value, left: value });
  const slot = (componentKey: string | null, sourcePath: string | null, exportName: string | null) => ({
    ownership: "managed",
    componentKey,
    sourcePath,
    exportName,
  });
  const node = (
    id: string,
    parentId: string | null,
    order: number,
    role: string,
    mode: string,
    width: unknown,
    height: unknown,
    componentKey: string | null = null,
  ) => ({
    id,
    parentId,
    order,
    name: id,
    role,
    layout: {
      mode,
      width,
      height,
      padding: id === "main" ? padding(24) : padding(),
      gap: id === "main" ? 16 : 0,
      align: "stretch",
      justify: "start",
    },
    placement: { kind: "flow" },
    visible: true,
    content: {},
    slot: slot(
      componentKey,
      componentKey === null ? null : `src/boxspec/slots/${componentKey}.tsx`,
      componentKey,
    ),
    locks: id === "sidebar" ? [{ path: "/layout/width", policy: "hard" }] : [],
    responsive: id === "sidebar" ? [{ breakpointId: "compact", visible: false }] : [],
  });

  return {
    schemaVersion: "1.0.0",
    projectId: input.projectId,
    screenId: input.screenId,
    name: input.name,
    revision: 1,
    target: "web-react",
    coordinateSpace: { unit: "css-px", origin: "top-left" },
    rootNodeId: "root",
    defaultPolicy: { layout: "hard", topology: "hard", presentation: "free", content: "hard" },
    breakpoints: [
      { id: "compact", minWidth: 0, maxWidthExclusive: 768 },
      { id: "desktop", minWidth: 768, maxWidthExclusive: null },
    ],
    designSystem: {
      id: `ds_${input.projectId}`,
      revision: 1,
      tokens: {
        "color.background": { type: "color", value: "#111318" },
        "color.text": { type: "color", value: "#F1F4FA" },
        "spacing.page": { type: "dimension", value: 24 },
        "spacing.section": { type: "dimension", value: 16 },
      },
    },
    nodes: [
      node("root", null, 0, "container", "column", fill(), fill()),
      node("header", "root", 0, "navigation", "leaf", fill(), fixed(64), "HeaderContent"),
      node("body", "root", 1, "container", "row", fill(), fill()),
      node("sidebar", "body", 0, "navigation", "leaf", fixed(260), fill(), "SidebarContent"),
      node("main", "body", 1, "content", "column", fill(), fill()),
      node("search", "main", 0, "input", "leaf", fill(), fixed(48), "ProjectSearch"),
      node("projects", "main", 1, "list", "leaf", fill(), fill(), "ProjectList"),
    ],
    assertions: [
      { id: "header-height", kind: "numeric", nodeId: "header", metric: "height", operator: "eq", expected: 64, tolerance: 1 },
      { id: "sidebar-width", kind: "numeric", nodeId: "sidebar", metric: "width", operator: "eq", expected: 260, tolerance: 1, when: { breakpointIds: ["desktop"] } },
      { id: "sidebar-hidden-compact", kind: "visibility", nodeId: "sidebar", expected: false, when: { breakpointIds: ["compact"] } },
      { id: "sidebar-visible-desktop", kind: "visibility", nodeId: "sidebar", expected: true, when: { breakpointIds: ["desktop"] } },
      { id: "main-next-sidebar", kind: "relation", nodeId: "main", otherNodeId: "sidebar", relation: "right-of", gap: 0, tolerance: 1, when: { breakpointIds: ["desktop"] } },
      { id: "main-left-compact", kind: "numeric", nodeId: "main", metric: "left", operator: "eq", expected: 0, tolerance: 1, when: { breakpointIds: ["compact"] } },
      { id: "main-visible", kind: "visibility", nodeId: "main", expected: true },
      { id: "search-no-x-overflow", kind: "overflow", nodeId: "search", axis: "x", allowed: "none" },
    ],
    verification: {
      viewports: [
        { id: "desktop", width: input.width, height: input.height, deviceScaleFactor: 1 },
        { id: "compact", width: 390, height: 844, deviceScaleFactor: 2 },
      ],
      fixtureIds: ["populated", "empty", "loading", "error", "long-text"],
      requiredChecks: ["schema", "policy", "layout", "types", "build", "interactions"],
      logicalTolerance: 1,
      boundaryTests: true,
    },
  };
}
