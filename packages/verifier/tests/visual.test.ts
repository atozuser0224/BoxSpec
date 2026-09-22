import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  compareVisual,
  computeApprovedVisualBaselineDescriptorHash,
  type TrustedVisualBaseline,
  type VisualBinding,
} from "../src/visual.js";
import { sha256Bytes } from "../src/hash.js";

const binding: VisualBinding = {
  effectiveContractHash: "1".repeat(64),
  verificationProfileHash: "2".repeat(64),
  fixturesHash: "3".repeat(64),
  viewportId: "desktop",
  fixtureId: "populated",
};

function approvedBaseline(imageBytes: Uint8Array): TrustedVisualBaseline {
  const descriptor = {
    baselineId: "baseline_approved",
    approvalId: "approval_human",
    approvedAt: "2026-09-22T00:00:00.000Z",
    binding,
    imageSha256: sha256Bytes(imageBytes),
  } as const;
  return {
    ...descriptor,
    descriptorHash: computeApprovedVisualBaselineDescriptorHash(descriptor),
    imageBytes,
  };
}

describe("trusted visual baseline engine", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  });

  async function capture(color: string): Promise<Buffer> {
    const page = await browser.newPage({ viewport: { width: 160, height: 100 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:#fff}.box{width:80px;height:50px;background:${color}}</style><div class="box"></div>`);
    const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide" });
    await page.close();
    return bytes;
  }

  it("passes exact approved pixels and binds profile, viewport, fixture, and hashes", async () => {
    const bytes = await capture("#067647");
    const result = compareVisual(bytes, approvedBaseline(bytes), binding);
    expect(result.status).toBe("PASS");
    expect(result.measurement?.changedPixels).toBe(0);
    expect(result.actualImageSha256).toBe(sha256Bytes(bytes));
    expect(result.bindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.baselineImageSha256).toBe(sha256Bytes(bytes));
  }, 30_000);

  it("fails a deliberate pixel regression with measured bounds", async () => {
    const baselineBytes = await capture("#067647");
    const actualBytes = await capture("#c4320a");
    const result = compareVisual(actualBytes, approvedBaseline(baselineBytes), binding);
    expect(result.status).toBe("FAIL");
    expect(result.measurement?.changedPixels).toBeGreaterThan(0);
    expect(result.measurement?.changedPixelRatio).toBeGreaterThan(0);
    expect(result.measurement?.differenceBounds).not.toBeNull();
    expect(result.violations[0]?.kind).toBe("pixel-regression");
  }, 30_000);

  it("returns UNSUPPORTED instead of creating or passing a missing baseline", async () => {
    const actualBytes = await capture("#067647");
    const result = compareVisual(actualBytes, undefined, binding);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.measurement).toBeNull();
    expect(result.baselineId).toBeNull();
  }, 30_000);

  it("returns STALE for baseline byte tamper or environment-binding mismatch", async () => {
    const baselineBytes = await capture("#067647");
    const changedBytes = await capture("#c4320a");
    const trusted = approvedBaseline(baselineBytes);
    expect(compareVisual(baselineBytes, { ...trusted, imageBytes: changedBytes }, binding).status).toBe("STALE");
    expect(compareVisual(baselineBytes, trusted, { ...binding, fixtureId: "empty" }).status).toBe("STALE");
  }, 30_000);
});
