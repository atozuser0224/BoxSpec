import assert from "node:assert/strict";
import test from "node:test";

import { parseVerificationAssetClosure, parseVerificationToolsManifest } from "../dist/verification-tools.js";

const hash = "a".repeat(64);
const asset = (relativePath) => ({ relativePath, sha256: hash, sizeBytes: 1 });

function validManifest() {
  return {
    schemaVersion: "1.0.0",
    verificationProfileId: "managed-react-vite-p1",
    executionProfileId: "managed-react-vite-p1",
    generatorVersion: "boxspec-0.0.0",
    applicationExecutable: { sha256: hash, sizeBytes: 1 },
    typecheck: {
      entryPoint: asset("verification/toolchain/typecheck-runner.mjs"),
      args: ["{outputDir}"],
      cwd: ".",
      timeoutMs: 60_000,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
    build: {
      entryPoint: asset("verification/toolchain/vite-build-runner.mjs"),
      args: ["{outputDir}"],
      cwd: ".",
      timeoutMs: 120_000,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
    toolchainManifest: asset("verification/manifests/toolchain.json"),
    browser: {
      ...asset("verification/browser/chrome-headless-shell.exe"),
      engine: "chromium",
      playwrightVersion: "1.63.0",
      chromiumRevision: "1243",
      browserVersion: "153.0.8010.12",
    },
    browserManifest: asset("verification/manifests/browser.json"),
    fixtures: ["empty", "loading", "error", "long-text", "populated"].map((id) => ({
      id,
      ...asset(`verification/fixtures/${id}.json`),
    })),
    route: "/index.html",
    outputDirectoryName: "dist",
    fixtureQueryParameter: "fixture",
  };
}

test("accepts the complete fixed managed-react profile", () => {
  const parsed = parseVerificationToolsManifest(validManifest());
  assert.equal(parsed.fixtures.length, 5);
  assert.equal(parsed.typecheck.environment.ELECTRON_RUN_AS_NODE, "1");
});

test("requires complete ordinal asset-closure inventories", () => {
  const closure = {
    schemaVersion: "1.0.0",
    root: "verification/toolchain",
    entries: [
      asset("verification/toolchain/a.js"),
      asset("verification/toolchain/node_modules/z/index.js"),
    ],
  };
  assert.equal(parseVerificationAssetClosure(closure, "verification/toolchain").entries.length, 2);
  assert.throws(() => parseVerificationAssetClosure({ ...closure, entries: [...closure.entries].reverse() }, "verification/toolchain"));
  assert.throws(() => parseVerificationAssetClosure({ ...closure, entries: [asset("verification/browser/chrome.exe")] }, "verification/toolchain"));
  assert.throws(() => parseVerificationAssetClosure({ ...closure, entries: [asset("verification/toolchain/A.js"), asset("verification/toolchain/a.js")] }, "verification/toolchain"));
  assert.throws(() => parseVerificationAssetClosure({ ...closure, entries: [asset("verification/toolchain/CON.txt")] }, "verification/toolchain"));
  assert.throws(() => parseVerificationAssetClosure({
    ...closure,
    entries: [{ ...asset("verification/toolchain/a.js"), executablePath: "C:/evil.exe" }],
  }, "verification/toolchain"));
});

test("rejects extra authority-bearing fields", () => {
  assert.throws(() => parseVerificationToolsManifest({ ...validManifest(), executablePath: "C:/untrusted.exe" }));
});

test("rejects traversal and incomplete fixture sets", () => {
  const traversal = validManifest();
  traversal.browser.relativePath = "../chrome.exe";
  assert.throws(() => parseVerificationToolsManifest(traversal));

  const incomplete = validManifest();
  incomplete.fixtures.pop();
  assert.throws(() => parseVerificationToolsManifest(incomplete));
});
