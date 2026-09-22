import type {
  ContractAssertion,
  ContractNode,
  DesignToken as SharedDesignToken,
  Layout as SharedLayout,
  LayoutContract as SharedLayoutContract,
  Padding as SharedPadding,
  Placement as SharedPlacement,
  PolicyLock as SharedPolicyLock,
  Size as SharedSize,
  Target as SharedTarget,
} from "@boxspec/shared/contracts";

export type Policy = "hard" | "soft" | "free";
export type Target = SharedTarget;
export type Size = SharedSize;
export type Padding = SharedPadding;
export type Layout = SharedLayout;
export type Placement = SharedPlacement;
export type PolicyLock = SharedPolicyLock;
export type LayoutNode = ContractNode;
export type ResponsiveOverride = ContractNode["responsive"][number];
export type Assertion = ContractAssertion;
export type DesignToken = SharedDesignToken;
export type Breakpoint = SharedLayoutContract["breakpoints"][number];
export type When = NonNullable<ContractAssertion["when"]>;
export type LayoutContract = SharedLayoutContract;

export interface LayoutOverride { nodeId: string; path: `/layout/${string}`; value: string | number | boolean | null }
export interface Actor { kind: "user" | "agent" | "system"; id: string }
export interface CommandMetadata { commandId: string; expectedRevision: number; actor: Actor; timestamp: string }
export type CoreCommand = CommandMetadata & ({
  type: "replace-contract";
  projectId: string;
  screenId: string;
  contract: LayoutContract;
} | {
  type: "apply-layout-overrides";
  projectId: string;
  screenId: string;
  overrides: LayoutOverride[];
} | {
  type: "rename-screen";
  projectId: string;
  screenId: string;
  name: string;
});
export interface StoredCommand { commandId: string; projectId: string; screenId: string; expectedRevision: number; resultingRevision: number; actor: Actor; timestamp: string; type: CoreCommand["type"] | "undo" | "redo"; beforeHash: string; afterHash: string; payloadJson: string }
