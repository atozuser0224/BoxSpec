import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { evaluateAccessibility, runAccessibilityAudit, type AccessibilityAuditBinding } from "../src/accessibility.js";

const binding: AccessibilityAuditBinding = {
  candidateId: "candidate_accessibility",
  treeHash: "a".repeat(64),
  verificationProfileId: "profile_web",
  verificationProfileHash: "b".repeat(64),
  viewportId: "desktop",
  fixtureId: "populated",
  stateId: "populated",
  nodeIds: ["heading", "save", "email"],
};

describe("trusted accessibility engine", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  });

  it("measures keyboard traversal, names, roles, and contrast on a real page", async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(`<!doctype html>
      <style>body{margin:0;background:#fff;color:#111;font:16px Arial}button,input{margin:8px}</style>
      <main><h1>Dashboard</h1><button aria-label="Save"></button><label for="email">Email</label><input id="email"></main>`);
    const result = await evaluateAccessibility(page, binding);
    expect(result.status).toBe("PASS");
    expect(result.violations).toEqual([]);
    expect(result.measurement.interactiveElements).toBe(2);
    expect(result.measurement.namedInteractiveElements).toBe(2);
    expect(result.measurement.reachedTabStops).toBe(result.measurement.tabStops);
    expect(result.measurement.contrastSamples).toBeGreaterThan(0);
    expect(result.bindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.domSha256).toMatch(/^[a-f0-9]{64}$/u);
    await page.close();
  }, 30_000);

  it("fails deliberate keyboard, accessible-name, and contrast violations", async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(`<!doctype html>
      <style>body{margin:0;background:#fff;color:#111;font:16px Arial}.faint{color:#aaa}.custom{width:80px;height:30px}</style>
      <main><button></button><div class="custom" role="button">Custom action</div><p class="faint">Low contrast content</p></main>`);
    const result = await runAccessibilityAudit({ page, binding });
    expect(result.status).toBe("FAIL");
    expect(result.violations.map((item) => item.kind)).toEqual(expect.arrayContaining(["accessible-name", "keyboard", "contrast"]));
    expect(result.violations.every((item) => item.blocking)).toBe(true);
    await page.close();
  }, 30_000);

  it("returns UNSUPPORTED when no trusted browser engine or auditable surface exists", async () => {
    expect((await evaluateAccessibility(undefined, binding)).status).toBe("UNSUPPORTED");
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent("<!doctype html><div aria-hidden=\"true\"></div>");
    expect((await evaluateAccessibility(page, binding)).status).toBe("UNSUPPORTED");
    await page.close();
  }, 30_000);

  it("returns STALE when the rendered DOM does not match its trusted hash", async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent("<!doctype html><button>Save</button>");
    const result = await runAccessibilityAudit({ page, binding, expectedDomSha256: "c".repeat(64) });
    expect(result.status).toBe("STALE");
    expect(result.violations[0]?.kind).toBe("trusted-dom-hash-mismatch");
    await page.close();
  }, 30_000);
});
