import * as ts from "typescript/unstable/ast";
import { AdoptedWebError } from "./errors.js";
import { contentHash } from "./hash.js";
import { validateSourceInput } from "./input.js";
import { withParsedSource } from "./parser.js";
import type { AdoptedWebMapping, AdoptedWebSourceInput, MappingDiff, MappingDriftIssue, MappingDriftReport } from "./types.js";

function mappingAttributes(input: AdoptedWebSourceInput): ReadonlySet<string> {
  return withParsedSource(input.language, input.content, (source) => {
    const values = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "data-boxspec-id") values.add(node.getText(source));
      node.forEachChild(visit);
    };
    visit(source);
    return values;
  });
}

function validateMappingContext(input: AdoptedWebSourceInput, mapping: AdoptedWebMapping): void {
  if (mapping.sourceId !== input.sourceId || mapping.fileName !== input.fileName ||
      mapping.projectId !== input.approvedContext.projectId || mapping.screenId !== input.approvedContext.screenId) {
    throw new AdoptedWebError("CONTEXT_NOT_APPROVED", "Mapping is outside the approved source context", { mappingId: mapping.mappingId });
  }
}

export function detectAdoptedMappingDrift(input: AdoptedWebSourceInput, mapping: AdoptedWebMapping): MappingDriftReport {
  validateSourceInput(input);
  validateMappingContext(input, mapping);
  const actual = contentHash(input.content);
  const issues: MappingDriftIssue[] = [];
  if (actual !== mapping.proposedContentHash) {
    issues.push({ code: actual === mapping.baseContentHash ? "PATCH_NOT_APPLIED" : "SOURCE_HASH_CHANGED", message: actual === mapping.baseContentHash ? "The approved mapping patch has not been applied." : "The source hash differs from the approved mapped source." });
  }
  const attributes = mappingAttributes(input);
  for (const node of mapping.nodes) {
    if (!attributes.has(node.attributeText)) issues.push({ code: "MAPPING_ATTRIBUTE_MISSING", message: "The mapped data-boxspec-id attribute is absent or changed.", templateNodeId: node.templateNodeId });
  }
  return { status: issues.length === 0 ? "ALIGNED" : "STALE", expectedContentHash: mapping.proposedContentHash, actualContentHash: actual, issues };
}

export function assertAdoptedMappingCurrent(input: AdoptedWebSourceInput, mapping: AdoptedWebMapping): void {
  const report = detectAdoptedMappingDrift(input, mapping);
  if (report.status === "STALE") {
    throw new AdoptedWebError("MAPPING_STALE", "Adopted source mapping must be re-analyzed before verification", {
      mappingId: mapping.mappingId,
      expectedContentHash: report.expectedContentHash,
      actualContentHash: report.actualContentHash,
    });
  }
}

export function diffAdoptedMappings(previous: AdoptedWebMapping, next: AdoptedWebMapping): MappingDiff {
  const before = new Map(previous.nodes.map((node) => [node.templateNodeId, node]));
  const after = new Map(next.nodes.map((node) => [node.templateNodeId, node]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...before.keys()].filter((id) => {
    const left = before.get(id);
    const right = after.get(id);
    return right !== undefined && left !== undefined &&
      (left.sourceFingerprint !== right.sourceFingerprint || left.runtimeIdExpression !== right.runtimeIdExpression || JSON.stringify(left.instanceBinding) !== JSON.stringify(right.instanceBinding));
  }).sort();
  return { status: added.length || removed.length || changed.length ? "CHANGED" : "UNCHANGED", addedTemplateNodeIds: added, removedTemplateNodeIds: removed, changedTemplateNodeIds: changed };
}
