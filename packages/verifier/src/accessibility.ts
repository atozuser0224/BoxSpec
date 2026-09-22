import type { Page } from "playwright";
import { hashCanonical, sha256Bytes } from "./hash.js";
import type { Violation } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface AccessibilityAuditBinding {
  readonly candidateId: string;
  readonly treeHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileHash: string;
  readonly viewportId: string;
  readonly fixtureId: string;
  readonly stateId: string;
  readonly nodeIds: readonly string[];
}

export interface AccessibilityMeasurement {
  readonly interactiveElements: number;
  readonly namedInteractiveElements: number;
  readonly textSamples: number;
  readonly contrastSamples: number;
  readonly unsupportedContrastSamples: number;
  readonly tabStops: number;
  readonly reachedTabStops: number;
  readonly minimumContrastRatio: number | null;
}

export interface AccessibilityAuditResult {
  readonly status: "PASS" | "FAIL" | "UNSUPPORTED" | "ERROR" | "STALE";
  readonly binding: AccessibilityAuditBinding;
  readonly bindingDigest: string;
  readonly domSha256: string | null;
  readonly violations: readonly Violation[];
  readonly measurement: AccessibilityMeasurement;
  readonly message: string;
}

interface BrowserFinding {
  readonly kind: string;
  readonly message: string;
  readonly selector: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

interface BrowserAuditSnapshot {
  readonly findings: readonly BrowserFinding[];
  readonly focusableIds: readonly string[];
  readonly interactiveElements: number;
  readonly namedInteractiveElements: number;
  readonly textSamples: number;
  readonly contrastRatios: readonly number[];
  readonly unsupportedContrastSamples: number;
}

function emptyMeasurement(): AccessibilityMeasurement {
  return {
    interactiveElements: 0,
    namedInteractiveElements: 0,
    textSamples: 0,
    contrastSamples: 0,
    unsupportedContrastSamples: 0,
    tabStops: 0,
    reachedTabStops: 0,
    minimumContrastRatio: null,
  };
}

function validateBinding(binding: AccessibilityAuditBinding): void {
  if (!binding.candidateId || !binding.verificationProfileId || !binding.viewportId || !binding.fixtureId || !binding.stateId) {
    throw new TypeError("Accessibility audit binding is incomplete");
  }
  if (!SHA256.test(binding.treeHash) || !SHA256.test(binding.verificationProfileHash)) {
    throw new TypeError("Accessibility audit binding hashes must be lowercase SHA-256 values");
  }
}

/** Browser hook for verifier/browser.ts; the richer result must be persisted as trusted evidence. */
export async function evaluateAccessibility(
  page: Page | undefined,
  context: AccessibilityAuditBinding,
): Promise<AccessibilityAuditResult> {
  return runAccessibilityAudit({ ...(page ? { page } : {}), binding: context });
}

function resultForUnavailable(binding: AccessibilityAuditBinding, message: string): AccessibilityAuditResult {
  return {
    status: "UNSUPPORTED",
    binding,
    bindingDigest: hashCanonical(binding),
    domSha256: null,
    violations: [],
    measurement: emptyMeasurement(),
    message,
  };
}

export async function runAccessibilityAudit(input: {
  readonly page?: Page;
  readonly binding: AccessibilityAuditBinding;
  readonly expectedDomSha256?: string;
  readonly normalTextContrast?: number;
  readonly largeTextContrast?: number;
}): Promise<AccessibilityAuditResult> {
  validateBinding(input.binding);
  const bindingDigest = hashCanonical(input.binding);
  if (!input.page) return resultForUnavailable(input.binding, "A trusted browser page was not supplied");
  const normalTextContrast = input.normalTextContrast ?? 4.5;
  const largeTextContrast = input.largeTextContrast ?? 3;
  if (normalTextContrast <= 1 || largeTextContrast <= 1) {
    throw new TypeError("Accessibility contrast thresholds must be greater than 1");
  }

  try {
    const startHtml = await input.page.content();
    const domSha256 = sha256Bytes(startHtml);
    if (input.expectedDomSha256 !== undefined && input.expectedDomSha256 !== domSha256) {
      return {
        status: "STALE",
        binding: input.binding,
        bindingDigest,
        domSha256,
        violations: [{
          id: `accessibility:${input.binding.viewportId}:${input.binding.fixtureId}:dom-start`,
          checkId: "accessibility",
          kind: "trusted-dom-hash-mismatch",
          severity: "error",
          blocking: true,
          message: "Rendered DOM does not match the trusted audit input hash",
          viewportId: input.binding.viewportId,
          fixtureId: input.binding.fixtureId,
          expected: input.expectedDomSha256,
          actual: domSha256,
        }],
        measurement: emptyMeasurement(),
        message: "Rendered DOM changed before accessibility audit",
      };
    }

    const snapshot = await input.page.evaluate(
      ({ normalContrast, largeContrast }): BrowserAuditSnapshot => {
        type AuditedElement = HTMLElement & { __boxspecA11yAuditId?: string };
        const findings: BrowserFinding[] = [];
        const focusableIds: string[] = [];
        const contrastRatios: number[] = [];
        let unsupportedContrastSamples = 0;
        let interactiveElements = 0;
        let namedInteractiveElements = 0;
        let textSamples = 0;
        const roleNames = new Set([
          "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader",
          "combobox", "complementary", "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure",
          "form", "grid", "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main",
          "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
          "note", "option", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader",
          "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table",
          "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
        ]);
        const interactiveRoles = new Set([
          "button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
          "radio", "scrollbar", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
        ]);
        const elements = [...document.querySelectorAll<HTMLElement>("body *")];
        const visible = (element: HTMLElement): boolean => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
        };
        const selector = (element: HTMLElement): string => {
          if (element.id) return `#${CSS.escape(element.id)}`;
          const name = element.tagName.toLowerCase();
          const siblings = element.parentElement ? [...element.parentElement.children].filter((item) => item.tagName === element.tagName) : [];
          return siblings.length > 1 ? `${name}:nth-of-type(${siblings.indexOf(element) + 1})` : name;
        };
        const implicitRole = (element: HTMLElement): string | null => {
          const tag = element.tagName.toLowerCase();
          if (tag === "button") return "button";
          if (tag === "a" && element.hasAttribute("href")) return "link";
          if (tag === "select") return "combobox";
          if (tag === "textarea") return "textbox";
          if (tag === "img") return "img";
          if (tag === "input") {
            const type = (element.getAttribute("type") ?? "text").toLowerCase();
            if (["button", "submit", "reset", "image"].includes(type)) return "button";
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "range") return "slider";
            if (["hidden", "file", "color"].includes(type)) return null;
            return "textbox";
          }
          return null;
        };
        const accessibleName = (element: HTMLElement): string => {
          const ariaLabel = element.getAttribute("aria-label")?.trim();
          if (ariaLabel) return ariaLabel;
          const labelledBy = element.getAttribute("aria-labelledby")?.trim().split(/\s+/u).filter(Boolean) ?? [];
          const labelledText = labelledBy.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
          if (labelledText) return labelledText;
          if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            const labels = [...(element.labels ?? [])].map((label) => label.textContent?.trim() ?? "").filter(Boolean).join(" ");
            if (labels) return labels;
            if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) && element.value.trim()) return element.value.trim();
          }
          if (element instanceof HTMLImageElement && element.alt.trim()) return element.alt.trim();
          return element.textContent?.trim() ?? "";
        };
        const nativeFocusable = (element: HTMLElement): boolean => {
          if (element.hasAttribute("disabled")) return false;
          const tag = element.tagName.toLowerCase();
          if (tag === "a") return element.hasAttribute("href");
          return ["button", "input", "select", "textarea", "summary"].includes(tag);
        };
        const parseColor = (value: string): [number, number, number, number] | null => {
          const match = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u);
          if (!match) return null;
          return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
        };
        const blend = (front: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          if (alpha === 0) return [255, 255, 255, 1];
          return [
            (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
            (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
            (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
            alpha,
          ];
        };
        const background = (element: HTMLElement): [number, number, number, number] | null => {
          let output: [number, number, number, number] = [255, 255, 255, 1];
          const stack: HTMLElement[] = [];
          for (let current: HTMLElement | null = element; current; current = current.parentElement) stack.push(current);
          for (const current of stack.reverse()) {
            const style = getComputedStyle(current);
            if (style.backgroundImage !== "none") return null;
            const color = parseColor(style.backgroundColor);
            if (!color) return null;
            output = blend(color, output);
          }
          return output;
        };
        const luminance = (color: [number, number, number, number]): number => {
          const channel = (value: number) => {
            const normalized = value / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return channel(color[0]) * 0.2126 + channel(color[1]) * 0.7152 + channel(color[2]) * 0.0722;
        };
        const contrast = (left: [number, number, number, number], right: [number, number, number, number]): number => {
          const first = luminance(left);
          const second = luminance(right);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        };

        const idCounts = new Map<string, number>();
        for (const element of elements) if (element.id) idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
        for (const [id, count] of idCounts) {
          if (count > 1) findings.push({ kind: "duplicate-id", message: `DOM id '${id}' occurs ${count} times`, selector: `#${CSS.escape(id)}`, expected: 1, actual: count });
        }

        let auditId = 0;
        for (const element of elements) {
          if (!visible(element)) continue;
          const explicitRole = element.getAttribute("role")?.trim().split(/\s+/u)[0] ?? null;
          if (explicitRole && !roleNames.has(explicitRole)) {
            findings.push({ kind: "invalid-role", message: `Unknown ARIA role '${explicitRole}'`, selector: selector(element), expected: "valid ARIA role", actual: explicitRole });
          }
          const role = explicitRole && roleNames.has(explicitRole) ? explicitRole : implicitRole(element);
          const isInteractive = nativeFocusable(element) || (role !== null && interactiveRoles.has(role));
          if (isInteractive) {
            interactiveElements += 1;
            const name = accessibleName(element);
            if (name) namedInteractiveElements += 1;
            else findings.push({ kind: "accessible-name", message: "Interactive element has no accessible name", selector: selector(element), expected: "non-empty accessible name", actual: "" });
            if (!nativeFocusable(element) && role !== null && interactiveRoles.has(role) && element.tabIndex < 0) {
              findings.push({ kind: "keyboard", message: `Custom ${role} is not keyboard focusable`, selector: selector(element), expected: "tabIndex >= 0", actual: element.tabIndex });
            }
          }
          const isFocusable = (nativeFocusable(element) || element.tabIndex >= 0) && !element.hasAttribute("disabled");
          if (isFocusable) {
            if (element.closest('[aria-hidden="true"]')) {
              findings.push({ kind: "aria-hidden-focus", message: "Focusable element is hidden from the accessibility tree", selector: selector(element), expected: false, actual: true });
            }
            const id = `boxspec-a11y-${auditId++}`;
            (element as AuditedElement).__boxspecA11yAuditId = id;
            focusableIds.push(id);
          }

          const hasDirectText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && /\S/u.test(node.textContent ?? ""));
          if (!hasDirectText) continue;
          textSamples += 1;
          const style = getComputedStyle(element);
          const foreground = parseColor(style.color);
          const back = background(element);
          if (!foreground || !back) {
            unsupportedContrastSamples += 1;
            continue;
          }
          const ratio = contrast(blend(foreground, back), back);
          contrastRatios.push(ratio);
          const fontSize = Number.parseFloat(style.fontSize);
          const fontWeight = Number.parseInt(style.fontWeight, 10);
          const large = fontSize >= 24 || (fontSize >= 18.66 && Number.isFinite(fontWeight) && fontWeight >= 700);
          const required = large ? largeContrast : normalContrast;
          if (ratio + 0.001 < required) {
            findings.push({
              kind: "contrast",
              message: `Text contrast ${ratio.toFixed(2)}:1 is below ${required.toFixed(2)}:1`,
              selector: selector(element),
              expected: required,
              actual: Number(ratio.toFixed(3)),
            });
          }
        }
        return { findings, focusableIds, interactiveElements, namedInteractiveElements, textSamples, contrastRatios, unsupportedContrastSamples };
      },
      { normalContrast: normalTextContrast, largeContrast: largeTextContrast },
    );

    await input.page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      document.body.focus();
    });
    const reached = new Set<string>();
    for (let index = 0; index < snapshot.focusableIds.length + 2; index += 1) {
      await input.page.keyboard.press("Tab");
      const focused = await input.page.evaluate(() => (document.activeElement as (HTMLElement & { __boxspecA11yAuditId?: string }) | null)?.__boxspecA11yAuditId ?? null);
      if (focused) reached.add(focused);
    }
    const findings = [...snapshot.findings];
    for (const id of snapshot.focusableIds) {
      if (!reached.has(id)) findings.push({ kind: "keyboard", message: "Focusable element was not reached by sequential Tab navigation", selector: id, expected: true, actual: false });
    }
    await input.page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>("body *")) delete (element as HTMLElement & { __boxspecA11yAuditId?: string }).__boxspecA11yAuditId;
    });
    const endHtml = await input.page.content();
    if (sha256Bytes(endHtml) !== domSha256) {
      return {
        status: "STALE",
        binding: input.binding,
        bindingDigest,
        domSha256,
        violations: [{
          id: `accessibility:${input.binding.viewportId}:${input.binding.fixtureId}:dom-end`,
          checkId: "accessibility",
          kind: "dom-changed-during-audit",
          severity: "error",
          blocking: true,
          message: "Rendered DOM changed during accessibility audit",
          viewportId: input.binding.viewportId,
          fixtureId: input.binding.fixtureId,
        }],
        measurement: emptyMeasurement(),
        message: "Rendered DOM changed during accessibility audit",
      };
    }

    const measurement: AccessibilityMeasurement = {
      interactiveElements: snapshot.interactiveElements,
      namedInteractiveElements: snapshot.namedInteractiveElements,
      textSamples: snapshot.textSamples,
      contrastSamples: snapshot.contrastRatios.length,
      unsupportedContrastSamples: snapshot.unsupportedContrastSamples,
      tabStops: snapshot.focusableIds.length,
      reachedTabStops: reached.size,
      minimumContrastRatio: snapshot.contrastRatios.length === 0 ? null : Number(Math.min(...snapshot.contrastRatios).toFixed(3)),
    };
    if (snapshot.interactiveElements === 0 && snapshot.textSamples === 0) {
      return { status: "UNSUPPORTED", binding: input.binding, bindingDigest, domSha256, violations: [], measurement, message: "No visible semantic or text surface was available to audit" };
    }
    const violations: Violation[] = findings.map((finding, index) => ({
      id: `accessibility:${input.binding.viewportId}:${input.binding.fixtureId}:${index}`,
      checkId: "accessibility",
      kind: finding.kind,
      severity: "error",
      blocking: true,
      message: `${finding.selector}: ${finding.message}`,
      viewportId: input.binding.viewportId,
      fixtureId: input.binding.fixtureId,
      ...(finding.expected === undefined ? {} : { expected: finding.expected }),
      ...(finding.actual === undefined ? {} : { actual: finding.actual }),
    }));
    const hasUnsupportedContrast = snapshot.unsupportedContrastSamples > 0;
    const status: AccessibilityAuditResult["status"] = violations.length > 0 ? "FAIL" : hasUnsupportedContrast ? "UNSUPPORTED" : "PASS";
    return {
      status,
      binding: input.binding,
      bindingDigest,
      domSha256,
      violations,
      measurement,
      message:
        status === "PASS"
          ? `${snapshot.interactiveElements} interactive element(s), ${snapshot.textSamples} text sample(s), and ${snapshot.focusableIds.length} tab stop(s) passed deterministic checks`
          : status === "FAIL"
            ? `${violations.length} blocking accessibility violation(s)`
            : `${snapshot.unsupportedContrastSamples} text sample(s) use a background the deterministic contrast engine cannot resolve`,
    };
  } catch (error) {
    return {
      status: "ERROR",
      binding: input.binding,
      bindingDigest,
      domSha256: null,
      violations: [],
      measurement: emptyMeasurement(),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
