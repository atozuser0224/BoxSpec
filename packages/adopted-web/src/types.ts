export type AdoptedWebLanguage = "tsx" | "jsx";
export type DiagnosticSupport = "STATIC" | "MEASUREMENT_ONLY" | "UNSUPPORTED";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface AdoptedViewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface ApprovedAnalysisContext {
  readonly projectId: string;
  readonly screenId: string;
  readonly approvalId: string;
  readonly allowedSourceIds: readonly string[];
  readonly viewport: AdoptedViewport;
  readonly testedStates: readonly string[];
}

export interface AdoptedWebSourceInput {
  readonly sourceId: string;
  readonly fileName: string;
  readonly language: AdoptedWebLanguage;
  readonly content: string;
  readonly approvedContext: ApprovedAnalysisContext;
}

export type AdoptedDiagnosticCode =
  | "PARSE_ERROR"
  | "INDEX_KEY_UNSUPPORTED"
  | "MISSING_STABLE_INSTANCE_KEY"
  | "DYNAMIC_ID_UNSUPPORTED"
  | "DYNAMIC_CLASS_MEASUREMENT_REQUIRED"
  | "CONDITIONAL_BRANCH_MEASUREMENT_REQUIRED"
  | "CSS_IN_JS_MEASUREMENT_REQUIRED"
  | "CUSTOM_COMPONENT_FORWARDING_UNVERIFIED"
  | "PORTAL_UNSUPPORTED"
  | "SHADOW_DOM_UNSUPPORTED"
  | "CANVAS_MEASUREMENT_ONLY";

export interface SourceRange {
  readonly start: number;
  readonly length: number;
  readonly line: number;
  readonly character: number;
}

export interface AdoptedDiagnostic {
  readonly code: AdoptedDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly support: DiagnosticSupport;
  readonly message: string;
  readonly range: SourceRange;
}

export interface ComponentDefinition {
  readonly componentDefinitionId: string;
  readonly name: string;
  readonly sourceId: string;
  readonly range: SourceRange;
}

export type InstanceBinding =
  | { readonly kind: "static" }
  | {
      readonly kind: "dynamic";
      readonly componentDefinitionId: string;
      readonly stableInstanceKeyExpression: string;
      readonly reactKeyExpression: string;
    };

export interface AdoptedNodeMapping {
  readonly templateNodeId: string;
  readonly tagName: string;
  readonly componentDefinitionId: string;
  readonly jsxPath: string;
  readonly runtimeIdExpression: string;
  readonly sourceFingerprint: string;
  readonly sourceRange: SourceRange;
  readonly attributeText: string;
  readonly instanceBinding: InstanceBinding;
}

export interface AdoptedWebMapping {
  readonly schemaVersion: "1.0.0";
  readonly mappingId: string;
  readonly projectId: string;
  readonly screenId: string;
  readonly sourceId: string;
  readonly fileName: string;
  readonly baseContentHash: string;
  readonly proposedContentHash: string;
  readonly componentDefinitions: readonly ComponentDefinition[];
  readonly nodes: readonly AdoptedNodeMapping[];
}

export interface PatchEdit {
  readonly start: number;
  readonly deleteLength: 0;
  readonly insertText: string;
  readonly templateNodeId: string;
  readonly reason: "ADD_STATIC_BOX_SPEC_ID" | "ADD_DYNAMIC_BOX_SPEC_ID";
}

export interface AdoptedPatchProposal {
  readonly schemaVersion: "1.0.0";
  readonly proposalId: string;
  readonly sourceId: string;
  readonly fileName: string;
  readonly baseContentHash: string;
  readonly proposedContentHash: string;
  readonly summary: string;
  readonly approvalRequired: true;
  readonly edits: readonly PatchEdit[];
}

export interface MaterializedPatch {
  readonly sourceId: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface AdoptedGuarantee {
  readonly mode: "ADOPTED";
  readonly status: "PROPOSAL_ONLY" | "MEASUREMENT_REQUIRED" | "UNSUPPORTED";
  readonly staticAnalysisConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  readonly layoutGuarantee: "NONE_UNTIL_MEASURED";
  readonly viewport: AdoptedViewport;
  readonly testedStates: readonly string[];
  readonly viewportEvidence: "DECLARED_NOT_VERIFIED";
  readonly supportedNodeCount: number;
  readonly excludedNodeCount: number;
  readonly claims: readonly string[];
  readonly exclusions: readonly string[];
}

export interface AdoptedWebAnalysis {
  readonly schemaVersion: "1.0.0";
  readonly sourceId: string;
  readonly contentHash: string;
  readonly proposal: AdoptedPatchProposal;
  readonly mapping: AdoptedWebMapping;
  readonly diagnostics: readonly AdoptedDiagnostic[];
  readonly guarantee: AdoptedGuarantee;
}

export interface MappingDriftIssue {
  readonly code: "SOURCE_HASH_CHANGED" | "PATCH_NOT_APPLIED" | "MAPPING_ATTRIBUTE_MISSING";
  readonly message: string;
  readonly templateNodeId?: string;
}

export interface MappingDriftReport {
  readonly status: "ALIGNED" | "STALE";
  readonly expectedContentHash: string;
  readonly actualContentHash: string;
  readonly issues: readonly MappingDriftIssue[];
}

export interface MappingDiff {
  readonly status: "UNCHANGED" | "CHANGED";
  readonly addedTemplateNodeIds: readonly string[];
  readonly removedTemplateNodeIds: readonly string[];
  readonly changedTemplateNodeIds: readonly string[];
}
