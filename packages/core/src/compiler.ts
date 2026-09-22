import { CoreError } from "./errors.js";
import { canonicalJson, hashContract, ordinalCompare, sha256 } from "./canonical.js";
import type { DesignToken, Layout, LayoutContract, LayoutNode, Placement, Size } from "./model.js";
import { parseLayoutContract } from "./validation.js";

export const REACT_COMPILER_VERSION = "boxspec-react-shell/1.1.0";
export interface ReactShellOptions { cssImportPath?: string; componentName?: string }
export interface GeneratedFile { path: string; content: string; sha256: string }
export interface ReactShellOutput { generatorVersion: string; contractHash: string; sourceHash: string; files: readonly GeneratedFile[] }

function px(value: number): string { return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}px`; }
function sizeCss(axis: "width" | "height", size: Size): string[] {
  if (size.mode === "fixed") return [`${axis}:${px(size.value)}`, "flex-shrink:0"];
  const rules = [`min-${axis}:${px(size.min)}`];
  if (size.max !== undefined) rules.push(`max-${axis}:${px(size.max)}`);
  if (size.mode === "fill") rules.push(`flex-grow:${size.weight}`, "flex-basis:0");
  else rules.push(`${axis}:fit-content`, "flex-grow:0");
  return rules;
}
function align(value: Layout["align"]): string { return value === "start" ? "flex-start" : value === "end" ? "flex-end" : value; }
function justify(value: Layout["justify"]): string { return value === "start" ? "flex-start" : value === "end" ? "flex-end" : value; }
function layoutCss(layout: Partial<Layout>): string[] {
  const rules: string[] = [];
  if (layout.mode) {
    if (layout.mode === "row" || layout.mode === "column") rules.push("display:flex", `flex-direction:${layout.mode}`);
    else if (layout.mode === "grid") rules.push("display:grid");
    else if (layout.mode === "overlay") rules.push("display:block", "position:relative");
    else rules.push("display:block");
  }
  if (layout.width) rules.push(...sizeCss("width", layout.width));
  if (layout.height) rules.push(...sizeCss("height", layout.height));
  if (layout.padding) rules.push(`padding:${px(layout.padding.top)} ${px(layout.padding.right)} ${px(layout.padding.bottom)} ${px(layout.padding.left)}`, "box-sizing:border-box");
  if (layout.gap !== undefined) rules.push(`gap:${px(layout.gap)}`);
  if (layout.align) rules.push(`align-items:${align(layout.align)}`);
  if (layout.justify) rules.push(`justify-content:${justify(layout.justify)}`);
  if (layout.gridColumns !== undefined) rules.push(`grid-template-columns:repeat(${layout.gridColumns},minmax(0,1fr))`);
  return rules;
}
function placementCss(placement: Placement): string[] {
  if (placement.kind === "flow") return [];
  const rules = ["position:absolute", `z-index:${placement.zIndex}`];
  if (placement.anchorX === "left") rules.push(`left:${px(placement.offsetX)}`);
  else if (placement.anchorX === "right") rules.push(`right:${px(placement.offsetX)}`);
  else rules.push("left:50%", `transform:translateX(-50%) translateX(${px(placement.offsetX)})`);
  if (placement.anchorY === "top") rules.push(`top:${px(placement.offsetY)}`);
  else if (placement.anchorY === "bottom") rules.push(`bottom:${px(placement.offsetY)}`);
  else {
    rules.push("top:50%");
    const transformIndex = rules.findIndex((rule) => rule.startsWith("transform:"));
    const vertical = `translateY(-50%) translateY(${px(placement.offsetY)})`;
    if (transformIndex >= 0) rules[transformIndex] = `${rules[transformIndex]} ${vertical}`;
    else rules.push(`transform:${vertical}`);
  }
  return rules;
}
function className(id: string): string { return `node_${id}`; }
function declaration(selector: string, rules: string[]): string { return `${selector}{${rules.join(";")};}`; }
function componentName(screenId: string): string { return `${screenId.split(/[_-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}Layout`; }

type SupportedToken = {
  readonly name: string;
  readonly variable: `--boxspec-${string}`;
  readonly type: DesignToken["type"];
};
const SUPPORTED_TOKENS: readonly SupportedToken[] = [
  { name: "border.width", variable: "--boxspec-border-width", type: "dimension" },
  { name: "color.accent", variable: "--boxspec-color-accent", type: "color" },
  { name: "color.background", variable: "--boxspec-color-background", type: "color" },
  { name: "color.border", variable: "--boxspec-color-border", type: "color" },
  { name: "color.surface", variable: "--boxspec-color-surface", type: "color" },
  { name: "color.text", variable: "--boxspec-color-text", type: "color" },
  { name: "font.family.body", variable: "--boxspec-font-family-body", type: "font-family" },
  { name: "font.family.display", variable: "--boxspec-font-family-display", type: "font-family" },
  { name: "radius.large", variable: "--boxspec-radius-large", type: "dimension" },
  { name: "radius.medium", variable: "--boxspec-radius-medium", type: "dimension" },
  { name: "radius.small", variable: "--boxspec-radius-small", type: "dimension" },
  { name: "spacing.large", variable: "--boxspec-spacing-large", type: "dimension" },
  { name: "spacing.medium", variable: "--boxspec-spacing-medium", type: "dimension" },
  { name: "spacing.page", variable: "--boxspec-spacing-page", type: "dimension" },
  { name: "spacing.section", variable: "--boxspec-spacing-section", type: "dimension" },
  { name: "spacing.small", variable: "--boxspec-spacing-small", type: "dimension" },
] as const;

function safeTokenValue(spec: SupportedToken, token: DesignToken): string {
  if (token.type !== spec.type) throw new CoreError("SCHEMA_INVALID", `Design token '${spec.name}' must have type '${spec.type}'`, { tokenName: spec.name, expectedType: spec.type, actualType: token.type });
  if (token.type === "dimension") return px(token.value);
  if (token.type === "color") {
    if (!/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(token.value)) {
      throw new CoreError("SCHEMA_INVALID", `Design token '${spec.name}' is not a supported hexadecimal color`, { tokenName: spec.name });
    }
    return token.value.toUpperCase();
  }
  if (!/^[\p{L}\p{N} '"_,.-]+$/u.test(token.value) || !token.value.trim()) {
    throw new CoreError("SCHEMA_INVALID", `Design token '${spec.name}' is not a safe font-family list`, { tokenName: spec.name });
  }
  return token.value;
}

function themeVariables(tokens: Readonly<Record<string, DesignToken>>): { readonly rules: string[]; readonly available: ReadonlySet<string> } {
  const rules: string[] = [], available = new Set<string>();
  for (const spec of SUPPORTED_TOKENS) {
    const token = tokens[spec.name];
    if (!token) continue;
    rules.push(`${spec.variable}:${safeTokenValue(spec, token)}`);
    available.add(spec.name);
  }
  return { rules, available };
}

function presentationCss(node: LayoutNode, rootNodeId: string, available: ReadonlySet<string>): string[] {
  const has = (name: string): boolean => available.has(name);
  const rules: string[] = [];
  if (node.id === rootNodeId) {
    if (has("color.background")) rules.push("background-color:var(--boxspec-color-background)");
    if (has("color.text")) rules.push("color:var(--boxspec-color-text)");
    if (has("color.accent")) rules.push("accent-color:var(--boxspec-color-accent)");
    if (has("font.family.body")) rules.push("font-family:var(--boxspec-font-family-body)");
  }
  const usesSurface = node.role === "navigation" || node.role === "content" || node.role === "list" || node.role === "input" || node.role === "overlay";
  if (usesSurface && has("color.surface")) rules.push("background-color:var(--boxspec-color-surface)");
  if ((usesSurface || node.role === "button") && has("radius.medium")) rules.push("border-radius:var(--boxspec-radius-medium)");
  if (node.role === "button" && has("color.accent")) rules.push("background-color:var(--boxspec-color-accent)");
  if (node.role === "button" && has("color.background")) rules.push("color:var(--boxspec-color-background)");
  if ((node.role === "text" || node.role === "input") && has("color.text")) rules.push("color:var(--boxspec-color-text)");
  return rules;
}
function renderNode(node: LayoutNode, children: Map<string | null, LayoutNode[]>): string {
  const nested = (children.get(node.id) ?? []).map((child) => renderNode(child, children)).join("\n");
  const content = node.slot.componentKey
    ? `{(() => { const Slot = slots[${JSON.stringify(node.slot.componentKey)}]; return Slot ? <Slot /> : null; })()}`
    : node.content.text !== undefined ? `{${JSON.stringify(node.content.text)}}` : "";
  const body = [content, nested].filter(Boolean).join("\n");
  return `<div className={styles[${JSON.stringify(className(node.id))}]} data-boxspec-node=${JSON.stringify(node.id)}>${body}</div>`;
}
function compileCss(contract: LayoutContract): string {
  const blocks: string[] = ["/* Generated by BoxSpec. Do not edit. */"];
  const theme = themeVariables(contract.designSystem.tokens);
  for (const node of contract.nodes) {
    blocks.push(declaration(`.${className(node.id)}`, [
      ...(node.id === contract.rootNodeId ? theme.rules : []),
      ...layoutCss(node.layout),
      ...placementCss(node.placement),
      ...presentationCss(node, contract.rootNodeId, theme.available),
      node.visible ? "" : "display:none",
    ].filter(Boolean)));
  }
  for (const breakpoint of [...contract.breakpoints].sort((a, b) => a.minWidth - b.minWidth || ordinalCompare(a.id, b.id))) {
    const conditions = [`(min-width:${px(breakpoint.minWidth)})`];
    if (breakpoint.maxWidthExclusive !== null) conditions.push(`(max-width:${px(Math.max(0, breakpoint.maxWidthExclusive - 0.001))})`);
    const responsive: string[] = [];
    for (const node of contract.nodes) {
      const override = node.responsive.find((item) => item.breakpointId === breakpoint.id);
      if (!override) continue;
      const rules = [...(override.layout ? layoutCss(override.layout) : []), ...(override.placement ? placementCss(override.placement) : [])];
      if (override.visible !== undefined) {
        if (override.visible) rules.push(...layoutCss({ mode: override.layout?.mode ?? node.layout.mode }).filter((rule) => rule.startsWith("display:")));
        else rules.push("display:none");
      }
      responsive.push(declaration(`.${className(node.id)}`, rules));
    }
    if (responsive.length) blocks.push(`@media ${conditions.join(" and ")}{${responsive.join("")}}`);
  }
  return `${blocks.join("\n")}\n`;
}
export function compileReactShell(input: LayoutContract, options: ReactShellOptions = {}): ReactShellOutput {
  const contract = parseLayoutContract(input);
  if (contract.target !== "web-react") throw new CoreError("UNSUPPORTED_TARGET", `React compiler cannot compile target '${contract.target}'`, { target: contract.target });
  const children = new Map<string | null, LayoutNode[]>();
  for (const node of contract.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || ordinalCompare(a.id, b.id));
  const root = contract.nodes.find((node) => node.id === contract.rootNodeId)!;
  const name = options.componentName ?? componentName(contract.screenId);
  const cssPath = options.cssImportPath ?? `./${contract.screenId}.layout.module.css`;
  const slotKeys = [...new Set(contract.nodes.map((node) => node.slot.componentKey).filter((key): key is string => key !== null))].sort(ordinalCompare);
  const tsx = `/* Generated by BoxSpec. Do not edit. */\nimport type { ComponentType } from "react";\nimport styles from ${JSON.stringify(cssPath)};\n\nexport const boxSpecContractHash = ${JSON.stringify(hashContract(contract))};\nexport type ${name}SlotKey = ${slotKeys.length ? slotKeys.map((key) => JSON.stringify(key)).join(" | ") : "never"};\nexport type ${name}Slots = Partial<Record<${name}SlotKey, ComponentType>>;\n\nexport interface ${name}Props { slots?: ${name}Slots }\n\nexport function ${name}({ slots = {} }: ${name}Props) {\n  return (\n    ${renderNode(root, children).split("\n").join("\n    ")}\n  );\n}\n`;
  const css = compileCss(contract);
  const orderedNodeIds = contract.nodes.map((node) => node.id).sort(ordinalCompare);
  const typeSource = `/* Generated by BoxSpec. Do not edit. */\nexport type ${name}NodeId = ${orderedNodeIds.map((nodeId) => JSON.stringify(nodeId)).join(" | ")};\nexport const ${name}NodeIds = ${canonicalJson(orderedNodeIds)} as const;\n`;
  const files = [
    { path: `${contract.screenId}.layout.tsx`, content: tsx, sha256: sha256(tsx) },
    { path: `${contract.screenId}.layout.module.css`, content: css, sha256: sha256(css) },
    { path: `${contract.screenId}.layout.types.ts`, content: typeSource, sha256: sha256(typeSource) },
  ] as const;
  return { generatorVersion: REACT_COMPILER_VERSION, contractHash: hashContract(contract), sourceHash: sha256(canonicalJson({ generatorVersion: REACT_COMPILER_VERSION, files })), files };
}
