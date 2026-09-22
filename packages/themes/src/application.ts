import { canonicalJson, hashContract, parseLayoutContract } from "@boxspec/core";
import type { DesignToken, LayoutContract } from "@boxspec/shared/contracts";
import { compareOrdinal } from "@boxspec/shared/hashing";
import { ThemeError } from "./errors.js";
import { parseThemePreset } from "./validation.js";
import type { ThemeApplicationResult, ThemePreset } from "./types.js";

const THEME_PREFIXES = ["color.", "font.", "radius.", "border."] as const;
function isThemeToken(name: string): boolean { return THEME_PREFIXES.some((prefix) => name.startsWith(prefix)); }
function protectedContract(contract: LayoutContract): unknown { const { designSystem: _designSystem, revision: _revision, ...protectedValue } = contract; return protectedValue; }
function assertRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) throw new ThemeError("THEME_REVISION_CONFLICT", `Theme application expected contract revision ${expected}, but current revision is ${actual}`, [{ path: "/revision", code: "REVISION_CONFLICT", message: `Expected ${expected}; received ${actual}` }]);
}
function apply(contractInput: LayoutContract, presetInput: ThemePreset, revision: number, mode: ThemeApplicationResult["contractRevisionMode"]): ThemeApplicationResult {
  const contract = parseLayoutContract(contractInput), preset = parseThemePreset(presetInput);
  const tokens: Record<string, DesignToken> = {};
  for (const name of Object.keys(contract.designSystem.tokens).sort(compareOrdinal)) if (!isThemeToken(name)) tokens[name] = contract.designSystem.tokens[name]!;
  for (const name of Object.keys(preset.tokens).sort(compareOrdinal)) tokens[name] = preset.tokens[name]!;
  const previousThemeTokens = Object.keys(contract.designSystem.tokens).filter(isThemeToken);
  const changedTokenNames = [...new Set([...previousThemeTokens, ...Object.keys(preset.tokens)])].filter((name) => canonicalJson(contract.designSystem.tokens[name] ?? null) !== canonicalJson(tokens[name] ?? null)).sort(compareOrdinal);
  const candidate = parseLayoutContract({ ...contract, revision, designSystem: { id: `theme_${preset.id}`, revision: contract.designSystem.revision + 1, tokens } });
  if (canonicalJson(protectedContract(contract)) !== canonicalJson(protectedContract(candidate))) throw new ThemeError("THEME_APPLICATION_INVALID", "Theme application changed protected contract structure", [{ path: "/", code: "PROTECTED_STATE_CHANGED", message: "Nodes, geometry, policy, or verification changed" }]);
  return {
    contract: candidate, themeId: preset.id, changedTokenNames, designSystemRevision: candidate.designSystem.revision, contractRevisionMode: mode,
    beforeContractHash: hashContract(contract), afterContractHash: hashContract(candidate),
  };
}
export function applyThemeToDraft(contract: LayoutContract, preset: ThemePreset, options: { readonly expectedContractRevision: number }): ThemeApplicationResult {
  const parsed = parseLayoutContract(contract); assertRevision(parsed.revision, options.expectedContractRevision);
  return apply(parsed, preset, parsed.revision, "preserved-draft");
}
export function applyThemeToContract(contract: LayoutContract, preset: ThemePreset, options: { readonly expectedRevision: number }): ThemeApplicationResult {
  const parsed = parseLayoutContract(contract); assertRevision(parsed.revision, options.expectedRevision);
  return apply(parsed, preset, parsed.revision + 1, "incremented-contract");
}
