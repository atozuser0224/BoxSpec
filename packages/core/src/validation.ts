import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import schema from "./schema/layout-contract.schema.json" with { type: "json" };
import { CoreError } from "./errors.js";
import { canonicalize, ordinalCompare } from "./canonical.js";
import type { LayoutContract, LayoutNode, Size } from "./model.js";

export type DiagnosticSeverity = "error" | "warning";
export interface ValidationDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: DiagnosticSeverity;
  nodeIds?: string[];
}
export type ValidationResult = { ok: true; contract: LayoutContract; diagnostics: ValidationDiagnostic[] } | { ok: false; diagnostics: ValidationDiagnostic[] };

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const schemaValidator = ajv.compile(schema);

function schemaDiagnostic(error: ErrorObject): ValidationDiagnostic {
  return {
    code: `SCHEMA_${error.keyword.toUpperCase().replaceAll("-", "_")}`,
    message: error.message ?? "Schema validation failed",
    path: error.instancePath || "/",
    severity: "error",
  };
}
function diag(code: string, message: string, path: string, nodeIds?: string[]): ValidationDiagnostic {
  return { code, message, path, severity: "error", ...(nodeIds ? { nodeIds } : {}) };
}
function duplicateDiagnostics(values: readonly string[], path: string, code: string): ValidationDiagnostic[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) seen.has(value) ? duplicate.add(value) : seen.add(value);
  return [...duplicate].sort(ordinalCompare).map((id) => diag(code, `Duplicate id '${id}'`, path));
}
function checkSize(size: Size, path: string): ValidationDiagnostic[] {
  if ("max" in size && size.max !== undefined && size.max < size.min) return [diag("SIZE_RANGE_INVALID", "Size max must be greater than or equal to min", path)];
  return [];
}
function pointerValue(source: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = source;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(key in current)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

export function semanticDiagnostics(contract: LayoutContract): ValidationDiagnostic[] {
  const out: ValidationDiagnostic[] = [];
  const nodeById = new Map(contract.nodes.map((node) => [node.id, node]));
  const breakpointIds = new Set(contract.breakpoints.map((bp) => bp.id));
  const fixtureIds = new Set(contract.verification.fixtureIds);
  out.push(...duplicateDiagnostics(contract.nodes.map((n) => n.id), "/nodes", "DUPLICATE_NODE_ID"));
  out.push(...duplicateDiagnostics(contract.breakpoints.map((b) => b.id), "/breakpoints", "DUPLICATE_BREAKPOINT_ID"));
  out.push(...duplicateDiagnostics(contract.assertions.map((a) => a.id), "/assertions", "DUPLICATE_ASSERTION_ID"));
  out.push(...duplicateDiagnostics(contract.verification.viewports.map((v) => v.id), "/verification/viewports", "DUPLICATE_VIEWPORT_ID"));
  if (!nodeById.has(contract.rootNodeId)) out.push(diag("ROOT_NOT_FOUND", `Root node '${contract.rootNodeId}' does not exist`, "/rootNodeId"));
  for (const [index, node] of contract.nodes.entries()) {
    const path = `/nodes/${index}`;
    if (node.id === contract.rootNodeId && node.parentId !== null) out.push(diag("ROOT_HAS_PARENT", "Root node must have null parentId", `${path}/parentId`, [node.id]));
    if (node.id !== contract.rootNodeId && node.parentId === null) out.push(diag("MULTIPLE_ROOTS", "Only rootNodeId may have null parentId", `${path}/parentId`, [node.id]));
    if (node.parentId !== null && !nodeById.has(node.parentId)) out.push(diag("PARENT_NOT_FOUND", `Parent '${node.parentId}' does not exist`, `${path}/parentId`, [node.id]));
    out.push(...checkSize(node.layout.width, `${path}/layout/width`), ...checkSize(node.layout.height, `${path}/layout/height`));
    if (node.layout.mode === "grid" && node.layout.gridColumns === undefined) out.push(diag("GRID_COLUMNS_REQUIRED", "Grid layout requires gridColumns", `${path}/layout`, [node.id]));
    if (node.layout.mode !== "grid" && node.layout.gridColumns !== undefined) out.push(diag("GRID_COLUMNS_UNEXPECTED", "gridColumns is only valid for grid layout", `${path}/layout/gridColumns`, [node.id]));
    for (const [lockIndex, lock] of node.locks.entries()) {
      if (lock.policy === "soft" && lock.min > lock.max) out.push(diag("SOFT_RANGE_INVALID", "Soft policy min must be <= max", `${path}/locks/${lockIndex}`, [node.id]));
      const target = pointerValue(node, lock.path);
      if (!target.found) out.push(diag("LOCK_PATH_NOT_FOUND", `Lock path '${lock.path}' does not exist on the node`, `${path}/locks/${lockIndex}/path`, [node.id]));
      else if (lock.policy === "soft" && typeof target.value !== "number") out.push(diag("SOFT_TARGET_NOT_NUMERIC", `Soft lock path '${lock.path}' must target a numeric scalar`, `${path}/locks/${lockIndex}/path`, [node.id]));
      if (node.locks.findIndex((candidate) => candidate.path === lock.path) !== lockIndex) out.push(diag("DUPLICATE_LOCK_PATH", `Duplicate lock path '${lock.path}'`, `${path}/locks/${lockIndex}`, [node.id]));
    }
    const responsiveIds = node.responsive.map((r) => r.breakpointId);
    out.push(...duplicateDiagnostics(responsiveIds, `${path}/responsive`, "DUPLICATE_RESPONSIVE_BREAKPOINT"));
    for (const [overrideIndex, override] of node.responsive.entries()) {
      if (!breakpointIds.has(override.breakpointId)) out.push(diag("BREAKPOINT_NOT_FOUND", `Breakpoint '${override.breakpointId}' does not exist`, `${path}/responsive/${overrideIndex}/breakpointId`, [node.id]));
      if (override.layout) {
        if (override.layout.width) out.push(...checkSize(override.layout.width, `${path}/responsive/${overrideIndex}/layout/width`));
        if (override.layout.height) out.push(...checkSize(override.layout.height, `${path}/responsive/${overrideIndex}/layout/height`));
      }
    }
  }
  for (const [index, node] of contract.nodes.entries()) {
    const chain = new Set<string>();
    let current: LayoutNode | undefined = node;
    while (current) {
      if (chain.has(current.id)) { out.push(diag("PARENT_CYCLE", `Parent cycle contains '${current.id}'`, `/nodes/${index}/parentId`, [...chain, current.id])); break; }
      chain.add(current.id);
      current = current.parentId === null ? undefined : nodeById.get(current.parentId);
    }
    if (node.layout.mode === "leaf" && contract.nodes.some((candidate) => candidate.parentId === node.id)) out.push(diag("LEAF_HAS_CHILDREN", "Leaf layout cannot contain child nodes", `/nodes/${index}/layout/mode`, [node.id]));
  }
  const siblings = new Map<LayoutNode["parentId"], LayoutNode[]>();
  for (const node of contract.nodes) siblings.set(node.parentId, [...(siblings.get(node.parentId) ?? []), node]);
  for (const [parentId, children] of siblings) {
    const orders = children.map((child) => String(child.order));
    out.push(...duplicateDiagnostics(orders, "/nodes", "DUPLICATE_SIBLING_ORDER").map((d) => ({ ...d, message: `${d.message} under '${parentId ?? "root"}'` })));
    if (parentId !== null) {
      const parent = nodeById.get(parentId);
      if (parent) {
        for (const sizeAxis of ["width", "height"] as const) {
          const parentSize = parent.layout[sizeAxis];
          const fillChild = children.find((child) => child.layout[sizeAxis].mode === "fill");
          if (parentSize.mode === "hug" && fillChild) out.push(diag("SIZING_CYCLE", `Hug ${sizeAxis} parent '${parent.id}' cannot contain fill ${sizeAxis} child '${fillChild.id}'`, "/nodes", [parent.id, fillChild.id]));
        }
        const axis = parent.layout.mode === "row" ? "width" : parent.layout.mode === "column" ? "height" : undefined;
        if (axis) {
          const parentSize = parent.layout[axis];
          if (parentSize.mode === "fixed") {
            const fixedTotal = children.reduce((sum, child) => { const size = child.layout[axis]; return sum + (size.mode === "fixed" ? size.value : size.min); }, 0);
            const padding = axis === "width" ? parent.layout.padding.left + parent.layout.padding.right : parent.layout.padding.top + parent.layout.padding.bottom;
            const required = fixedTotal + padding + Math.max(0, children.length - 1) * parent.layout.gap;
            if (required > parentSize.value) out.push(diag("CONSTRAINT_CONFLICT", `Fixed children require ${required}px but parent '${parent.id}' has ${parentSize.value}px`, "/nodes", [parent.id, ...children.filter((child) => child.layout[axis].mode === "fixed").map((child) => child.id)]));
          }
        }
        for (const child of children) if (child.placement.kind === "anchor" && parent.layout.mode !== "overlay") out.push(diag("ANCHOR_REQUIRES_OVERLAY", `Anchored node '${child.id}' requires an overlay parent`, "/nodes", [parent.id, child.id]));
      }
    }
  }
  const sortedBreakpoints = [...contract.breakpoints].sort((a, b) => a.minWidth - b.minWidth || ordinalCompare(a.id, b.id));
  if (sortedBreakpoints[0]?.minWidth !== 0) out.push(diag("BREAKPOINT_GAP", "Breakpoint coverage must begin at width 0", "/breakpoints"));
  for (let index = 0; index < sortedBreakpoints.length; index += 1) {
    const current = sortedBreakpoints[index]!;
    if (current.maxWidthExclusive !== null && current.maxWidthExclusive <= current.minWidth) out.push(diag("BREAKPOINT_EMPTY", `Breakpoint '${current.id}' has an empty range`, "/breakpoints"));
    const next = sortedBreakpoints[index + 1];
    if (next) {
      if (current.maxWidthExclusive === null || current.maxWidthExclusive > next.minWidth) out.push(diag("BREAKPOINT_OVERLAP", `Breakpoints '${current.id}' and '${next.id}' overlap`, "/breakpoints"));
      else if (current.maxWidthExclusive < next.minWidth) out.push(diag("BREAKPOINT_GAP", `Gap between breakpoints '${current.id}' and '${next.id}'`, "/breakpoints"));
    } else if (current.maxWidthExclusive !== null) out.push(diag("BREAKPOINT_GAP", "Breakpoint coverage must extend without an upper bound", "/breakpoints"));
  }
  const expectedUnit = contract.target === "web-react" ? "css-px" : contract.target === "unity-ugui" ? "canvas-unit" : "dp";
  if (contract.coordinateSpace.unit !== expectedUnit) out.push(diag("TARGET_UNIT_MISMATCH", `Target '${contract.target}' requires coordinate unit '${expectedUnit}'`, "/coordinateSpace/unit"));
  for (const [index, assertion] of contract.assertions.entries()) {
    if (!nodeById.has(assertion.nodeId)) out.push(diag("ASSERTION_NODE_NOT_FOUND", `Assertion node '${assertion.nodeId}' does not exist`, `/assertions/${index}/nodeId`));
    if (assertion.kind === "relation" && !nodeById.has(assertion.otherNodeId)) out.push(diag("ASSERTION_NODE_NOT_FOUND", `Assertion other node '${assertion.otherNodeId}' does not exist`, `/assertions/${index}/otherNodeId`));
    if (assertion.kind === "relation" && assertion.nodeId === assertion.otherNodeId) out.push(diag("ASSERTION_SELF_RELATION", "A relation assertion must reference two different nodes", `/assertions/${index}/otherNodeId`));
    for (const id of assertion.when?.breakpointIds ?? []) if (!breakpointIds.has(id)) out.push(diag("ASSERTION_BREAKPOINT_NOT_FOUND", `Assertion breakpoint '${id}' does not exist`, `/assertions/${index}/when/breakpointIds`));
    for (const id of assertion.when?.fixtureIds ?? []) if (!fixtureIds.has(id)) out.push(diag("ASSERTION_FIXTURE_NOT_FOUND", `Assertion fixture '${id}' does not exist`, `/assertions/${index}/when/fixtureIds`));
  }
  out.push(...duplicateDiagnostics(contract.verification.requiredChecks, "/verification/requiredChecks", "DUPLICATE_REQUIRED_CHECK"));
  return out;
}

export function validateLayoutContract(input: unknown): ValidationResult {
  if (!schemaValidator(input)) return { ok: false, diagnostics: (schemaValidator.errors ?? []).map(schemaDiagnostic) };
  const contract = canonicalize(input as unknown as LayoutContract);
  const diagnostics = semanticDiagnostics(contract);
  return diagnostics.some((item) => item.severity === "error") ? { ok: false, diagnostics } : { ok: true, contract, diagnostics };
}
export function parseLayoutContract(input: unknown): LayoutContract {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const version = (input as Record<string, unknown>).schemaVersion;
    if (typeof version === "string" && version !== "1.0.0") throw new CoreError("READ_ONLY", `Contract schema version '${version}' is not writable by this core`, { schemaVersion: version, supportedVersion: "1.0.0" });
  }
  const result = validateLayoutContract(input);
  if (!result.ok) throw new CoreError(result.diagnostics.some((d) => d.code.startsWith("SCHEMA_")) ? "SCHEMA_INVALID" : "SEMANTIC_INVALID", "Layout contract is invalid", { diagnostics: result.diagnostics });
  return result.contract;
}
