import type { LayoutContract } from "@boxspec/shared/contracts";
import type { RenderMeasurement, Violation } from "./types.js";

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function applies(
  assertion: LayoutContract["assertions"][number],
  measurement: RenderMeasurement,
): boolean {
  const when = assertion.when;
  if (when?.breakpointIds && (!measurement.breakpointId || !when.breakpointIds.includes(measurement.breakpointId))) return false;
  return !when?.fixtureIds || when.fixtureIds.includes(measurement.fixtureId);
}

function violation(
  assertion: LayoutContract["assertions"][number],
  measurement: RenderMeasurement,
  message: string,
  expected: unknown,
  actual: unknown,
): Violation {
  return {
    id: `layout:${measurement.viewportId}:${measurement.fixtureId}:${assertion.id}`,
    checkId: "layout",
    kind: assertion.kind,
    severity: "error",
    blocking: true,
    message,
    nodeId: assertion.nodeId,
    ...(assertion.kind === "relation" ? { otherNodeId: assertion.otherNodeId } : {}),
    viewportId: measurement.viewportId,
    fixtureId: measurement.fixtureId,
    expected,
    actual,
  };
}

export function evaluateLayoutAssertions(
  contract: LayoutContract,
  measurements: readonly RenderMeasurement[],
): Violation[] {
  const violations: Violation[] = [];
  for (const measurement of measurements) {
    for (const assertion of contract.assertions) {
      if (!applies(assertion, measurement)) continue;
      const node = measurement.nodes[assertion.nodeId];
      if (!node) {
        violations.push(violation(assertion, measurement, `Node ${assertion.nodeId} has no measured DOM mapping`, true, false));
        continue;
      }
      if (assertion.kind === "visibility") {
        if (node.visible !== assertion.expected) {
          violations.push(violation(assertion, measurement, `Visibility of ${assertion.nodeId} is ${node.visible}`, assertion.expected, node.visible));
        }
        continue;
      }
      if (assertion.kind === "numeric") {
        if (!node.visible) {
          violations.push(violation(assertion, measurement, `Visible geometry required for ${assertion.nodeId}`, "visible", "hidden"));
          continue;
        }
        const actual = node[assertion.metric];
        const tolerance = assertion.tolerance;
        const passed =
          assertion.operator === "eq"
            ? Math.abs(actual - assertion.expected) <= tolerance
            : assertion.operator === "gte"
              ? actual + tolerance >= assertion.expected
              : actual - tolerance <= assertion.expected;
        if (!passed) {
          violations.push(
            violation(
              assertion,
              measurement,
              `${assertion.nodeId}.${assertion.metric} ${rounded(actual)} does not satisfy ${assertion.operator} ${assertion.expected} ± ${tolerance}`,
              { operator: assertion.operator, value: assertion.expected, tolerance },
              rounded(actual),
            ),
          );
        }
        continue;
      }
      if (assertion.kind === "overflow") {
        const actual = assertion.axis === "x" ? node.overflowX : assertion.axis === "y" ? node.overflowY : node.overflowX || node.overflowY;
        if (assertion.allowed === "none" && actual) {
          violations.push(violation(assertion, measurement, `${assertion.nodeId} overflows on ${assertion.axis}`, false, true));
        }
        continue;
      }
      const other = measurement.nodes[assertion.otherNodeId];
      if (!other) {
        violations.push(violation(assertion, measurement, `Related node ${assertion.otherNodeId} has no measured DOM mapping`, true, false));
        continue;
      }
      if (!node.visible || !other.visible) {
        violations.push(violation(assertion, measurement, `Relation ${assertion.relation} requires visible nodes`, "visible", "hidden"));
        continue;
      }
      const expectedGap = assertion.gap;
      const tolerance = assertion.tolerance;
      let delta = 0;
      let passed = false;
      switch (assertion.relation) {
        case "right-of":
          delta = node.left - other.right;
          passed = Math.abs(delta - expectedGap) <= tolerance;
          break;
        case "below":
          delta = node.top - other.bottom;
          passed = Math.abs(delta - expectedGap) <= tolerance;
          break;
        case "aligned-left":
          delta = node.left - other.left;
          passed = Math.abs(delta) <= tolerance;
          break;
        case "aligned-top":
          delta = node.top - other.top;
          passed = Math.abs(delta) <= tolerance;
          break;
        case "inside":
          passed =
            node.left + tolerance >= other.left + expectedGap &&
            node.top + tolerance >= other.top + expectedGap &&
            node.right - tolerance <= other.right - expectedGap &&
            node.bottom - tolerance <= other.bottom - expectedGap;
          delta = Math.min(node.left - other.left, node.top - other.top, other.right - node.right, other.bottom - node.bottom);
          break;
      }
      if (!passed) {
        violations.push(
          violation(
            assertion,
            measurement,
            `${assertion.nodeId} violates ${assertion.relation} relative to ${assertion.otherNodeId}`,
            { gap: expectedGap, tolerance },
            rounded(delta),
          ),
        );
      }
    }
  }
  return violations;
}
