export type ThemeErrorCode = "THEME_CATALOG_INVALID" | "THEME_NOT_FOUND" | "THEME_REVISION_CONFLICT" | "THEME_APPLICATION_INVALID";
export interface ThemeIssue { readonly path: string; readonly code: string; readonly message: string }
export class ThemeError extends Error {
  override readonly name = "ThemeError";
  constructor(readonly code: ThemeErrorCode, message: string, readonly issues: readonly ThemeIssue[] = []) { super(message); }
}
