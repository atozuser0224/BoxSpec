import * as ts from "typescript/unstable/ast";
import { contentHash } from "./hash.js";
import { withParsedSource } from "./parser.js";
import type { AdoptedWebLanguage } from "./types.js";

/** AST-shape evidence helper used to prove a proposal only adds BoxSpec mapping attributes. */
export function sourceShapeFingerprint(fileName: string, language: AdoptedWebLanguage, content: string): string {
  void fileName;
  return withParsedSource(language, content, (source) => {
    const parts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "data-boxspec-id") return;
      parts.push(String(node.kind));
      if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isJsxText(node)) parts.push(node.getText(source));
      node.forEachChild(visit);
    };
    visit(source);
    return contentHash(parts.join("\u001F"));
  });
}
