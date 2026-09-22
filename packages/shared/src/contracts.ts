import type { NodeId, ProjectId, ScreenId, Sha256 } from "./domain.js";

export type Target = "web-react" | "unity-ugui" | "react-native-android";
export type CoordinateUnit = "css-px" | "canvas-unit" | "dp";
export type Policy = "hard" | "free";

export type Size =
  | { readonly mode: "fixed"; readonly value: number }
  | { readonly mode: "fill"; readonly weight: number; readonly min: number; readonly max?: number }
  | { readonly mode: "hug"; readonly min: number; readonly max?: number };

export interface Padding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Layout {
  readonly mode: "row" | "column" | "grid" | "overlay" | "leaf";
  readonly width: Size;
  readonly height: Size;
  readonly padding: Padding;
  readonly gap: number;
  readonly align: "start" | "center" | "end" | "stretch";
  readonly justify: "start" | "center" | "end" | "space-between";
  readonly gridColumns?: number;
}

export type LayoutPatch = Partial<Layout> & { readonly mode?: Layout["mode"] };
export type Placement =
  | { readonly kind: "flow" }
  | {
      readonly kind: "anchor";
      readonly anchorX: "left" | "center" | "right";
      readonly anchorY: "top" | "center" | "bottom";
      readonly offsetX: number;
      readonly offsetY: number;
      readonly zIndex: number;
    };

export type PolicyLock =
  | { readonly path: string; readonly policy: "hard" | "free" }
  | { readonly path: string; readonly policy: "soft"; readonly min: number; readonly max: number };

export interface ContractNode {
  readonly id: NodeId;
  readonly parentId: NodeId | null;
  readonly order: number;
  readonly name: string;
  readonly role: "container" | "navigation" | "content" | "text" | "button" | "image" | "input" | "list" | "viewport" | "overlay";
  readonly layout: Layout;
  readonly placement: Placement;
  readonly visible: boolean;
  readonly content: { readonly text?: string };
  readonly slot: {
    readonly ownership: "managed" | "adopted" | "reference";
    readonly componentKey: string | null;
    readonly sourcePath: string | null;
    readonly exportName: string | null;
  };
  readonly locks: readonly PolicyLock[];
  readonly responsive: readonly {
    readonly breakpointId: string;
    readonly layout?: LayoutPatch;
    readonly placement?: Placement;
    readonly visible?: boolean;
  }[];
  readonly sketchBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface AssertionWhen {
  readonly breakpointIds?: readonly string[];
  readonly fixtureIds?: readonly string[];
}

export type ContractAssertion =
  | { readonly id: string; readonly kind: "numeric"; readonly nodeId: NodeId; readonly metric: "left" | "top" | "right" | "bottom" | "width" | "height"; readonly operator: "eq" | "gte" | "lte"; readonly expected: number; readonly tolerance: number; readonly when?: AssertionWhen }
  | { readonly id: string; readonly kind: "relation"; readonly nodeId: NodeId; readonly otherNodeId: NodeId; readonly relation: "right-of" | "below" | "aligned-left" | "aligned-top" | "inside"; readonly gap: number; readonly tolerance: number; readonly when?: AssertionWhen }
  | { readonly id: string; readonly kind: "visibility"; readonly nodeId: NodeId; readonly expected: boolean; readonly when?: AssertionWhen }
  | { readonly id: string; readonly kind: "overflow"; readonly nodeId: NodeId; readonly axis: "x" | "y" | "both"; readonly allowed: "none" | "ellipsis" | "scroll"; readonly when?: AssertionWhen };

export type DesignToken =
  | { readonly type: "color" | "font-family"; readonly value: string }
  | { readonly type: "dimension"; readonly value: number };

export interface LayoutContract {
  readonly schemaVersion: "1.0.0";
  readonly projectId: ProjectId;
  readonly screenId: ScreenId;
  readonly name: string;
  readonly revision: number;
  readonly target: Target;
  readonly coordinateSpace: { readonly unit: CoordinateUnit; readonly origin: "top-left" };
  readonly rootNodeId: NodeId;
  readonly defaultPolicy: { readonly layout: Policy; readonly topology: "hard"; readonly presentation: Policy; readonly content: Policy };
  readonly breakpoints: readonly { readonly id: string; readonly minWidth: number; readonly maxWidthExclusive: number | null }[];
  readonly designSystem: { readonly id: string; readonly revision: number; readonly tokens: Readonly<Record<string, DesignToken>> };
  readonly nodes: readonly ContractNode[];
  readonly assertions: readonly ContractAssertion[];
  readonly verification: {
    readonly viewports: readonly { readonly id: string; readonly width: number; readonly height: number; readonly deviceScaleFactor: number }[];
    readonly fixtureIds: readonly string[];
    readonly requiredChecks: readonly ("schema" | "policy" | "layout" | "types" | "build" | "interactions" | "accessibility" | "visual")[];
    readonly logicalTolerance: number;
    readonly boundaryTests: boolean;
  };
}

export interface ContextSlice {
  readonly schemaVersion: "1.0.0";
  readonly kind: "context-slice";
  readonly projectId: ProjectId;
  readonly screenId: ScreenId;
  readonly revision: number;
  readonly contractHash: Sha256;
  readonly rootNodeId: NodeId;
  readonly coordinateSpace: LayoutContract["coordinateSpace"];
  readonly breakpoints: LayoutContract["breakpoints"];
  readonly defaultPolicy: LayoutContract["defaultPolicy"];
  readonly scopeNodeIds: readonly NodeId[];
  readonly includedNodes: readonly ContractNode[];
  readonly assertions: readonly ContractAssertion[];
  readonly totalNodeCount: number;
  readonly nextCursor: string | null;
}
