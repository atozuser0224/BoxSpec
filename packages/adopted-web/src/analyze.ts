import * as ts from "typescript/unstable/ast";
import { contentHash, stableId } from "./hash.js";
import { validateSourceInput } from "./input.js";
import { withParsedSource } from "./parser.js";
import type {
  AdoptedDiagnostic,
  AdoptedDiagnosticCode,
  AdoptedGuarantee,
  AdoptedNodeMapping,
  AdoptedPatchProposal,
  AdoptedWebAnalysis,
  AdoptedWebSourceInput,
  ComponentDefinition,
  DiagnosticSeverity,
  DiagnosticSupport,
  InstanceBinding,
  PatchEdit,
  SourceRange,
} from "./types.js";

interface ComponentContext {
  readonly definition: ComponentDefinition;
  readonly body: ts.Node;
  hostIndex: number;
}

interface MapContext {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly itemName?: string;
  readonly indexName?: string;
  readonly keyExpression?: ts.Expression;
  readonly keyText?: string;
  readonly issueNode: ts.Node;
}

function range(source: ts.SourceFile, node: ts.Node): SourceRange {
  const start = node.getStart(source);
  const location = source.getLineAndCharacterOfPosition(start);
  return { start, length: node.getEnd() - start, line: location.line + 1, character: location.character + 1 };
}

function componentName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text) &&
      node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.text;
  return undefined;
}

function componentBody(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node) && node.initializer) return node.initializer;
  return node;
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

function isHostTag(tagName: string): boolean {
  return /^[a-z]/.test(tagName) && !tagName.includes(".");
}

function attribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name);
}

function staticAttributeValue(item: ts.JsxAttribute): string | undefined {
  if (!item.initializer) return "";
  if (ts.isStringLiteral(item.initializer)) return item.initializer.text;
  return undefined;
}

function mapContext(node: ts.Node, source: ts.SourceFile): MapContext | undefined {
  let cursor: ts.Node | undefined = node;
  while (cursor && cursor !== source) {
    if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) && ts.isCallExpression(cursor.parent)) {
      const call: ts.CallExpression = cursor.parent;
      if (call.arguments.includes(cursor) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "map") {
        const item = cursor.parameters[0]?.name;
        const index = cursor.parameters[1]?.name;
        let jsxCursor: ts.Node | undefined = node;
        let key: ts.JsxAttribute | undefined;
        while (jsxCursor && jsxCursor !== cursor) {
          const opening = openingOf(jsxCursor);
          if (opening) {
            const candidate = attribute(opening, "key");
            if (candidate) key = candidate;
          }
          jsxCursor = jsxCursor.parent;
        }
        const expression = key?.initializer && ts.isJsxExpression(key.initializer) ? key.initializer.expression : undefined;
        return {
          callback: cursor,
          ...(item && ts.isIdentifier(item) ? { itemName: item.text } : {}),
          ...(index && ts.isIdentifier(index) ? { indexName: index.text } : {}),
          ...(expression ? { keyExpression: expression, keyText: expression.getText(source) } : {}),
          issueNode: key ?? cursor,
        };
      }
    }
    cursor = cursor.parent;
  }
  return undefined;
}

function includesIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && child.text === identifier) found = true;
    if (!found) child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function stableMapKey(context: MapContext): boolean {
  if (!context.keyExpression || !context.keyText) return false;
  if (context.indexName && includesIdentifier(context.keyExpression, context.indexName)) return false;
  if (ts.isStringLiteral(context.keyExpression) || ts.isNumericLiteral(context.keyExpression)) return false;
  return context.itemName ? includesIdentifier(context.keyExpression, context.itemName) : false;
}

function insideConditional(node: ts.Node, boundary: ts.Node): ts.Node | undefined {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor && cursor !== boundary) {
    if (ts.isConditionalExpression(cursor) ||
        (ts.isBinaryExpression(cursor) && cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return cursor;
    cursor = cursor.parent;
  }
  return undefined;
}

function insidePortal(node: ts.Node, boundary: ts.Node, source: ts.SourceFile): ts.CallExpression | undefined {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor && cursor !== boundary) {
    if (ts.isCallExpression(cursor)) {
      const expression = cursor.expression.getText(source);
      if (expression === "createPortal" || expression.endsWith(".createPortal")) return cursor;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

function normalizedOpening(opening: ts.JsxOpeningLikeElement, source: ts.SourceFile): string {
  return opening.getText(source).replace(/\s+/g, " ").replace(/\sdata-boxspec-id\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g, "").trim();
}

function applyEdits(content: string, edits: readonly PatchEdit[]): string {
  let output = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.insertText + output.slice(edit.start + edit.deleteLength);
  }
  return output;
}

function diagnosticMessage(code: AdoptedDiagnosticCode): { severity: DiagnosticSeverity; support: DiagnosticSupport; message: string } {
  switch (code) {
    case "PARSE_ERROR": return { severity: "error", support: "UNSUPPORTED", message: "The source has a JSX/TypeScript parse error; no mapping guarantee is available." };
    case "INDEX_KEY_UNSUPPORTED": return { severity: "error", support: "UNSUPPORTED", message: "A repeated element uses an array index in its React key; persistent BoxSpec identity is unsafe." };
    case "MISSING_STABLE_INSTANCE_KEY": return { severity: "error", support: "UNSUPPORTED", message: "A repeated element needs an explicit stable key derived from the item before it can be mapped." };
    case "DYNAMIC_ID_UNSUPPORTED": return { severity: "error", support: "UNSUPPORTED", message: "An existing dynamic data-boxspec-id cannot be statically verified." };
    case "DYNAMIC_CLASS_MEASUREMENT_REQUIRED": return { severity: "warning", support: "MEASUREMENT_ONLY", message: "A dynamic className requires rendered-state measurement; class semantics were not inferred." };
    case "CONDITIONAL_BRANCH_MEASUREMENT_REQUIRED": return { severity: "warning", support: "MEASUREMENT_ONLY", message: "Conditional JSX requires measurement in every declared state." };
    case "CSS_IN_JS_MEASUREMENT_REQUIRED": return { severity: "warning", support: "MEASUREMENT_ONLY", message: "CSS-in-JS behavior requires rendered measurement; generated styles were not inferred." };
    case "CUSTOM_COMPONENT_FORWARDING_UNVERIFIED": return { severity: "warning", support: "MEASUREMENT_ONLY", message: "A custom component is not patched because DOM prop forwarding is unverified." };
    case "PORTAL_UNSUPPORTED": return { severity: "error", support: "UNSUPPORTED", message: "Portal geometry is outside the adopted DOM subtree without a validated adapter." };
    case "SHADOW_DOM_UNSUPPORTED": return { severity: "error", support: "UNSUPPORTED", message: "Shadow DOM internals are unsupported without a validated adapter." };
    case "CANVAS_MEASUREMENT_ONLY": return { severity: "warning", support: "MEASUREMENT_ONLY", message: "Only the canvas element bounds can be measured; canvas-drawn UI is not mapped." };
  }
}

export function analyzeAdoptedWebSource(input: AdoptedWebSourceInput): AdoptedWebAnalysis {
  validateSourceInput(input);
  return withParsedSource(input.language, input.content, (source, parseDiagnostics) => analyzeSource(input, source, parseDiagnostics));
}

function analyzeSource(input: AdoptedWebSourceInput, source: ts.SourceFile, parseDiagnostics: readonly { readonly pos: number; readonly end: number; readonly text: string }[]): AdoptedWebAnalysis {
  const baseHash = contentHash(input.content);
  const diagnostics: AdoptedDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const components: ComponentDefinition[] = [];
  const mappings: AdoptedNodeMapping[] = [];
  const edits: PatchEdit[] = [];
  let excludedNodeCount = 0;

  const addDiagnostic = (code: AdoptedDiagnosticCode, node: ts.Node): void => {
    const itemRange = range(source, node);
    const key = code + ":" + itemRange.start;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    const detail = diagnosticMessage(code);
    diagnostics.push({ code, ...detail, range: itemRange });
  };

  for (const issue of parseDiagnostics) addDiagnostic("PARSE_ERROR", findNodeAt(source, issue.pos));

  const visitGlobalRisk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (expression === "createPortal" || expression.endsWith(".createPortal")) addDiagnostic("PORTAL_UNSUPPORTED", node);
      if (expression === "attachShadow" || expression.endsWith(".attachShadow")) addDiagnostic("SHADOW_DOM_UNSUPPORTED", node);
      if (expression === "styled" || expression.startsWith("styled.")) addDiagnostic("CSS_IN_JS_MEASUREMENT_REQUIRED", node);
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(source);
      if (tag === "styled" || tag.startsWith("styled.") || tag === "css") addDiagnostic("CSS_IN_JS_MEASUREMENT_REQUIRED", node);
    }
    node.forEachChild(visitGlobalRisk);
  };
  visitGlobalRisk(source);

  const visit = (node: ts.Node, current?: ComponentContext): void => {
    const name = componentName(node);
    let context = current;
    if (name) {
      const body = componentBody(node);
      const definition: ComponentDefinition = {
        componentDefinitionId: stableId("cmp_", input.sourceId + ":" + name, 16),
        name,
        sourceId: input.sourceId,
        range: range(source, body),
      };
      components.push(definition);
      context = { definition, body, hostIndex: 0 };
      if (body !== node) {
        visit(body, context);
        return;
      }
    }

    const opening = openingOf(node);
    if (opening && context) {
      const tagName = opening.tagName.getText(source);
      if (!isHostTag(tagName)) {
        addDiagnostic("CUSTOM_COMPONENT_FORWARDING_UNVERIFIED", opening);
        excludedNodeCount += 1;
      } else {
        const jsxPath = "host." + context.hostIndex++;
        const templateNodeId = stableId("aw_", context.definition.componentDefinitionId + ":" + jsxPath + ":" + tagName, 20);
        const repeat = mapContext(opening, source);
        let binding: InstanceBinding = { kind: "static" };
        let runtimeIdExpression = JSON.stringify(templateNodeId);
        let canMap = true;
        const portal = insidePortal(opening, context.body, source);
        if (portal) {
          addDiagnostic("PORTAL_UNSUPPORTED", portal);
          canMap = false;
        }
        if (repeat) {
          if (repeat.indexName && repeat.keyExpression && includesIdentifier(repeat.keyExpression, repeat.indexName)) {
            addDiagnostic("INDEX_KEY_UNSUPPORTED", repeat.issueNode);
            canMap = false;
          } else if (!stableMapKey(repeat) || !repeat.keyText) {
            addDiagnostic("MISSING_STABLE_INSTANCE_KEY", repeat.issueNode);
            canMap = false;
          } else {
            binding = {
              kind: "dynamic",
              componentDefinitionId: context.definition.componentDefinitionId,
              stableInstanceKeyExpression: repeat.keyText,
              reactKeyExpression: repeat.keyText,
            };
            runtimeIdExpression = JSON.stringify(context.definition.componentDefinitionId + "/" + templateNodeId + ":") + " + String(" + repeat.keyText + ")";
          }
        }

        const existing = attribute(opening, "data-boxspec-id");
        let attributeText: string;
        if (existing) {
          const staticValue = staticAttributeValue(existing);
          if (staticValue === undefined || repeat) {
            addDiagnostic("DYNAMIC_ID_UNSUPPORTED", existing);
            canMap = false;
          }
          attributeText = existing.getText(source);
          if (staticValue !== undefined) runtimeIdExpression = JSON.stringify(staticValue);
        } else {
          attributeText = binding.kind === "dynamic"
            ? "data-boxspec-id={" + runtimeIdExpression + "}"
            : "data-boxspec-id=" + JSON.stringify(templateNodeId);
        }

        if (canMap) {
          if (!existing) {
            edits.push({
              start: opening.tagName.getEnd(),
              deleteLength: 0,
              insertText: " " + attributeText,
              templateNodeId,
              reason: binding.kind === "dynamic" ? "ADD_DYNAMIC_BOX_SPEC_ID" : "ADD_STATIC_BOX_SPEC_ID",
            });
          }
          mappings.push({
            templateNodeId,
            tagName,
            componentDefinitionId: context.definition.componentDefinitionId,
            jsxPath,
            runtimeIdExpression,
            sourceFingerprint: contentHash(normalizedOpening(opening, source)),
            sourceRange: range(source, opening),
            attributeText,
            instanceBinding: binding,
          });
        } else {
          excludedNodeCount += 1;
        }

        const className = attribute(opening, "className");
        if (className?.initializer && ts.isJsxExpression(className.initializer)) addDiagnostic("DYNAMIC_CLASS_MEASUREMENT_REQUIRED", className);
        if (tagName === "canvas") addDiagnostic("CANVAS_MEASUREMENT_ONLY", opening);
        const conditional = insideConditional(opening, context.body);
        if (conditional) addDiagnostic("CONDITIONAL_BRANCH_MEASUREMENT_REQUIRED", conditional);
      }
    }
    node.forEachChild((child) => visit(child, context));
  };
  visit(source);

  const proposedContent = applyEdits(input.content, edits);
  const proposedHash = contentHash(proposedContent);
  const sortedEdits = [...edits].sort((a, b) => a.start - b.start);
  const proposal: AdoptedPatchProposal = {
    schemaVersion: "1.0.0",
    proposalId: stableId("proposal_", input.sourceId + ":" + baseHash + ":" + JSON.stringify(sortedEdits), 24),
    sourceId: input.sourceId,
    fileName: input.fileName,
    baseContentHash: baseHash,
    proposedContentHash: proposedHash,
    summary: "Add " + sortedEdits.length + " data-boxspec-id attribute" + (sortedEdits.length === 1 ? "" : "s") + " without changing imports, control flow, layout, or business logic.",
    approvalRequired: true,
    edits: sortedEdits,
  };
  const mapping = {
    schemaVersion: "1.0.0" as const,
    mappingId: stableId("mapping_", input.sourceId + ":" + baseHash + ":" + proposedHash + ":" + mappings.map((item) => item.templateNodeId).join(","), 24),
    projectId: input.approvedContext.projectId,
    screenId: input.approvedContext.screenId,
    sourceId: input.sourceId,
    fileName: input.fileName,
    baseContentHash: baseHash,
    proposedContentHash: proposedHash,
    componentDefinitions: components,
    nodes: mappings,
  };
  const hasUnsupported = diagnostics.some((item) => item.support === "UNSUPPORTED");
  const hasMeasurement = diagnostics.some((item) => item.support === "MEASUREMENT_ONLY");
  const guarantee: AdoptedGuarantee = {
    mode: "ADOPTED",
    status: hasUnsupported ? "UNSUPPORTED" : hasMeasurement ? "MEASUREMENT_REQUIRED" : "PROPOSAL_ONLY",
    staticAnalysisConfidence: hasUnsupported ? (mappings.length > 0 ? "LOW" : "NONE") : hasMeasurement ? "MEDIUM" : "HIGH",
    layoutGuarantee: "NONE_UNTIL_MEASURED",
    viewport: { ...input.approvedContext.viewport },
    testedStates: [...input.approvedContext.testedStates],
    viewportEvidence: "DECLARED_NOT_VERIFIED",
    supportedNodeCount: mappings.length,
    excludedNodeCount,
    claims: [
      "Static host JSX nodes were identified from the supplied source text only.",
      "The proposal contains attribute insertions only and remains subject to user approval.",
      "Dynamic instance bindings are emitted only when an explicit non-index React key is statically tied to the item.",
    ],
    exclusions: [...new Set(diagnostics.filter((item) => item.support !== "STATIC").map((item) => item.code))].sort(),
  };
  return { schemaVersion: "1.0.0", sourceId: input.sourceId, contentHash: baseHash, proposal, mapping, diagnostics, guarantee };
}

function findNodeAt(source: ts.SourceFile, position: number): ts.Node {
  let best: ts.Node = source;
  const visit = (node: ts.Node): void => {
    if (node.getFullStart() <= position && node.getEnd() >= position) {
      best = node;
      node.forEachChild(visit);
    }
  };
  visit(source);
  return best;
}
